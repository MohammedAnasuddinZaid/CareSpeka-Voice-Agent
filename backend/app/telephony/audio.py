"""Telephony audio codec and sample-rate conversion.

Telephony media streams are not browser microphones.  Both Exotel AgentStream
and Twilio Media Streams deliver **base64-encoded 8 kHz mono G.711 mu-law**
frames, and expect mu-law back.  The local AI pipeline runs on 16 kHz PCM for
VAD/ASR and 22.05 kHz PCM for TTS, so every frame is converted in both
directions.

``audioop`` (CPython standard library) provides the G.711 codec; the linear
resampler is shared with :mod:`app.asr` so there is exactly one resampling
implementation in the project.
"""
from __future__ import annotations

import base64
import struct
from dataclasses import dataclass
from typing import Iterable

import numpy as np

try:
    import audioop  # type: ignore
except Exception:  # pragma: no cover - audioop is present on 3.10/3.12
    audioop = None  # type: ignore


TELEPHONY_SAMPLE_RATE = 8000
AI_SAMPLE_RATE = 16000
TTS_SAMPLE_RATE = 22050
FRAME_MS = 20
FRAME_SAMPLES = TELEPHONY_SAMPLE_RATE * FRAME_MS // 1000  # 160 samples
FRAME_BYTES = FRAME_SAMPLES * 2  # mono 16-bit


def b64_decode(data: str | bytes) -> bytes:
    if isinstance(data, bytes):
        return base64.b64decode(data)
    return base64.b64decode(data.encode("ascii"))


def b64_encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _need_audioop(feature: str) -> None:
    if audioop is None:  # pragma: no cover
        raise RuntimeError(
            f"G.711 {feature} requires the standard-library 'audioop' module, "
            "which is unavailable in this Python build."
        )


def pcm16_to_mulaw(pcm: bytes) -> bytes:
    _need_audioop("encoding")
    return audioop.lin2ulaw(pcm, 2)


def mulaw_to_pcm16(mulaw: bytes) -> bytes:
    _need_audioop("decoding")
    return audioop.ulaw2lin(mulaw, 2)


def pcm16_to_alaw(pcm: bytes) -> bytes:
    _need_audioop("encoding")
    return audioop.lin2alaw(pcm, 2)


def alaw_to_pcm16(alaw: bytes) -> bytes:
    _need_audioop("decoding")
    return audioop.alaw2lin(alaw, 2)


def pcm16_to_float(pcm: bytes) -> np.ndarray:
    if not pcm:
        return np.zeros(0, dtype=np.float32)
    usable = len(pcm) - (len(pcm) % 2)
    samples = np.frombuffer(pcm[:usable], dtype="<i2").astype(np.float32) / 32768.0
    return samples


def float_to_pcm16(samples: np.ndarray) -> bytes:
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def resample_pcm16(pcm: bytes, source_rate: int, target_rate: int) -> bytes:
    if source_rate == target_rate or not pcm:
        return pcm
    from app.asr import resample_linear  # local import avoids a cycle at import time

    samples = pcm16_to_float(pcm)
    if samples.size == 0:
        return b""
    converted = resample_linear(samples, source_rate, target_rate)
    return float_to_pcm16(converted)


def mulaw_to_ai_pcm16(mulaw: bytes) -> bytes:
    """mu-law 8 kHz -> 16 kHz PCM16 (what VAD and ASR expect)."""
    pcm8 = mulaw_to_pcm16(mulaw)
    return resample_pcm16(pcm8, TELEPHONY_SAMPLE_RATE, AI_SAMPLE_RATE)


def tts_pcm16_to_mulaw(pcm: bytes, source_rate: int = TTS_SAMPLE_RATE) -> bytes:
    """TTS PCM (22.05 kHz) -> 8 kHz mu-law for the telephone line."""
    pcm8 = resample_pcm16(pcm, source_rate, TELEPHONY_SAMPLE_RATE)
    return pcm16_to_mulaw(pcm8)


def iter_frames(pcm16: bytes, frame_bytes: int = FRAME_BYTES) -> Iterable[bytes]:
    """Yield fixed-size frames, padding the final short frame with silence."""
    if not pcm16:
        return
    offset = 0
    total = len(pcm16)
    while offset < total:
        chunk = pcm16[offset : offset + frame_bytes]
        if len(chunk) < frame_bytes:
            chunk = chunk + b"\x00" * (frame_bytes - len(chunk))
        yield chunk
        offset += frame_bytes


def wav_pcm16(data: bytes) -> tuple[bytes, int]:
    """Extract raw PCM and the sample rate from a small RIFF/WAVE byte string."""
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("Not a RIFF/WAVE payload.")
    rate = 16000
    channels = 1
    bits = 16
    fmt = 16
    pos = 12
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        body = data[pos + 8 : pos + 8 + size]
        if chunk_id == b"fmt " and len(body) >= 16:
            fmt, channels, rate = struct.unpack("<HHI", body[0:8])
            bits = struct.unpack("<H", body[14:16])[0]
        elif chunk_id == b"data":
            pcm = body
            if channels > 1 and bits == 16:
                samples = np.frombuffer(
                    pcm[: len(pcm) - (len(pcm) % (2 * channels))], dtype="<i2"
                )
                samples = samples.reshape(-1, channels).mean(axis=1)
                pcm = samples.astype("<i2").tobytes()
            if bits == 8:
                raw = np.frombuffer(pcm, dtype="<u1").astype(np.float32)
                pcm = float_to_pcm16((raw - 128.0) / 128.0)
            return pcm, rate
        pos += 8 + size + (size % 2)
    raise ValueError("WAVE payload had no data chunk.")


@dataclass
class AudioFormat:
    """Describes a provider's media format so the bridge never hardcodes it."""

    encoding: str = "mulaw"  # mulaw | alaw | pcm16
    sample_rate: int = TELEPHONY_SAMPLE_RATE
    frame_ms: int = FRAME_MS

    def decode_to_ai(self, payload: bytes) -> bytes:
        if self.encoding == "mulaw":
            pcm = mulaw_to_pcm16(payload)
        elif self.encoding == "alaw":
            pcm = alaw_to_pcm16(payload)
        else:
            pcm = payload
        return resample_pcm16(pcm, self.sample_rate, AI_SAMPLE_RATE)

    def encode_from_ai(self, pcm16: bytes, source_rate: int) -> bytes:
        resampled = resample_pcm16(pcm16, source_rate, self.sample_rate)
        if self.encoding == "mulaw":
            return pcm16_to_mulaw(resampled)
        if self.encoding == "alaw":
            return pcm16_to_alaw(resampled)
        return resampled
