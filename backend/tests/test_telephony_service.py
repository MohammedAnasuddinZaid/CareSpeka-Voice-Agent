"""Tests for the durable telephony orchestration service.

The deterministic mock provider is used throughout, so no telephone call is
placed.  Where a real provider is needed to exercise a safety guard, a small
fake stands in for it.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
from types import SimpleNamespace

import pytest

from app import database, escalation
from app.config import settings
from app.telephony import service as service_module
from app.telephony.base import ProviderCapabilities, ProviderEvent
from app.telephony.models import ProviderMode
from app.telephony.service import (
    RateLimited,
    TelephonyService,
    _pick_nurse,
    _public_call,
    _with_sample_rate,
    provider_settings_caller,
)


_TABLES = (
    "call_events", "message_events", "telephony_calls", "messages",
    "escalation_actions", "escalations", "family_requests", "family_permissions",
    "scheduled_jobs", "verification_challenges", "sessions", "users",
    "audit_log", "webhook_events", "provider_config", "transcripts", "calls",
    "contacts",
)


@pytest.fixture()
def db(clean_db):
    clean_db.init_db()
    with clean_db.connection() as conn:
        for table in _TABLES:
            conn.execute(f"DELETE FROM {table}")
    return clean_db


@pytest.fixture()
def svc(db):
    return TelephonyService(SimpleNamespace())


class FakeScheduler:
    def __init__(self):
        self.ack_checks: list[str] = []
        self.retries: list[str] = []

    def schedule_ack_check(self, escalation_id):
        self.ack_checks.append(escalation_id)
        return {"created": True}

    def schedule_retry_call(self, call_id):
        self.retries.append(call_id)
        return {"created": True}


class FakeRealProvider:
    name = "twilio"
    mode = ProviderMode.REAL
    caller_id = "+918000000000"
    webhook_secret = ""

    def is_configured(self):
        return True

    def capabilities(self):
        return ProviderCapabilities(outbound_calls=True, sms=True, call_control=True)

    def operating_mode(self):
        return "configured-unverified"

    async def start_outbound_call(self, **kwargs):
        raise AssertionError("a call must not be placed when webhooks are not public")

    async def send_message(self, **kwargs):
        raise AssertionError("a message must not be sent when webhooks are not public")


def _contact(db, *, patient_id=1, role="primary_nurse", phone="+918000000001",
             consent="unknown", active=True, name="Nurse Joy", channel="sms"):
    return db.add_contact(
        patient_id=patient_id,
        role=role,
        display_name=name,
        phone_e164=phone,
        phone_masked="•••••0001",
        preferred_channel=channel,
        consent_status=consent,
        verification_status="verified",
        is_primary=role == "primary_nurse",
    )


# ---------------------------------------------------------------------------
# URLs and configuration
# ---------------------------------------------------------------------------
def test_webhook_base_and_ready(svc, monkeypatch):
    monkeypatch.setattr(service_module, "settings", replace(settings, public_base_url="", webhook_base_url=""))
    assert svc.webhook_base() == ""
    assert svc.webhook_ready() is False

    monkeypatch.setattr(
        service_module, "settings",
        replace(settings, public_base_url="https://public.example/", webhook_base_url=""),
    )
    assert svc.webhook_base() == "https://public.example"
    assert svc.webhook_ready() is True

    # The dedicated webhook base wins over the general public base.
    monkeypatch.setattr(
        service_module, "settings",
        replace(
            settings, public_base_url="https://public.example",
            webhook_base_url="http://internal.example",
        ),
    )
    assert svc.webhook_base() == "http://internal.example"
    assert svc.webhook_ready() is False


def test_urls_use_wss_and_carry_the_exotel_token(svc, monkeypatch):
    monkeypatch.setattr(
        service_module, "settings",
        replace(settings, public_base_url="https://public.example", webhook_base_url=""),
    )
    monkeypatch.setattr(
        service_module.registry, "get_provider",
        lambda name=None: SimpleNamespace(name="exotel", webhook_secret="a b/c"),
    )
    urls = svc.urls("exotel")
    assert urls["answer_url"].startswith("https://public.example/api/telephony/exotel/voice?token=")
    assert urls["stream_url"].startswith("wss://public.example/api/telephony/exotel/media?token=")
    assert urls["status_url"].startswith("https://public.example/api/telephony/exotel/events?token=")
    # The token is URL-encoded, never placed raw in a query string.
    assert "a%20b%2Fc" in urls["answer_url"]


def test_urls_without_a_secret_have_no_query_suffix(svc, monkeypatch):
    monkeypatch.setattr(
        service_module, "settings",
        replace(settings, public_base_url="https://public.example", webhook_base_url=""),
    )
    monkeypatch.setattr(
        service_module.registry, "get_provider",
        lambda name=None: SimpleNamespace(name="mock", webhook_secret=""),
    )
    urls = svc.urls("mock")
    assert urls["answer_url"] == "https://public.example/api/telephony/mock/voice"


def test_quiet_hours_overnight_and_daytime(monkeypatch, svc):
    from datetime import datetime

    fake = replace(
        settings, quiet_hours_enabled=True, quiet_hours_start=21, quiet_hours_end=7
    )
    monkeypatch.setattr(service_module, "settings", fake)
    assert svc.in_quiet_hours(datetime(2026, 1, 1, 23)) is True
    assert svc.in_quiet_hours(datetime(2026, 1, 1, 3)) is True
    assert svc.in_quiet_hours(datetime(2026, 1, 1, 7)) is False
    assert svc.in_quiet_hours(datetime(2026, 1, 1, 12)) is False
    assert svc.in_quiet_hours(datetime(2026, 1, 1, 21)) is True

    # A same-hour window means "no quiet hours".
    monkeypatch.setattr(service_module, "settings", replace(fake, quiet_hours_start=8, quiet_hours_end=8))
    assert svc.in_quiet_hours(datetime(2026, 1, 1, 8)) is False

    # Disabled quiet hours always return False.
    monkeypatch.setattr(service_module, "settings", replace(fake, quiet_hours_enabled=False))
    assert svc.in_quiet_hours(datetime(2026, 1, 1, 23)) is False


def test_call_rate_limit_and_emergency_override(db, svc):
    for index in range(settings.rate_limit_calls_per_hour):
        db.create_telephony_call(
            provider="mock", direction="outbound", from_e164="", to_e164="",
            patient_id=1, state="completed",
        )
    with pytest.raises(RateLimited):
        svc.check_call_allowed(1)
    # Emergencies ignore the soft limit.
    svc.check_call_allowed(1, is_emergency=True)
    # A different patient is not affected.
    svc.check_call_allowed(2)


# ---------------------------------------------------------------------------
# outbound calls
# ---------------------------------------------------------------------------
def test_start_nurse_call_success_and_duplicate(db, svc):
    result = asyncio.run(
        svc.start_nurse_call(
            patient_id=1,
            patient_name="Asha Rao",
            to_number="+919876543210",
            idempotency="idem-call",
            actor={"username": "nurse.demo"},
        )
    )
    assert result["ok"] is True
    assert result["accepted"] is True
    assert result["mode"] == "mock"
    assert result["call"]["state"] == "ringing"
    # The patient name is internal metadata and must not leak to the API caller.
    assert "patient_name" not in result["call"]["metadata"]
    assert result["call"]["metadata"]["requested_by"] == "nurse.demo"

    duplicate = asyncio.run(
        svc.start_nurse_call(
            patient_id=1,
            patient_name="Asha Rao",
            to_number="+919876543210",
            idempotency="idem-call",
        )
    )
    assert duplicate["duplicate"] is True
    assert duplicate["call"]["id"] == result["call"]["id"]
    assert len(db.list_telephony_calls()) == 1


def test_start_nurse_call_records_an_event(db, svc):
    result = asyncio.run(
        svc.start_nurse_call(
            patient_id=1, patient_name="Asha", to_number="+919876543210",
            idempotency="idem-events",
        )
    )
    events = db.list_call_events(result["call"]["id"])
    assert [e["event_type"] for e in events] == ["provider.request"]
    assert db.get_telephony_call_by_provider_id(result["call"]["provider_call_id"]) is not None


def test_start_nurse_call_requires_public_https_for_a_real_provider(db, monkeypatch):
    monkeypatch.setattr(service_module, "settings", replace(
        settings, public_base_url="", webhook_base_url="",
    ))
    fake = FakeRealProvider()
    monkeypatch.setattr(service_module.registry, "get_provider", lambda name=None: fake)
    svc = TelephonyService(SimpleNamespace())
    result = asyncio.run(
        svc.start_nurse_call(
            patient_id=1, patient_name="Asha", to_number="+919876543210",
        )
    )
    assert result["ok"] is False
    assert result["reason"] == "webhook_not_public"
    assert "HTTPS" in result["message"]
    # No half-created call row is left behind.
    assert db.list_telephony_calls() == []


def test_start_nurse_call_schedules_a_retry_on_failure(db, svc, monkeypatch):
    class FailingProvider(FakeRealProvider):
        name = "mock"

        def operating_mode(self):
            return "mock"

        async def start_outbound_call(self, **kwargs):
            from app.telephony.base import CallResult

            return CallResult(ok=False, detail="carrier rejected")

    scheduler = FakeScheduler()
    svc.scheduler = scheduler
    monkeypatch.setattr(service_module.registry, "get_provider", lambda name=None: FailingProvider())
    monkeypatch.setattr(service_module, "settings", replace(settings, public_base_url="https://x.test"))
    result = asyncio.run(
        svc.start_nurse_call(
            patient_id=1, patient_name="Asha", to_number="+919876543210",
            idempotency="idem-fail",
        )
    )
    assert result["ok"] is False
    assert result["call"]["state"] == "failed"
    assert result["call"]["error"] == "carrier rejected"
    assert scheduler.retries == [result["call"]["id"]]


def test_retry_outbound_call_reuses_the_record(db, svc):
    first = asyncio.run(
        svc.start_nurse_call(
            patient_id=1, patient_name="Asha", to_number="+919876543210",
            idempotency="idem-retry",
        )
    )
    record = db.get_telephony_call(first["call"]["id"])
    retried = asyncio.run(svc.retry_outbound_call(record, reason="busy"))
    assert retried["ok"] is True
    assert len(db.list_telephony_calls()) == 1
    events = [e["event_type"] for e in db.list_call_events(record["id"])]
    assert "retry.busy" in events


def test_retry_refuses_a_no_longer_configured_provider(db, svc, monkeypatch):
    class Unconfigured(FakeRealProvider):
        def is_configured(self):
            return False

    monkeypatch.setattr(service_module.registry, "get_provider", lambda name=None: Unconfigured())
    result = asyncio.run(svc.retry_outbound_call({"id": "x", "provider": "twilio", "to_e164": "+1"}))
    assert result == {"ok": False, "detail": "Provider is no longer configured."}


def test_end_call_completes_and_is_idempotent(db, svc):
    started = asyncio.run(
        svc.start_nurse_call(
            patient_id=1, patient_name="Asha", to_number="+919876543210",
            idempotency="idem-end",
        )
    )
    ended = asyncio.run(svc.end_call(started["call"]["id"]))
    assert ended["ok"] is True
    assert ended["call"]["state"] == "completed"
    assert ended["call"]["ended_at"] is not None

    # Ending again is harmless.
    again = asyncio.run(svc.end_call(started["call"]["id"]))
    assert again["ok"] is True
    assert db.get_telephony_call(started["call"]["id"])["state"] == "completed"

    assert asyncio.run(svc.end_call("missing")) == {"ok": False, "message": "Call not found."}


# ---------------------------------------------------------------------------
# messages
# ---------------------------------------------------------------------------
def test_send_message_success_and_duplicate(db, svc):
    result = asyncio.run(
        svc.send_message(
            patient_id=1, to_number="+919876543210", body="Take your tablets.",
            idempotency="idem-msg", actor={"username": "nurse.demo"},
        )
    )
    assert result["ok"] is True
    assert result["accepted"] is True
    assert result["message"]["state"] == "sent"
    assert "delivered" not in result["message"]["state"]

    duplicate = asyncio.run(
        svc.send_message(
            patient_id=1, to_number="+919876543210", body="Take your tablets.",
            idempotency="idem-msg",
        )
    )
    assert duplicate["duplicate"] is True
    assert duplicate["message"]["id"] == result["message"]["id"]


def test_send_message_respects_quiet_hours_and_override(db, svc, monkeypatch):
    monkeypatch.setattr(
        service_module, "settings",
        replace(settings, quiet_hours_enabled=True, quiet_hours_start=0, quiet_hours_end=23),
    )
    # 00:00-23:00 is quiet for every hour except 23:00 in this window, so pick a
    # time that is definitely inside it by patching the clock input instead.
    monkeypatch.setattr(service_module.TelephonyService, "in_quiet_hours", lambda self, now=None: True)
    blocked = asyncio.run(
        svc.send_message(patient_id=1, to_number="+919876543210", body="hi")
    )
    assert blocked["ok"] is False
    assert blocked["reason"] == "quiet_hours"
    assert db.list_messages() == []

    allowed = asyncio.run(
        svc.send_message(
            patient_id=1, to_number="+919876543210", body="hi", allow_quiet_hours=True,
        )
    )
    assert allowed["ok"] is True


def test_send_message_rate_limit(db, svc):
    for _ in range(settings.rate_limit_messages_per_hour):
        db.create_message(
            provider="mock", direction="outbound", channel="sms", from_e164="",
            to_e164="", body="x", patient_id=1, state="sent",
        )
    with pytest.raises(RateLimited):
        asyncio.run(svc.send_message(patient_id=1, to_number="+919876543210", body="hi"))


def test_send_message_requires_public_https_for_a_real_provider(db, monkeypatch):
    monkeypatch.setattr(service_module, "settings", replace(
        settings, public_base_url="", webhook_base_url="",
    ))
    monkeypatch.setattr(service_module.registry, "get_provider", lambda name=None: FakeRealProvider())
    svc = TelephonyService(SimpleNamespace())
    result = asyncio.run(
        svc.send_message(patient_id=1, to_number="+919876543210", body="hi")
    )
    assert result["ok"] is False
    assert result["reason"] == "webhook_not_public"
    assert db.list_messages() == []


# ---------------------------------------------------------------------------
# provider events
# ---------------------------------------------------------------------------
def _event(**overrides):
    payload = dict(
        event_id="evt-1", kind="call.status", provider="mock",
        provider_call_id="pc-1", state="answered",
    )
    payload.update(overrides)
    return ProviderEvent(**payload)


def test_call_event_applies_state_once(db, svc):
    record = db.create_telephony_call(
        provider="mock", direction="outbound", from_e164="", to_e164="",
        patient_id=1, state="ringing",
    )
    db.set_provider_call_id(record["id"], "pc-1")

    applied = asyncio.run(svc.handle_provider_event(_event()))
    assert applied["applied"] is True
    assert applied["call"]["state"] == "answered"
    assert applied["call"]["answered_at"] is not None

    replay = asyncio.run(svc.handle_provider_event(_event()))
    assert replay["applied"] is False
    assert replay["reason"] == "replay"


def test_call_event_unknown_call_is_reported(db, svc):
    result = asyncio.run(svc.handle_provider_event(_event(provider_call_id="no-such")))
    assert result["applied"] is False
    assert result["reason"] == "unknown_call"


def test_failed_call_event_schedules_a_retry(db, svc):
    scheduler = FakeScheduler()
    svc.scheduler = scheduler
    record = db.create_telephony_call(
        provider="mock", direction="outbound", from_e164="", to_e164="",
        patient_id=1, state="dialing",
    )
    db.set_provider_call_id(record["id"], "pc-fail")
    result = asyncio.run(
        svc.handle_provider_event(
            _event(provider_call_id="pc-fail", state="no_answer", event_id="evt-fail")
        )
    )
    assert result["applied"] is True
    assert result["call"]["state"] == "no_answer"
    assert scheduler.retries == [record["id"]]


def test_message_event_applies_delivery(db, svc):
    record = db.create_message(
        provider="mock", direction="outbound", channel="sms", from_e164="",
        to_e164="", body="hi", patient_id=1, state="sent",
    )
    db.set_message_provider_id(record["id"], "pm-1")
    event = ProviderEvent(
        event_id="mevt-1", kind="message.status", provider="mock",
        provider_message_id="pm-1", state="delivered",
    )
    applied = asyncio.run(svc.handle_provider_event(event))
    assert applied["applied"] is True
    assert applied["message"]["state"] == "delivered"
    assert applied["message"]["delivered_at"] is not None

    replay = asyncio.run(svc.handle_provider_event(event))
    assert replay["reason"] == "replay"


def test_message_event_unknown_message(db, svc):
    event = ProviderEvent(
        event_id="mevt-x", kind="message.status", provider="mock",
        provider_message_id="missing", state="delivered",
    )
    result = asyncio.run(svc.handle_provider_event(event))
    assert result["applied"] is False
    assert result["reason"] == "unknown_message"


def test_unmatched_event_has_no_identifiers(db, svc):
    event = ProviderEvent(event_id="evt-empty", kind="media.start", provider="mock")
    result = asyncio.run(svc.handle_provider_event(event))
    assert result == {"ok": True, "applied": False, "reason": "unmatched_event", "duplicate": False}


# ---------------------------------------------------------------------------
# inbound calls / personas
# ---------------------------------------------------------------------------
def test_inbound_from_an_unknown_number(db, svc):
    result = svc.handle_inbound_call(
        from_number="+919999999999", to_number="+918000000000", provider_name="mock",
    )
    assert result["persona"] == "unknown"
    assert result["identified"] is False
    assert result["call"]["direction"] == "inbound"
    assert result["call"]["state"] == "ringing"


def test_inbound_from_a_patient_contact(db, svc):
    _contact(db, role="patient", phone="+919876543210", name="Asha Rao")
    result = svc.handle_inbound_call(
        from_number="+919876543210", to_number="+918000000000", provider_name="mock",
    )
    assert result["persona"] == "patient"
    assert result["identified"] is True
    assert result["display_name"] == "Asha Rao"
    assert result["call"]["metadata"]["persona"] == "patient"


def test_inbound_from_a_nurse_contact(db, svc):
    for role in ("primary_nurse", "primary_nurse_backup"):
        _contact(db, role=role, phone="+918000000001", name="Nurse Joy")
        result = svc.handle_inbound_call(
            from_number="+918000000001", to_number="+918000000000", provider_name="mock",
        )
        assert result["persona"] == "nurse"


def test_inbound_family_requires_permission_and_consent(db, svc):
    contact_id = _contact(
        db, role="family", phone="+919876543210", name="Priya", consent="granted",
    )
    # Consent alone is not enough - an explicit permission grant is required.
    denied = svc.handle_inbound_call(
        from_number="+919876543210", to_number="+918000000000", provider_name="mock",
    )
    assert denied["persona"] == "family_unverified"
    assert denied["identified"] is False

    db.upsert_family_permission(
        patient_id=1, contact_id=contact_id, scope={"read": True}, granted_by="nurse",
    )
    allowed = svc.handle_inbound_call(
        from_number="+919876543210", to_number="+918000000000", provider_name="mock",
    )
    assert allowed["persona"] == "family"
    assert allowed["identified"] is True

    # Revoking the permission immediately restores the unverified persona.
    db.revoke_family_permission(1, contact_id)
    revoked = svc.handle_inbound_call(
        from_number="+919876543210", to_number="+918000000000", provider_name="mock",
    )
    assert revoked["persona"] == "family_unverified"


def test_inbound_family_without_consent_is_unverified(db, svc):
    contact_id = _contact(
        db, role="family", phone="+919876543210", name="Priya", consent="refused",
    )
    db.upsert_family_permission(
        patient_id=1, contact_id=contact_id, scope={"read": True}, granted_by="nurse",
    )
    result = svc.handle_inbound_call(
        from_number="+919876543210", to_number="+918000000000", provider_name="mock",
    )
    assert result["persona"] == "family_unverified"


# ---------------------------------------------------------------------------
# escalations
# ---------------------------------------------------------------------------
def test_emergency_escalation_advises_emergency_services(db, svc):
    scheduler = FakeScheduler()
    svc.scheduler = scheduler
    nurse = _contact(db, role="primary_nurse", phone="+918000000001")
    decision = escalation.classify("I have crushing chest pain")
    result = asyncio.run(
        svc.raise_escalation(
            patient_id=1, decision=decision, call_id="tcall_1", excerpt="chest pain",
        )
    )
    record = result["escalation"]
    assert record["severity"] == "emergency"
    assert record["requires_ack"] is True
    assert record["transcript_excerpt"] == "chest pain"
    assert scheduler.ack_checks == [record["id"]]

    actions = db.list_escalation_actions(record["id"])
    types = [a["action_type"] for a in actions]
    assert "advise_emergency_services" in types
    assert f"call_primary_nurse" in types
    assert "message_primary_nurse" in types
    assert "dashboard_alert" in types
    emergency_action = next(a for a in actions if a["action_type"] == "advise_emergency_services")
    assert emergency_action["target_masked"] == settings.emergency_number
    # The nurse was actually contacted through the mock provider, and a call
    # record exists for the escalation call.
    assert db.get_contact(nurse)["phone_e164"] == "+918000000001"
    escalation_calls = [c for c in db.list_telephony_calls() if c["purpose"] == "escalate_primary_nurse"]
    assert len(escalation_calls) == 1


def test_escalation_is_deduplicated_within_the_bucket(db, svc):
    _contact(db, role="primary_nurse", phone="+918000000001")
    decision = escalation.classify("I have crushing chest pain")
    first = asyncio.run(svc.raise_escalation(patient_id=1, decision=decision, bucket="2026-01-01T10"))
    second = asyncio.run(svc.raise_escalation(patient_id=1, decision=decision, bucket="2026-01-01T10"))
    assert "duplicate" not in first
    assert second["duplicate"] is True
    assert second["escalation"]["id"] == first["escalation"]["id"]
    assert len(db.list_escalations()) == 1


def test_escalation_without_a_nurse_records_unavailable(db, svc):
    decision = escalation.classify("I forgot to take my tablets")  # follow-up, no call
    result = asyncio.run(svc.raise_escalation(patient_id=1, decision=decision, bucket="b1"))
    assert result["escalation"]["severity"] == "follow_up"
    assert result["escalation"]["requires_ack"] is False
    actions = {a["action_type"]: a for a in db.list_escalation_actions(result["escalation"]["id"])}
    assert actions["notify_nurse"]["state"] == "unavailable"
    assert actions["dashboard_alert"]["state"] == "done"
    # A follow-up never places a phone call.
    assert db.list_telephony_calls() == []


def test_acknowledge_and_resolve_escalation(db, svc):
    decision = escalation.classify("chest pain")
    raised = asyncio.run(svc.raise_escalation(patient_id=1, decision=decision, bucket="ack-b"))
    escalation_id = raised["escalation"]["id"]

    actor = {"display_name": "Nurse Joy"}
    acked = svc.acknowledge_escalation(escalation_id, actor=actor, note="On my way")
    assert acked["ok"] is True
    assert acked["escalation"]["state"] == "acknowledged"
    assert acked["escalation"]["acknowledged_by"] == "Nurse Joy"

    # Re-acknowledging is an idempotent no-op that keeps the row acknowledged.
    again = svc.acknowledge_escalation(escalation_id)
    assert again["ok"] is True
    assert again["escalation"]["state"] == "acknowledged"

    resolved = svc.resolve_escalation(escalation_id, actor=actor, note="Refilled")
    assert resolved["ok"] is True
    assert resolved["escalation"]["state"] == "resolved"
    assert resolved["escalation"]["resolved_by"] == "Nurse Joy"

    # A resolved escalation can never be reopened or acknowledged.
    reopened = svc.acknowledge_escalation(escalation_id)
    assert reopened["ok"] is False
    assert "Cannot acknowledge" in reopened["message"]
    assert db.get_escalation(escalation_id)["state"] == "resolved"

    assert svc.resolve_escalation("missing") == {"ok": False, "message": "Escalation not found."}
    assert svc.acknowledge_escalation("missing") == {"ok": False, "message": "Escalation not found."}


# ---------------------------------------------------------------------------
# overview
# ---------------------------------------------------------------------------
def test_overview_counts_active_and_open_items(db, svc):
    asyncio.run(
        svc.start_nurse_call(
            patient_id=1, patient_name="Asha", to_number="+919876543210",
            idempotency="ov-1",
        )
    )
    raised = asyncio.run(
        svc.raise_escalation(
            patient_id=1, decision=escalation.classify("chest pain"), bucket="ov-b",
        )
    )
    db.create_message(
        provider="mock", direction="outbound", channel="sms", from_e164="",
        to_e164="", body="pending", patient_id=1, state="sent",
    )
    db.create_job(kind="follow_up_call", run_at=db.utc_offset(60), patient_id=1)

    overview = svc.overview()
    assert overview["counts"]["active_calls"] == 1
    assert overview["counts"]["open_escalations"] == 1
    assert overview["counts"]["unacknowledged"] == 1
    assert overview["counts"]["pending_messages"] == 1
    assert overview["counts"]["scheduled_jobs"] == 1
    assert overview["telephony"]["webhook_ready"] is False
    assert overview["open_escalations"][0]["id"] == raised["escalation"]["id"]
    assert raised["escalation"]["id"] in overview["escalation_actions"]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def test_pick_nurse_prefers_active_contacts():
    contacts = [
        {"role": "primary_nurse", "active": False, "name": "off"},
        {"role": "primary_nurse", "active": True, "name": "on"},
        {"role": "primary_nurse_backup", "active": True, "name": "backup"},
    ]
    assert _pick_nurse(contacts, backup=False)["name"] == "on"
    assert _pick_nurse(contacts, backup=True)["name"] == "backup"
    assert _pick_nurse([], backup=False) is None


def test_with_sample_rate_only_for_exotel():
    assert _with_sample_rate("https://x/media", SimpleNamespace(name="twilio")) == "https://x/media"
    assert _with_sample_rate("https://x/media", SimpleNamespace(name="exotel")) == "https://x/media?sample-rate=8000"
    assert _with_sample_rate("https://x/media?a=1", SimpleNamespace(name="exotel")) == "https://x/media?a=1&sample-rate=8000"


def test_provider_settings_caller_falls_back():
    assert provider_settings_caller(SimpleNamespace(caller_id="+911")) == "+911"
    assert provider_settings_caller(SimpleNamespace(from_number="+912")) == "+912"
    assert provider_settings_caller(SimpleNamespace()) == ""


def test_public_call_hides_internal_metadata():
    public = _public_call({
        "id": "x",
        "metadata_json": "{}",
        "metadata": {"patient_name": "Asha", "requested_by": "nurse"},
    })
    assert "metadata_json" not in public
    assert public["metadata"] == {"requested_by": "nurse"}
    assert _public_call(None) == {}