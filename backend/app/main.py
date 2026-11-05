"""FastAPI application for the CareSpeak VoiceLink local voice line."""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import database
from app.call_manager import CallManager, CallSession
from app.config import settings
from app.engine import VoiceEngine
from app.security import ValidationError, is_local_origin
from app.version import __version__

engine = VoiceEngine()
manager = CallManager(engine)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await engine.start()
    yield
    await manager.shutdown()
    await engine.shutdown()


app = FastAPI(
    title="CareSpeak VoiceLink",
    version=__version__,
    description="Local-only AI voice line. No cloud inference, no telephony billing.",
    lifespan=lifespan,
)
app.state.engine = engine
app.state.manager = manager
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_origin_regex=settings.allowed_origin_regex,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "service": "CareSpeak VoiceLink",
        "version": __version__,
        "local_only": True,
        "health": "/api/voicelink/health",
        "websocket": "/ws/voicelink",
    }


@app.get("/api/voicelink/health")
@app.get("/health")
async def health(refresh: bool = Query(False)) -> dict[str, Any]:
    result = await engine.health(refresh=refresh)
    return {
        "status": result["status"],
        "ok": result["status"] == "ready",
        "service": "CareSpeak VoiceLink",
        "version": __version__,
        "local_only": True,
        "checks": result["checks"],
        "voice_link": result,
        "gateway": {
            "phone_url": settings.phone_url,
            "ca_url": f"http://{settings.lan_ip}:3080/ca.crt",
            "port": settings.gateway_port,
        },
    }


@app.get("/api/voicelink/status")
async def status() -> dict[str, Any]:
    return engine.status(manager.active_count)


@app.get("/api/voicelink/patients")
async def patients() -> dict[str, Any]:
    records = await asyncio.to_thread(database.list_patients)
    return {"patients": records, "synthetic_only": True}


@app.get("/api/voicelink/history")
async def history(limit: int = Query(20, ge=1, le=100)) -> dict[str, Any]:
    records = await asyncio.to_thread(database.list_calls, limit)
    return {"calls": records, "stored": settings.store_transcripts}


@app.get("/api/voicelink/history/{call_id}")
async def history_detail(call_id: str) -> dict[str, Any]:
    record = await asyncio.to_thread(database.get_call, call_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Call record not found.")
    return record


@app.delete("/api/voicelink/history")
async def clear_history() -> dict[str, Any]:
    count = await asyncio.to_thread(database.delete_history)
    return {"deleted": count}


@app.get("/api/voicelink/diagnostics")
async def diagnostics() -> dict[str, Any]:
    health_result = await engine.health(refresh=True)
    return {
        "health": health_result,
        "asr": engine.asr.health(),
        "tts": engine.tts.health(),
        "llm": await engine.llm.health(refresh=True),
        "status": engine.status(manager.active_count),
        "active_sessions": [
            {
                "call_id": session.call_id,
                "state": session.state.state.value,
                "turns": session.turn_count,
                "barge_in": session.barge_in_enabled,
            }
            for session in manager.sessions.values()
        ],
    }


async def _wait_for_start(websocket: WebSocket) -> tuple[str, str, bool] | None:
    while True:
        message = await websocket.receive()
        if message.get("type") == "websocket.disconnect":
            return None
        if message.get("text"):
            try:
                payload = json.loads(message["text"])
            except json.JSONDecodeError:
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "bad_json",
                        "message": "Expected a JSON control message.",
                        "fatal": False,
                    }
                )
                continue
            if payload.get("type") == "ping":
                await websocket.send_json({"type": "pong", "t": time.time()})
                continue
            if payload.get("type") != "start_call":
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "start_call_required",
                        "message": "Send start_call before any other control message.",
                        "fatal": False,
                    }
                )
                continue
            return (
                str(payload.get("caller", "")),
                str(payload.get("callee", "")),
                bool(payload.get("demo_mode", settings.demo_mode)),
            )
        if message.get("bytes"):
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "start_call_required",
                    "message": "Audio arrived before start_call.",
                    "fatal": False,
                }
            )


async def _heartbeat(session: CallSession) -> None:
    try:
        while session.active:
            await asyncio.sleep(20)
            if time.monotonic() - session.started_monotonic > settings.max_call_minutes * 60:
                await manager.end_call(
                    session,
                    reason="time_limit",
                    status="time_limit",
                )
                return
            if not await session.send({"type": "keepalive", "t": time.time()}):
                return
    except asyncio.CancelledError:
        return


@app.websocket("/ws/voicelink")
async def voicelink_socket(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    if not is_local_origin(origin):
        await websocket.close(code=1008, reason="Local origins only")
        return
    await websocket.accept()
    await websocket.send_json(
        {
            "type": "hello",
            "service": "CareSpeak VoiceLink",
            "version": __version__,
            "local_only": True,
            "agent": {"extension": "CS-0000", "name": "Aria"},
            "limits": {
                "max_turns": settings.max_turns,
                "max_minutes": settings.max_call_minutes,
                "max_audio_bytes": settings.max_audio_bytes,
            },
            "capabilities": {
                "vad": True,
                "push_to_talk": True,
                "text_fallback": True,
                "barge_in": True,
            },
        }
    )

    session: Optional[CallSession] = None
    heartbeat: Optional[asyncio.Task] = None
    try:
        request = await _wait_for_start(websocket)
        if request is None:
            return
        caller, callee, demo_mode = request
        try:
            session = await manager.start_call(
                websocket, caller=caller, callee=callee, demo_mode=demo_mode
            )
        except ValidationError as exc:
            await websocket.send_json(
                {
                    "type": "error",
                    "code": exc.code,
                    "message": exc.message,
                    "fatal": True,
                }
            )
            await websocket.close(code=1008)
            return
        heartbeat = asyncio.create_task(_heartbeat(session))

        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                if session is None:
                    continue
                await manager.handle_audio(session, message["bytes"])
                continue
            text = message.get("text")
            if not text:
                continue
            if len(text) > 32_000:
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "message_too_large",
                        "message": "Control message is too large.",
                        "fatal": False,
                    }
                )
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "bad_json",
                        "message": "Expected a JSON control message.",
                        "fatal": False,
                    }
                )
                continue
            if payload.get("type") == "start_call":
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "call_already_started",
                        "message": "This socket already has an active call.",
                        "fatal": False,
                    }
                )
                continue
            keep_open = await manager.handle_control(session, payload)
            if not keep_open:
                break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "server_error",
                    "message": f"Local voice server error: {exc}",
                    "fatal": True,
                }
            )
        except Exception:
            pass
    finally:
        if heartbeat is not None:
            heartbeat.cancel()
        if session is not None:
            await manager.detach(session, reason="socket_closed")
        try:
            await websocket.close()
        except Exception:
            pass


@app.exception_handler(ValidationError)
async def validation_handler(request: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message, "code": exc.code},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level="info",
    )
