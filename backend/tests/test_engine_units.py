"""Deep tests for the engine composition root (health, warmup, lifecycle)."""
from __future__ import annotations

import asyncio
import functools
from types import SimpleNamespace

import pytest

from app import engine as engine_module
from app.config import settings
from app.engine import VoiceEngine


def async_test(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))

    return wrapper


class FakeASR:
    def __init__(self, *, ready=True, server=True, warm=True, warm_error=None):
        self.model_ready = ready
        self._server = server
        self._warm = warm
        self._warm_error = warm_error
        self._last_error = None
        self.health_calls = 0
        self.warms = 0
        self.shutdowns = 0

    async def server_healthy(self, refresh: bool = False) -> bool:
        self.health_calls += 1
        return self._server

    def health(self):
        return {"model": "fake-whisper", "running": self._server}

    async def warm(self):
        self.warms += 1
        if self._warm_error is not None:
            raise self._warm_error
        return self._warm

    async def shutdown(self):
        self.shutdowns += 1


class FakeLLM:
    def __init__(self, *, ok=True):
        self.ok = ok
        self.health_calls = 0
        self.warmups = 0
        self.shutdowns = 0

    async def health(self, refresh: bool = False):
        self.health_calls += 1
        return {
            "ok": self.ok,
            "model_installed": self.ok,
            "models": [],
            "error": None if self.ok else "down",
        }

    async def warmup(self):
        self.warmups += 1
        return {"ok": True, "warmup_ms": 3}

    async def shutdown(self):
        self.shutdowns += 1


class FakeTTS:
    def __init__(self, *, files=True, loaded=True, self_test=5):
        self._files = files
        self._loaded = loaded
        self._self_test = self_test
        self.loads = 0
        self.shutdowns = 0

    def health(self):
        return {
            "files_ready": self._files,
            "loaded": self._loaded,
            "self_test_ms": self._self_test,
            "engine": "fake",
        }

    async def load(self):
        self.loads += 1
        return True

    async def shutdown(self):
        self.shutdowns += 1


class FakeVADModel:
    def __init__(self):
        self.streams = 0

    @classmethod
    def load(cls):
        return cls()

    def new_stream(self):
        self.streams += 1
        return SimpleNamespace(kind="vad-stream")


@pytest.fixture()
def engine(monkeypatch):
    monkeypatch.setattr(engine_module, "WhisperASR", lambda: FakeASR())
    monkeypatch.setattr(engine_module, "SherpaTTS", lambda: FakeTTS())
    monkeypatch.setattr(engine_module, "OllamaClient", lambda: FakeLLM())
    instance = VoiceEngine()
    instance.vad_model = FakeVADModel()
    monkeypatch.setattr(engine_module.database, "healthcheck", lambda: {"ok": True, "tables": 18})
    instance._health_cache = (0.0, {})
    return instance


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------
@async_test
async def test_health_reports_ready_when_every_component_is_up(engine):
    result = await engine.health()
    assert result["status"] == "ready"
    assert all(result["checks"].values())
    assert set(result["checks"]) == {
        "database", "ollama", "llm_model", "whisper_model",
        "whisper_server", "tts_model", "tts_engine", "vad_model",
    }
    assert result["details"]["database"]["tables"] == 18
    assert result["details"]["ollama"]["ok"] is True
    assert result["details"]["whisper"]["model"] == "fake-whisper"
    assert result["details"]["tts"]["engine"] == "fake"
    assert result["details"]["vad"]["loaded"] is True
    assert isinstance(result["checked_at"], float)


@async_test
async def test_health_is_degraded_when_one_check_fails(engine):
    engine.asr._server = False
    result = await engine.health()
    assert result["status"] == "degraded"
    assert result["checks"]["whisper_server"] is False
    assert result["checks"]["database"] is True


@async_test
async def test_health_is_unavailable_when_nothing_is_up(engine, monkeypatch):
    monkeypatch.setattr(engine_module.database, "healthcheck", lambda: {"ok": False})
    engine.llm.ok = False
    engine.asr.model_ready = False
    engine.asr._server = False
    engine.tts._files = False
    engine.tts._loaded = False
    engine.tts._self_test = None
    engine.vad_model = None
    result = await engine.health()
    assert result["status"] == "unavailable"
    assert not any(result["checks"].values())


@async_test
async def test_health_is_cached_until_refreshed(engine):
    first = await engine.health()
    calls = engine.asr.health_calls, engine.llm.health_calls
    second = await engine.health()
    assert second is first
    assert (engine.asr.health_calls, engine.llm.health_calls) == calls

    refreshed = await engine.health(refresh=True)
    assert refreshed is not first
    assert engine.asr.health_calls == calls[0] + 1
    assert engine.llm.health_calls == calls[1] + 1


# ---------------------------------------------------------------------------
# status and VAD streams
# ---------------------------------------------------------------------------
def test_status_describes_the_local_service(engine):
    status = engine.status(active_calls=2)
    assert status["service"] == "CareSpeak VoiceLink"
    assert status["version"] == settings.version
    assert status["local_only"] is True
    assert status["active_calls"] == 2
    assert status["max_active_calls"] == settings.max_active_calls
    assert status["backend"] == {"host": settings.host, "port": settings.port}
    assert status["ca_url"].endswith("/ca.crt")
    assert set(status["models"]) == {"llm", "stt", "tts", "vad"}
    assert status["transcripts_stored"] == settings.store_transcripts


def test_new_vad_stream_requires_a_loaded_model(engine):
    engine.vad_model = None
    engine._vad_error = None
    with pytest.raises(RuntimeError) as exc:
        engine.new_vad_stream()
    assert "Silero VAD is unavailable" in str(exc.value)

    engine._vad_error = "onnx failed"
    with pytest.raises(RuntimeError) as exc:
        engine.new_vad_stream()
    assert "onnx failed" in str(exc.value)


def test_new_vad_stream_delegates_to_the_model(engine):
    stream = engine.new_vad_stream()
    assert stream.kind == "vad-stream"
    assert engine.vad_model.streams == 1


# ---------------------------------------------------------------------------
# warmup helpers
# ---------------------------------------------------------------------------
@async_test
async def test_load_vad_swallows_failures(engine, monkeypatch):
    class Broken:
        @classmethod
        def load(cls):
            raise RuntimeError("onnxruntime missing")

    monkeypatch.setattr(engine_module, "SileroVADModel", Broken)
    await engine._load_vad()
    assert engine.vad_model is None
    assert "onnxruntime missing" in engine._vad_error


@async_test
async def test_load_vad_records_success(engine, monkeypatch):
    monkeypatch.setattr(engine_module, "SileroVADModel", FakeVADModel)
    await engine._load_vad()
    assert isinstance(engine.vad_model, FakeVADModel)
    assert engine._vad_error is None


@async_test
async def test_warm_asr_records_success_and_failure(engine):
    await engine._warm_asr()
    assert engine._warm_status["asr"] == {"ok": True, "error": None}

    engine.asr = FakeASR(warm_error=RuntimeError("model missing"))
    await engine._warm_asr()
    assert engine._warm_status["asr"]["ok"] is False
    assert "model missing" in engine._warm_status["asr"]["error"]


@async_test
async def test_warm_llm_records_the_result(engine):
    await engine._warm_llm()
    assert engine._warm_status["llm"] == {"ok": True, "warmup_ms": 3}
    assert engine.llm.warmups == 1


# ---------------------------------------------------------------------------
# start and shutdown
# ---------------------------------------------------------------------------
@async_test
async def test_start_loads_tts_and_vad_then_warms_asr(engine, monkeypatch):
    monkeypatch.setattr(engine_module, "SileroVADModel", FakeVADModel)
    monkeypatch.setattr(
        engine_module, "settings", SimpleNamespace(ensure_dirs=lambda: None, llm_warmup=False)
    )
    monkeypatch.setattr(engine_module.database, "init_db", lambda: None)

    await engine.start()
    assert engine.tts.loads == 1
    assert isinstance(engine.vad_model, FakeVADModel)
    assert len(engine._background) == 1
    await asyncio.gather(*engine._background)
    assert engine.asr.warms == 1
    assert engine._warm_status["asr"]["ok"] is True
    assert engine.llm.warmups == 0  # warmup is disabled


@async_test
async def test_start_survives_a_missing_vad_model(engine, monkeypatch):
    class Broken:
        @classmethod
        def load(cls):
            raise FileNotFoundError("silero_vad.onnx not found")

    monkeypatch.setattr(engine_module, "SileroVADModel", Broken)
    monkeypatch.setattr(
        engine_module, "settings", SimpleNamespace(ensure_dirs=lambda: None, llm_warmup=False)
    )
    monkeypatch.setattr(engine_module.database, "init_db", lambda: None)

    await engine.start()
    assert engine.vad_model is None
    assert "not found" in engine._vad_error
    await asyncio.gather(*engine._background)


@async_test
async def test_shutdown_stops_every_component(engine):
    await engine.shutdown()
    assert engine.asr.shutdowns == 1
    assert engine.tts.shutdowns == 1
    assert engine.llm.shutdowns == 1


@async_test
async def test_shutdown_cancels_pending_background_tasks(engine):
    async def forever():
        await asyncio.sleep(3600)

    task = asyncio.create_task(forever())
    engine._background = [task]
    await engine.shutdown()
    assert task.cancelled() is True
    assert engine.asr.shutdowns == 1