"""CareSpeak VoiceLink configuration.

Everything is local by default.  No cloud URL is used unless an operator
explicitly overrides OLLAMA_URL, and even then the application only speaks the
Ollama HTTP protocol (no API keys, no billing).
"""
from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent

# Load local-only config.  Both files are git-ignored.
for candidate in (PROJECT_DIR / ".env.voicelink", BACKEND_DIR / ".env"):
    if candidate.exists():
        load_dotenv(candidate, override=False)


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    return value.strip() if value is not None else default


def _int_env(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    return _env(name, "1" if default else "0").lower() in {"1", "true", "yes", "on"}


def _lan_ip() -> str:
    """Best-effort private LAN address (no packet is actually sent)."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.2)
        sock.connect(("10.255.255.255", 1))
        value = sock.getsockname()[0]
        sock.close()
        if value and not value.startswith("127."):
            return value
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            value = info[4][0]
            if value and not value.startswith("127."):
                return value
    except OSError:
        pass
    return "127.0.0.1"


@dataclass(frozen=True)
class Settings:
    base_dir: Path = BACKEND_DIR
    project_dir: Path = PROJECT_DIR
    data_dir: Path = BACKEND_DIR / "data"
    models_dir: Path = BACKEND_DIR / "models"
    logs_dir: Path = BACKEND_DIR / "logs"
    runtime_dir: Path = BACKEND_DIR / "runtime"

    host: str = _env("VOICELINK_HOST", "127.0.0.1")
    port: int = _int_env("VOICELINK_PORT", 8000)
    db_path: Path = Path(_env("VOICELINK_DB_PATH", str(BACKEND_DIR / "data" / "voicelink.db")))

    ollama_url: str = _env("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    ollama_model: str = _env("OLLAMA_MODEL", "qwen2.5:3b")
    ollama_timeout_s: float = _float_env("OLLAMA_TIMEOUT_S", 90.0)
    ollama_keep_alive: str = _env("OLLAMA_KEEP_ALIVE", "30m")
    ollama_num_ctx: int = _int_env("OLLAMA_NUM_CTX", 4096)
    ollama_num_predict: int = _int_env("OLLAMA_NUM_PREDICT", 90)
    ollama_temperature: float = _float_env("OLLAMA_TEMPERATURE", 0.35)

    whisper_mode: str = _env("WHISPER_MODE", "server")  # server | cli
    # CPU is the safe default: base.en is fast enough and leaves the 6 GB GPU
    # free for other CareSpeak workloads.  Set WHISPER_BACKEND=cuda to opt in.
    whisper_backend: str = _env("WHISPER_BACKEND", "cpu")  # auto | cpu | cuda
    whisper_model: Path = Path(
        _env("WHISPER_MODEL", str(BACKEND_DIR / "models" / "whisper" / "ggml-base.en.bin"))
    )
    whisper_language: str = _env("WHISPER_LANGUAGE", "en")
    whisper_threads: int = _int_env("WHISPER_THREADS", max(2, (os.cpu_count() or 8) // 2))
    whisper_server_host: str = _env("WHISPER_SERVER_HOST", "127.0.0.1")
    whisper_server_port: int = _int_env("WHISPER_SERVER_PORT", 8178)
    whisper_timeout_s: float = _float_env("WHISPER_TIMEOUT_S", 90.0)
    whisper_auto_start: bool = _bool_env("WHISPER_AUTO_START", True)

    # sherpa-onnx VITS (LJSpeech, public domain dataset; model card apache-2.0)
    tts_engine: str = _env("TTS_ENGINE", "sherpa")  # sherpa | kokoro
    tts_threads: int = _int_env("TTS_THREADS", 4)
    tts_speed: float = _float_env("TTS_SPEED", 1.0)
    tts_voice: str = _env("TTS_VOICE", "af_heart")
    tts_max_sentence_chars: int = _int_env("TTS_MAX_SENTENCE_CHARS", 220)
    sherpa_tts_dir: Path = Path(
        _env("SHERPA_TTS_DIR", str(BACKEND_DIR / "models" / "tts" / "sherpa-ljs"))
    )
    kokoro_model: Path = Path(
        _env("KOKORO_MODEL", str(BACKEND_DIR / "models" / "tts" / "kokoro-v1.0.fp32.onnx"))
    )
    kokoro_voices: Path = Path(
        _env("KOKORO_VOICES", str(BACKEND_DIR / "models" / "tts" / "voices-v1.0.bin"))
    )
    kokoro_threads: int = _int_env("KOKORO_THREADS", 4)

    vad_model: Path = Path(
        _env("VAD_MODEL", str(BACKEND_DIR / "models" / "vad" / "silero_vad.onnx"))
    )
    vad_threshold: float = _float_env("VAD_THRESHOLD", 0.55)
    vad_silence_ms: int = _int_env("VAD_SILENCE_MS", 850)
    vad_min_speech_ms: int = _int_env("VAD_MIN_SPEECH_MS", 260)
    vad_barge_in_ms: int = _int_env("VAD_BARGE_IN_MS", 140)
    vad_preroll_ms: int = _int_env("VAD_PREROLL_MS", 400)
    vad_max_utterance_ms: int = _int_env("VAD_MAX_UTTERANCE_MS", 30000)

    gateway_port: int = _int_env("VOICELINK_GATEWAY_PORT", 3443)
    phone_url_override: str = _env("VOICELINK_PHONE_URL", "")
    lan_ip: str = field(default_factory=_lan_ip)

    allowed_origins: List[str] = field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://localhost:3443",
            "https://127.0.0.1:3443",
        ]
    )
    # Localhost + RFC1918 LAN only.  A public origin can never pass this regex.
    allowed_origin_regex: str = (
        r"^https?://(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
        r"192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?$"
    )

    store_transcripts: bool = _bool_env("VOICELINK_STORE_TRANSCRIPTS", True)
    log_transcripts: bool = _bool_env("VOICELINK_LOG_TRANSCRIPTS", False)
    demo_mode: bool = _bool_env("VOICELINK_DEMO_MODE", True)
    max_active_calls: int = _int_env("VOICELINK_MAX_ACTIVE_CALLS", 4)
    max_call_minutes: int = _int_env("VOICELINK_MAX_CALL_MINUTES", 30)
    max_turns: int = _int_env("VOICELINK_MAX_TURNS", 40)
    max_audio_bytes: int = _int_env("VOICELINK_MAX_AUDIO_BYTES", 16 * 1024 * 1024)
    ws_max_message_bytes: int = _int_env("VOICELINK_WS_MAX_MESSAGE_BYTES", 1024 * 1024)
    health_cache_seconds: float = _float_env("VOICELINK_HEALTH_CACHE_S", 8.0)
    llm_warmup: bool = _bool_env("VOICELINK_LLM_WARMUP", True)
    version: str = "1.0.0"

    @property
    def phone_url(self) -> str:
        if self.phone_url_override:
            return self.phone_url_override
        if self.lan_ip == "127.0.0.1":
            return f"https://localhost:{self.gateway_port}/voicelink"
        return f"https://{self.lan_ip}:{self.gateway_port}/voicelink"

    @property
    def engine_is_sherpa(self) -> bool:
        return self.tts_engine.strip().lower() == "sherpa"

    @property
    def sherpa_model_path(self) -> Path:
        return self.sherpa_tts_dir / "vits-ljs.onnx"

    @property
    def sherpa_lexicon_path(self) -> Path:
        return self.sherpa_tts_dir / "lexicon.txt"

    @property
    def sherpa_tokens_path(self) -> Path:
        return self.sherpa_tts_dir / "tokens.txt"

    def whisper_binary(self) -> Path:
        candidates = []
        if self.whisper_backend == "cuda":
            candidates.append(
                self.models_dir / "whisper.cpp" / "cuda" / "Release" / "whisper-server.exe"
            )
        if self.whisper_backend in {"auto", "cpu"}:
            candidates.append(
                self.models_dir / "whisper.cpp" / "cpu" / "Release" / "whisper-server.exe"
            )
        if self.whisper_backend == "auto":
            candidates.append(
                self.models_dir / "whisper.cpp" / "cuda" / "Release" / "whisper-server.exe"
            )
        cpu = self.models_dir / "whisper.cpp" / "cpu" / "Release" / "whisper-server.exe"
        if cpu not in candidates:
            candidates.append(cpu)
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return cpu

    @property
    def whisper_log_path(self) -> Path:
        return self.logs_dir / "whisper-server.log"

    @property
    def whisper_pid_path(self) -> Path:
        return self.runtime_dir / "whisper.pid"

    @property
    def stack_pid_path(self) -> Path:
        return self.runtime_dir / "stack.json"

    def ensure_dirs(self) -> None:
        for path in (
            self.data_dir,
            self.logs_dir,
            self.models_dir,
            self.runtime_dir,
            self.db_path.parent,
        ):
            path.mkdir(parents=True, exist_ok=True)


settings = Settings()
