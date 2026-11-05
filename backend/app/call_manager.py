"""Call state machine, sessions and the live voice-turn orchestration."""
from __future__ import annotations

import asyncio
import base64
import time
import uuid
from enum import Enum
from typing import Any, Optional

import numpy as np

from app import database, prompts
from app.config import settings
from app.engine import VoiceEngine
from app.llm import LLMError, OllamaClient
from app.security import (
    ValidationError,
    clean_assistant_text,
    detect_emergency,
    emergency_reply,
    guard_user_text,
    trim_for_call,
    validate_dial,
)
from app.tts import StreamingTTSChunker, split_sentences
from app.vad import PushToTalkBuffer, VADStream

SAMPLE_RATE = 16000


class CallState(str, Enum):
    IDLE = "IDLE"
    DIALING = "DIALING"
    CONNECTING = "CONNECTING"
    CONNECTED = "CONNECTED"
    LISTENING = "LISTENING"
    PROCESSING = "PROCESSING"
    SPEAKING = "SPEAKING"
    ENDED = "ENDED"
    ERROR = "ERROR"


class CallStateMachine:
    valid_transitions = {
        CallState.IDLE: {CallState.DIALING},
        CallState.DIALING: {CallState.CONNECTING, CallState.ENDED, CallState.ERROR},
        CallState.CONNECTING: {CallState.CONNECTED, CallState.ENDED, CallState.ERROR},
        CallState.CONNECTED: {CallState.LISTENING, CallState.ENDED, CallState.ERROR},
        CallState.LISTENING: {
            CallState.PROCESSING,
            CallState.SPEAKING,
            CallState.ENDED,
            CallState.ERROR,
        },
        CallState.PROCESSING: {
            CallState.SPEAKING,
            CallState.LISTENING,
            CallState.ENDED,
            CallState.ERROR,
        },
        CallState.SPEAKING: {
            CallState.LISTENING,
            CallState.PROCESSING,
            CallState.ENDED,
            CallState.ERROR,
        },
        CallState.ENDED: set(),
        CallState.ERROR: {CallState.ENDED, CallState.IDLE},
    }

    def __init__(self) -> None:
        self.state = CallState.IDLE

    def transition(self, next_state: CallState, force: bool = False) -> bool:
        if next_state == self.state:
            return True
        if force or next_state in self.valid_transitions.get(self.state, set()):
            self.state = next_state
            return True
        return False


class CallSession:
    def __init__(
        self,
        *,
        call_id: str,
        caller: str,
        callee: str,
        patient: dict[str, Any] | None,
        demo_mode: bool,
        websocket: Any,
        vad: Optional[VADStream],
    ) -> None:
        self.call_id = call_id
        self.caller = caller
        self.callee = callee
        self.patient = patient
        self.demo_mode = demo_mode
        self.websocket = websocket
        self.state = CallStateMachine()
        self.vad = vad
        self.ptt = PushToTalkBuffer()
        self.ptt_active = False
        self.barge_in_enabled = True
        self.mic_muted = False
        self.created_at = time.time()
        self.started_monotonic = time.monotonic()
        self.send_lock = asyncio.Lock()
        self.turn_lock = asyncio.Lock()
        self.history: list[dict[str, str]] = []
        self.metrics: list[dict[str, Any]] = []
        self.transcript: list[dict[str, Any]] = []
        self.turn_count = 0
        self.agent_task: Optional[asyncio.Task] = None
        self.watchdog_task: Optional[asyncio.Task] = None
        self.cancel_event = asyncio.Event()
        self.current_turn_id: Optional[str] = None
        self.current_reply: list[str] = []
        self.current_metrics: dict[str, Any] = {}
        self.current_turn_started = 0.0
        self.current_finalized = False
        self.audio_sent_this_turn = False
        self.audio_seq = 0
        self.last_audio_sent_seq = 0
        self.audio_seconds = 0.0
        self.audio_seconds_this_turn = 0.0
        self.closed = False
        self.finalized = False
        self.greeting_complete = False
        self.last_activity = time.time()

    @property
    def active(self) -> bool:
        return not self.finalized and self.state.state not in {
            CallState.ENDED,
            CallState.ERROR,
        }

    async def send(self, event: dict[str, Any]) -> bool:
        if self.closed:
            return False
        try:
            async with self.send_lock:
                await self.websocket.send_json(event)
            self.last_activity = time.time()
            return True
        except Exception:
            self.closed = True
            return False

    def transition(self, state: CallState, force: bool = False) -> bool:
        return self.state.transition(state, force=force)

    def remember(self, role: str, text: str, latency_ms: int | None = None) -> None:
        clean = " ".join((text or "").split())
        if not clean:
            return
        self.history.append({"role": role, "text": clean})
        self.history = self.history[-24:]
        self.transcript.append({"role": role, "text": clean})
        try:
            database.append_transcript(self.call_id, role, clean, latency_ms)
        except Exception:
            # A transcript write must never break an in-progress call.
            pass

    def snapshot_metrics(self) -> dict[str, Any]:
        e2e = [
            item.get("e2e_first_audio_ms")
            for item in self.metrics
            if item.get("e2e_first_audio_ms") is not None
        ]
        return {
            "turns": self.turn_count,
            "avg_e2e_first_audio_ms": int(sum(e2e) / len(e2e)) if e2e else None,
            "audio_seconds": round(self.audio_seconds, 2),
            "duration_ms": int((time.monotonic() - self.started_monotonic) * 1000),
        }


class CallManager:
    def __init__(self, engine: VoiceEngine) -> None:
        self.engine = engine
        self.sessions: dict[str, CallSession] = {}
        self._lock = asyncio.Lock()

    @property
    def active_count(self) -> int:
        return len([s for s in self.sessions.values() if s.active])

    async def start_call(
        self,
        websocket: Any,
        *,
        caller: str,
        callee: str,
        demo_mode: Optional[bool] = None,
    ) -> CallSession:
        target = validate_dial(caller, callee)
        patient = database.get_patient(target.caller)
        if patient is None:
            raise ValidationError(
                "unknown_caller",
                f"Caller extension {target.caller} is not provisioned in the demo directory.",
                404,
            )
        async with self._lock:
            if self.active_count >= settings.max_active_calls:
                raise ValidationError(
                    "capacity",
                    "The local line is at capacity. Please end another call and try again.",
                    503,
                )
            call_id = database.new_call_id()
            database.create_call(
                call_id=call_id,
                caller_extension=target.caller,
                callee_extension=target.callee,
                patient_name=patient.get("display_name"),
                demo_mode=bool(settings.demo_mode if demo_mode is None else demo_mode),
            )
            try:
                vad = self.engine.new_vad_stream()
            except Exception:
                vad = None
            session = CallSession(
                call_id=call_id,
                caller=target.caller,
                callee=target.callee,
                patient=patient,
                demo_mode=bool(settings.demo_mode if demo_mode is None else demo_mode),
                websocket=websocket,
                vad=vad,
            )
            self.sessions[call_id] = session

        session.transition(CallState.DIALING)
        await session.send(
            {
                "type": "call_started",
                "call_id": call_id,
                "caller": target.caller,
                "callee": target.callee,
                "callee_name": prompts.AGENT_NAME,
                "patient": patient,
                "demo_mode": session.demo_mode,
                "state": CallState.DIALING.value,
                "started_at": session.created_at,
                "limits": {
                    "max_turns": settings.max_turns,
                    "max_minutes": settings.max_call_minutes,
                },
                "capabilities": {
                    "vad": session.vad is not None,
                    "push_to_talk": True,
                    "text_fallback": True,
                    "barge_in": True,
                },
            }
        )
        for next_state in (
            CallState.CONNECTING,
            CallState.CONNECTED,
            CallState.LISTENING,
        ):
            session.transition(next_state)
            await self._send_state(session)
        await self._send_greeting(session)
        return session

    async def _send_state(self, session: CallSession) -> None:
        await session.send(
            {
                "type": "state",
                "state": session.state.state.value,
                "elapsed_ms": int(
                    (time.monotonic() - session.started_monotonic) * 1000
                ),
            }
        )

    async def _send_greeting(self, session: CallSession) -> None:
        text = prompts.greeting(session.patient)
        turn_id = "greet_" + uuid.uuid4().hex[:8]
        session.remember("assistant", text)
        await session.send(
            {
                "type": "assistant",
                "turn_id": turn_id,
                "role": "assistant",
                "text": text,
                "final": True,
                "greeting": True,
            }
        )
        audio_error_sent = False

        async def greet() -> None:
            nonlocal audio_error_sent
            try:
                total_seconds = 0.0
                for index, sentence in enumerate(split_sentences(text)):
                    if index == 0:
                        session.transition(CallState.SPEAKING)
                        await self._send_state(session)
                    result = await self.engine.tts.synthesize(sentence)
                    if session.closed or session.state.state != CallState.SPEAKING:
                        return
                    await self._send_audio(
                        session,
                        turn_id,
                        result,
                        first_audio=index == 0,
                    )
                    total_seconds += result.duration_s
                await session.send(
                    {
                        "type": "assistant_end",
                        "turn_id": turn_id,
                        "text": text,
                        "final": True,
                        "greeting": True,
                        "interrupted": False,
                        "metrics": {},
                    }
                )
                session.greeting_complete = True
                self._schedule_playback_watchdog(
                    session, session.audio_seq, total_seconds + 6.0
                )
            except asyncio.CancelledError:
                return
            except Exception as exc:
                if not audio_error_sent:
                    audio_error_sent = True
                    await session.send(
                        {
                            "type": "error",
                            "code": "tts_unavailable",
                            "message": f"Greeting audio could not be generated: {exc}",
                            "fatal": False,
                        }
                    )
                if session.state.state == CallState.SPEAKING:
                    session.transition(CallState.LISTENING)
                    await self._send_state(session)
            finally:
                if session.agent_task is asyncio.current_task():
                    session.agent_task = None

        session.agent_task = asyncio.create_task(greet())

    async def handle_control(
        self, session: CallSession, message: dict[str, Any]
    ) -> bool:
        """Handle a JSON control message. Returns False when the socket should close."""
        kind = str(message.get("type", "")).strip()
        if kind == "ping":
            await session.send({"type": "pong", "t": time.time()})
            return True
        if kind == "config":
            if "barge_in" in message:
                session.barge_in_enabled = bool(message.get("barge_in"))
            if "muted" in message:
                session.mic_muted = bool(message.get("muted"))
            await session.send(
                {
                    "type": "config_ack",
                    "barge_in": session.barge_in_enabled,
                    "muted": session.mic_muted,
                }
            )
            return True
        if kind == "ptt_start":
            if session.state.state in {CallState.SPEAKING, CallState.PROCESSING}:
                await self.interrupt(session, "ptt")
            if not session.active:
                return True
            session.ptt_active = True
            session.ptt.start()
            session.transition(CallState.LISTENING)
            await session.send(
                {"type": "vad", "event": "speech_start", "source": "ptt"}
            )
            return True
        if kind == "ptt_stop":
            if not session.ptt_active:
                return True
            session.ptt_active = False
            samples = session.ptt.finish()
            await session.send(
                {
                    "type": "vad",
                    "event": "speech_end",
                    "source": "ptt",
                    "duration_ms": int(samples.size * 1000 / SAMPLE_RATE),
                }
            )
            if samples.size:
                await self._schedule_turn(session, samples=samples, input_kind="ptt")
            else:
                await session.send(
                    {
                        "type": "notice",
                        "code": "no_speech",
                        "message": "No speech was captured. Hold the button while you speak.",
                    }
                )
                if session.state.state == CallState.LISTENING:
                    await self._send_state(session)
            return True
        if kind == "playback_done":
            await self._playback_done(session, int(message.get("seq") or 0))
            return True
        if kind == "text_input":
            text = guard_user_text(str(message.get("text", "")))
            if not text:
                await session.send(
                    {
                        "type": "error",
                        "code": "empty_text",
                        "message": "Type a message before sending.",
                        "fatal": False,
                    }
                )
                return True
            if session.state.state in {CallState.SPEAKING, CallState.PROCESSING}:
                await self.interrupt(session, "text_input")
            await self._schedule_turn(session, text=text, input_kind="text")
            return True
        if kind == "end_call":
            await self.end_call(session, reason="caller_hangup")
            return False
        await session.send(
            {
                "type": "error",
                "code": "unknown_message",
                "message": f"Unsupported control message: {kind or '(empty)'}",
                "fatal": False,
            }
        )
        return True

    async def handle_audio(self, session: CallSession, frame: bytes) -> None:
        if not session.active or session.closed or session.mic_muted:
            return
        if len(frame) > settings.ws_max_message_bytes:
            await session.send(
                {
                    "type": "error",
                    "code": "audio_too_large",
                    "message": "Audio frame exceeded the local limit.",
                    "fatal": False,
                }
            )
            return
        if len(frame) < 2:
            return
        try:
            samples = (
                np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0
            )
        except ValueError:
            return

        if session.ptt_active:
            session.ptt.append(samples)
            return
        if session.state.state == CallState.PROCESSING:
            return
        if session.state.state == CallState.SPEAKING and not session.barge_in_enabled:
            return
        if session.vad is None:
            return
        agent_speaking = session.state.state == CallState.SPEAKING
        events = session.vad.feed(samples, agent_speaking=agent_speaking)
        for event in events:
            if event["type"] == "speech_start":
                await session.send(
                    {
                        "type": "vad",
                        "event": "speech_start",
                        "source": "vad",
                        "prob": round(float(event.get("prob", 0.0)), 3),
                        "barge_in": bool(event.get("barge_in")),
                    }
                )
                if event.get("barge_in"):
                    await self.interrupt(session, "barge_in")
            elif event["type"] == "speech_end":
                utterance = event.get("samples")
                await session.send(
                    {
                        "type": "vad",
                        "event": "speech_end",
                        "source": "vad",
                        "duration_ms": event.get("duration_ms", 0),
                        "reason": event.get("reason"),
                    }
                )
                if isinstance(utterance, np.ndarray) and utterance.size:
                    await self._schedule_turn(
                        session, samples=utterance, input_kind="speech"
                    )

    async def _schedule_turn(
        self,
        session: CallSession,
        *,
        samples: Optional[np.ndarray] = None,
        text: Optional[str] = None,
        input_kind: str = "speech",
    ) -> None:
        if not session.active or session.closed:
            return
        if session.turn_count >= settings.max_turns:
            await session.send(
                {
                    "type": "error",
                    "code": "turn_limit",
                    "message": "This demo call reached its turn limit. Ending the call.",
                    "fatal": True,
                }
            )
            await self.end_call(session, reason="turn_limit")
            return
        if session.agent_task is not None and not session.agent_task.done():
            if session.state.state == CallState.SPEAKING:
                await self.interrupt(session, "barge_in")
            else:
                return
        if session.state.state not in {CallState.LISTENING, CallState.CONNECTED}:
            session.transition(CallState.LISTENING, force=True)
        session.agent_task = asyncio.create_task(
            self._run_turn(
                session, samples=samples, text=text, input_kind=input_kind
            )
        )

    async def _run_turn(
        self,
        session: CallSession,
        *,
        samples: Optional[np.ndarray],
        text: Optional[str],
        input_kind: str,
    ) -> None:
        turn_id = "turn_" + uuid.uuid4().hex[:8]
        session.current_turn_id = turn_id
        session.current_reply = []
        session.current_metrics = {
            "turn_id": turn_id,
            "input": input_kind,
            "asr_ms": None,
            "llm_first_token_ms": None,
            "llm_total_ms": None,
            "tts_first_ms": None,
            "tts_total_ms": 0,
            "tts_sentences": 0,
            "e2e_first_audio_ms": None,
            "interrupted": False,
        }
        session.current_turn_started = time.perf_counter()
        session.current_finalized = False
        session.audio_sent_this_turn = False
        session.audio_seconds_this_turn = 0.0
        session.cancel_event = asyncio.Event()

        async with session.turn_lock:
            try:
                session.transition(CallState.PROCESSING)
                await self._send_state(session)

                user_text = (text or "").strip()
                if samples is not None:
                    try:
                        asr_result = await self.engine.asr.transcribe(samples, SAMPLE_RATE)
                    except Exception as exc:
                        await session.send(
                            {
                                "type": "error",
                                "code": "asr_unavailable",
                                "message": f"Speech recognition failed: {exc}",
                                "fatal": False,
                            }
                        )
                        session.transition(CallState.LISTENING)
                        await self._send_state(session)
                        return
                    session.current_metrics["asr_ms"] = asr_result.get("elapsed_ms")
                    user_text = asr_result.get("text", "")

                user_text = guard_user_text(user_text)
                if not user_text:
                    await session.send(
                        {
                            "type": "transcript",
                            "turn_id": turn_id,
                            "role": "user",
                            "text": "",
                            "final": True,
                            "input": input_kind,
                            "asr_ms": session.current_metrics.get("asr_ms"),
                            "note": "no_speech",
                        }
                    )
                    session.transition(CallState.LISTENING)
                    await self._send_state(session)
                    session.current_turn_id = None
                    return

                await session.send(
                    {
                        "type": "transcript",
                        "turn_id": turn_id,
                        "role": "user",
                        "text": user_text,
                        "final": True,
                        "input": input_kind,
                        "asr_ms": session.current_metrics.get("asr_ms"),
                    }
                )
                session.remember(
                    "user",
                    user_text,
                    latency_ms=session.current_metrics.get("asr_ms"),
                )
                history_before = list(session.history[:-1])

                emergency = detect_emergency(user_text)
                if emergency:
                    reply = emergency_reply(emergency)
                    session.current_metrics["emergency"] = emergency
                    session.current_reply = [reply]
                    await session.send(
                        {"type": "assistant_start", "turn_id": turn_id}
                    )
                    await session.send(
                        {
                            "type": "assistant_delta",
                            "turn_id": turn_id,
                            "text": reply,
                        }
                    )
                    for sentence in split_sentences(reply):
                        await self._speak_sentence(session, turn_id, sentence)
                    await self._finalize_turn(session, interrupted=False)
                    await self._after_turn(session)
                    return

                await session.send(
                    {"type": "assistant_start", "turn_id": turn_id}
                )
                messages = prompts.build_messages(
                    session.patient, session.demo_mode, history_before, user_text
                )
                chunker = StreamingTTSChunker()
                first_delta_at: Optional[float] = None
                last_delta_at: Optional[float] = None
                llm_done: dict[str, Any] = {}
                reply_chars = 0
                spoken: list[str] = []
                spoken_words = 0
                limit_reached = False

                async def speak_candidate(candidate: str) -> bool:
                    nonlocal spoken_words
                    if len(spoken) >= 2 or spoken_words >= 55:
                        return False
                    remaining = max(12, 55 - spoken_words)
                    piece = trim_for_call(
                        candidate, max_sentences=1, max_words=remaining
                    )
                    if not piece:
                        return False
                    if not await self._speak_sentence(session, turn_id, piece):
                        return False
                    spoken.append(piece)
                    spoken_words += len(piece.split())
                    return True

                try:
                    async for chunk in self.engine.llm.stream_chat(
                        messages, session.cancel_event
                    ):
                        if chunk.get("delta"):
                            delta = str(chunk["delta"])
                            now = time.perf_counter()
                            if first_delta_at is None:
                                first_delta_at = now
                            last_delta_at = now
                            reply_chars += len(delta)
                            session.current_reply.append(delta)
                            await session.send(
                                {
                                    "type": "assistant_delta",
                                    "turn_id": turn_id,
                                    "text": delta,
                                }
                            )
                            for sentence in chunker.push(delta):
                                if not await speak_candidate(sentence):
                                    limit_reached = True
                                    break
                                if len(spoken) >= 2 or spoken_words >= 55:
                                    limit_reached = True
                                    break
                            if limit_reached or reply_chars > 900:
                                limit_reached = True
                                break
                        if chunk.get("done"):
                            llm_done = chunk
                    if first_delta_at is not None:
                        session.current_metrics["llm_first_token_ms"] = int(
                            (first_delta_at - session.current_turn_started) * 1000
                        )
                    if llm_done.get("total_ms") is not None:
                        session.current_metrics["llm_total_ms"] = llm_done["total_ms"]
                    elif last_delta_at is not None:
                        session.current_metrics["llm_total_ms"] = int(
                            (last_delta_at - session.current_turn_started) * 1000
                        )
                except LLMError as exc:
                    fallback = prompts.unavailable_reply()
                    session.current_reply = [fallback]
                    await session.send(
                        {
                            "type": "assistant_delta",
                            "turn_id": turn_id,
                            "text": fallback,
                        }
                    )
                    await session.send(
                        {
                            "type": "error",
                            "code": exc.code,
                            "message": str(exc),
                            "fatal": False,
                        }
                    )
                    await self._speak_sentence(session, turn_id, fallback)
                    await self._finalize_turn(session, interrupted=False)
                    await self._after_turn(session)
                    return

                if limit_reached:
                    chunker.buffer = ""
                else:
                    for sentence in chunker.flush():
                        if not await speak_candidate(sentence):
                            break

                cleaned = " ".join(spoken).strip()
                if not cleaned:
                    cleaned = "I am here. Could you say that again?"
                    spoken.append(cleaned)
                    await session.send(
                        {
                            "type": "assistant_delta",
                            "turn_id": turn_id,
                            "text": cleaned,
                        }
                    )
                    await self._speak_sentence(session, turn_id, cleaned)
                # Persist and display exactly what was spoken, not discarded
                # model tail text that the caller never heard.
                session.current_reply = [" ".join(spoken).strip()]
                await self._finalize_turn(session, interrupted=False)
                await self._after_turn(session)
            except asyncio.CancelledError:
                if session.current_turn_id == turn_id and not session.current_finalized:
                    await self._finalize_turn(session, interrupted=True)
                return
            except Exception as exc:
                await session.send(
                    {
                        "type": "error",
                        "code": "turn_failed",
                        "message": f"The call turn failed: {exc}",
                        "fatal": False,
                    }
                )
                if session.current_turn_id == turn_id and not session.current_finalized:
                    await self._finalize_turn(session, interrupted=True)
                if session.active:
                    session.transition(CallState.LISTENING)
                    await self._send_state(session)
            finally:
                if session.agent_task is asyncio.current_task():
                    session.agent_task = None
                if session.current_turn_id == turn_id:
                    session.current_turn_id = None

    async def _speak_sentence(
        self,
        session: CallSession,
        turn_id: str,
        sentence: str,
    ) -> bool:
        if session.cancel_event.is_set() or session.current_turn_id != turn_id:
            return False
        sentence = clean_assistant_text(sentence, limit=settings.tts_max_sentence_chars)
        if not sentence:
            return False
        try:
            result = await self.engine.tts.synthesize(sentence)
        except Exception as exc:
            if not session.current_metrics.get("tts_error_sent"):
                session.current_metrics["tts_error_sent"] = True
                await session.send(
                    {
                        "type": "error",
                        "code": "tts_unavailable",
                        "message": f"Text to speech failed: {exc}",
                        "fatal": False,
                    }
                )
            return False
        if session.cancel_event.is_set() or session.current_turn_id != turn_id:
            return False
        metrics = session.current_metrics
        if metrics.get("tts_first_ms") is None:
            metrics["tts_first_ms"] = result.gen_ms
        metrics["tts_total_ms"] = int(metrics.get("tts_total_ms") or 0) + result.gen_ms
        metrics["tts_sentences"] = int(metrics.get("tts_sentences") or 0) + 1
        if not session.audio_sent_this_turn:
            session.transition(CallState.SPEAKING)
            await self._send_state(session)
            metrics["e2e_first_audio_ms"] = int(
                (time.perf_counter() - session.current_turn_started) * 1000
            )
            session.audio_sent_this_turn = True
        session.audio_seq += 1
        sent = await self._send_audio(
            session,
            turn_id,
            result,
            first_audio=True,
            seq=session.audio_seq,
        )
        return sent

    async def _send_audio(
        self,
        session: CallSession,
        turn_id: str,
        result: Any,
        first_audio: bool,
        seq: Optional[int] = None,
    ) -> None:
        if seq is None:
            session.audio_seq += 1
            seq = session.audio_seq
        session.audio_seconds += float(result.duration_s)
        session.audio_seconds_this_turn += float(result.duration_s)
        session.last_audio_sent_seq = seq
        return await session.send(
            {
                "type": "audio",
                "turn_id": turn_id,
                "seq": seq,
                "mime": "audio/wav",
                "sample_rate": result.sample_rate,
                "duration_ms": int(result.duration_s * 1000),
                "data_b64": base64.b64encode(result.wav).decode("ascii"),
            }
        )

    async def _finalize_turn(
        self, session: CallSession, *, interrupted: bool, reason: str | None = None
    ) -> None:
        if session.current_finalized:
            return
        session.current_finalized = True
        turn_id = session.current_turn_id
        if not turn_id:
            return
        text = clean_assistant_text("".join(session.current_reply))
        metrics = dict(session.current_metrics)
        metrics["interrupted"] = interrupted
        if interrupted:
            metrics["interrupt_reason"] = reason
        if metrics.get("e2e_first_audio_ms") is None:
            metrics["e2e_first_audio_ms"] = int(
                (time.perf_counter() - session.current_turn_started) * 1000
            )
        if text:
            session.remember(
                "assistant", text, latency_ms=metrics.get("e2e_first_audio_ms")
            )
        session.metrics.append(metrics)
        session.turn_count += 1
        await session.send(
            {
                "type": "assistant_end",
                "turn_id": turn_id,
                "text": text,
                "interrupted": interrupted,
                "metrics": metrics,
            }
        )
        await session.send({"type": "metrics", **metrics})
        session.current_turn_id = None
        session.current_reply = []

    async def _after_turn(self, session: CallSession) -> None:
        if not session.active:
            return
        if session.audio_sent_this_turn:
            self._schedule_playback_watchdog(
                session,
                session.last_audio_sent_seq,
                max(4.0, session.audio_seconds_this_turn + 6.0),
            )
        else:
            session.transition(CallState.LISTENING)
            await self._send_state(session)

    def _schedule_playback_watchdog(
        self, session: CallSession, seq: int, delay_s: float
    ) -> None:
        if session.watchdog_task and not session.watchdog_task.done():
            session.watchdog_task.cancel()

        async def watchdog() -> None:
            try:
                await asyncio.sleep(min(max(delay_s, 2.0), 90.0))
                if (
                    session.active
                    and session.state.state == CallState.SPEAKING
                    and session.last_audio_sent_seq == seq
                ):
                    session.transition(CallState.LISTENING)
                    await self._send_state(session)
                    await session.send(
                        {
                            "type": "notice",
                            "code": "playback_timeout",
                            "message": "Playback completion was not reported; microphone is open again.",
                        }
                    )
            except asyncio.CancelledError:
                return

        session.watchdog_task = asyncio.create_task(watchdog())

    async def _playback_done(self, session: CallSession, seq: int) -> None:
        if session.state.state != CallState.SPEAKING:
            return
        if seq < session.last_audio_sent_seq:
            return
        if (
            session.agent_task is not None
            and not session.agent_task.done()
            and not session.current_finalized
        ):
            # More text or audio may still arrive from this turn.
            return
        if session.watchdog_task and not session.watchdog_task.done():
            session.watchdog_task.cancel()
        session.transition(CallState.LISTENING)
        await self._send_state(session)

    async def interrupt(self, session: CallSession, reason: str) -> None:
        if not session.active:
            return
        if session.state.state not in {CallState.SPEAKING, CallState.PROCESSING}:
            return
        turn_id = session.current_turn_id
        session.cancel_event.set()
        task = session.agent_task
        if task is not None and not task.done() and task is not asyncio.current_task():
            task.cancel()
            # Let the turn's CancelledError handler close the turn exactly once
            # before the barge-in acknowledgement is sent to the browser.
            try:
                await asyncio.wait_for(task, timeout=4.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            except Exception:
                pass
        await self._finalize_turn(session, interrupted=True, reason=reason)
        if session.watchdog_task and not session.watchdog_task.done():
            session.watchdog_task.cancel()
        session.transition(CallState.LISTENING, force=True)
        await self._send_state(session)
        await session.send(
            {
                "type": "interrupted",
                "reason": reason,
                "turn_id": turn_id,
            }
        )

    async def end_call(
        self,
        session: CallSession,
        *,
        reason: str = "ended",
        notify: bool = True,
        status: str = "completed",
    ) -> None:
        if session.finalized:
            return
        session.finalized = True
        session.cancel_event.set()
        for task in (session.agent_task, session.watchdog_task):
            if task is not None and not task.done():
                task.cancel()
        if session.current_turn_id and not session.current_finalized:
            await self._finalize_turn(session, interrupted=True, reason=reason)
        session.transition(CallState.ENDED, force=True)
        avg = session.snapshot_metrics()
        try:
            database.finish_call(
                call_id=session.call_id,
                status=status,
                turns=session.turn_count,
                avg_latency_ms=avg.get("avg_e2e_first_audio_ms"),
            )
        except Exception:
            pass
        self.sessions.pop(session.call_id, None)
        if notify and not session.closed:
            await session.send(
                {
                    "type": "call_ended",
                    "call_id": session.call_id,
                    "reason": reason,
                    "state": CallState.ENDED.value,
                    "summary": avg,
                }
            )
        session.closed = True

    async def detach(self, session: CallSession, reason: str = "disconnected") -> None:
        if session.finalized:
            return
        await self.end_call(
            session, reason=reason, notify=False, status="disconnected"
        )

    async def shutdown(self) -> None:
        for session in list(self.sessions.values()):
            await self.end_call(
                session, reason="server_shutdown", notify=False, status="shutdown"
            )
        self.sessions.clear()
