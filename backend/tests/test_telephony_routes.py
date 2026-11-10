"""Tests for the telephony HTTP/WebSocket router.

The carrier is always the deterministic mock provider or a fake bridge, so no
real call is placed.  The tests exercise the exact production routes: webhook
verification, TwiML generation, inbound-call discovery, media stream handling
and stream teardown.
"""
from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.websockets import WebSocketDisconnect

from app import database
from app.telephony import router as router_module
from app.telephony.audio import AudioFormat
from app.telephony.router import (
    _external_url,
    _json,
    _media_track,
    _nested,
    _provider_or_404,
    router,
)

PATIENT_PHONE = "+919876543210"
NURSE_PHONE = "+918000000001"

TABLES = (
    "call_events", "message_events", "telephony_calls", "messages",
    "escalation_actions", "escalations", "family_requests", "family_permissions",
    "scheduled_jobs", "verification_challenges", "sessions", "users",
    "audit_log", "webhook_events", "provider_config", "transcripts", "calls",
    "contacts",
)


# ---------------------------------------------------------------------------
# fakes
# ---------------------------------------------------------------------------
class FakeService:
    def __init__(self):
        self.events = []
        self.inbound = []
        self.escalations = []
        self.verified_urls = []

    def urls(self, provider_name):
        self.verified_urls.append(provider_name)
        return {
            "answer_url": "https://example.test/answer",
            "stream_url": "wss://example.test/stream",
            "status_url": "https://example.test/status",
        }

    async def handle_provider_event(self, event):
        self.events.append(event)
        return {"ok": True, "applied": True, "reason": "test"}

    def handle_inbound_call(self, **kwargs):
        self.inbound.append(kwargs)
        return {
            "call": {
                "id": "tcall_inbound",
                "patient_id": 1,
                "metadata": {"persona": "patient"},
                "purpose": "inbound",
            },
            "persona": "patient",
            "identified": True,
            "patient_id": 1,
        }

    async def raise_escalation(self, **kwargs):
        self.escalations.append(kwargs)
        return {"ok": True}


class FakeBridge:
    instances: list["FakeBridge"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.media: list[bytes] = []
        self.started = False
        self.stopped = False
        FakeBridge.instances.append(self)

    async def start(self):
        self.started = True

    async def handle_media(self, raw: bytes):
        self.media.append(raw)

    async def stop(self):
        self.stopped = True


@pytest.fixture(autouse=True)
def _reset_fake_bridge():
    FakeBridge.instances = []
    yield
    FakeBridge.instances = []


@pytest.fixture()
def db(clean_db):
    clean_db.init_db()
    with clean_db.connection() as conn:
        for table in TABLES:
            conn.execute(f"DELETE FROM {table}")
    return clean_db


@pytest.fixture()
def app(db, monkeypatch):
    application = FastAPI()
    application.state.service = FakeService()
    application.state.engine = SimpleNamespace(name="engine")
    application.include_router(router)
    monkeypatch.setattr(router_module, "TelephonyBridge", FakeBridge)
    return application


@pytest.fixture()
def client(app):
    with TestClient(app) as test_client:
        yield test_client


def _request(path="/api/telephony/twilio/events", *, scheme="http", host="127.0.0.1:8000",
             query="", headers=()):
    raw = [(b"host", host.encode())]
    raw.extend((key.encode(), value.encode()) for key, value in headers)
    return Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": scheme,
            "path": path,
            "query_string": query.encode(),
            "headers": raw,
            "server": (host.split(":")[0], 8000),
        }
    )


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def test_external_url_honours_forwarded_headers():
    request = _request(
        path="/api/telephony/twilio/events",
        query="type=call",
        headers=(("x-forwarded-proto", "https"), ("x-forwarded-host", "care.example.test")),
    )
    assert _external_url(request) == (
        "https://care.example.test/api/telephony/twilio/events?type=call"
    )


def test_external_url_falls_back_to_the_request():
    request = _request(path="/api/telephony/twilio/voice")
    assert _external_url(request) == "http://127.0.0.1:8000/api/telephony/twilio/voice"


def test_external_url_takes_the_first_forwarded_value():
    request = _request(
        headers=(
            ("x-forwarded-proto", "https, http"),
            ("x-forwarded-host", "public.example, internal.example"),
        )
    )
    assert _external_url(request).startswith("https://public.example/")


def test_provider_lookup_rejects_unknown_names():
    with pytest.raises(Exception) as exc:
        _provider_or_404("carrier-pigeon")
    assert exc.value.status_code == 404


def test_json_and_nested_helpers_are_defensive():
    assert _json('{"a": 1}') == {"a": 1}
    assert _json("[1, 2]") == {}
    with pytest.raises(ValueError):
        _json("not-json")
    assert _nested({"start": {"streamSid": "s"}}, "start", "streamSid") == "s"
    assert _nested({"start": "not-a-dict"}, "start", "streamSid") is None
    assert _nested({}, "a", "b") is None


def test_media_track_extraction():
    assert _media_track({"media": {"track": "outbound"}}) == "outbound"
    assert _media_track({"track": "Inbound"}) == "inbound"
    assert _media_track({}) is None


# ---------------------------------------------------------------------------
# status webhooks
# ---------------------------------------------------------------------------
def test_provider_event_is_verified_and_dispatched(client, app):
    response = client.post(
        "/api/telephony/mock/events?type=call",
        data={
            "event_id": "evt-1",
            "CallSid": "pc-1",
            "kind": "call.status",
            "state": "answered",
        },
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "applied": True, "reason": "test"}
    event = app.state.service.events[0]
    assert event.provider_call_id == "pc-1"
    assert event.state == "answered"


def test_provider_event_rejects_a_bad_signature(client, app):
    response = client.post(
        "/api/telephony/mock/events",
        data={"CallSid": "pc-1", "state": "answered"},
        headers={"x-mock-signature": "bogus"},
    )
    assert response.status_code == 401
    assert response.json() == {"ok": False, "code": "invalid_signature"}
    assert app.state.service.events == []


def test_provider_event_unknown_provider_is_404(client):
    assert client.post("/api/telephony/nope/events", data={}).status_code == 404


def test_provider_event_query_hint_sets_the_kind(client, app):
    client.post(
        "/api/telephony/mock/events?type=call",
        data={"event_id": "evt-hint", "CallSid": "pc-2", "state": "ringing"},
    )
    assert app.state.service.events[0].kind == "call.status"


# ---------------------------------------------------------------------------
# answer URL
# ---------------------------------------------------------------------------
def test_mock_answer_url_acknowledges_the_stream(client):
    response = client.post("/api/telephony/mock/voice", data={"From": PATIENT_PHONE, "To": NURSE_PHONE})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "provider": "mock", "stream_ready": True}


def test_twilio_answer_url_returns_twiml_with_the_stream(client, app, monkeypatch):
    monkeypatch.setattr(router_module.webhooks, "verify", lambda *a, **k: None)
    response = client.post(
        "/api/telephony/twilio/voice",
        data={"From": PATIENT_PHONE, "To": NURSE_PHONE},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/xml")
    assert '<Stream url="wss://example.test/stream" />' in response.text
    assert app.state.service.verified_urls == ["twilio"]


def test_voice_webhook_creates_an_unknown_inbound_call(client, app, monkeypatch, db):
    monkeypatch.setattr(router_module.webhooks, "verify", lambda *a, **k: None)
    client.post(
        "/api/telephony/twilio/voice",
        data={"From": PATIENT_PHONE, "To": NURSE_PHONE, "CallSid": "brand-new"},
    )
    inbound = app.state.service.inbound[0]
    assert inbound["from_number"] == PATIENT_PHONE
    assert inbound["to_number"] == NURSE_PHONE
    assert inbound["provider_name"] == "twilio"
    assert inbound["metadata"]["provider_call_id"] == "brand-new"


def test_voice_webhook_does_not_duplicate_a_known_call(client, app, monkeypatch, db):
    monkeypatch.setattr(router_module.webhooks, "verify", lambda *a, **k: None)
    record = db.create_telephony_call(
        provider="twilio", direction="outbound", from_e164=NURSE_PHONE,
        to_e164=PATIENT_PHONE, state="ringing",
    )
    db.set_provider_call_id(record["id"], "known-call")
    client.post(
        "/api/telephony/twilio/voice",
        data={"From": PATIENT_PHONE, "To": NURSE_PHONE, "CallSid": "known-call"},
    )
    assert app.state.service.inbound == []


def test_voice_webhook_rejects_an_unsigned_real_provider(client, app):
    response = client.post(
        "/api/telephony/twilio/voice",
        data={"From": PATIENT_PHONE, "To": NURSE_PHONE},
    )
    assert response.status_code == 401
    assert app.state.service.inbound == []


# ---------------------------------------------------------------------------
# media stream
# ---------------------------------------------------------------------------
def _start_payload(call_sid="pc-1", from_number=PATIENT_PHONE, to_number=NURSE_PHONE):
    return {
        "event": "start",
        "start": {
            "streamSid": "ss-1",
            "callSid": call_sid,
            "from": from_number,
            "to": to_number,
        },
    }


def test_media_stream_bridges_audio_and_tears_down(client, app, db):
    record = db.create_telephony_call(
        provider="mock", direction="outbound", from_e164=NURSE_PHONE,
        to_e164=PATIENT_PHONE, patient_id=1, state="ringing",
    )
    db.set_provider_call_id(record["id"], "pc-1")

    with client.websocket_connect("/api/telephony/mock/media") as ws:
        ws.send_json(_start_payload())
        # A real inbound frame reaches the bridge after base64 decoding.
        ws.send_json(
            {"event": "media", "media": {"payload": base64.b64encode(b"caller").decode()}}
        )
        # An echoed outbound track is ignored so the agent cannot hear itself.
        ws.send_json(
            {
                "event": "media",
                "media": {"track": "outbound", "payload": base64.b64encode(b"echo").decode()},
            }
        )
        ws.send_json({"event": "stop"})

    bridge = FakeBridge.instances[0]
    assert bridge.started is True
    assert bridge.kwargs["call_id"] == record["id"]
    assert bridge.kwargs["persona"] == "patient"
    assert bridge.kwargs["patient"]["display_name"] == "Asha Rao"
    assert bridge.media == [b"caller"]
    assert bridge.stopped is True
    stored = db.get_telephony_call(record["id"])
    assert stored["state"] == "completed"
    assert stored["ended_at"] is not None
    event_types = [e["event_type"] for e in db.list_call_events(record["id"])]
    assert "media.stop" in event_types


def test_media_stream_creates_an_inbound_call(client, app, db):
    with client.websocket_connect("/api/telephony/mock/media") as ws:
        ws.send_json(_start_payload(call_sid="unknown-call", from_number=PATIENT_PHONE))
        ws.send_json({"event": "stop"})
    inbound = app.state.service.inbound[0]
    assert inbound["from_number"] == PATIENT_PHONE
    assert inbound["metadata"]["provider_call_id"] == "unknown-call"


def test_media_stream_ignores_malformed_frames(client, app):
    with client.websocket_connect("/api/telephony/mock/media") as ws:
        ws.send_text("not-json")
        ws.send_json({"event": "media", "media": {"payload": "abc"}})
        ws.send_json(_start_payload())
        ws.send_json({"event": "media", "media": {"payload": "abc"}})
        ws.send_json({"event": "dtmf", "dtmf": {"digit": "1"}})
        ws.send_json({"event": "stop"})
    assert FakeBridge.instances[0].media == []


def test_media_stream_rejects_an_unknown_provider(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/api/telephony/nope/media"):
            pass
    assert exc.value.code == 1008


def test_media_stream_enforces_the_exotel_shared_secret(client, monkeypatch):
    fake_provider = SimpleNamespace(
        name="exotel",
        webhook_secret="shared-secret",
        media_format=AudioFormat(),
        stream_id_field="stream_sid",
        outbound_chunk_bytes=3200,
    )
    monkeypatch.setattr(router_module.registry, "get_provider", lambda name=None: fake_provider)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/api/telephony/exotel/media?token=wrong"):
            pass
    assert exc.value.code == 1008

    with client.websocket_connect("/api/telephony/exotel/media?token=shared-secret") as ws:
        ws.send_json(_start_payload())
        ws.send_json({"event": "stop"})
    assert FakeBridge.instances[0].started is True


def test_media_stream_without_a_secret_accepts_the_connection(client, monkeypatch):
    fake_provider = SimpleNamespace(
        name="exotel",
        webhook_secret="",
        media_format=AudioFormat(),
        stream_id_field="stream_sid",
        outbound_chunk_bytes=0,
    )
    monkeypatch.setattr(router_module.registry, "get_provider", lambda name=None: fake_provider)
    with client.websocket_connect("/api/telephony/exotel/media") as ws:
        ws.send_json(_start_payload())
        ws.send_json({"event": "stop"})
    assert FakeBridge.instances[0].started is True