"""Deep tests for the real carrier adapters (Twilio and Exotel).

All HTTP is served by ``httpx.MockTransport``: no request leaves the machine and
no real call, message or webhook is ever created.  The tests pin the published
wire formats, the honest state mapping and the fail-closed webhook checks.
"""
from __future__ import annotations

import base64
import functools
import hashlib
import hmac
import asyncio
from urllib.parse import parse_qs

import httpx
import pytest

from app.telephony.exotel import (
    ExotelProvider,
    _map_exotel_call_status,
    _map_exotel_sms_status,
)
from app.telephony.twilio import (
    TwilioProvider,
    _map_twilio_call_status,
    _map_twilio_message_status,
)

ACCOUNT_SID = "AC00000000000000000000000000000000"
AUTH_TOKEN = "twilio-auth-token"
FROM_NUMBER = "+918000000000"
TO_NUMBER = "+919876543210"


def async_test(fn):
    """Run an async test without requiring the pytest-asyncio plugin."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))

    return wrapper


@pytest.fixture()
def http(monkeypatch):
    """Install an httpx transport and expose the recorded requests."""
    requests: list[httpx.Request] = []
    state = {"handler": lambda request: httpx.Response(200, json={})}

    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return state["handler"](request)

        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return SimpleHTTP(requests, state)


class SimpleHTTP:
    def __init__(self, requests, state):
        self.requests = requests
        self.state = state

    def respond(self, response: httpx.Response) -> None:
        self.state["handler"] = lambda request: response

    def respond_json(self, payload, status_code=200) -> None:
        self.respond(httpx.Response(status_code, json=payload))

    def fail(self, error: Exception) -> None:
        def handler(request):
            raise error

        self.state["handler"] = handler


def twilio() -> TwilioProvider:
    return TwilioProvider(
        account_sid=ACCOUNT_SID,
        auth_token=AUTH_TOKEN,
        from_number=FROM_NUMBER,
        messaging_number="+918000000099",
        timeout_s=5,
    )


def exotel(**overrides) -> ExotelProvider:
    payload = dict(
        api_key="key",
        api_token="token",
        account_sid="acct",
        caller_id=FROM_NUMBER,
        webhook_secret="shared-token",
        dlt_entity_id="entity",
        dlt_template_id="template",
        timeout_s=5,
    )
    payload.update(overrides)
    return ExotelProvider(**payload)


# ---------------------------------------------------------------------------
# Twilio configuration
# ---------------------------------------------------------------------------
def test_twilio_configuration_and_capabilities():
    provider = twilio()
    assert provider.is_configured() is True
    assert provider.missing_configuration() == []
    assert provider.messaging_number == "+918000000099"
    caps = provider.capabilities()
    assert caps.outbound_calls and caps.inbound_calls and caps.bidirectional_audio
    assert caps.sms and caps.whatsapp and caps.message_status_callbacks
    assert provider.stream_id_field == "streamSid"
    assert provider.media_format.encoding == "mulaw"
    assert provider.media_format.sample_rate == 8000


def test_twilio_missing_configuration_is_reported():
    provider = TwilioProvider()
    assert provider.is_configured() is False
    assert provider.missing_configuration() == [
        "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER",
    ]
    assert provider.operating_mode() == "disabled"
    assert provider.describe()["configured"] is False


@async_test
async def test_twilio_health_tracks_configuration():
    assert (await TwilioProvider().health())["ok"] is False
    healthy = await twilio().health()
    assert healthy["ok"] is True
    assert healthy["unverified"] is True


@async_test
async def test_twilio_refuses_to_call_when_unconfigured(http):
    result = await TwilioProvider().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/answer", stream_url="wss://x/stream",
        status_url="https://x/status",
    )
    assert result.ok is False
    assert result.mode == "disabled"
    assert "TWILIO_ACCOUNT_SID" in result.detail
    assert http.requests == []


# ---------------------------------------------------------------------------
# Twilio calls
# ---------------------------------------------------------------------------
@async_test
async def test_twilio_start_outbound_call_wire_format(http):
    http.respond_json({"sid": "CA123", "status": "queued"})
    result = await twilio().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/answer", stream_url="wss://x/stream",
        status_url="https://x/status", record=True,
    )
    assert result.ok is True
    assert result.accepted is True
    assert result.provider_call_id == "CA123"
    assert result.state == "queued"

    request = http.requests[0]
    assert request.method == "POST"
    assert request.url.path.endswith(f"/Accounts/{ACCOUNT_SID}/Calls.json")
    form = parse_qs(request.content.decode())
    assert form["To"] == [TO_NUMBER]
    assert form["From"] == [FROM_NUMBER]
    assert form["Url"] == ["https://x/answer"]
    assert form["StatusCallback"] == ["https://x/status"]
    assert form["Record"] == ["true"]
    assert request.headers["authorization"].startswith("Basic ")


@async_test
async def test_twilio_start_call_uses_the_requested_caller_id(http):
    http.respond_json({"sid": "CA1", "status": "ringing"})
    await twilio().start_outbound_call(
        to_number=TO_NUMBER, from_number="+918000000777",
        answer_url="https://x/a", stream_url="wss://x/s", status_url="https://x/st",
    )
    form = parse_qs(http.requests[0].content.decode())
    assert form["From"] == ["+918000000777"]
    assert "Record" not in form


@async_test
async def test_twilio_maps_a_rejected_call(http):
    http.respond(httpx.Response(400, text="bad number"))
    result = await twilio().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/a", stream_url="wss://x/s", status_url="https://x/st",
    )
    assert result.ok is False
    assert result.accepted is False
    assert "400" in result.detail
    assert "bad number" in result.detail


@async_test
async def test_twilio_handles_network_failure(http):
    http.fail(httpx.ConnectError("boom"))
    result = await twilio().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/a", stream_url="wss://x/s", status_url="https://x/st",
    )
    assert result.ok is False
    assert "Twilio request failed" in result.detail


@async_test
async def test_twilio_status_and_end_call(http):
    http.respond_json({"status": "in-progress"})
    status = await twilio().get_call_status("CA1")
    assert status["ok"] is True
    assert status["state"] == "connected"
    assert http.requests[0].method == "GET"

    http.respond(httpx.Response(204))
    ended = await twilio().end_call("CA1")
    assert ended == {"ok": True, "provider_call_id": "CA1", "state": "completed"}
    assert http.requests[1].method == "POST"
    assert parse_qs(http.requests[1].content.decode()) == {"Status": ["completed"]}


@async_test
async def test_twilio_status_and_end_call_failures(http):
    http.fail(httpx.ConnectError("down"))
    status = await twilio().get_call_status("CA1")
    assert status["ok"] is False
    assert status["state"] == "unknown"

    http.respond(httpx.Response(500))
    ended = await twilio().end_call("CA1")
    assert ended["ok"] is False
    assert ended["state"] == "unknown"


# ---------------------------------------------------------------------------
# Twilio messages
# ---------------------------------------------------------------------------
@async_test
async def test_twilio_send_sms_and_whatsapp(http):
    http.respond_json({"sid": "SM1", "status": "queued"})
    sms = await twilio().send_message(
        to_number=TO_NUMBER, from_number=None, body="Hello",
        channel="sms", status_url="https://x/status",
    )
    assert sms.ok and sms.provider_message_id == "SM1"
    form = parse_qs(http.requests[0].content.decode())
    assert form["From"] == ["+918000000099"]  # the messaging number
    assert form["Body"] == ["Hello"]

    http.respond_json({"sid": "SM2", "status": "queued"})
    whatsapp = await twilio().send_message(
        to_number=TO_NUMBER, from_number=None, body="Hi",
        channel="whatsapp", status_url="https://x/status",
    )
    assert whatsapp.ok is True
    form = parse_qs(http.requests[1].content.decode())
    assert form["To"] == [f"whatsapp:{TO_NUMBER}"]
    assert form["From"] == ["whatsapp:+918000000099"]


@async_test
async def test_twilio_refuses_an_unsupported_channel(http):
    result = await twilio().send_message(
        to_number=TO_NUMBER, from_number=None, body="Hi",
        channel="carrier-pigeon", status_url="",
    )
    assert result.ok is False
    assert "carrier-pigeon" in result.detail
    assert http.requests == []


@async_test
async def test_twilio_message_failures(http):
    http.respond(httpx.Response(429, text="rate limited"))
    rejected = await twilio().send_message(
        to_number=TO_NUMBER, from_number=None, body="Hi",
        channel="sms", status_url="",
    )
    assert rejected.ok is False
    assert "429" in rejected.detail

    http.fail(httpx.ConnectError("down"))
    failed = await twilio().send_message(
        to_number=TO_NUMBER, from_number=None, body="Hi",
        channel="sms", status_url="",
    )
    assert failed.ok is False


@async_test
async def test_twilio_message_status_lookup(http):
    http.respond_json({"status": "delivered"})
    status = await twilio().get_message_status("SM1")
    assert status["ok"] is True
    assert status["state"] == "delivered"

    http.fail(httpx.ConnectError("down"))
    failed = await twilio().get_message_status("SM1")
    assert failed["ok"] is False


# ---------------------------------------------------------------------------
# Twilio webhooks
# ---------------------------------------------------------------------------
def _twilio_signature(token: str, url: str, params: dict[str, str]) -> str:
    signing = url + "".join(f"{key}{params[key]}" for key in sorted(params))
    digest = hmac.new(token.encode(), signing.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def test_twilio_verifies_a_valid_signature():
    url = "https://care.example.test/api/telephony/twilio/events"
    body = b"CallSid=CA1&CallStatus=ringing"
    headers = {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": _twilio_signature(
            AUTH_TOKEN, url, {"CallSid": "CA1", "CallStatus": "ringing"}
        ),
    }
    assert twilio().verify_webhook(headers, body, url) is True


def test_twilio_rejects_a_tampered_signature():
    url = "https://care.example.test/api/telephony/twilio/events"
    body = b"CallSid=CA1&CallStatus=ringing"
    headers = {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "not-the-signature",
    }
    assert twilio().verify_webhook(headers, body, url) is False
    # Missing token or signature always fails closed.
    assert twilio().verify_webhook({"content-type": "application/x-www-form-urlencoded"}, body, url) is False
    assert TwilioProvider(auth_token=AUTH_TOKEN).verify_webhook(headers, body, url) is False


def test_twilio_verifies_the_url_without_the_default_port():
    url = "https://care.example.test:443/api/telephony/twilio/events"
    body = b"CallSid=CA1"
    signed_url = "https://care.example.test/api/telephony/twilio/events"
    headers = {
        "x-twilio-signature": _twilio_signature(
            AUTH_TOKEN, signed_url, {"CallSid": "CA1"}
        )
    }
    assert twilio().verify_webhook(headers, body, url) is True


def test_twilio_parse_event_call_and_message():
    provider = twilio()
    call = provider.parse_event(
        {"CallSid": "CA1", "CallStatus": "in-progress", "From": TO_NUMBER,
         "To": FROM_NUMBER, "Direction": "outbound-api"}
    )
    assert call.kind == "call.status"
    assert call.event_id == "CA1:in-progress"
    assert call.state == "connected"
    assert call.direction == "outbound-api"
    assert call.from_number == TO_NUMBER

    message = provider.parse_event(
        {"MessageSid": "SM1", "MessageStatus": "delivered", "From": FROM_NUMBER, "To": TO_NUMBER}
    )
    assert message.kind == "message.status"
    assert message.event_id == "SM1:delivered"
    assert message.provider_message_id == "SM1"
    assert message.state == "delivered"


def test_twilio_status_maps_are_total():
    assert _map_twilio_call_status("queued") == "queued"
    assert _map_twilio_call_status("accepted") == "queued"
    assert _map_twilio_call_status("initiated") == "dialing"
    assert _map_twilio_call_status("in-progress") == "connected"
    assert _map_twilio_call_status("no-answer") == "no_answer"
    assert _map_twilio_call_status("canceled") == "cancelled"
    assert _map_twilio_call_status(None) == "unknown"
    assert _map_twilio_call_status("something-new") == "unknown"

    assert _map_twilio_message_status("queued") == "queued"
    assert _map_twilio_message_status("sent") == "sent"
    assert _map_twilio_message_status("delivered") == "delivered"
    assert _map_twilio_message_status("undelivered") == "undelivered"
    assert _map_twilio_message_status("failed") == "failed"
    assert _map_twilio_message_status("read") == "delivered"  # WhatsApp read == delivered
    assert _map_twilio_message_status("weird") == "unknown"


# ---------------------------------------------------------------------------
# Exotel configuration
# ---------------------------------------------------------------------------
def test_exotel_configuration_requires_a_webhook_secret():
    provider = exotel()
    assert provider.is_configured() is True
    assert provider.missing_configuration() == []

    unconfigured = ExotelProvider(api_key="k", api_token="t", account_sid="a", caller_id="+91")
    assert unconfigured.is_configured() is False
    assert "EXOTEL_WEBHOOK_SECRET" in unconfigured.missing_configuration()
    assert unconfigured.operating_mode() == "disabled"


def test_exotel_regions_and_capabilities():
    assert exotel().base_url == "https://api.in.exotel.com"
    assert exotel(subdomain="api.exotel.com").base_url == "https://api.exotel.com"
    caps = exotel().capabilities()
    assert caps.sms and caps.bidirectional_audio and caps.recording
    assert exotel().outbound_chunk_bytes == 3200
    assert exotel().media_format.encoding == "pcm16"


@async_test
async def test_exotel_health_reports_region():
    health = await exotel().health()
    assert health["ok"] is True
    assert health["region"] == "IN"
    assert (await ExotelProvider().health())["ok"] is False


@async_test
async def test_exotel_refuses_to_call_when_unconfigured(http):
    result = await ExotelProvider().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/a", stream_url="wss://x/s", status_url="https://x/st",
    )
    assert result.ok is False
    assert result.mode == "disabled"
    assert http.requests == []


# ---------------------------------------------------------------------------
# Exotel calls
# ---------------------------------------------------------------------------
@async_test
async def test_exotel_start_outbound_call_wire_format(http):
    http.respond_json({"Call": {"Sid": "exo-1", "Status": "in-progress"}})
    result = await exotel().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/a", stream_url="wss://x/s", status_url="https://x/st",
        record=True, metadata={"call_record_id": "tcall_1"},
    )
    assert result.ok is True
    assert result.accepted is True
    assert result.provider_call_id == "exo-1"
    # Never claim the callee answered before the webhook says so.
    assert result.state == "queued"

    request = http.requests[0]
    assert request.url.path == "/v1/Accounts/acct/Calls/connect"
    form = parse_qs(request.content.decode())
    assert form["From"] == [TO_NUMBER]
    assert form["CallerId"] == [FROM_NUMBER]
    assert form["StreamUrl"] == ["wss://x/s"]
    assert form["StreamType"] == ["bidirectional"]
    assert form["Record"] == ["true"]
    assert form["CustomField"] == ["tcall_1"]
    assert form["StatusCallbackEvents[]"] == ["answered", "terminal", "ringing"]
    assert request.headers["authorization"].startswith("Basic ")


@async_test
async def test_exotel_accepts_a_flat_response(http):
    http.respond_json({"Sid": "exo-2", "Status": "queued"})
    result = await exotel().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/a", stream_url="wss://x/s", status_url="https://x/st",
    )
    assert result.provider_call_id == "exo-2"


@async_test
async def test_exotel_rejects_non_json_and_http_errors(http):
    http.respond(httpx.Response(200, text="<html>not json</html>"))
    non_json = await exotel().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/a", stream_url="wss://x/s", status_url="https://x/st",
    )
    assert non_json.ok is False
    assert "non-JSON" in non_json.detail

    http.respond(httpx.Response(402, text="no credit"))
    rejected = await exotel().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/a", stream_url="wss://x/s", status_url="https://x/st",
    )
    assert rejected.ok is False
    assert "402" in rejected.detail
    assert rejected.raw == {"status_code": 402}

    http.fail(httpx.ConnectError("down"))
    failed = await exotel().start_outbound_call(
        to_number=TO_NUMBER, from_number=None,
        answer_url="https://x/a", stream_url="wss://x/s", status_url="https://x/st",
    )
    assert failed.ok is False
    assert failed.mode == "error"


@async_test
async def test_exotel_status_and_end_call(http):
    http.respond_json({"Call": {"Status": "in-progress"}})
    status = await exotel().get_call_status("exo-1")
    assert status["ok"] is True
    assert status["state"] == "connected"

    http.respond(httpx.Response(200))
    ended = await exotel().end_call("exo-1")
    assert ended["ok"] is True
    assert ended["state"] == "completed"

    http.fail(httpx.ConnectError("down"))
    assert (await exotel().get_call_status("exo-1"))["state"] == "unknown"
    assert (await exotel().end_call("exo-1"))["ok"] is False


# ---------------------------------------------------------------------------
# Exotel messages
# ---------------------------------------------------------------------------
@async_test
async def test_exotel_send_sms_includes_dlt_identifiers(http):
    http.respond_json({"SMSMessage": {"Sid": "sms-1", "Status": "queued"}})
    result = await exotel().send_message(
        to_number=TO_NUMBER, from_number=None, body="Hello",
        channel="sms", status_url="https://x/status",
    )
    assert result.ok is True
    assert result.provider_message_id == "sms-1"
    assert result.state == "queued"
    form = parse_qs(http.requests[0].content.decode())
    assert form["DltEntityId"] == ["entity"]
    assert form["DltTemplateId"] == ["template"]
    assert form["To"] == [TO_NUMBER]
    assert http.requests[0].url.path == "/v1/Accounts/acct/Sms/send"


@async_test
async def test_exotel_message_failures_and_channels(http):
    unsupported = await exotel().send_message(
        to_number=TO_NUMBER, from_number=None, body="Hi",
        channel="voice", status_url="",
    )
    assert unsupported.ok is False
    assert "voice" in unsupported.detail

    http.respond(httpx.Response(400, text="DLT rejected"))
    rejected = await exotel().send_message(
        to_number=TO_NUMBER, from_number=None, body="Hi",
        channel="sms", status_url="",
    )
    assert rejected.ok is False
    assert "400" in rejected.detail

    http.respond(httpx.Response(200, text="nope"))
    non_json = await exotel().send_message(
        to_number=TO_NUMBER, from_number=None, body="Hi",
        channel="sms", status_url="",
    )
    assert non_json.ok is False
    assert "non-JSON" in non_json.detail


@async_test
async def test_exotel_message_status_lookup(http):
    http.respond_json({"SMSMessage": {"DetailedStatus": "delivered_to_handset"}})
    status = await exotel().get_message_status("sms-1")
    assert status["ok"] is True
    assert status["state"] == "delivered"

    http.fail(httpx.ConnectError("down"))
    assert (await exotel().get_message_status("sms-1"))["ok"] is False


# ---------------------------------------------------------------------------
# Exotel webhooks
# ---------------------------------------------------------------------------
def test_exotel_webhook_shared_token():
    provider = exotel()
    body = b"CallSid=exo-1&Status=ringing"
    url = "https://care.example.test/api/telephony/exotel/events?token=shared-token"
    assert provider.verify_webhook({}, body, url) is True
    assert provider.verify_webhook({}, body, url.replace("shared-token", "wrong")) is False
    # A token header is accepted too.
    assert provider.verify_webhook({"x-voicelink-token": "shared-token"}, body, "https://x/") is True
    assert ExotelProvider().verify_webhook({}, body, url) is False


def test_exotel_webhook_hmac_header():
    provider = exotel()
    body = b'{"CallSid": "exo-1"}'
    signature = hmac.new(b"shared-token", body, hashlib.sha256).hexdigest()
    url = "https://care.example.test/api/telephony/exotel/events"
    assert provider.verify_webhook({"x-voicelink-signature": signature}, body, url) is True
    assert provider.verify_webhook({"x-voicelink-signature": "bad"}, body, url) is False


def test_exotel_parse_event_call_and_message():
    provider = exotel()
    call = provider.parse_event(
        {"CallSid": "exo-1", "Status": "in-progress", "From": TO_NUMBER,
         "To": FROM_NUMBER, "Direction": "outbound", "EventId": "evt-1"}
    )
    assert call.event_id == "evt-1"
    assert call.kind == "call.status"
    assert call.state == "connected"
    assert call.from_number == TO_NUMBER

    message = provider.parse_event(
        {"SmsSid": "sms-1", "Status": "delivered", "From": FROM_NUMBER, "To": TO_NUMBER}
    )
    assert message.kind == "message.status"
    assert message.provider_message_id == "sms-1"
    assert message.state == "delivered"

    nested = provider.parse_event(
        {"SMSMessage": {"Sid": "sms-2"}, "DetailedStatus": "failed"}
    )
    assert nested.provider_message_id == "sms-2"
    assert nested.state == "failed"
    assert nested.event_id == "sms-2"


def test_exotel_event_ids_and_error_detail():
    provider = exotel()
    event = provider.parse_event({"CallSid": "exo-9", "Status": "failed", "ErrorCode": "E500"})
    assert event.event_id == "exo-9:failed"
    assert event.detail == "E500"
    assert event.state == "failed"


def test_exotel_status_maps_are_total():
    assert _map_exotel_call_status("in-progress") == "connected"
    assert _map_exotel_call_status("in_progress") == "connected"
    assert _map_exotel_call_status("no-answer") == "no_answer"
    assert _map_exotel_call_status("canceled") == "cancelled"
    assert _map_exotel_call_status("") == "queued"
    assert _map_exotel_call_status("something-else") == "provider_timeout"

    assert _map_exotel_sms_status("submitted") == "sent"
    assert _map_exotel_sms_status("delivered_to_handset") == "delivered"
    assert _map_exotel_sms_status("rejected") == "failed"
    assert _map_exotel_sms_status("invalid") == "failed"
    assert _map_exotel_sms_status("mystery") == "unknown"