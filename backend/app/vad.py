"""Streaming Silero VAD and utterance segmentation (16 kHz mono)."""
from __future__ import annotations

import threading
from collections import deque
from pathlib import Path
from typing import Any, Optional

import numpy as np
import onnxruntime as ort

from app.config import settings

SAMPLE_RATE = 16000
# This ONNX export (the official silero_vad.onnx) is calibrated for 256-sample
# windows; feeding 512 samples silently collapses its probabilities.
CHUNK_SAMPLES = 256
CHUNK_MS = 16


class SileroVADModel:
    """One shared ONNX session; each call owns its own recurrent state."""

    _instance: Optional["SileroVADModel"] = None
    _lock = threading.Lock()

    def __init__(self, model_path: Path) -> None:
        if not model_path.exists():
            raise FileNotFoundError(f"Silero VAD model not found: {model_path}")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            str(model_path),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        self.path = model_path

    @classmethod
    def load(cls) -> "SileroVADModel":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls(settings.vad_model)
            return cls._instance

    def new_stream(self, **kwargs: Any) -> "VADStream":
        return VADStream(self, **kwargs)


class VADStream:
    """Consumes arbitrary 16 kHz frames and emits speech boundaries."""

    def __init__(
        self,
        model: SileroVADModel,
        *,
        threshold: Optional[float] = None,
        silence_ms: Optional[int] = None,
        min_speech_ms: Optional[int] = None,
        barge_in_ms: Optional[int] = None,
        preroll_ms: Optional[int] = None,
        max_utterance_ms: Optional[int] = None,
    ) -> None:
        self.model = model
        self.threshold = (
            settings.vad_threshold if threshold is None else float(threshold)
        )
        self.silence_ms = settings.vad_silence_ms if silence_ms is None else int(silence_ms)
        self.min_speech_ms = (
            settings.vad_min_speech_ms if min_speech_ms is None else int(min_speech_ms)
        )
        self.barge_in_ms = (
            settings.vad_barge_in_ms if barge_in_ms is None else int(barge_in_ms)
        )
        self.preroll_ms = (
            settings.vad_preroll_ms if preroll_ms is None else int(preroll_ms)
        )
        self.max_utterance_ms = (
            settings.vad_max_utterance_ms
            if max_utterance_ms is None
            else int(max_utterance_ms)
        )
        self._preroll_chunks = max(1, self.preroll_ms // CHUNK_MS)
        self.reset()

    def reset(self) -> None:
        self._pending = np.empty(0, dtype=np.float32)
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._preroll: deque[np.ndarray] = deque(maxlen=self._preroll_chunks)
        self._chunks: list[np.ndarray] = []
        self.in_speech = False
        self._trigger_hits = 0
        self._barge_hits = 0
        self._voiced_ms = 0
        self._silence_ms = 0
        self._total_ms = 0
        self._last_prob = 0.0
        self._barge_emitted = False

    def _infer(self, chunk: np.ndarray) -> float:
        frame = chunk.reshape(1, -1).astype(np.float32)
        output, state = self.model.session.run(
            None,
            {
                "input": frame,
                "state": self._state,
                "sr": np.array(SAMPLE_RATE, dtype=np.int64),
            },
        )
        self._state = state.astype(np.float32)
        return float(np.asarray(output).reshape(-1)[0])

    def feed(
        self, samples: np.ndarray | list[float], *, agent_speaking: bool = False
    ) -> list[dict[str, Any]]:
        """Return zero or more events.

        Event shapes:
          {"type":"speech_start","prob":float,"barge_in":bool}
          {"type":"speech_end","samples":np.float32[],"reason":str,"duration_ms":int}
        """
        incoming = np.asarray(samples, dtype=np.float32).reshape(-1)
        if incoming.size:
            self._pending = np.concatenate((self._pending, incoming))
        events: list[dict[str, Any]] = []

        while self._pending.size >= CHUNK_SAMPLES:
            chunk = self._pending[:CHUNK_SAMPLES].copy()
            self._pending = self._pending[CHUNK_SAMPLES:]
            prob = self._infer(chunk)
            self._last_prob = prob
            voiced = prob >= self.threshold

            if not self.in_speech:
                self._preroll.append(chunk)
                if agent_speaking:
                    if prob >= max(self.threshold, 0.70):
                        self._barge_hits += 1
                    else:
                        self._barge_hits = 0
                    if self._barge_hits * CHUNK_MS >= self.barge_in_ms:
                        self.in_speech = True
                        self._barge_emitted = True
                        self._trigger_hits = 0
                        self._barge_hits = 0
                        self._voiced_ms = min(
                            self.max_utterance_ms, self._preroll_chunks * CHUNK_MS
                        )
                        self._silence_ms = 0
                        self._total_ms = self._voiced_ms
                        self._chunks = list(self._preroll)
                        self._preroll.clear()
                        events.append(
                            {
                                "type": "speech_start",
                                "prob": prob,
                                "barge_in": True,
                            }
                        )
                    continue

                if voiced:
                    self._trigger_hits += 1
                else:
                    self._trigger_hits = 0
                if self._trigger_hits >= 2:
                    self.in_speech = True
                    self._barge_emitted = False
                    self._trigger_hits = 0
                    self._voiced_ms = min(
                        self.max_utterance_ms,
                        max(CHUNK_MS, self._preroll_chunks * CHUNK_MS),
                    )
                    self._silence_ms = 0
                    self._total_ms = self._voiced_ms
                    self._chunks = list(self._preroll)
                    self._preroll.clear()
                    events.append(
                        {"type": "speech_start", "prob": prob, "barge_in": False}
                    )
                continue

            # Currently inside an utterance.
            self._chunks.append(chunk)
            self._total_ms += CHUNK_MS
            if voiced:
                self._voiced_ms += CHUNK_MS
                self._silence_ms = 0
            else:
                self._silence_ms += CHUNK_MS

            end_reason: str | None = None
            if self._silence_ms >= self.silence_ms:
                end_reason = "silence"
            elif self._total_ms >= self.max_utterance_ms:
                end_reason = "max_duration"
            if end_reason:
                samples_out = np.concatenate(self._chunks) if self._chunks else np.empty(0, np.float32)
                if self._silence_ms > 160:
                    trim = min(
                        len(samples_out),
                        int((self._silence_ms - 160) * SAMPLE_RATE / 1000),
                    )
                    samples_out = samples_out[: len(samples_out) - trim]
                duration_ms = int(len(samples_out) * 1000 / SAMPLE_RATE)
                keep = self._voiced_ms >= self.min_speech_ms and samples_out.size > 0
                events.append(
                    {
                        "type": "speech_end",
                        "samples": samples_out if keep else np.empty(0, np.float32),
                        "reason": end_reason,
                        "duration_ms": duration_ms,
                        "barge_in": self._barge_emitted,
                    }
                )
                self.reset()
        return events

    def flush(self) -> Optional[np.ndarray]:
        """End an in-progress utterance, used when a push-to-talk key is released."""
        if not self.in_speech or not self._chunks:
            self.reset()
            return None
        samples = np.concatenate(self._chunks)
        self.reset()
        return samples

    @property
    def last_probability(self) -> float:
        return self._last_prob


class PushToTalkBuffer:
    """Plain audio buffer for the accessibility fallback; no VAD required."""

    def __init__(self, max_seconds: int = 30) -> None:
        self.max_samples = max_seconds * SAMPLE_RATE
        self._parts: list[np.ndarray] = []
        self._size = 0

    def start(self) -> None:
        self._parts.clear()
        self._size = 0

    def append(self, samples: np.ndarray) -> int:
        if self._size >= self.max_samples:
            return 0
        room = self.max_samples - self._size
        part = np.asarray(samples, dtype=np.float32).reshape(-1)[:room]
        self._parts.append(part)
        self._size += part.size
        return int(part.size)

    def finish(self, min_ms: int = 200) -> np.ndarray:
        samples = (
            np.concatenate(self._parts)
            if self._parts
            else np.empty(0, dtype=np.float32)
        )
        self._parts.clear()
        self._size = 0
        if samples.size < int(SAMPLE_RATE * min_ms / 1000):
            return np.empty(0, dtype=np.float32)
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak < 0.004:
            return np.empty(0, dtype=np.float32)
        return samples

    @property
    def duration_ms(self) -> int:
        return int(self._size * 1000 / SAMPLE_RATE)
