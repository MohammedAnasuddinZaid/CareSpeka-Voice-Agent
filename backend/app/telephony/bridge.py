"""Bidirectional audio bridge between a telephony media stream and the local AI.

The bridge is transport-agnostic: the router feeds it provider media frames and
gives it a callback that writes frames back.  Everything in between reuses the
*existing* VoiceLink pipeline (Silero VAD, whisper.cpp, Ollama, sherpa-onnx), so
the telephone conversation is the same assistant as the browser demo, not a
second engine.

Handled here: codec and sample-rate conversion, framing, VAD, streaming ASR,
streaming LLM, sentence-chunked TTS, playback, barge-in, cancellation of stale
replies, silence handling and escalation hooks.
"""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import numpy as np

from app import prompts
from app.escalation import EscalationDecision, classify, safety_message
from app.security import clean_assistant_text, trim_for_call
from app.telephony.audio import (
    AI_SAMPLE_RATE,
    TELEPHONY_SAMPLE_RATE,
    AudioFormat,
    float_to_pcm16,
    iter_frames,
    pcm16_to_float,
    wav_pcm16,
)
from app.telephony.models import EscalationSeverity
from app.vad import SileroVADModel, VADStream

SendAudio = Callable[[bytes], Awaitable[None]]
SendClear = Callable[[], Awaitable[None]]
EscalationHook = Callable[["EscalationRequest"], Awaitable[Optional[str]]]

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


@dataclass
class EscalationRequest:
    decision: EscalationDecision
    call_id: Optional[str]
    patient_id: Optional[int]
    utterance: str


@dataclass
class BridgeMetrics:
    turns: int = 0
    first_audio_ms: list[int] = field(default_factory=list)
    asr_ms: list[int] = field(default_factory=list)

    def snapshot(self) -> dict[str, Any]:
        return {
            "turns": self.turns,
            "avg_first_audio_ms": int(sum(self.first_audio_ms) / len(self.first_audio_ms))
            if self.first_audio_ms
            else None,
            "avg_asr_ms": int(sum(self.asr_ms) / len(self.asr_ms)) if self.asr_ms else None,
        }


class TelephonyBridge:
    def __init__(
        self,
        *,
        engine: Any,
        media_format: AudioFormat,
        send_audio: SendAudio,
        send_clear: Optional[SendClear] = None,
        call_id: Optional[str] = None,
        patient: Optional[dict[str, Any]] = None,
        patient_id: Optional[int] = None,
        persona: str = "patient",
        demo_mode: bool = True,
        on_escalation: Optional[EscalationHook] = None,
        outbound_chunk_bytes: int = 0,
        max_turns: int = 40,
        max_seconds: int = 1800,
    ) -> None:
        self.engine = engine
        self.media_format = media_format
        self.send_audio = send_audio
        self.send_clear = send_clear
        self.call_id = call_id
        self.patient = patient
        self.patient_id = patient_id
        self.persona = persona
        self.demo_mode = demo_mode
        self.on_escalation = on_escalation
        self.outbound_chunk_bytes = max(0, int(outbound_chunk_bytes or 0))
        self.max_turns = max_turns
        self.max_seconds = max_seconds

        self.history: list[dict[str, str]] = []
        self.metrics = BridgeMetrics()
        self.speaking = False
        self.active = True
        self.closed = False
        self._generation = 0
        self._cancel = asyncio.Event()
        self._turn_lock = asyncio.Lock()
        self._started = time.monotonic()
        self._vad: Optional[VADStream] = None
        self._tasks: set[asyncio.Task] = set()

    # --- lifecycle -----------------------------------------------------
    async def start(self) -> None:
        model = SileroVADModel.load()
        self._vad = model.new_stream()
        greeting = self._greeting()
        self.history.append({"role": "assistant", "content": greeting})
        await self._speak(greeting)

    async def stop(self) -> None:
        self.closed = True
        self.active = False
        self._cancel.set()

    def _greeting(self) -> str:
        if self.persona == "nurse":
            return (
                f"Hello, this is {prompts.AGENT_NAME}, the CareSpeak AI assistant. "
                "You are speaking with the automated line, not the patient. How can I help?"
            )
        if self.persona in {"family", "family_unverified"}:
            return (
                f"Hello, this is {prompts.AGENT_NAME}, an AI assistant. "
                "I can only share information that the patient has approved. How can I help?"
            )
        if self.persona == "unknown":
            return (
                f"Hello, this is {prompts.AGENT_NAME}, an AI assistant from CareSpeak. "
                "I could not match this number to a patient record. I cannot share any "
                "patient information on this call."
            )
        name = (self.patient or {}).get("display_name", "there")
        first = str(name).split(" ")[0]
        return (
            f"Hi {first}, this is {prompts.AGENT_NAME}, your CareSpeak care assistant "
            "calling. How are you feeling today?"
        )

    # --- inbound audio -------------------------------------------------
    async def handle_media(self, payload: bytes) -> None:
        if not self.active or self.closed or self._vad is None:
            return
        ai_pcm = self.media_format.decode_to_ai(payload)
        samples = pcm16_to_float(ai_pcm)
        if samples.size == 0:
            return
        events = self._vad.feed(samples, agent_speaking=self.speaking)
        for event in events:
            if event["type"] == "speech_start":
                if event.get("barge_in"):
                    await self._barge_in()
            elif event["type"] == "speech_end":
                utterance = event.get("samples")
                if utterance is not None and utterance.size:
                    # Run the turn as a background task so the media loop keeps
                    # feeding the VAD and a barge-in can be detected mid-reply.
                    task = asyncio.create_task(self._run_turn(np.asarray(utterance, dtype=np.float32)))
                    self._tasks.add(task)
                    task.add_done_callback(self._tasks.discard)

    async def _barge_in(self) -> None:
        self._generation += 1
        self._cancel.set()
        if self.send_clear is not None:
            try:
                await self.send_clear()
            except Exception:
                pass
        self.speaking = False

    # --- turn ----------------------------------------------------------
    async def _run_turn(self, samples: np.ndarray) -> None:
        async with self._turn_lock:
            if self.closed or self.metrics.turns >= self.max_turns:
                return
            if time.monotonic() - self._started > self.max_seconds:
                return
            started = time.perf_counter()
            try:
                asr = await self.engine.asr.transcribe(samples, AI_SAMPLE_RATE)
            except Exception:
                await self._speak("I am having trouble hearing you clearly. Could you say that again?")
                return
            user_text = clean_assistant_text(str(asr.get("text") or ""))
            if asr.get("elapsed_ms"):
                self.metrics.asr_ms.append(int(asr["elapsed_ms"]))
            if not user_text:
                return
            self.history.append({"role": "user", "content": user_text})

            decision = classify(user_text)
            if decision.severity != EscalationSeverity.ROUTINE:
                await self._handle_escalation(decision, user_text)

            if self._cancel.is_set():
                self._cancel.clear()
            await self._generate_reply(started)

    async def _handle_escalation(self, decision: EscalationDecision, user_text: str) -> None:
        message = safety_message(
            decision.severity,
            emergency_number="112",
        )
        if message:
            await self._speak(message)
            self.history.append({"role": "assistant", "content": message})
        if self.on_escalation is not None:
            request = EscalationRequest(
                decision=decision,
                call_id=self.call_id,
                patient_id=self.patient_id,
                utterance=user_text,
            )
            # Fire the notification work in the background so speech is not
            # blocked on provider round-trips.
            asyncio.create_task(self._safe_escalate(request))

    async def _safe_escalate(self, request: EscalationRequest) -> None:
        try:
            assert self.on_escalation is not None
            await self.on_escalation(request)
        except Exception:
            pass

    async def _generate_reply(self, started: float) -> None:
        self._generation += 1
        generation = self._generation
        cancel = self._cancel
        cancel.clear()
        messages = self._build_messages()
        buffer = ""
        spoke_any = False
        self.speaking = True
        try:
            async for chunk in self.engine.llm.stream_chat(messages, cancel_event=cancel):
                if generation != self._generation or self.closed:
                    return
                delta = chunk.get("delta") or ""
                if not delta:
                    if chunk.get("done"):
                        break
                    continue
                buffer += delta
                sentence, buffer = _take_sentence(buffer)
                if sentence:
                    await self._speak(
                        sentence,
                        started=started if not spoke_any else None,
                    )
                    spoke_any = True
                    if cancel.is_set():
                        return
            if buffer.strip() and generation == self._generation and not self.closed:
                await self._speak(trim_for_call(buffer.strip()), started=started)
        except Exception:
            if generation == self._generation and not self.closed:
                await self._speak(
                    "I am sorry, I am having trouble answering right now. Please stay on the line "
                    "or ask your nurse to call you back.",
                    started=started,
                )
        finally:
            self.speaking = False
            if generation == self._generation:
                self.metrics.turns += 1

    def _build_messages(self) -> list[dict[str, str]]:
        system = self._system_prompt()
        messages = [{"role": "system", "content": system}]
        messages.extend(self.history[-prompts.MAX_HISTORY_MESSAGES :])
        return messages

    def _system_prompt(self) -> str:
        if self.persona == "patient":
            base = prompts.system_prompt(self.patient, self.demo_mode)
        elif self.persona == "nurse":
            base = (
                f"You are {prompts.AGENT_NAME}, an AI care communication assistant on a "
                "telephone call with a nurse. Be concise, factual and professional. "
                "Never invent patient history; only use information the nurse states or "
                "that appears in the approved record."
            )
        elif self.persona == "family":
            base = (
                f"You are {prompts.AGENT_NAME}, an AI assistant on a call with an approved "
                "family member. Share only information the patient has explicitly permitted. "
                "If unsure whether something is permitted, say you cannot share it and offer "
                "to pass a message to the care team."
            )
        else:
            base = (
                f"You are {prompts.AGENT_NAME}, an AI assistant. This caller's identity is "
                "not verified. Do not reveal any patient information. Offer to take a message "
                "for the care team."
            )
        return (
            base
            + "\n\nTelephone style: keep every reply to one or two short spoken sentences. "
            "Never claim a message or call was delivered unless it is confirmed. If the caller "
            "asks for a human, say you will pass the request to the care team. Ask exactly one "
            "clarifying question when something is unclear."
        )

    # --- speaking ------------------------------------------------------
    async def _speak(
        self, text: str, *, first_of_turn: bool = False, started: Optional[float] = None
    ) -> None:
        clean = trim_for_call(text) or clean_assistant_text(text)
        if not clean:
            return
        try:
            result = await self.engine.tts.synthesize(clean)
        except Exception:
            return
        if self.closed:
            return
        pcm, rate = wav_pcm16(result.wav)
        encoded = self.media_format.encode_from_ai(pcm, rate)
        frame_bytes = self._frame_bytes()
        bytes_per_sample = self._bytes_per_sample()
        # Round the provider's minimum chunk up to a whole number of frames so
        # every payload stays aligned with the 20 ms frame cadence.
        chunk_size = max(frame_bytes, self.outbound_chunk_bytes or frame_bytes)
        if chunk_size % frame_bytes:
            chunk_size += frame_bytes - (chunk_size % frame_bytes)
        pending = bytearray()
        first = True
        for frame in iter_frames(encoded, frame_bytes):
            if self.closed:
                return
            if self._cancel.is_set():
                return
            pending.extend(frame)
            # Carriers differ: Twilio accepts 20 ms frames, Exotel requires
            # chunks of at least 3200 bytes.  Batch up to the provider's floor.
            if len(pending) < chunk_size:
                continue
            await self.send_audio(bytes(pending))
            if first and started is not None:
                self.metrics.first_audio_ms.append(
                    int((time.perf_counter() - started) * 1000)
                )
                first = False
            # Pace playback so the carrier buffer does not overrun.
            await asyncio.sleep(len(pending) / (self.media_format.sample_rate * bytes_per_sample))
            pending.clear()
        if pending:
            if self.outbound_chunk_bytes:
                # Exotel requires the final chunk to respect the same minimum
                # size and 320-byte multiple.  Pad with codec silence.
                pad = chunk_size - len(pending)
                if pad > 0:
                    silence = b"\x00" if self.media_format.encoding == "pcm16" else b"\xff"
                    pending.extend(silence * pad)
            await self.send_audio(bytes(pending))
            if first and started is not None:
                self.metrics.first_audio_ms.append(
                    int((time.perf_counter() - started) * 1000)
                )

    def _bytes_per_sample(self) -> int:
        return 1 if self.media_format.encoding in {"mulaw", "alaw"} else 2

    def _frame_bytes(self) -> int:
        return int(self.media_format.sample_rate * self.media_format.frame_ms / 1000) * self._bytes_per_sample()


def _take_sentence(buffer: str) -> tuple[Optional[str], str]:
    parts = _SENTENCE_RE.split(buffer, maxsplit=1)
    if len(parts) == 2 and len(parts[0].strip()) >= 3:
        return parts[0].strip(), parts[1]
    if len(buffer) > 220:
        cut = buffer.rfind(" ", 0, 220)
        if cut <= 0:
            cut = 220
        return buffer[:cut].strip(), buffer[cut:]
    return None, buffer
