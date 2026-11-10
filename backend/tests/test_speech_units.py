"""Deep tests for the speech pipeline units (whisper.cpp client and sherpa TTS).

Pure helpers are tested directly; the HTTP client is pinned with
``httpx.MockTransport``; the sherpa engine is replaced with a fake that returns
deterministic samples.  No model file, server or audio device is required.
"""
from __future__ import annotations

import asyncio
import functools
import io
import wave
from pathlib import Path
from types import SimpleNamespace

import httpx
import numpy as np
import pytest

from app import asr as asr_module
from app import tts as tts_module
from app.asr import (
    SAMPLE_RATE,
    WhisperASR,
    clean_transcript,
    resample_linear,
    wav_bytes_from_float,
)
from app.tts import (
    SherpaTTS,
    StreamingTTSChunker,
    TTSResult,
    normalize_for_speech,
    split_sentences,
)


def async_test(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))

    return wrapper


def read_wav(data: bytes) -> tuple[int, int, int, int]:
    with wave.open(io.BytesIO(data), "rb") as handle:
        return (
            handle.getnchannels(),
            handle.getsampwidth(),
            handle.getframerate(),
            handle.getnframes(),
        )


# ---------------------------------------------------------------------------
# ASR helpers
# ---------------------------------------------------------------------------
def test_wav_bytes_are_mono_16_bit_pcm():
    samples = np.array([0.0, 0.5, -0.5], dtype=np.float32)
    wav = wav_bytes_from_float(samples, sample_rate=16000)
    assert wav[:4] == b"RIFF"
    assert read_wav(wav) == (1, 2, 16000, 3)


def test_wav_bytes_clip_out_of_range_samples():
    samples = np.array([2.0, -2.0], dtype=np.float32)
    wav = wav_bytes_from_float(samples)
    with wave.open(io.BytesIO(wav), "rb") as handle:
        pcm = np.frombuffer(handle.readframes(2), dtype="<i2")
    assert pcm.tolist() == [32767, -32767]


def test_resample_is_identity_at_the_same_rate():
    samples = np.arange(10, dtype=np.float32)
    result = resample_linear(samples, 16000, 16000)
    assert np.array_equal(result, samples)


def test_resample_handles_empty_audio():
    result = resample_linear(np.array([], dtype=np.float32), 8000, 16000)
    assert result.size == 0


def test_resample_doubles_and_halves_the_sample_count():
    source = np.linspace(0.0, 1.0, 800, dtype=np.float32)
    upsampled = resample_linear(source, 8000, 16000)
    assert upsampled.size == 1600
    assert upsampled.dtype == np.float32
    downsampled = resample_linear(upsampled, 16000, 8000)
    assert downsampled.size == 800


def test_clean_transcript_removes_whisper_annotations():
    assert clean_transcript("[BLANK_AUDIO]") == ""
    assert clean_transcript("(silence)") == ""
    assert clean_transcript("[Music] hello [Inaudible] there") == "hello there"
    assert clean_transcript("Take   your\n tablets.") == "Take your tablets."
    assert clean_transcript("...") == ""
    assert clean_transcript("") == ""


# ---------------------------------------------------------------------------
# ASR model readiness and transcription
# ---------------------------------------------------------------------------
def test_model_ready_requires_a_real_file(tmp_path: Path):
    asr = WhisperASR()
    asr.model = tmp_path / "model.bin"
    assert asr.model_ready is False
    asr.model.write_bytes(b"x" * 1_000_000)
    assert asr.model_ready is False  # exactly 1 MB is still too small
    asr.model.write_bytes(b"x" * 1_000_001)
    assert asr.model_ready is True


@async_test
async def test_transcribe_rejects_audio_shorter_than_150_ms(monkeypatch):
    asr = WhisperASR()

    async def never_called():
        raise AssertionError("the server must not be contacted")

    monkeypatch.setattr(asr, "ensure_running", never_called)
    result = await asr.transcribe(np.zeros(1000, dtype=np.float32))
    assert result["text"] == ""
    assert result["reason"] == "too_short"
    assert result["elapsed_ms"] >= 0


@async_test
async def test_transcribe_reports_an_unavailable_server(monkeypatch):
    asr = WhisperASR()
    asr._last_error = "whisper is down"

    async def unavailable():
        return False

    monkeypatch.setattr(asr, "ensure_running", unavailable)
    with pytest.raises(RuntimeError) as exc:
        await asr.transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
    assert "whisper is down" in str(exc.value)


def _install_http(monkeypatch, handler):
    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)


@async_test
async def test_transcribe_returns_clean_text(monkeypatch):
    asr = WhisperASR()
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"text": "Hello [BLANK_AUDIO] there"})

    async def ready():
        return True

    monkeypatch.setattr(asr, "ensure_running", ready)
    _install_http(monkeypatch, handler)
    result = await asr.transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
    assert result["text"] == "Hello there"
    assert result["reason"] == "ok"
    assert result["bytes"] > 44
    assert seen[0].url.path == "/inference"
    assert b"utterance.wav" in seen[0].content


@async_test
async def test_transcribe_marks_annotations_as_no_speech(monkeypatch):
    asr = WhisperASR()

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "[BLANK_AUDIO]"})

    async def ready():
        return True

    monkeypatch.setattr(asr, "ensure_running", ready)
    _install_http(monkeypatch, handler)
    result = await asr.transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
    assert result["text"] == ""
    assert result["reason"] == "no_speech"


@async_test
async def test_transcribe_surfaces_http_errors(monkeypatch):
    asr = WhisperASR()

    async def ready():
        return True

    monkeypatch.setattr(asr, "ensure_running", ready)

    async def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="model loading")

    _install_http(monkeypatch, failing)
    with pytest.raises(RuntimeError) as exc:
        await asr.transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
    assert "503" in str(exc.value) and "model loading" in str(exc.value)


@async_test
async def test_transcribe_surfaces_transport_errors(monkeypatch):
    asr = WhisperASR()

    async def ready():
        return True

    monkeypatch.setattr(asr, "ensure_running", ready)

    async def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    _install_http(monkeypatch, broken)
    with pytest.raises(RuntimeError) as exc:
        await asr.transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
    assert "request failed" in str(exc.value)


# ---------------------------------------------------------------------------
# ASR server health
# ---------------------------------------------------------------------------
@async_test
async def test_server_health_is_false_without_a_model(tmp_path: Path, monkeypatch):
    asr = WhisperASR()
    asr.model = tmp_path / "missing.bin"

    async def never(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request expected")

    _install_http(monkeypatch, never)
    assert await asr.server_healthy(refresh=True) is False


@async_test
async def test_server_health_checks_the_endpoint_and_caches(tmp_path: Path, monkeypatch):
    asr = WhisperASR()
    asr.model = tmp_path / "model.bin"
    asr.model.write_bytes(b"x" * 2_000_000)
    hits = {"n": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        hits["n"] += 1
        return httpx.Response(200, text="ok")

    _install_http(monkeypatch, handler)
    assert await asr.server_healthy() is True
    assert await asr.server_healthy() is True  # cached
    assert hits["n"] == 1
    assert await asr.server_healthy(refresh=True) is True
    assert hits["n"] == 2


@async_test
async def test_server_health_maps_failures_to_false(tmp_path: Path, monkeypatch):
    asr = WhisperASR()
    asr.model = tmp_path / "model.bin"
    asr.model.write_bytes(b"x" * 2_000_000)

    async def not_ok(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    _install_http(monkeypatch, not_ok)
    assert await asr.server_healthy(refresh=True) is False

    async def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    _install_http(monkeypatch, boom)
    assert await asr.server_healthy(refresh=True) is False


# ---------------------------------------------------------------------------
# ASR auto-start
# ---------------------------------------------------------------------------
@async_test
async def test_ensure_running_returns_true_when_already_healthy(monkeypatch):
    asr = WhisperASR()

    async def healthy(refresh=False):
        return True

    monkeypatch.setattr(asr, "server_healthy", healthy)

    async def no_spawn():
        raise AssertionError("must not spawn")

    monkeypatch.setattr(asr, "_spawn", no_spawn)
    assert await asr.ensure_running() is True


@async_test
async def test_ensure_running_respects_disabled_auto_start(monkeypatch):
    asr = WhisperASR()

    async def unhealthy(refresh=False):
        return False

    monkeypatch.setattr(asr, "server_healthy", unhealthy)
    monkeypatch.setattr(
        asr_module, "settings",
        SimpleNamespace(whisper_auto_start=False),
    )
    assert await asr.ensure_running() is False
    assert "WHISPER_AUTO_START" in asr._last_error


@async_test
async def test_ensure_running_reports_a_spawn_failure(monkeypatch):
    asr = WhisperASR()

    async def unhealthy(refresh=False):
        return False

    def broken_spawn():
        raise FileNotFoundError("whisper-server binary not found: nope")

    monkeypatch.setattr(asr, "server_healthy", unhealthy)
    monkeypatch.setattr(asr, "_spawn", broken_spawn)
    monkeypatch.setattr(asr_module, "settings", SimpleNamespace(whisper_auto_start=True))
    assert await asr.ensure_running() is False
    assert "binary not found" in asr._last_error


@async_test
async def test_ensure_running_waits_for_a_spawned_server(monkeypatch):
    asr = WhisperASR()
    calls = {"n": 0}

    async def eventually(refresh=False):
        calls["n"] += 1
        return calls["n"] >= 2

    monkeypatch.setattr(asr, "server_healthy", eventually)
    monkeypatch.setattr(asr, "_spawn", lambda: setattr(asr, "_spawned", True))
    monkeypatch.setattr(asr_module, "settings", SimpleNamespace(whisper_auto_start=True))
    assert await asr.ensure_running() is True
    assert asr._last_error is None


@async_test
async def test_shutdown_closes_the_client_and_process(tmp_path: Path, monkeypatch):
    asr = WhisperASR()
    closed = {"client": False}

    class FakeClient:
        async def aclose(self):
            closed["client"] = True

    class FakeProcess:
        def __init__(self):
            self.terminated = False

        def poll(self):
            return None

        def terminate(self):
            self.terminated = True

        def wait(self, timeout=None):
            return 0

    asr._client = FakeClient()
    asr._process = FakeProcess()
    asr._spawned = True
    asr._log_handle = io.BytesIO()
    pid = tmp_path / "whisper.pid"
    pid.write_text("123", encoding="ascii")
    monkeypatch.setattr(
        asr_module, "settings",
        SimpleNamespace(whisper_pid_path=pid),
    )

    await asr.shutdown()
    assert closed["client"] is True
    assert asr._client is None
    assert asr._process.terminated is True
    assert pid.exists() is False
    assert asr._log_handle is None


def test_health_reports_paths_and_state(tmp_path: Path):
    asr = WhisperASR()
    asr.model = tmp_path / "model.bin"
    asr.binary = tmp_path / "whisper-server.exe"
    health = asr.health()
    assert health["model_exists"] is False
    assert health["binary_exists"] is False
    assert health["backend"] in {"cpu", "cuda"}
    assert health["spawned_by_app"] is False
    assert health["running"] is False


# ---------------------------------------------------------------------------
# TTS text normalisation
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "spoken,expected",
    [
        ("CareSpeak is calling", "Care Speak is calling."),
        ("VoiceLink demo", "Voice Link demo."),
        ("Extension CS-1234", "Extension C S 1 2 3 4."),
        ("Call 112 now", "Call one one two now."),
        ("Dial 1-1-2", "Dial one one two."),
        ("Your BP is fine", "Your blood pressure is fine."),
        ("Go to the ER", "Go to the emergency room."),
        ("The AI assistant", "The A I assistant."),
        ("Dr. Rao", "Doctor Rao."),
        ("Mr. and Mrs. Rao", "Mister and Missus Rao."),
        ("Your appt. is at 5", "Your appointment is at 5."),
        ("Take your meds.", "Take your medicines."),
        ("Wait 10 min.", "Wait 10 minutes."),
        ("In an hr.", "In an hour."),
        ("Salt & pepper", "Salt and pepper."),
        ("Call +91", "Call plus 91."),
        ("Mail care@example", "Mail care at example."),
        ("Yes/no", "Yes or no."),
        ("(softly) Hello", "Hello."),
        ("Hello!", "Hello!"),
        ("", ""),
    ],
)
def test_normalize_for_speech_expands_tokens(spoken, expected):
    assert normalize_for_speech(spoken) == expected


def test_normalize_for_speech_collapses_whitespace():
    assert normalize_for_speech("  Take   your   tablets  ") == "Take your tablets."


# ---------------------------------------------------------------------------
# TTS sentence splitting
# ---------------------------------------------------------------------------
def test_split_sentences_keeps_punctuation():
    assert split_sentences("One. Two! Three?") == ["One.", "Two!", "Three?"]


def test_split_sentences_does_not_break_abbreviations():
    assert split_sentences("Dr. Rao is here. Hello.") == ["Dr. Rao is here.", "Hello."]


def test_split_sentences_appends_the_unpunctuated_tail():
    assert split_sentences("Hello. World") == ["Hello.", "World"]
    assert split_sentences("   ") == []


# ---------------------------------------------------------------------------
# Streaming chunker
# ---------------------------------------------------------------------------
def test_chunker_emits_a_complete_sentence():
    chunker = StreamingTTSChunker(max_chars=220, min_chars=8)
    # A boundary is only known once the following whitespace arrives.
    assert chunker.push("Hello there.") == []
    assert chunker.push(" And") == ["Hello there."]
    assert chunker.buffer == "And"


def test_chunker_waits_for_more_text():
    chunker = StreamingTTSChunker(max_chars=220, min_chars=8)
    assert chunker.push("Hello ") == []
    assert chunker.push("there") == []
    assert chunker.push(". How") == ["Hello there."]
    assert chunker.flush() == ["How"]


def test_chunker_does_not_split_an_abbreviation():
    chunker = StreamingTTSChunker(max_chars=220, min_chars=8)
    assert chunker.push("Call Dr. Rao. He is here.") == []
    assert chunker.flush() == ["Call Dr. Rao. He is here."]


def test_chunker_breaks_long_text_at_a_comma():
    chunker = StreamingTTSChunker(max_chars=20, min_chars=5)
    assert chunker.push("Alpha beta gamma, delta epsilon zeta") == ["Alpha beta gamma"]
    assert chunker.flush() == ["delta epsilon zeta"]


def test_chunker_breaks_long_text_at_a_space():
    chunker = StreamingTTSChunker(max_chars=20, min_chars=5)
    assert chunker.push("one two three four five six") == ["one two three four"]
    assert chunker.flush() == ["five six"]


def test_chunker_flush_returns_nothing_when_empty():
    assert StreamingTTSChunker().flush() == []


def test_chunker_flush_splits_a_long_remainder():
    chunker = StreamingTTSChunker(max_chars=20, min_chars=5)
    ready = chunker.push("First sentence. " + "word " * 30)
    assert ready and ready[0] == "First sentence."
    remainder = chunker.flush()
    assert remainder
    assert all("word" in part or "sentence" in part for part in remainder)


# ---------------------------------------------------------------------------
# Sherpa TTS
# ---------------------------------------------------------------------------
def tts_settings(tmp_path: Path, **overrides):
    base = dict(
        engine_is_sherpa=True,
        tts_engine="sherpa",
        sherpa_model_path=tmp_path / "vits.onnx",
        sherpa_lexicon_path=tmp_path / "lexicon.txt",
        sherpa_tokens_path=tmp_path / "tokens.txt",
        tts_threads=2,
        tts_speed=1.0,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def make_files(tmp_path: Path) -> None:
    (tmp_path / "vits.onnx").write_bytes(b"model")
    (tmp_path / "lexicon.txt").write_text("lexicon", encoding="utf-8")
    (tmp_path / "tokens.txt").write_text("tokens", encoding="utf-8")


def test_files_ready_requires_every_asset(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tts_module, "settings", tts_settings(tmp_path))
    tts = SherpaTTS()
    assert tts.files_ready is False
    make_files(tmp_path)
    assert tts.files_ready is True
    (tmp_path / "lexicon.txt").unlink()
    assert tts.files_ready is False


def test_files_ready_is_false_for_a_non_sherpa_engine(tmp_path: Path, monkeypatch):
    make_files(tmp_path)
    monkeypatch.setattr(
        tts_module, "settings", tts_settings(tmp_path, engine_is_sherpa=False)
    )
    assert SherpaTTS().files_ready is False


def test_load_sync_rejects_a_non_sherpa_engine(tmp_path: Path, monkeypatch):
    make_files(tmp_path)
    monkeypatch.setattr(
        tts_module, "settings", tts_settings(tmp_path, tts_engine="kokoro")
    )
    with pytest.raises(RuntimeError) as exc:
        SherpaTTS()._load_sync()
    assert "TTS_ENGINE='kokoro'" in str(exc.value) or "kokoro" in str(exc.value)


def test_load_sync_requires_the_bundled_files(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tts_module, "settings", tts_settings(tmp_path))
    with pytest.raises(FileNotFoundError) as exc:
        SherpaTTS()._load_sync()
    assert "VITS files are missing" in str(exc.value)


def test_synthesize_sync_requires_a_loaded_engine():
    tts = SherpaTTS()
    with pytest.raises(RuntimeError) as exc:
        tts._synthesize_sync("Hello")
    assert "not loaded" in str(exc.value)


def test_synthesize_sync_produces_a_valid_wav(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tts_module, "settings", tts_settings(tmp_path))
    samples = np.array([0.0, 0.5, -1.0], dtype=np.float32)

    class FakeAudio:
        samples = np.array([0.0, 0.5, -1.0], dtype=np.float32)
        sample_rate = 22050

    class FakeEngine:
        sample_rate = 22050

        def generate(self, text, sid=0, speed=1.0):
            return FakeAudio()

    tts = SherpaTTS()
    tts.engine = FakeEngine()
    result = tts._synthesize_sync("CareSpeak says hi")
    assert isinstance(result, TTSResult)
    assert result.text == "Care Speak says hi."
    assert result.sample_rate == 22050
    assert result.duration_s == pytest.approx(3 / 22050)
    assert result.gen_ms >= 0
    assert read_wav(result.wav) == (1, 2, 22050, 3)


def test_synthesize_sync_rejects_empty_audio(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tts_module, "settings", tts_settings(tmp_path))

    class EmptyAudio:
        samples = np.array([], dtype=np.float32)
        sample_rate = 22050

    class FakeEngine:
        sample_rate = 22050

        def generate(self, text, sid=0, speed=1.0):
            return EmptyAudio()

    tts = SherpaTTS()
    tts.engine = FakeEngine()
    with pytest.raises(RuntimeError) as exc:
        tts._synthesize_sync("Hello")
    assert "empty audio" in str(exc.value)


@async_test
async def test_synthesize_loads_once_and_returns_audio(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tts_module, "settings", tts_settings(tmp_path))
    tts = SherpaTTS()
    tts.engine = object()
    expected = TTSResult(wav=b"RIFF", sample_rate=22050, duration_s=0.1, gen_ms=1, text="Hi.")
    tts._synthesize_sync = lambda text: expected
    assert await tts.synthesize("Hi") is expected


@async_test
async def test_synthesize_raises_when_the_engine_cannot_load(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tts_module, "settings", tts_settings(tmp_path))
    tts = SherpaTTS()
    tts._error = "files missing"

    async def failing_load():
        return False

    tts.load = failing_load
    with pytest.raises(RuntimeError) as exc:
        await tts.synthesize("Hello")
    assert "files missing" in str(exc.value)


@async_test
async def test_synthesize_reports_a_blank_utterance(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tts_module, "settings", tts_settings(tmp_path))

    class FakeAudio:
        samples = np.array([0.1], dtype=np.float32)
        sample_rate = 22050

    class FakeEngine:
        sample_rate = 22050

        def generate(self, text, sid=0, speed=1.0):
            return FakeAudio()

    tts = SherpaTTS()
    tts.engine = FakeEngine()
    with pytest.raises(ValueError) as exc:
        await tts.synthesize("   ")
    assert "Nothing to speak" in str(exc.value)


def test_health_and_shutdown(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tts_module, "settings", tts_settings(tmp_path))
    make_files(tmp_path)
    tts = SherpaTTS()
    health = tts.health()
    assert health["files_ready"] is True
    assert health["loaded"] is False
    assert health["threads"] == 2
    assert "sherpa-onnx VITS" in health["engine"]

    tts.engine = object()
    then = tts.health()
    assert then["loaded"] is True


@async_test
async def test_shutdown_unloads_the_engine():
    tts = SherpaTTS()
    tts.engine = object()
    await tts.shutdown()
    assert tts.engine is None