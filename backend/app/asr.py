"""Local whisper.cpp server client with automatic startup and CPU fallback."""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
import tempfile
import time
import wave
from pathlib import Path
from typing import Any, Optional

import httpx
import numpy as np

from app.config import settings

SAMPLE_RATE = 16000
_ANNOTATION_RE = re.compile(
    r"[\[\(](?:blank_audio|silence|music|sound|inaudible|no speech|applause)[\]\)]",
    re.IGNORECASE,
)


def wav_bytes_from_float(samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> bytes:
    pcm = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")
    import io

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm16.tobytes())
    return buffer.getvalue()


def resample_linear(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    data = np.asarray(samples, dtype=np.float32).reshape(-1)
    if source_rate == target_rate or data.size == 0:
        return data
    duration = data.size / float(source_rate)
    target_size = max(1, int(round(duration * target_rate)))
    source_positions = np.linspace(0.0, data.size - 1, num=data.size, dtype=np.float64)
    target_positions = np.linspace(0.0, data.size - 1, num=target_size, dtype=np.float64)
    return np.interp(target_positions, source_positions, data).astype(np.float32)


def clean_transcript(text: str) -> str:
    clean = _ANNOTATION_RE.sub(" ", text or "")
    clean = " ".join(clean.split()).strip()
    if not clean or all(not ch.isalnum() for ch in clean):
        return ""
    return clean


class WhisperASR:
    def __init__(self) -> None:
        self.binary = settings.whisper_binary()
        self.model = settings.whisper_model
        self.base_url = (
            f"http://{settings.whisper_server_host}:{settings.whisper_server_port}"
        )
        self._client: Optional[httpx.AsyncClient] = None
        self._process: Optional[subprocess.Popen[bytes]] = None
        self._log_handle = None
        self._start_lock = asyncio.Lock()
        self._semaphore = asyncio.Semaphore(1)
        self._spawned = False
        self._last_error: Optional[str] = None
        self._last_health: tuple[float, bool] = (0.0, False)
        self.backend = "cpu" if "\\cuda\\" not in str(self.binary).lower() else "cuda"

    @property
    def model_ready(self) -> bool:
        return self.model.exists() and self.model.stat().st_size > 1_000_000

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0))
        return self._client

    async def server_healthy(self, refresh: bool = False) -> bool:
        now = time.monotonic()
        if not refresh and now - self._last_health[0] < 2.0:
            return self._last_health[1]
        if not self.model_ready:
            self._last_health = (now, False)
            return False
        try:
            client = await self._http()
            response = await client.get(self.base_url + "/", timeout=1.5)
            healthy = response.status_code == 200
        except Exception:
            healthy = False
        self._last_health = (now, healthy)
        return healthy

    def _spawn(self) -> None:
        settings.ensure_dirs()
        if not self.binary.exists():
            raise FileNotFoundError(f"whisper-server binary not found: {self.binary}")
        if not self.model_ready:
            raise FileNotFoundError(f"whisper model not found: {self.model}")
        log_path = settings.whisper_log_path
        self._log_handle = open(log_path, "ab", buffering=0)
        self._log_handle.write(
            f"\n--- starting {self.binary} at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n".encode()
        )
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        cmd = [
            str(self.binary),
            "-m",
            str(self.model),
            "--host",
            settings.whisper_server_host,
            "--port",
            str(settings.whisper_server_port),
            "-t",
            str(settings.whisper_threads),
            "-l",
            settings.whisper_language or "en",
            "-nt",
        ]
        self._process = subprocess.Popen(
            cmd,
            cwd=str(settings.project_dir),
            stdout=self._log_handle,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
        settings.whisper_pid_path.write_text(str(self._process.pid), encoding="ascii")
        self._spawned = True

    async def ensure_running(self, timeout_s: float = 45.0) -> bool:
        if await self.server_healthy(refresh=True):
            return True
        if not settings.whisper_auto_start:
            self._last_error = (
                "whisper.cpp server is not running and WHISPER_AUTO_START is disabled."
            )
            return False
        async with self._start_lock:
            if await self.server_healthy(refresh=True):
                return True
            try:
                self._spawn()
            except Exception as exc:
                self._last_error = str(exc)
                return False
            deadline = time.monotonic() + timeout_s
            while time.monotonic() < deadline:
                if self._process is not None and self._process.poll() is not None:
                    self._last_error = (
                        f"whisper.cpp server exited with code {self._process.returncode}. "
                        f"See {settings.whisper_log_path}."
                    )
                    break
                if await self.server_healthy(refresh=True):
                    self._last_error = None
                    return True
                await asyncio.sleep(0.4)
            self._last_error = self._last_error or (
                "Timed out waiting for the whisper.cpp server to become ready."
            )
            return False

    async def transcribe(
        self, samples: np.ndarray, sample_rate: int = SAMPLE_RATE
    ) -> dict[str, Any]:
        started = time.perf_counter()
        audio = resample_linear(samples, sample_rate, SAMPLE_RATE)
        if audio.size < int(SAMPLE_RATE * 0.15):
            return {
                "text": "",
                "elapsed_ms": int((time.perf_counter() - started) * 1000),
                "reason": "too_short",
            }
        if not await self.ensure_running():
            raise RuntimeError(self._last_error or "whisper.cpp is unavailable.")

        wav = wav_bytes_from_float(audio)
        if not wav:
            return {"text": "", "elapsed_ms": 0, "reason": "empty"}
        async with self._semaphore:
            client = await self._http()
            try:
                response = await client.post(
                    self.base_url + "/inference",
                    files={"file": ("utterance.wav", wav, "audio/wav")},
                    data={
                        "temperature": "0.0",
                        "temperature_inc": "0.2",
                        "response_format": "json",
                        "language": settings.whisper_language or "en",
                    },
                    timeout=settings.whisper_timeout_s,
                )
            except Exception as exc:
                self._last_health = (0.0, False)
                raise RuntimeError(f"whisper.cpp request failed: {exc}") from exc
        if response.status_code != 200:
            raise RuntimeError(
                f"whisper.cpp returned HTTP {response.status_code}: {response.text[:200]}"
            )
        try:
            payload = response.json()
        except json.JSONDecodeError:
            payload = {"text": response.text}
        text = clean_transcript(str(payload.get("text", "")))
        return {
            "text": text,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
            "reason": "ok" if text else "no_speech",
            "bytes": len(wav),
        }

    def health(self) -> dict[str, Any]:
        return {
            "binary": str(self.binary),
            "binary_exists": self.binary.exists(),
            "backend": self.backend,
            "model": str(self.model),
            "model_exists": self.model_ready,
            "server_url": self.base_url,
            "running": self._last_health[1],
            "spawned_by_app": self._spawned,
            "error": self._last_error,
        }

    async def warm(self) -> bool:
        return await self.ensure_running()

    async def shutdown(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        if self._spawned and self._process is not None and self._process.poll() is None:
            self._process.terminate()
            try:
                await asyncio.to_thread(self._process.wait, 5)
            except Exception:
                self._process.kill()
        if self._log_handle is not None:
            self._log_handle.close()
            self._log_handle = None
        try:
            if settings.whisper_pid_path.exists():
                settings.whisper_pid_path.unlink()
        except OSError:
            pass
