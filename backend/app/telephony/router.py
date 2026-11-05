"""FastAPI endpoints a telephony provider talks to.

Three entry points:

* ``POST /api/telephony/{provider}/events`` - call/message status webhooks.
* ``POST /api/telephony/{provider}/voice``  - the answer URL (TwiML for Twilio).
* ``WS   /api/telephony/{provider}/media``  - the bidirectional media stream that
  is bridged to the local AI pipeline.

Every webhook is signature-verified and de-duplicated before it can change state.
These routes are intentionally separate from ``/ws/voicelink`` so the browser demo
keeps working unchanged.
"""
from __future__ import annotations

import base64
import asyncio
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from starlette.websockets import WebSocketState

from app import database
from app.telephony import registry, webhooks
from app.telephony.audio import b64_decode
from app.telephony.bridge import EscalationRequest, TelephonyBridge
from app.telephony.webhooks import WebhookRejected

logger = logging.getLogger("voicelink.telephony")

router = APIRouter(prefix="/api/telephony", tags=["telephony"])

KNOWN_PROVIDERS = {"exotel", "twilio", "mock"}


def _service(request_or_ws: Any) -> Any:
    app = getattr(request_or_ws, "app", None)
    if app is None:
        app = request_or_ws.scope["app"]
    return app.state.service


def _provider_or_404(name: str) -> Any:
    if name not in KNOWN_PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown telephony provider.")
    return registry.get_provider(name)


# ---------------------------------------------------------------------------
# Status / delivery webhooks
# ---------------------------------------------------------------------------
@router.post("/{provider}/events")
async def provider_events(provider: str, request: Request) -> Response:
    resolved = _provider_or_404(provider)
    body = await request.body()
    headers = {k: v for k, v in request.headers.items()}
    url = str(request.url)
    kind_hint = "call.status" if request.query_params.get("type") == "call" else None
    try:
        event = webhooks.extract_event(
            resolved, headers, body, url, kind_hint=kind_hint
        )
    except WebhookRejected as exc:
        logger.warning("Rejected %s webhook: %s", provider, exc.code)
        return JSONResponse({"ok": False, "code": exc.code}, status_code=exc.status_code)
    service = _service(request)
    result = await service.handle_provider_event(event)
    return JSONResponse({"ok": True, **{k: v for k, v in result.items() if k != "ok"}})


# ---------------------------------------------------------------------------
# Answer URL (Twilio TwiML / Exotel acknowledgement)
# ---------------------------------------------------------------------------
@router.post("/{provider}/voice")
async def provider_voice(provider: str, request: Request) -> Response:
    resolved = _provider_or_404(provider)
    body = await request.body()
    headers = {k: v for k, v in request.headers.items()}
    url = str(request.url)

    if resolved.name != "mock":
        try:
            webhooks.verify(resolved, headers, body, url)
        except WebhookRejected as exc:
            logger.warning("Rejected %s voice webhook: %s", provider, exc.code)
            return Response(status_code=exc.status_code, content=exc.message)

    form = webhooks.parse_body(headers.get("content-type", ""), body)
    from_number = form.get("From") or form.get("from")
    to_number = form.get("To") or form.get("to")
    call_sid = form.get("CallSid") or form.get("CallSid") or form.get("call_sid")

    service = _service(request)
    if call_sid and database.get_telephony_call_by_provider_id(call_sid) is None:
        # An inbound call the platform has not seen yet.
        service.handle_inbound_call(
            from_number=from_number or "",
            to_number=to_number or "",
            provider_name=resolved.name,
            metadata={"provider_call_id": call_sid, "source": "voice_webhook"},
        )

    if resolved.name == "twilio":
        urls = service.urls(resolved.name)
        twiml = (
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
            "<Response><Connect>"
            f"<Stream url=\"{urls['stream_url']}\" />"
            "</Connect></Response>"
        )
        return Response(content=twiml, media_type="application/xml")

    # Exotel attaches AgentStream through its flow configuration / StreamUrl, so
    # the answer URL only needs to acknowledge the request.
    return JSONResponse({"ok": True, "provider": resolved.name, "stream_ready": True})


# ---------------------------------------------------------------------------
# Bidirectional media WebSocket
# ---------------------------------------------------------------------------
@router.websocket("/{provider}/media")
async def provider_media(websocket: WebSocket, provider: str) -> None:
    if provider not in KNOWN_PROVIDERS:
        await websocket.close(code=1008, reason="Unknown provider")
        return
    resolved = registry.get_provider(provider)

    # Exotel callbacks carry a shared-secret token; enforce it when configured.
    token = getattr(resolved, "webhook_secret", "") or ""
    if token and websocket.query_params.get("token", "") != token:
        await websocket.close(code=1008, reason="Invalid stream token")
        return

    await websocket.accept()

    service = _service(websocket)
    engine = websocket.app.state.engine

    stream_sid: Optional[str] = None
    call_record_id: Optional[str] = None
    bridge: Optional[TelephonyBridge] = None
    send_lock = asyncio.Lock()
    closed = asyncio.Event()

    async def send_event(event: dict[str, Any]) -> None:
        if websocket.client_state != WebSocketState.CONNECTED or closed.is_set():
            return
        try:
            async with send_lock:
                await websocket.send_json(event)
        except Exception:
            closed.set()

    async def send_audio(pcm: bytes) -> None:
        if not stream_sid:
            await send_event({"event": "connected"})
        await send_event(
            {
                "event": "media",
                "stream_sid": stream_sid,
                "media": {"payload": base64.b64encode(pcm).decode("ascii")},
            }
        )

    async def send_clear() -> None:
        await send_event({"event": "clear", "stream_sid": stream_sid})

    async def on_escalation(request: EscalationRequest) -> Optional[str]:
        await service.raise_escalation(
            patient_id=request.patient_id,
            decision=request.decision,
            call_id=request.call_id,
            excerpt=request.utterance,
            actor="voice_bridge",
        )
        return None

    try:
        while not closed.is_set():
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            text = message.get("text")
            if not text:
                continue
            try:
                payload = _json(text)
            except ValueError:
                continue
            event = (payload.get("event") or payload.get("type") or "").lower()

            if event in {"connected", "start", "mark", "dtmf"}:
                if event != "start":
                    continue
                stream_sid = (
                    payload.get("stream_sid")
                    or payload.get("streamSid")
                    or _nested(payload, "start", "stream_sid")
                    or _nested(payload, "start", "streamSid")
                )
                call_sid = (
                    payload.get("call_sid")
                    or payload.get("callSid")
                    or _nested(payload, "start", "call_sid")
                    or _nested(payload, "start", "callSid")
                )
                from_number = (
                    payload.get("from")
                    or _nested(payload, "start", "from")
                )
                to_number = payload.get("to") or _nested(payload, "start", "to")

                record = None
                if call_sid:
                    record = database.get_telephony_call_by_provider_id(call_sid)
                inbound_info: dict[str, Any] = {}
                if record is None:
                    inbound_info = service.handle_inbound_call(
                        from_number=from_number or "",
                        to_number=to_number or "",
                        provider_name=resolved.name,
                        metadata={"provider_call_id": call_sid, "source": "media_start"},
                    )
                    record = inbound_info.get("call")
                    if record and call_sid:
                        database.set_provider_call_id(record["id"], call_sid)

                if record:
                    call_record_id = record["id"]
                    database.update_telephony_call(
                        call_record_id,
                        state="connected",
                        answered=True,
                    )

                persona = (
                    (record or {}).get("metadata", {}).get("persona")
                    or inbound_info.get("persona")
                    or ("patient" if record and record.get("purpose") == "nurse_to_patient_ai" else "patient")
                )
                patient_id = (record or {}).get("patient_id") or inbound_info.get("patient_id")
                patient = (
                    database.get_patient_by_id(int(patient_id))
                    if patient_id
                    else None
                )
                bridge = TelephonyBridge(
                    engine=engine,
                    media_format=resolved.media_format,
                    send_audio=send_audio,
                    send_clear=send_clear,
                    call_id=call_record_id,
                    patient=patient,
                    patient_id=patient_id,
                    persona=persona,
                    demo_mode=_demo_mode(),
                    on_escalation=on_escalation,
                )
                await bridge.start()
                continue

            if event in {"media", "audio"} and bridge is not None:
                encoded = (
                    _nested(payload, "media", "payload")
                    or payload.get("payload")
                )
                if encoded:
                    try:
                        raw = b64_decode(encoded)
                    except Exception:
                        continue
                    await bridge.handle_media(raw)
                continue

            if event in {"stop", "close"}:
                break
            if event == "clear":
                continue
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Media stream error: %s", exc)
    finally:
        closed.set()
        if bridge is not None:
            try:
                await bridge.stop()
            except Exception:
                pass
        if call_record_id:
            try:
                database.update_telephony_call(
                    call_record_id, state="completed", ended=True
                )
                database.add_call_event(
                    call_record_id,
                    event_type="media.stop",
                    state="completed",
                    payload={"reason": "stream_closed"},
                    provider_event_id=f"media-stop:{call_record_id}",
                )
            except Exception:
                pass
        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close()
        except Exception:
            pass


def _demo_mode() -> bool:
    from app.config import settings

    return settings.demo_mode


def _json(text: str) -> dict[str, Any]:
    import json

    data = json.loads(text)
    return data if isinstance(data, dict) else {}


def _nested(payload: dict[str, Any], *path: str) -> Any:
    current: Any = payload
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current
