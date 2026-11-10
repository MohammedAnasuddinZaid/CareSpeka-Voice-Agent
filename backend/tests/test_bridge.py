"""Deep tests for the bidirectional telephony audio bridge.

The VAD, ASR, LLM and TTS engines are replaced with deterministic fakes, and the
audio codec is exercised with raw PCM so the tests do not depend on ``audioop``.
Nothing here touches a real model, a real carrier or a real call.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

from app.escalation import EscalationSeverity, classify
from app.telephony import bridge as bridge_module
from app.telephony.audio import AudioFormat
from app.telephony.bridge import (
    BridgeMetrics,
    EscalationRequest,
    TelephonyBridge,
    _take_sentence,
)

PCM_FORMAT = AudioFormat(encoding="pcm16", sample_rate=8000, frame_ms=20)


# ---------------------------------------------------------------------------
# fakes
# ---------------------------------------------------------------------------
class FakeVADStream:
    instances: list["FakeVADStream"] = []

    def __init__(self):
        self.next_events: list[dict] = []
        self.fed: list[np.ndarray] = []
        self.speaking_flags: list[bool] = []
        FakeVADStream.instances.append(self)

    def feed(self, samples, *, agent_speaking=False):
        self.fed.append(np.asarray(samples))
        self.speaking_flags.append(bool(agent_speaking))
        events, self.next_events = self.next_events, []
        return events


class FakeVADModel:
    @classmethod
    def load(cls):
        return cls()

    def new_stream(self):
        return FakeVADStream()


class FakeASR:
    def __init__(self, text="I have a headache", elapsed_ms=12):
        self.text = text
        self.elapsed_ms = elapsed_ms
        self.calls: list[tuple[np.ndarray, int]] = []

    async def transcribe(self, samples, sample_rate):
        self.calls.append((np.asarray(samples), sample_rate))
        if isinstance(self.text, Exception):
            raise self.text
        return {"text": self.text, "elapsed_ms": self.elapsed_ms}


class FakeLLM:
    def __init__(self, chunks=None):
        self.chunks = chunks if chunks is not None else ["Hello", " there.", " How", " are you?"]
        self.calls: list[list[dict]] = []
        self.cancel_events: list[object] = []
        self.hook = None

    async def stream_chat(self, messages, cancel_event=None):
        self.calls.append(messages)
        self.cancel_events.append(cancel_event)
        for index, delta in enumerate(self.chunks):
            if cancel_event is not None and cancel_event.is_set():
                return
            if self.hook is not None:
                self.hook(index, cancel_event)
            yield {"delta": delta}
        yield {"done": True}


class FakeTTS:
    def __init__(self):
        self.texts: list[str] = []

    async def synthesize(self, text):
        self.texts.append(text)
        return SimpleNamespace(wav=b"RIFF-fake")


class FakeEngine:
    def __init__(self, asr=None, llm=None, tts=None):
        self.asr = asr or FakeASR()
        self.llm = llm or FakeLLM()
        self.tts = tts or FakeTTS()


@pytest.fixture(autouse=True)
def _fake_audio(monkeypatch):
    FakeVADStream.instances = []
    monkeypatch.setattr(bridge_module, "SileroVADModel", FakeVADModel)
    # Every synthesis returns exactly one 20 ms frame of PCM at 8 kHz.
    monkeypatch.setattr(
        bridge_module,
        "wav_pcm16",
        lambda wav: (np.zeros(160, dtype="<i2").tobytes(), 8000),
    )


def make_bridge(engine=None, **overrides):
    sent: list[bytes] = []
    cleared: list[bool] = []

    async def send_audio(pcm):
        sent.append(pcm)

    async def send_clear():
        cleared.append(True)

    kwargs = dict(
        engine=engine or FakeEngine(),
        media_format=PCM_FORMAT,
        send_audio=send_audio,
        send_clear=send_clear,
        call_id="tcall_1",
        patient={"display_name": "Asha Rao"},
        patient_id=1,
        persona="patient",
        demo_mode=True,
    )
    kwargs.update(overrides)
    bridge = TelephonyBridge(**kwargs)
    return bridge, sent, cleared


def run(coro):
    return asyncio.run(coro)


def utterance(n=320):
    return np.zeros(n, dtype=np.float32)


# ---------------------------------------------------------------------------
# metrics and sentence segmentation
# ---------------------------------------------------------------------------
def test_metrics_snapshot_averages_and_empty_case():
    metrics = BridgeMetrics()
    assert metrics.snapshot() == {
        "turns": 0, "avg_first_audio_ms": None, "avg_asr_ms": None,
    }
    metrics.turns = 2
    metrics.first_audio_ms = [100, 300]
    metrics.asr_ms = [10, 30]
    assert metrics.snapshot() == {
        "turns": 2, "avg_first_audio_ms": 200, "avg_asr_ms": 20,
    }


def test_take_sentence_splits_on_boundaries():
    sentence, rest = _take_sentence("Hello there. How are you?")
    assert sentence == "Hello there."
    assert rest == "How are you?"

    # Fragments shorter than three characters are not spoken on their own.
    sentence, rest = _take_sentence("A. How are you?")
    assert sentence is None
    assert rest == "A. How are you?"


def test_take_sentence_breaks_long_text_at_a_word_boundary():
    text = "word " * 60  # 300 characters, no punctuation
    sentence, rest = _take_sentence(text)
    assert sentence is not None
    assert len(sentence) <= 220
    assert sentence.startswith("word")
    assert sentence.endswith("word")
    assert rest.strip().startswith("word")
    # Nothing is lost between the two halves beyond the boundary whitespace.
    assert (sentence + rest).replace(" ", "") == text.replace(" ", "")


def test_take_sentence_handles_an_unbreakable_long_token():
    text = "x" * 240
    sentence, rest = _take_sentence(text)
    assert sentence == "x" * 220
    assert rest == "x" * 20


def test_take_sentence_keeps_short_text_buffered():
    assert _take_sentence("Still speaking") == (None, "Still speaking")


# ---------------------------------------------------------------------------
# greetings and personas
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "persona,expected",
    [
        ("patient", "Hi Asha"),
        ("nurse", "speaking with the automated line"),
        ("family", "information that the patient has approved"),
        ("family_unverified", "information that the patient has approved"),
        ("unknown", "could not match this number"),
    ],
)
def test_greeting_matches_the_persona(persona, expected):
    bridge, _, _ = make_bridge(persona=persona)
    assert expected in bridge._greeting()


def test_patient_greeting_falls_back_when_no_name_is_known():
    bridge, _, _ = make_bridge(patient=None)
    assert "Hi there" in bridge._greeting()


def test_start_stores_the_greeting_and_sends_audio():
    bridge, sent, _ = make_bridge()
    run(bridge.start())
    assert bridge.history == [{"role": "assistant", "content": bridge._greeting()}]
    assert sent and all(isinstance(chunk, bytes) for chunk in sent)
    assert len(FakeVADStream.instances) == 1


# ---------------------------------------------------------------------------
# inbound audio and turns
# ---------------------------------------------------------------------------
def test_handle_media_is_ignored_before_start_and_after_stop():
    bridge, _, _ = make_bridge()
    frame = np.zeros(160, dtype="<i2").tobytes()

    run(bridge.handle_media(frame))  # no VAD yet
    assert FakeVADStream.instances == []

    run(bridge.start())
    vad = FakeVADStream.instances[0]
    run(bridge.handle_media(b""))  # empty payloads are dropped
    assert vad.fed == []

    run(bridge.handle_media(frame))
    assert len(vad.fed) == 1
    # 8 kHz -> 16 kHz, so a 20 ms frame doubles in length.
    assert vad.fed[0].size == 320

    run(bridge.stop())
    run(bridge.handle_media(frame))
    assert len(vad.fed) == 1


def test_speech_end_runs_a_complete_turn():
    engine = FakeEngine(asr=FakeASR("I have a headache", elapsed_ms=42))
    bridge, sent, _ = make_bridge(engine)
    run(bridge.start())
    sent.clear()

    async def drive():
        FakeVADStream.instances[0].next_events = [
            {"type": "speech_end", "samples": utterance()}
        ]
        await bridge.handle_media(np.zeros(160, dtype="<i2").tobytes())
        await asyncio.gather(*list(bridge._tasks))

    run(drive())
    assert engine.asr.calls and engine.asr.calls[0][1] == 16000
    assert {"role": "user", "content": "I have a headache"} in bridge.history
    assert bridge.metrics.turns == 1
    assert bridge.metrics.asr_ms == [42]
    assert sent, "the reply must be spoken"
    # The system prompt is first and includes the patient name.
    system = engine.llm.calls[0][0]
    assert system["role"] == "system"
    assert "Asha" in system["content"]


def test_empty_transcript_is_ignored():
    engine = FakeEngine(asr=FakeASR("   "))
    bridge, sent, _ = make_bridge(engine)
    run(bridge.start())

    async def drive():
        FakeVADStream.instances[0].next_events = [
            {"type": "speech_end", "samples": utterance()}
        ]
        await bridge.handle_media(np.zeros(160, dtype="<i2").tobytes())
        await asyncio.gather(*list(bridge._tasks))

    run(drive())
    assert engine.llm.calls == []
    assert bridge.metrics.turns == 0


def test_asr_failure_speaks_an_apology():
    engine = FakeEngine(asr=FakeASR(RuntimeError("whisper crashed")))
    bridge, sent, _ = make_bridge(engine)
    run(bridge.start())
    sent.clear()

    async def drive():
        FakeVADStream.instances[0].next_events = [
            {"type": "speech_end", "samples": utterance()}
        ]
        await bridge.handle_media(np.zeros(160, dtype="<i2").tobytes())
        await asyncio.gather(*list(bridge._tasks))

    run(drive())
    assert engine.tts.texts[-1].startswith("I am having trouble hearing you")
    assert sent


def test_barge_in_cancels_the_reply_and_clears_playback():
    engine = FakeEngine()
    bridge, sent, cleared = make_bridge(engine)
    run(bridge.start())
    cleared.clear()

    async def drive():
        FakeVADStream.instances[0].next_events = [
            {"type": "speech_start", "barge_in": True}
        ]
        await bridge.handle_media(np.zeros(160, dtype="<i2").tobytes())

    generation = bridge._generation
    run(drive())
    assert cleared == [True]
    assert bridge._cancel.is_set() is True
    assert bridge.speaking is False
    assert bridge._generation == generation + 1


def test_no_barge_in_flag_does_not_clear_playback():
    bridge, _, cleared = make_bridge()
    run(bridge.start())
    cleared.clear()

    async def drive():
        FakeVADStream.instances[0].next_events = [{"type": "speech_start"}]
        await bridge.handle_media(np.zeros(160, dtype="<i2").tobytes())

    run(drive())
    assert cleared == []
    assert bridge._cancel.is_set() is False


def test_llm_cancellation_stops_the_reply():
    llm = FakeLLM(chunks=["First sentence.", "Second sentence.", "Third sentence."])
    engine = FakeEngine(llm=llm)
    bridge, sent, _ = make_bridge(engine)
    run(bridge.start())
    sent.clear()

    def hook(index, cancel_event):
        if index == 0:
            cancel_event.set()

    llm.hook = hook
    run(bridge._run_turn(utterance()))
    # Nothing is played once the turn is cancelled...
    assert sent == []
    # ...and the remaining sentences are never generated.
    assert "Second sentence." not in engine.tts.texts
    assert "Third sentence." not in engine.tts.texts


def test_llm_failure_speaks_a_safe_fallback():
    class BrokenLLM:
        async def stream_chat(self, messages, cancel_event=None):
            raise RuntimeError("ollama down")
            yield  # pragma: no cover

    engine = FakeEngine(llm=BrokenLLM())
    bridge, sent, _ = make_bridge(engine)
    run(bridge.start())
    sent.clear()
    run(bridge._run_turn(utterance()))
    assert engine.tts.texts[-1].startswith("I am sorry, I am having trouble answering")
    assert sent


def test_turn_limits_are_enforced():
    bridge, sent, _ = make_bridge()
    bridge.max_turns = 1
    run(bridge.start())
    run(bridge._run_turn(utterance()))
    assert bridge.metrics.turns == 1
    sent.clear()
    run(bridge._run_turn(utterance()))
    assert sent == []

    expired, _, _ = make_bridge()
    expired._started -= 10_000
    expired.max_seconds = 60
    run(expired._run_turn(utterance()))
    assert expired.metrics.turns == 0


def test_stop_marks_the_bridge_closed():
    bridge, _, _ = make_bridge()
    run(bridge.stop())
    assert bridge.closed is True
    assert bridge.active is False
    assert bridge._cancel.is_set() is True


# ---------------------------------------------------------------------------
# escalation hooks
# ---------------------------------------------------------------------------
def test_emergency_turn_alerts_and_speaks_the_safety_message():
    engine = FakeEngine(asr=FakeASR("I have crushing chest pain"))
    seen: list[EscalationRequest] = []

    async def on_escalation(request):
        seen.append(request)
        return "ok"

    bridge, sent, _ = make_bridge(engine, on_escalation=on_escalation)
    run(bridge.start())
    sent.clear()

    async def drive():
        await bridge._run_turn(utterance())
        # The notification itself runs in the background: let it finish.
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    run(drive())
    assert seen and seen[0].decision.severity == EscalationSeverity.EMERGENCY
    assert seen[0].call_id == "tcall_1"
    assert seen[0].patient_id == 1
    assert seen[0].utterance == "I have crushing chest pain"
    assert any("medical emergency" in text for text in engine.tts.texts)
    assert any("112" in text for text in engine.tts.texts)
    assert sent


def test_escalation_hook_errors_are_swallowed():
    engine = FakeEngine(asr=FakeASR("I have crushing chest pain"))

    async def on_escalation(request):
        raise RuntimeError("provider down")

    bridge, _, _ = make_bridge(engine, on_escalation=on_escalation)
    run(bridge.start())

    async def drive():
        await bridge._handle_escalation(classify("I have crushing chest pain"), "I have crushing chest pain")
        # The background notification raises, but the call must survive it.
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    run(drive())
    assert bridge.closed is False
    assert bridge.active is True


def test_routine_turn_does_not_escalate():
    engine = FakeEngine(asr=FakeASR("I am feeling okay today"))
    seen: list[EscalationRequest] = []

    async def on_escalation(request):
        seen.append(request)

    bridge, _, _ = make_bridge(engine, on_escalation=on_escalation)
    run(bridge.start())
    run(bridge._run_turn(utterance()))
    assert seen == []


# ---------------------------------------------------------------------------
# system prompts
# ---------------------------------------------------------------------------
def test_system_prompt_is_persona_specific():
    patient, _, _ = make_bridge(persona="patient")
    nurse, _, _ = make_bridge(persona="nurse")
    family, _, _ = make_bridge(persona="family")
    unknown, _, _ = make_bridge(persona="unknown")
    assert "Asha" in patient._system_prompt()
    assert "telephone call with a nurse" in nurse._system_prompt()
    assert "approved family member" in family._system_prompt()
    assert "identity is not verified" in unknown._system_prompt()
    for bridge in (patient, nurse, family, unknown):
        assert "one or two short spoken sentences" in bridge._system_prompt()


def test_build_messages_trims_the_history():
    bridge, _, _ = make_bridge()
    for index in range(60):
        bridge.history.append({"role": "user", "content": f"message {index}"})
    messages = bridge._build_messages()
    assert messages[0]["role"] == "system"
    assert len(messages) == 1 + bridge_module.prompts.MAX_HISTORY_MESSAGES
    assert messages[-1]["content"] == "message 59"


# ---------------------------------------------------------------------------
# outbound chunking
# ---------------------------------------------------------------------------
def test_small_chunks_are_sent_frame_by_frame():
    bridge, sent, _ = make_bridge()
    run(bridge._speak("Hello there."))
    assert len(sent) == 1
    assert len(sent[0]) == 320  # one 20 ms PCM16 frame at 8 kHz


def test_exotel_minimum_chunks_are_batched_and_padded():
    bridge, sent, _ = make_bridge(outbound_chunk_bytes=3200)

    async def speak_long():
        # 400 ms of audio at 8 kHz is 6400 bytes -> two 3200-byte chunks.
        await bridge._speak("Long reply.")

    original = bridge_module.wav_pcm16
    bridge_module.wav_pcm16 = lambda wav: (np.zeros(3200, dtype="<i2").tobytes(), 8000)
    try:
        run(speak_long())
    finally:
        bridge_module.wav_pcm16 = original
    assert sent and all(len(chunk) == 3200 for chunk in sent[:-1])
    # The final chunk also respects the carrier minimum.
    assert len(sent[-1]) == 3200


def test_speak_records_first_audio_latency():
    bridge, sent, _ = make_bridge()
    import time

    run(bridge._speak("Hello.", started=time.perf_counter() - 0.05))
    assert bridge.metrics.first_audio_ms
    assert bridge.metrics.first_audio_ms[0] >= 0


def test_speak_ignores_empty_text_and_tts_failures():
    bridge, sent, _ = make_bridge()
    run(bridge._speak("   "))
    assert sent == []

    class BrokenTTS:
        async def synthesize(self, text):
            raise RuntimeError("tts down")

    broken, broken_sent, _ = make_bridge(FakeEngine(tts=BrokenTTS()))
    run(broken._speak("Hello."))
    assert broken_sent == []