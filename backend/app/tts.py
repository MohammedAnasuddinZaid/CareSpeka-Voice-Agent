"""Local text-to-speech using sherpa-onnx VITS (LJSpeech)."""
from __future__ import annotations

import asyncio
import io
import re
import threading
import time
import wave
from dataclasses import dataclass
from typing import Optional

import numpy as np
import sherpa_onnx

from app.config import settings

SENTENCE_END = re.compile(r"(?<=[.!?])(?:[\"')\]]*)\s+")
ABBREVIATIONS = {"dr", "mr", "mrs", "ms", "prof", "st", "vs", "e.g", "i.e", "no"}


@dataclass
class TTSResult:
    wav: bytes
    sample_rate: int
    duration_s: float
    gen_ms: int
    text: str


def normalize_for_speech(text: str) -> str:
    """Expand tokens the VITS lexicon does not pronounce well."""
    clean = " ".join(str(text or "").split())
    replacements = [
        (r"\bCareSpeak\b", "Care Speak"),
        (r"\bVoiceLink\b", "Voice Link"),
        (r"\bCS-(\d)(\d)(\d)(\d)\b", r"C S \1 \2 \3 \4"),
        (r"\b1-1-2\b", "one one two"),
        (r"\b112\b", "one one two"),
        (r"\bBP\b", "blood pressure"),
        (r"\bER\b", "emergency room"),
        (r"\bAI\b", "A I"),
        (r"\bDr\.", "Doctor"),
        (r"\bMr\.", "Mister"),
        (r"\bMrs\.", "Missus"),
        (r"\bappt\.?", "appointment"),
        (r"\bmeds\b", "medicines"),
        (r"\bmin\.", "minutes"),
        (r"\bhr\.", "hour"),
        (r"&", " and "),
        (r"\+", " plus "),
        (r"@", " at "),
        (r"[/\\]", " or "),
    ]
    for pattern, replacement in replacements:
        clean = re.sub(pattern, replacement, clean, flags=re.IGNORECASE)
    clean = re.sub(r"\([^)]{0,80}\)", " ", clean)  # stage directions
    clean = re.sub(r"\s+", " ", clean).strip()
    if clean and clean[-1] not in ".!?":
        clean += "."
    return clean


def split_sentences(text: str) -> list[str]:
    clean = " ".join(text.split())
    if not clean:
        return []
    parts: list[str] = []
    start = 0
    for match in SENTENCE_END.finditer(clean):
        candidate = clean[start : match.start()].strip()
        if not candidate:
            continue
        last_word = re.split(r"\s+", candidate)[-1].lower().rstrip(".")
        if last_word in ABBREVIATIONS and len(candidate) < 40:
            continue
        parts.append(candidate)
        start = match.end()
    tail = clean[start:].strip()
    if tail:
        parts.append(tail)
    return parts


class StreamingTTSChunker:
    """Turns a token stream into short speakable sentences as early as possible."""

    def __init__(self, max_chars: int | None = None, min_chars: int = 8) -> None:
        self.max_chars = max_chars or settings.tts_max_sentence_chars
        self.min_chars = min_chars
        self.buffer = ""

    def push(self, delta: str) -> list[str]:
        self.buffer += delta
        ready: list[str] = []
        while True:
            sentence = self._take_sentence()
            if not sentence:
                break
            ready.append(sentence)
        if len(self.buffer) > self.max_chars:
            split_at = max(
                self.buffer.rfind(",", 0, self.max_chars),
                self.buffer.rfind(";", 0, self.max_chars),
                self.buffer.rfind(":", 0, self.max_chars),
            )
            if split_at < self.min_chars:
                split_at = self.buffer.rfind(" ", self.min_chars, self.max_chars)
            if split_at >= self.min_chars:
                ready.append(self.buffer[:split_at].strip())
                self.buffer = self.buffer[split_at + 1 :].lstrip()
        return [item for item in ready if item]

    def _take_sentence(self) -> Optional[str]:
        match = SENTENCE_END.search(self.buffer)
        if not match:
            return None
        candidate = self.buffer[: match.start()].strip()
        if len(candidate) < self.min_chars:
            return None
        last_word = re.split(r"\s+", candidate)[-1].lower().rstrip(".")
        if last_word in ABBREVIATIONS:
            return None
        self.buffer = self.buffer[match.end() :]
        return candidate

    def flush(self) -> list[str]:
        remainder = self.buffer.strip()
        self.buffer = ""
        if not remainder:
            return []
        if len(remainder) <= self.max_chars:
            return [remainder]
        return split_sentences(remainder)


class SherpaTTS:
    def __init__(self) -> None:
        self.engine: Optional[sherpa_onnx.OfflineTts] = None
        self._lock = threading.Lock()
        self._async_lock = asyncio.Semaphore(1)
        self._load_ms = 0
        self._self_test_ms: Optional[int] = None
        self._error: Optional[str] = None
        self._sample_rate = 22050

    @property
    def files_ready(self) -> bool:
        return (
            settings.engine_is_sherpa
            and settings.sherpa_model_path.exists()
            and settings.sherpa_lexicon_path.exists()
            and settings.sherpa_tokens_path.exists()
        )

    def _load_sync(self) -> None:
        if settings.tts_engine.lower() != "sherpa":
            raise RuntimeError(
                f"TTS_ENGINE={settings.tts_engine!r} is not bundled in the zero-cost "
                "install. Set TTS_ENGINE=sherpa."
            )
        if not self.files_ready:
            raise FileNotFoundError(
                "sherpa-onnx VITS files are missing. Run setup.ps1 to download them."
            )
        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=str(settings.sherpa_model_path),
                    lexicon=str(settings.sherpa_lexicon_path),
                    tokens=str(settings.sherpa_tokens_path),
                    data_dir="",
                    dict_dir="",
                ),
                num_threads=settings.tts_threads,
                provider="cpu",
                debug=False,
            ),
            rule_fsts="",
            max_num_sentences=1,
        )
        started = time.perf_counter()
        self.engine = sherpa_onnx.OfflineTts(config)
        self._load_ms = int((time.perf_counter() - started) * 1000)
        self._sample_rate = int(self.engine.sample_rate)

    async def load(self) -> bool:
        if self.engine is not None:
            return True
        try:
            await asyncio.to_thread(self._load_sync)
            # A real synthesis check, not a hard-coded health flag.
            test = await asyncio.to_thread(self._synthesize_sync, "Hello.")
            self._self_test_ms = test.gen_ms
            self._error = None
            return True
        except Exception as exc:
            self._error = str(exc)
            self.engine = None
            return False

    def _synthesize_sync(self, text: str) -> TTSResult:
        if self.engine is None:
            raise RuntimeError(self._error or "TTS engine is not loaded.")
        spoken = normalize_for_speech(text)
        if not spoken:
            raise ValueError("Nothing to speak.")
        started = time.perf_counter()
        with self._lock:
            audio = self.engine.generate(spoken, sid=0, speed=settings.tts_speed)
        samples = np.asarray(audio.samples, dtype=np.float32).reshape(-1)
        if samples.size == 0:
            raise RuntimeError("TTS engine returned empty audio.")
        sample_rate = int(audio.sample_rate or self._sample_rate)
        pcm16 = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(pcm16.tobytes())
        generation_ms = int((time.perf_counter() - started) * 1000)
        return TTSResult(
            wav=buffer.getvalue(),
            sample_rate=sample_rate,
            duration_s=samples.size / float(sample_rate),
            gen_ms=generation_ms,
            text=spoken,
        )

    async def synthesize(self, text: str) -> TTSResult:
        if self.engine is None and not await self.load():
            raise RuntimeError(self._error or "TTS engine is unavailable.")
        async with self._async_lock:
            return await asyncio.to_thread(self._synthesize_sync, text)

    def health(self) -> dict:
        return {
            "engine": "sherpa-onnx VITS (LJSpeech)",
            "loaded": self.engine is not None,
            "files_ready": self.files_ready,
            "model": str(settings.sherpa_model_path),
            "sample_rate": self._sample_rate,
            "load_ms": self._load_ms,
            "self_test_ms": self._self_test_ms,
            "threads": settings.tts_threads,
            "error": self._error,
        }

    async def shutdown(self) -> None:
        self.engine = None
