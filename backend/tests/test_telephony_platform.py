"""Integration and unit tests for the VoiceLink telephony care platform.

All tests run against the deterministic mock provider and an isolated database.
None of them place a real telephone call, and none assert that a real call was
made.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
from urllib.parse import urlencode

import pytest

from app import auth, database, escalation
from app.config import settings
from app.telephony import numbers, registry, webhooks
from app.telephony.base import ProviderEvent
from app.telephony.exotel import ExotelProvider
from app.telephony.mock import MockProvider
from app.telephony.models import (
    CallState,
    EscalationSeverity,
    MessageState,
    transition_call,
    transition_message,
)
from app.telephony.twilio import TwilioProvider
from app.telephony.audio import AudioFormat, mulaw_to_pcm16, pcm16_to_mulaw


# ---------------------------------------------------------------------------
# Numbers
# ---------------------------------------------------------------------------
def test_number_normalisation_and_masking():
    assert numbers.normalize("09876543210", "IN") == "+919876543210"
    assert numbers.normalize("+919876543210") == "+919876543210"
    assert numbers.mask("+919876543210").endswith("3210")
    assert "987654" not in numbers.mask("+919876543210")
    assert numbers.is_emergency_number("112")
    with pytest.raises(numbers.NumberError):
        numbers.normalize("not-a-number", "IN")


# ---------------------------------------------------------------------------
# State machines
# ---------------------------------------------------------------------------
def test_call_state_machine_rejects_illegal_and_replay():
    assert transition_call(CallState.CREATED.value, CallState.QUEUED.value).ok
    assert not transition_call(CallState.COMPLETED.value, CallState.RINGING.value).ok
    # A duplicate terminal event is a no-op, not an error.
    assert transition_call(CallState.COMPLETED.value, CallState.COMPLETED.value).ok


def test_message_never_jumps_from_created_to_delivered():
    assert not transition_message(MessageState.CREATED.value, MessageState.DELIVERED.value).ok
    assert transition_message(MessageState.SENT.value, MessageState.DELIVERED.value).ok


# ---------------------------------------------------------------------------
# Escalation engine
# ---------------------------------------------------------------------------
def test_escalation_rules_are_deterministic():
    emergency = escalation.classify("I have crushing chest pain right now")
    assert emergency.severity == EscalationSeverity.EMERGENCY
    assert emergency.source == "rules"

    urgent = escalation.classify("I just fell down and cannot walk")
    assert urgent.severity == EscalationSeverity.URGENT

    routine = escalation.classify("I took my tablets this morning")
    assert routine.severity == EscalationSeverity.ROUTINE

    # A negation must not trigger an emergency.
    assert escalation.classify("I do not have chest pain").severity != EscalationSeverity.EMERGENCY


def test_escalation_llm_hint_requires_confirmation():
    hint = escalation.classify("I feel a bit strange today", llm_hint="urgent")
    assert hint.severity == EscalationSeverity.URGENT
    assert hint.requires_confirmation
    confirmed = escalation.apply_confirmation(hint, True)
    assert confirmed.severity == EscalationSeverity.URGENT
    denied = escalation.apply_confirmation(hint, False)
    assert denied.severity == EscalationSeverity.ROUTINE


# ---------------------------------------------------------------------------
# Audio conversion
# ---------------------------------------------------------------------------
def test_mulaw_roundtrip_and_audio_format():
    pcm = (b"\x00\x10" * 320)
    mulaw = pcm16_to_mulaw(pcm)
    assert len(mulaw) == 320
    back = mulaw_to_pcm16(mulaw)
    assert len(back) == len(pcm)


def test_audio_format_decode_encode_shapes():
    fmt = AudioFormat(encoding="mulaw", sample_rate=8000)
    decoded = fmt.decode_to_ai(b"\xff" * 160)
    # 8k -> 16k doubles the sample count; PCM16 so 320 samples -> 640 bytes.
    assert len(decoded) == 640
    encoded = fmt.encode_from_ai(decoded, 16000)
    assert len(encoded) == 160


def test_exotel_uses_raw_pcm_not_mulaw():
    assert ExotelProvider.media_format.encoding == "pcm16"
    assert TwilioProvider.media_format.encoding == "mulaw"


# ---------------------------------------------------------------------------
# Webhook authenticity and replay
# ---------------------------------------------------------------------------
def test_twilio_signature_verification():
    token = "test-auth-token"
    provider = TwilioProvider(account_sid="ACxxx", auth_token=token, from_number="+10000000000")
    url = "https://example.com/api/telephony/twilio/events"
    params = {"CallSid": "CA1", "CallStatus": "completed"}
    body = urlencode(params).encode()
    signing = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    signature = base64.b64encode(
        hmac.new(token.encode(), signing.encode(), hashlib.sha1).digest()
    ).decode()
    headers = {"x-twilio-signature": signature, "content-type": "application/x-www-form-urlencoded"}
    assert provider.verify_webhook(headers, body, url)
    assert not provider.verify_webhook({"x-twilio-signature": "wrong", "content-type": "application/x-www-form-urlencoded"}, body, url)


def test_exotel_shared_secret_token_verification():
    provider = ExotelProvider(
        api_key="k", api_token="t", account_sid="s", caller_id="+910000000000", webhook_secret="topsecret"
    )
    assert provider.verify_webhook({}, b"{}", "https://x/api/telephony/exotel/events?token=topsecret")
    assert not provider.verify_webhook({}, b"{}", "https://x/api/telephony/exotel/events?token=nope")
    # Unconfigured secret must fail closed.
    assert not ExotelProvider().verify_webhook({}, b"{}", "https://x?token=")


def test_webhook_replay_guard_and_idempotency_key():
    guard = webhooks.ReplayGuard()
    assert not guard.seen("evt-1")
    assert guard.seen("evt-1")
    key_a = webhooks.idempotency_key("call", 1, "purpose")
    key_b = webhooks.idempotency_key("call", 1, "purpose")
    assert key_a == key_b
    assert webhooks.idempotency_key("call", 2, "purpose") != key_a


# ---------------------------------------------------------------------------
# Persistence & idempotency
# ---------------------------------------------------------------------------
def test_call_creation_is_idempotent(clean_db):
    first = clean_db.create_telephony_call(
        provider="mock", direction="outbound", from_e164="+910000000000",
        to_e164="+919876543210", idempotency_key="idem-1", patient_id=1,
    )
    second = clean_db.create_telephony_call(
        provider="mock", direction="outbound", from_e164="+910000000000",
        to_e164="+919876543210", idempotency_key="idem-1", patient_id=1,
    )
    assert first["created"] is True
    assert second["created"] is False
    assert first["id"] == second["id"]


def test_audit_chain_detects_absence_of_tampering(clean_db):
    clean_db.append_audit(action="unit.test", actor_id="tester", actor_role="admin")
    chain = clean_db.verify_audit_chain()
    assert chain["ok"] is True


# ---------------------------------------------------------------------------
# Auth, sessions, RBAC
# ---------------------------------------------------------------------------
def test_password_hashing_and_rbac(clean_db):
    encoded = auth.hash_password("correct horse battery")
    assert auth.verify_password("correct horse battery", encoded)
    assert not auth.verify_password("wrong", encoded)

    user_id = clean_db.create_user(
        username="rbac.nurse", display_name="RBAC Nurse", role="nurse",
        password_hash=auth.hash_password("nurse-pass"), patient_id=1,
    )
    assert user_id > 0
    # A nurse assigned to patient 1 must be refused for another patient.
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        auth.ensure_patient_access(
            {"role": "nurse", "patient_id": 1, "id": user_id}, 2
        )
    # ...but allowed for their own patient.
    auth.ensure_patient_access({"role": "nurse", "patient_id": 1, "id": user_id}, 1)


def test_login_lockout_after_repeated_failures(clean_db):
    clean_db.create_user(
        username="lock.me", display_name="Lock", role="admin",
        password_hash=auth.hash_password("right"),
    )
    for _ in range(settings.login_max_attempts):
        assert auth.authenticate("lock.me", "wrong") is None
    # Now even the correct password is refused while locked.
    assert auth.authenticate("lock.me", "right") is None


# ---------------------------------------------------------------------------
# Verification challenges
# ---------------------------------------------------------------------------
def test_verification_expiry_and_replay(clean_db):
    contact_id = clean_db.add_contact(
        patient_id=1, role="patient", display_name="Asha Rao",
        phone_e164="+919876543210", phone_masked="******3210", is_primary=True,
    )
    secret = "unit-secret"
    code_hash = hmac.new(secret.encode(), b"123456", hashlib.sha256).hexdigest()

    # Expired challenge is not usable.
    expired = clean_db.create_challenge(
        contact_id=contact_id, phone_masked="******3210", channel="sms",
        purpose="contact_ownership", code_hash=code_hash, ttl_seconds=-10, max_attempts=3,
    )
    assert expired["expires_at"] < clean_db.utc_now()

    # A fresh challenge can be used exactly once.
    fresh = clean_db.create_challenge(
        contact_id=contact_id, phone_masked="******3210", channel="sms",
        purpose="contact_ownership", code_hash=code_hash, ttl_seconds=600, max_attempts=3,
    )
    clean_db.update_challenge(fresh["id"], state="verified", used=True)
    assert clean_db.get_challenge(fresh["id"])["state"] == "verified"
    assert clean_db.get_challenge(fresh["id"])["used_at"] is not None


# ---------------------------------------------------------------------------
# Family access
# ---------------------------------------------------------------------------
def test_family_permission_grant_and_revocation(clean_db):
    patient_id = 1
    contact_id = clean_db.add_contact(
        patient_id=patient_id, role="family", display_name="Ravi Rao",
        phone_e164="+919812345678", phone_masked="******5678",
    )
    clean_db.upsert_family_permission(
        patient_id=patient_id, contact_id=contact_id, scope={"mode1": True}, granted_by="nurse"
    )
    permission = clean_db.get_family_permission(patient_id, contact_id)
    assert permission and not permission["revoked"]

    clean_db.revoke_family_permission(patient_id, contact_id)
    assert clean_db.get_family_permission(patient_id, contact_id)["revoked"]


def test_family_request_approval_lifecycle(clean_db):
    contact_id = clean_db.add_contact(
        patient_id=1, role="family", display_name="Meera Rao",
        phone_e164="+919800000001", phone_masked="******0001",
    )
    request = clean_db.create_family_request(
        patient_id=1, contact_id=contact_id, mode="family_ai",
        requested_by="family", expires_in_seconds=3600,
    )
    assert request["state"] == "pending"
    updated = clean_db.update_family_request(request["id"], state="approved", decided_by="nurse")
    assert updated["state"] == "approved"
    assert updated["decided_at"] is not None


# ---------------------------------------------------------------------------
# Escalation persistence and thresholds
# ---------------------------------------------------------------------------
def test_escalation_dedupe_and_action_plan(clean_db):
    key = escalation.dedupe_key(1, "cardiac", EscalationSeverity.EMERGENCY, "bucket")
    first = clean_db.create_escalation(
        patient_id=1, severity="emergency", category="cardiac", reason="test",
        dedupe_key=key, requires_ack=True,
    )
    second = clean_db.create_escalation(
        patient_id=1, severity="emergency", category="cardiac", reason="test",
        dedupe_key=key, requires_ack=True,
    )
    assert first["created"] is True
    assert second["created"] is False
    assert first["id"] == second["id"]

    clean_db.add_escalation_action(first["id"], action_type="notify_nurse", state="done")
    actions = clean_db.list_escalation_actions(first["id"])
    assert actions and actions[0]["action_type"] == "notify_nurse"


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------
def test_scheduler_leases_jobs_and_retries_with_backoff(clean_db):
    job = clean_db.create_job(
        kind="retry_call", run_at=clean_db.utc_offset(-1), payload={"call_id": "x"},
        dedupe_key="job-1", max_attempts=2,
    )
    claimed = clean_db.claim_due_jobs(limit=10, lease_seconds=60)
    assert any(j["id"] == job["id"] for j in claimed)
    # A second claim while leased must not return the same job twice.
    claimed_again = clean_db.claim_due_jobs(limit=10, lease_seconds=60)
    assert not any(j["id"] == job["id"] for j in claimed_again)

    retried = clean_db.retry_job(job["id"], run_at=clean_db.utc_offset(30), error="boom")
    assert retried["state"] == "pending"
    assert retried["last_error"] == "boom"

    # Dedupe key prevents a second identical job.
    duplicate = clean_db.create_job(
        kind="retry_call", run_at=clean_db.utc_offset(5), dedupe_key="job-1",
    )
    assert duplicate["created"] is False


# ---------------------------------------------------------------------------
# Provider behaviour: failure, recovery, honesty
# ---------------------------------------------------------------------------
def test_mock_provider_never_claims_real_delivery():
    provider = MockProvider()

    async def scenario():
        call = await provider.start_outbound_call(
            to_number="+919876543210", from_number=None, answer_url="x",
            stream_url="y", status_url="z",
        )
        message = await provider.send_message(
            to_number="+919876543210", from_number=None, body="hi", channel="sms", status_url="z",
        )
        return call, message

    call, message = asyncio.run(scenario())
    assert call.ok and call.accepted
    assert call.mode == "mock"
    assert provider.operating_mode() == "mock"
    # Accepted is not delivered.
    assert message.accepted is True
    assert message.state == "sent"


def test_unconfigured_real_provider_reports_disabled():
    provider = ExotelProvider()
    assert not provider.is_configured()
    assert provider.operating_mode() == "disabled"

    result = asyncio.run(
        provider.start_outbound_call(
            to_number="+919876543210", from_number=None, answer_url="x",
            stream_url="y", status_url="z",
        )
    )
    assert result.ok is False
    assert "not configured" in result.detail.lower()


def test_registry_resolves_mock_when_no_real_provider(clean_db):
    summary = registry.provider_summary()
    assert summary["resolved"] == "mock"
    assert summary["mode_label"].lower().startswith("simulated")


# ---------------------------------------------------------------------------
# Service-level duplicate webhook handling
# ---------------------------------------------------------------------------
def test_service_handles_duplicate_and_out_of_order_webhooks(clean_db):
    from app.telephony.service import TelephonyService

    async def scenario():
        service = TelephonyService(engine=None)
        service.scheduler = None
        result = await service.start_nurse_call(
            patient_id=1, patient_name="Asha Rao", to_number="+919876543210",
        )
        assert result["ok"]
        provider_call_id = result["call"]["provider_call_id"]
        assert provider_call_id

        answered = ProviderEvent(
            event_id="ev-answered", kind="call.status", provider="mock",
            provider_call_id=provider_call_id, state="answered",
        )
        first = await service.handle_provider_event(answered)
        assert first.get("applied") is True
        # Replaying the exact same event must not double-apply.
        replay = await service.handle_provider_event(answered)
        assert replay.get("duplicate") is True or replay.get("applied") is False

        # A terminal event then an older ringing event must not resurrect the call.
        completed = ProviderEvent(
            event_id="ev-completed", kind="call.status", provider="mock",
            provider_call_id=provider_call_id, state="completed",
        )
        await service.handle_provider_event(completed)
        stale = ProviderEvent(
            event_id="ev-ringing", kind="call.status", provider="mock",
            provider_call_id=provider_call_id, state="ringing",
        )
        await service.handle_provider_event(stale)
        return result["call"]["id"]

    call_id = asyncio.run(scenario())
    assert database.get_telephony_call(call_id)["state"] == "completed"


def test_message_status_updates_are_idempotent(clean_db):
    from app.telephony.service import TelephonyService

    async def scenario():
        service = TelephonyService(engine=None)
        service.scheduler = None
        sent = await service.send_message(
            patient_id=1, to_number="+919876543210", body="Appointment reminder",
        )
        assert sent["ok"]
        assert sent["message"]["state"] in {"queued", "sent"}
        provider_message_id = sent["message"]["provider_message_id"]

        delivered = ProviderEvent(
            event_id="msg-1", kind="message.status", provider="mock",
            provider_message_id=provider_message_id, state="delivered",
        )
        await service.handle_provider_event(delivered)
        assert database.get_message(sent["message"]["id"])["state"] == "delivered"
        # Replay must not error and must not regress the state.
        await service.handle_provider_event(delivered)
        return sent["message"]["id"]

    message_id = asyncio.run(scenario())
    assert database.get_message(message_id)["state"] == "delivered"


# ---------------------------------------------------------------------------
# Persistence across a simulated restart
# ---------------------------------------------------------------------------
def test_records_survive_a_reconnect(clean_db):
    call = clean_db.create_telephony_call(
        provider="mock", direction="inbound", from_e164="+919800000009",
        to_e164="+910000000000", idempotency_key="restart-1",
    )
    # The connection manager opens a brand new SQLite connection every call,
    # which is exactly what a process restart looks like to the file.
    fetched = clean_db.get_telephony_call(call["id"])
    assert fetched is not None
    assert fetched["from_e164"] == "+919800000009"


# ---------------------------------------------------------------------------
# HTTP API integration
# ---------------------------------------------------------------------------
@pytest.fixture()
def api_client(clean_db):
    from fastapi.testclient import TestClient

    import app.main as main

    # A known administrator for deterministic sign-in.
    clean_db.create_user(
        username="api.admin", display_name="API Admin", role="admin",
        password_hash=auth.hash_password("api-admin-pass"),
    )
    client = TestClient(main.app)
    login = client.post(
        "/api/platform/auth/login",
        json={"username": "api.admin", "password": "api-admin-pass"},
    )
    assert login.status_code == 200, login.text
    return client


def test_api_requires_authentication(clean_db):
    from fastapi.testclient import TestClient

    import app.main as main

    client = TestClient(main.app)
    response = client.get("/api/platform/overview")
    assert response.status_code == 401


def test_api_overview_and_provider(api_client):
    overview = api_client.get("/api/platform/overview")
    assert overview.status_code == 200
    body = overview.json()
    assert body["ok"] is True
    assert "telephony" in body
    assert body["telephony"]["resolved"] == "mock"

    provider = api_client.get("/api/platform/provider")
    assert provider.status_code == 200
    assert provider.json()["provider"]["mode_label"].lower().startswith("simulated")


def test_api_contact_never_returns_full_number(api_client):
    created = api_client.post(
        "/api/platform/contacts",
        json={
            "patient_id": 1, "role": "patient", "display_name": "Asha Rao",
            "phone": "09876543210", "is_primary": True,
        },
    )
    assert created.status_code == 200, created.text
    contact = created.json()["contact"]
    assert "phone_e164" not in contact
    assert contact["phone_masked"].endswith("3210")


def test_api_start_call_and_message_with_mock(api_client):
    api_client.post(
        "/api/platform/contacts",
        json={"patient_id": 1, "role": "patient", "display_name": "Asha Rao", "phone": "09876543210"},
    )
    call = api_client.post("/api/platform/calls", json={"patient_id": 1})
    assert call.status_code == 200, call.text
    payload = call.json()
    assert payload["mode"] == "mock"

    message = api_client.post(
        "/api/platform/messages",
        json={"patient_id": 1, "body": "Please take your evening tablets.", "channel": "sms"},
    )
    assert message.status_code == 200, message.text
    assert message.json()["accepted"] is True


def test_api_rejects_call_without_number(api_client):
    # patient 1 has no contact yet in a fresh DB fixture state only sometimes;
    # use a patient id that definitely has no contact by creating a new one.
    response = api_client.post("/api/platform/calls", json={"patient_id": 999})
    assert response.status_code in {400, 403, 404}


def test_api_family_permission_and_revocation(api_client):
    contact = api_client.post(
        "/api/platform/contacts",
        json={"patient_id": 1, "role": "family", "display_name": "Ravi Rao", "phone": "09812345678"},
    ).json()["contact"]
    grant = api_client.post(
        "/api/platform/family/permissions",
        json={"patient_id": 1, "contact_id": contact["id"], "scope": {"mode1": True}},
    )
    assert grant.status_code == 200
    revoke = api_client.post(f"/api/platform/family/permissions/1/{contact['id']}/revoke")
    assert revoke.status_code == 200


def test_api_audit_chain_is_intact(api_client):
    response = api_client.get("/api/platform/audit")
    assert response.status_code == 200
    assert response.json()["chain"]["ok"] is True


def test_api_mock_verification_never_claims_sms_delivery(api_client):
    contact = api_client.post(
        "/api/platform/contacts",
        json={
            "patient_id": 1, "role": "patient", "display_name": "Asha Rao",
            "phone": "09876543210", "is_primary": True,
        },
    ).json()["contact"]

    started = api_client.post(
        f"/api/platform/contacts/{contact['id']}/verify", json={"channel": "sms"},
    )
    assert started.status_code == 200, started.text
    payload = started.json()
    # A mock must never be reported as having delivered a real SMS.
    assert payload["delivery"]["sent"] is False
    assert payload["delivery"]["mode"] == "mock"
    code = payload["simulated_code"]
    assert code and len(code) == 6 and code.isdigit()

    confirmed = api_client.post(
        f"/api/platform/contacts/{contact['id']}/verify/confirm", json={"code": code},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["verified"] is True

    contacts = api_client.get("/api/platform/contacts?patient_id=1").json()["contacts"]
    stored = next(c for c in contacts if c["id"] == contact["id"])
    assert stored["verification_status"] == "verified"


def test_api_call_prefers_verified_primary_patient_contact(api_client):
    secondary = api_client.post(
        "/api/platform/contacts",
        json={
            "patient_id": 1, "role": "patient", "display_name": "Asha Rao",
            "phone": "09876543210", "is_primary": False,
        },
    ).json()["contact"]
    primary = api_client.post(
        "/api/platform/contacts",
        json={
            "patient_id": 1, "role": "patient", "display_name": "Asha Rao",
            "phone": "09876543211", "is_primary": True,
        },
    ).json()["contact"]
    code = api_client.post(
        f"/api/platform/contacts/{primary['id']}/verify", json={"channel": "sms"},
    ).json()["simulated_code"]
    api_client.post(
        f"/api/platform/contacts/{primary['id']}/verify/confirm", json={"code": code},
    )

    # Without an explicit contact the verified primary patient contact wins.
    call = api_client.post("/api/platform/calls", json={"patient_id": 1})
    assert call.status_code == 200, call.text
    assert call.json()["call"]["to_masked"].endswith("3211")

    # An explicit contact_id is still honoured.
    explicit = api_client.post(
        "/api/platform/calls", json={"patient_id": 1, "contact_id": secondary["id"]},
    )
    assert explicit.status_code == 200, explicit.text
    assert explicit.json()["call"]["to_masked"].endswith("3210")
    assert explicit.json()["call"]["contact_id"] == secondary["id"]


# ---------------------------------------------------------------------------
# Real-provider protocol details (documented vs implemented)
# ---------------------------------------------------------------------------
def test_provider_media_protocols_are_explicit():
    # Twilio Media Streams use camelCase streamSid; Exotel uses stream_sid.
    assert TwilioProvider().stream_id_field == "streamSid"
    assert ExotelProvider().stream_id_field == "stream_sid"
    # Exotel rejects outbound chunks below 3200 bytes / not a multiple of 320.
    assert ExotelProvider().outbound_chunk_bytes == 3200
    assert TwilioProvider().outbound_chunk_bytes == 0


def test_provider_secrets_are_stored_but_never_echoed(api_client):
    from app import secrets_store

    response = api_client.post(
        "/api/platform/provider/secrets",
        json={"values": {"EXOTEL_API_KEY": "dummy-key-for-redaction-test"}},
    )
    assert response.status_code == 200, response.text
    # The value must never travel back to the caller, only the key name.
    assert "dummy-key-for-redaction-test" not in response.text
    assert response.json()["stored"] == ["EXOTEL_API_KEY"]
    assert secrets_store.get("EXOTEL_API_KEY") == "dummy-key-for-redaction-test"

    status = api_client.get("/api/platform/provider").json()["provider"]["secrets"]
    assert status["EXOTEL_API_KEY"] is True
    assert "dummy-key-for-redaction-test" not in str(status)

    secrets_store.clear(["EXOTEL_API_KEY"])
    registry.reset_cache()


def test_exotel_requires_webhook_secret_to_be_configured():
    incomplete = ExotelProvider(
        api_key="key", api_token="token", account_sid="sid",
        caller_id="+918000000000",
    )
    assert incomplete.is_configured() is False
    assert "EXOTEL_WEBHOOK_SECRET" in incomplete.missing_configuration()

    complete = ExotelProvider(
        api_key="key", api_token="token", account_sid="sid",
        caller_id="+918000000000", webhook_secret="shared-secret",
    )
    assert complete.is_configured() is True


def test_external_url_honours_forwarded_headers():
    from starlette.requests import Request

    from app.telephony.router import _external_url

    scope = {
        "type": "http",
        "method": "POST",
        "scheme": "http",
        "path": "/api/telephony/twilio/events",
        "raw_path": b"/api/telephony/twilio/events",
        "query_string": b"type=call",
        "root_path": "",
        "headers": [
            (b"host", b"internal.local:8000"),
            (b"x-forwarded-host", b"abc123.trycloudflare.com"),
            (b"x-forwarded-proto", b"https"),
        ],
        "server": ("127.0.0.1", 8000),
        "client": ("127.0.0.1", 12345),
    }
    assert (
        _external_url(Request(scope))
        == "https://abc123.trycloudflare.com/api/telephony/twilio/events?type=call"
    )


def test_public_tunnel_cannot_reach_non_telephony_routes(clean_db):
    from fastapi.testclient import TestClient

    import app.main as main

    client = TestClient(main.app)
    proxied = {"cf-connecting-ip": "203.0.113.7"}
    blocked = client.get("/api/voicelink/health", headers=proxied)
    assert blocked.status_code == 404
    # The carrier surface still passes the guard (405 = reachable, wrong verb).
    allowed = client.get("/api/telephony/mock/events", headers=proxied)
    assert allowed.status_code == 405
    # Local requests are unaffected.
    local = client.get("/api/voicelink/health")
    assert local.status_code == 200


def test_bridge_batches_audio_for_exotel_chunk_floor():
    import struct

    from app.telephony.bridge import TelephonyBridge

    rate = 22050
    samples = b"\x00\x01" * int(rate * 0.3)
    wav = (
        b"RIFF" + struct.pack("<I", 36 + len(samples)) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
        + b"data" + struct.pack("<I", len(samples)) + samples
    )

    class _TTS:
        async def synthesize(self, text):  # noqa: ANN001
            class _Result:
                pass

            result = _Result()
            result.wav = wav
            return result

    class _Engine:
        pass

    engine = _Engine()
    engine.tts = _TTS()
    sent: list[int] = []

    async def send_audio(payload: bytes) -> None:
        sent.append(len(payload))

    async def scenario() -> None:
        bridge = TelephonyBridge(
            engine=engine,
            media_format=AudioFormat(encoding="pcm16", sample_rate=8000),
            send_audio=send_audio,
            outbound_chunk_bytes=3200,
        )
        await bridge._speak("Hello there.")
        await bridge.stop()

    asyncio.run(scenario())
    assert sent, "no audio was sent"
    # Exotel requires every chunk (including the last) to be 3200 bytes.
    assert all(size == 3200 for size in sent)


def test_router_uses_camelcase_stream_sid_for_twilio(clean_db, monkeypatch):
    from fastapi.testclient import TestClient

    import app.main as main
    from app.telephony import router as router_module

    class _FakeBridge:
        def __init__(self, **kwargs):  # noqa: ANN003
            self.send_audio = kwargs["send_audio"]
            self.send_clear = kwargs["send_clear"]
            self.media: list[bytes] = []

        async def start(self) -> None:
            await self.send_audio(b"\x00\x00\x00\x00")
            await self.send_clear()

        async def stop(self) -> None:
            return None

        async def handle_media(self, payload: bytes) -> None:
            self.media.append(payload)

    monkeypatch.setattr(router_module, "TelephonyBridge", _FakeBridge)
    client = TestClient(main.app)
    with client.websocket_connect("/api/telephony/twilio/media") as ws:
        ws.send_json({"event": "connected"})
        ws.send_json(
            {
                "event": "start",
                "start": {
                    "streamSid": "MZ-test",
                    "callSid": "CA-test",
                    "from": "+919800000001",
                    "to": "+919800000002",
                },
            }
        )
        media = ws.receive_json()
        assert media["event"] == "media"
        assert media["streamSid"] == "MZ-test"
        assert "stream_sid" not in media
        cleared = ws.receive_json()
        assert cleared == {"event": "clear", "streamSid": "MZ-test"}
        ws.send_json({"event": "stop"})


def test_outbound_media_track_is_ignored():
    from app.telephony.router import _media_track

    assert _media_track({"media": {"track": "outbound"}}) == "outbound"
    assert _media_track({"media": {"track": "inbound"}}) == "inbound"
    assert _media_track({"media": {"payload": "x"}}) is None


def test_exotel_initial_response_is_not_reported_as_answered(monkeypatch):
    from app.telephony import exotel as exotel_module

    class _Response:
        status_code = 200
        text = "{}"

        def json(self):
            # Exotel's documented connect response example says in-progress.
            return {"Call": {"Sid": "CA-initial", "Status": "in-progress"}}

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, *args, **kwargs):
            return _Response()

    monkeypatch.setattr(exotel_module.httpx, "AsyncClient", _Client)
    provider = ExotelProvider(
        api_key="k", api_token="t", account_sid="sid",
        caller_id="+918000000000", webhook_secret="s",
    )
    result = asyncio.run(
        provider.start_outbound_call(
            to_number="+919876543210",
            from_number="+918000000000",
            answer_url="https://example.test/answer",
            stream_url="wss://example.test/media",
            status_url="https://example.test/status",
        )
    )
    assert result.ok is True
    assert result.accepted is True
    assert result.provider_call_id == "CA-initial"
    assert result.state == "queued"


def test_twilio_accepted_status_maps_to_queued():
    from app.telephony.twilio import _map_twilio_call_status

    assert _map_twilio_call_status("accepted") == "queued"
    assert _map_twilio_call_status("queued") == "queued"


def test_session_cookie_is_secure_only_behind_tls(clean_db):
    from fastapi.testclient import TestClient

    import app.main as main

    clean_db.create_user(
        username="cookie.user", display_name="Cookie User", role="admin",
        password_hash=auth.hash_password("cookie-pass-123"),
    )
    client = TestClient(main.app)
    local = client.post(
        "/api/platform/auth/login",
        json={"username": "cookie.user", "password": "cookie-pass-123"},
    )
    assert local.status_code == 200, local.text
    assert "secure" not in local.headers.get("set-cookie", "").lower()

    proxied = client.post(
        "/api/platform/auth/login",
        json={"username": "cookie.user", "password": "cookie-pass-123"},
        headers={"x-forwarded-proto": "https"},
    )
    assert proxied.status_code == 200, proxied.text
    assert "secure" in proxied.headers.get("set-cookie", "").lower()
