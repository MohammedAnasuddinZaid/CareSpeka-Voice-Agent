"""Deep tests for streaming VAD segmentation and the push-to-talk fallback.

The Silero ONNX session is replaced with a scripted fake, so the probability
sequence (and therefore every boundary) is deterministic and no model file is
needed.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import List

import numpy as np
import pytest

from app import vad as vad_module
from app.vad import (
    CHUNK_MS,
    CHUNK_SAMPLES,
    SAMPLE_RATE,
    PushToTalkBuffer,
    SileroVADModel,
    VADStream,
)


class FakeSession:
    """Pops one probability per inference call and echoes the recurrent state."""

    def __init__(self, probs: List[float]) -> None:
        self.probs = list(probs)
        self.calls: list[dict] = []

    def run(self, output_names, feeds):
        self.calls.append(feeds)
        prob = self.probs.pop(0) if self.probs else 0.0
        return np.array([prob], dtype=np.float32), feeds["state"]


def stream(probs, **overrides) -> tuple[VADStream, FakeSession]:
    session = FakeSession(probs)
    model = SimpleNamespace(session=session)
    options = dict(
        threshold=0.5,
        silence_ms=100,
        min_speech_ms=32,
        barge_in_ms=48,
        preroll_ms=32,
        max_utterance_ms=1000,
    )
    options.update(overrides)
    return VADStream(model, **options), session


def chunk(value: float = 0.0) -> np.ndarray:
    return np.full(CHUNK_SAMPLES, value, dtype=np.float32)


# ---------------------------------------------------------------------------
# construction and buffering
# ---------------------------------------------------------------------------
def test_explicit_options_override_settings():
    vad, _ = stream([], threshold=0.2, silence_ms=300, min_speech_ms=100,
                    barge_in_ms=200, preroll_ms=160, max_utterance_ms=9000)
    assert vad.threshold == 0.2
    assert vad.silence_ms == 300
    assert vad.min_speech_ms == 100
    assert vad.barge_in_ms == 200
    assert vad.preroll_ms == 160
    assert vad.max_utterance_ms == 9000
    # 160 ms of preroll is ten 16 ms chunks.
    assert vad._preroll_chunks == 10


def test_partial_frames_are_buffered_until_a_whole_chunk_arrives():
    vad, session = stream([0.9])
    assert vad.feed(np.zeros(100, dtype=np.float32)) == []
    assert session.calls == []
    assert vad.feed(np.zeros(CHUNK_SAMPLES - 100, dtype=np.float32)) == []
    assert len(session.calls) == 1
    feeds = session.calls[0]
    assert feeds["input"].shape == (1, CHUNK_SAMPLES)
    assert feeds["input"].dtype == np.float32
    assert int(feeds["sr"]) == SAMPLE_RATE
    assert vad.last_probability == pytest.approx(0.9)


def test_feed_accepts_plain_lists_and_leftover_samples_are_kept():
    vad, session = stream([0.9, 0.9])
    vad.feed([0.0] * (CHUNK_SAMPLES + 10))
    assert len(session.calls) == 1
    assert vad._pending.size == 10


# ---------------------------------------------------------------------------
# speech start
# ---------------------------------------------------------------------------
def test_two_voiced_chunks_start_speech():
    vad, _ = stream([0.9, 0.9])
    assert vad.feed(chunk()) == []
    events = vad.feed(chunk())
    assert events == [{"type": "speech_start", "prob": pytest.approx(0.9), "barge_in": False}]
    assert vad.in_speech is True


def test_one_voiced_chunk_followed_by_silence_does_not_start_speech():
    vad, _ = stream([0.9, 0.1, 0.9, 0.1])
    events = []
    for _ in range(4):
        events.extend(vad.feed(chunk()))
    assert events == []
    assert vad.in_speech is False


def test_below_threshold_never_starts_speech():
    vad, _ = stream([0.49] * 10)
    events = []
    for _ in range(10):
        events.extend(vad.feed(chunk()))
    assert events == []


# ---------------------------------------------------------------------------
# speech end
# ---------------------------------------------------------------------------
def test_silence_ends_the_utterance_with_buffered_audio():
    # 2 chunks to start (preroll included), 3 voiced, then 7 silent (112 ms).
    vad, _ = stream([0.9, 0.9] + [0.9] * 3 + [0.1] * 7)
    events = []
    for _ in range(12):
        events.extend(vad.feed(chunk()))
    starts = [e for e in events if e["type"] == "speech_start"]
    ends = [e for e in events if e["type"] == "speech_end"]
    assert len(starts) == 1 and len(ends) == 1
    end = ends[0]
    assert end["reason"] == "silence"
    assert end["barge_in"] is False
    # 12 chunks of 256 samples = 3072 samples = 192 ms.
    assert end["samples"].size == 3072
    assert end["duration_ms"] == 192
    assert vad.in_speech is False


def test_longer_silence_trims_the_dead_air():
    vos = 2
    sil = 13  # 208 ms, beyond the 160 ms grace window
    vad, _ = stream([0.9, 0.9] + [0.9] * vos + [0.1] * sil, silence_ms=200)
    events = []
    for _ in range(2 + vos + sil):
        events.extend(vad.feed(chunk()))
    end = [e for e in events if e["type"] == "speech_end"][0]
    total = (2 + vos + sil) * CHUNK_SAMPLES
    trimmed = int((sil * CHUNK_MS - 160) * SAMPLE_RATE / 1000)
    assert end["samples"].size == total - trimmed
    assert end["duration_ms"] == int(end["samples"].size * 1000 / SAMPLE_RATE)


def test_short_utterance_is_discarded_but_still_reported():
    vad, _ = stream([0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
                    min_speech_ms=10_000)
    events = []
    for _ in range(10):
        events.extend(vad.feed(chunk()))
    end = [e for e in events if e["type"] == "speech_end"][0]
    assert end["samples"].size == 0
    assert end["duration_ms"] > 0
    assert end["reason"] == "silence"


def test_maximum_utterance_forces_an_end():
    vad, _ = stream([0.9] * 10, max_utterance_ms=64, silence_ms=1000)
    events = []
    for _ in range(4):
        events.extend(vad.feed(chunk()))
    end = [e for e in events if e["type"] == "speech_end"][0]
    assert end["reason"] == "max_duration"
    assert end["samples"].size == 4 * CHUNK_SAMPLES  # proroll + 2 in-speech chunks
    assert end["duration_ms"] == 64
    assert vad.in_speech is False


# ---------------------------------------------------------------------------
# barge-in
# ---------------------------------------------------------------------------
def test_barge_in_needs_high_confidence_for_the_configured_window():
    vad, _ = stream([0.6, 0.6, 0.6, 0.9, 0.9, 0.9])
    events = []
    for _ in range(6):
        events.extend(vad.feed(chunk(), agent_speaking=True))
    starts = [e for e in events if e["type"] == "speech_start"]
    assert len(starts) == 1
    assert starts[0]["barge_in"] is True


def test_same_audio_without_agent_speaking_is_a_normal_start():
    vad, _ = stream([0.9, 0.9])
    events = []
    for _ in range(2):
        events.extend(vad.feed(chunk(), agent_speaking=False))
    starts = [e for e in events if e["type"] == "speech_start"]
    assert len(starts) == 1
    assert starts[0]["barge_in"] is False


def test_low_confidence_speech_does_not_interrupt_playback():
    vad, _ = stream([0.6] * 8)
    events = []
    for _ in range(8):
        events.extend(vad.feed(chunk(), agent_speaking=True))
    assert events == []
    assert vad.in_speech is False


# ---------------------------------------------------------------------------
# flush and reset
# ---------------------------------------------------------------------------
def test_flush_returns_the_buffered_utterance_and_resets():
    vad, _ = stream([0.9, 0.9, 0.9])
    for _ in range(3):
        vad.feed(chunk())
    assert vad.in_speech is True
    samples = vad.flush()
    assert samples is not None
    assert samples.size == 3 * CHUNK_SAMPLES
    assert vad.in_speech is False
    assert vad.flush() is None


def test_flush_without_speech_returns_none():
    vad, _ = stream([0.1])
    vad.feed(chunk())
    assert vad.flush() is None


def test_reset_clears_probability_and_state():
    vad, _ = stream([0.9, 0.9])
    vad.feed(chunk())
    vad.feed(chunk())
    assert vad.last_probability == pytest.approx(0.9)
    vad.reset()
    assert vad.last_probability == 0.0
    assert vad.in_speech is False
    assert vad._chunks == []
    assert vad._pending.size == 0


# ---------------------------------------------------------------------------
# Silero model wrapper
# ---------------------------------------------------------------------------
def test_missing_model_file_raises_a_clear_error(tmp_path: Path):
    with pytest.raises(FileNotFoundError) as exc:
        SileroVADModel(tmp_path / "nope.onnx")
    assert "Silero VAD model not found" in str(exc.value)


def test_load_caches_a_single_shared_instance(monkeypatch):
    sentinel = object.__new__(SileroVADModel)
    monkeypatch.setattr(SileroVADModel, "_instance", sentinel)
    assert SileroVADModel.load() is sentinel


def test_new_stream_inherits_the_model_and_options():
    sentinel = object.__new__(SileroVADModel)
    stream_obj = sentinel.new_stream(threshold=0.33, silence_ms=123)
    assert stream_obj.model is sentinel
    assert stream_obj.threshold == 0.33
    assert stream_obj.silence_ms == 123


# ---------------------------------------------------------------------------
# push-to-talk fallback
# ---------------------------------------------------------------------------
def test_push_to_talk_caps_the_buffer():
    buffer = PushToTalkBuffer(max_seconds=1)
    assert buffer.max_samples == SAMPLE_RATE
    buffer.start()
    assert buffer.append(np.zeros(10_000, dtype=np.float32)) == 10_000
    assert buffer.append(np.zeros(10_000, dtype=np.float32)) == 6_000
    assert buffer.append(np.zeros(10, dtype=np.float32)) == 0
    assert buffer.duration_ms == 1000


def test_push_to_talk_finish_requires_audio_and_a_peak():
    buffer = PushToTalkBuffer()
    buffer.start()
    assert buffer.finish().size == 0  # nothing recorded

    buffer.start()
    buffer.append(np.zeros(SAMPLE_RATE // 10, dtype=np.float32))  # 100 ms
    assert buffer.finish(min_ms=200).size == 0  # too short

    buffer.start()
    quiet = np.full(SAMPLE_RATE // 2, 0.001, dtype=np.float32)
    buffer.append(quiet)
    assert buffer.finish().size == 0  # below the noise floor

    buffer.start()
    loud = np.full(SAMPLE_RATE // 2, 0.5, dtype=np.float32)
    buffer.append(loud)
    result = buffer.finish()
    assert result.size == SAMPLE_RATE // 2
    assert buffer.duration_ms == 0  # finish clears the buffer


def test_push_to_talk_start_clears_previous_audio():
    buffer = PushToTalkBuffer()
    buffer.start()
    buffer.append(np.full(SAMPLE_RATE, 0.4, dtype=np.float32))
    buffer.start()
    assert buffer.duration_ms == 0
    assert buffer.finish().size == 0