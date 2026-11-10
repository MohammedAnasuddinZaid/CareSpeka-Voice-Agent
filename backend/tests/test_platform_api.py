"""Tests for the dashboard REST API (``app.platform_api``).

The suite mounts the real router on a throwaway FastAPI app and overrides only
``current_user``, so every route handler, authorisation check, audit write and
serialiser runs exactly as it does in production.  The deterministic mock
carrier is used, and the database is wiped before each test, so nothing here
places a real call or touches a real record.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import auth, database, secrets_store
from app.auth import current_user
from app.platform_api import router
from app.scheduler import Scheduler
from app.telephony import numbers
from app.telephony.service import TelephonyService

PATIENT_PHONE = "+919876543210"
NURSE_PHONE = "+918000000001"
PATIENT_MASKED = numbers.mask(PATIENT_PHONE)
ALL_FULL_NUMBERS = (PATIENT_PHONE, NURSE_PHONE, "+918000000000")

TABLES = (
    "call_events", "message_events", "telephony_calls", "messages",
    "escalation_actions", "escalations", "family_requests", "family_permissions",
    "scheduled_jobs", "verification_challenges", "sessions", "users",
    "audit_log", "webhook_events", "provider_config", "transcripts", "calls",
    "contacts",
)

CURRENT_USER: dict = {}


# ---------------------------------------------------------------------------
# fixtures and helpers
# ---------------------------------------------------------------------------
@pytest.fixture()
def db(clean_db):
    clean_db.init_db()
    with clean_db.connection() as conn:
        for table in TABLES:
            conn.execute(f"DELETE FROM {table}")
    return clean_db


@pytest.fixture()
def api(db):
    app = FastAPI()
    service = TelephonyService(SimpleNamespace())
    scheduler = Scheduler(service)
    service.scheduler = scheduler
    app.state.service = service
    app.state.scheduler = scheduler
    app.include_router(router)
    app.dependency_overrides[current_user] = lambda: CURRENT_USER
    become(role="admin")
    with TestClient(app) as client:
        yield SimpleNamespace(app=app, client=client, service=service, scheduler=scheduler)


@pytest.fixture()
def raw_api(db):
    """The same router without the ``current_user`` override."""
    app = FastAPI()
    app.state.service = TelephonyService(SimpleNamespace())
    app.state.scheduler = Scheduler(app.state.service)
    app.include_router(router)
    with TestClient(app) as client:
        yield client


def become(**overrides) -> dict:
    CURRENT_USER.clear()
    CURRENT_USER.update(
        {
            "id": 1,
            "username": "admin",
            "display_name": "Admin",
            "role": "admin",
            "patient_id": None,
            "active": True,
            "dev_bypass": False,
        }
    )
    CURRENT_USER.update(overrides)
    return CURRENT_USER


def make_user(db, *, role="admin", password="secret123", username=None) -> int:
    username = username or f"{role}.user"
    user_id = db.create_user(
        username=username,
        display_name=username.replace(".", " ").title(),
        role=role,
        password_hash=auth.hash_password(password),
        patient_id=None,
    )
    return user_id


def patient_id(db, extension="CS-1001") -> int:
    return db.get_patient(extension)["id"]


def add_contact(db, *, patient, phone=PATIENT_PHONE, role="patient", name="Asha Rao",
                consent="granted", channel="sms"):
    return db.add_contact(
        patient_id=patient,
        role=role,
        display_name=name,
        phone_e164=phone,
        phone_masked=f"****{phone[-4:]}",
        preferred_channel=channel,
        consent_status=consent,
        verification_status="verified",
        is_primary=True,
    )


def assert_no_full_numbers(payload) -> None:
    """Recursively assert that no full phone number or E.164 key escaped."""

    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                lowered = key.lower()
                assert not lowered.endswith("_e164"), f"leaked key {key}"
                assert lowered not in {
                    "phone_e164", "phone", "mobile", "from_number", "to_number",
                    "caller", "called", "from", "to",
                }, f"leaked key {key}"
                walk(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                walk(item)
        elif isinstance(value, str):
            for number in ALL_FULL_NUMBERS:
                assert number not in value, f"leaked number in {value!r}"

    walk(payload)


def error_code(response) -> str:
    detail = response.json().get("detail")
    if isinstance(detail, dict):
        return detail.get("code", "")
    return str(detail)


# ---------------------------------------------------------------------------
# authentication
# ---------------------------------------------------------------------------
def test_login_sets_a_session_cookie_and_never_returns_the_hash(db, raw_api):
    user_id = make_user(db, role="nurse", username="nurse.login")
    response = raw_api.post(
        "/api/platform/auth/login",
        json={"username": "NURSE.LOGIN", "password": "secret123"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["user"]["id"] == user_id
    assert body["user"]["role"] == "nurse"
    assert "password_hash" not in json.dumps(body)
    assert auth.SESSION_COOKIE in response.cookies

    # The cookie authenticates a follow-up request.
    me = raw_api.get("/api/platform/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["username"] == "nurse.login"

    # Logging out revokes the session immediately.
    assert raw_api.post("/api/platform/auth/logout").json() == {"ok": True}
    assert raw_api.get("/api/platform/auth/me").status_code == 401


def test_login_rejects_bad_credentials_without_enumerating_users(db, raw_api):
    make_user(db, username="nurse.login")
    wrong_password = raw_api.post(
        "/api/platform/auth/login",
        json={"username": "nurse.login", "password": "nope"},
    )
    unknown_user = raw_api.post(
        "/api/platform/auth/login",
        json={"username": "ghost", "password": "nope"},
    )
    assert wrong_password.status_code == 401
    assert unknown_user.status_code == 401
    # The response is identical, so it cannot be used to discover usernames.
    assert wrong_password.json() == unknown_user.json()
    assert error_code(wrong_password) == "invalid_credentials"


def test_unauthenticated_requests_are_refused(raw_api):
    response = raw_api.get("/api/platform/patients")
    assert response.status_code == 401
    assert error_code(response) == "unauthenticated"


def test_me_returns_only_safe_user_fields(api):
    response = api.client.get("/api/platform/auth/me")
    assert response.status_code == 200
    user = response.json()["user"]
    assert set(user) == {
        "id", "username", "display_name", "role", "patient_id", "dev_bypass",
    }


def test_dev_bypass_user_is_an_admin(monkeypatch, api):
    become(role="nurse", dev_bypass=True)
    response = api.client.get("/api/platform/audit")
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# bootstrap and patients
# ---------------------------------------------------------------------------
def test_bootstrap_and_patients_never_expose_full_numbers(api, db):
    asha = patient_id(db)
    add_contact(db, patient=asha)

    bootstrap = api.client.get("/api/platform/bootstrap").json()
    assert bootstrap["ok"] is True
    assert len(bootstrap["patients"]) >= 6
    assert bootstrap["contacts"]
    assert_no_full_numbers(bootstrap)

    patients = api.client.get("/api/platform/patients").json()
    assert patients["synthetic_only"] is True
    assert patients["patients"][0]["contacts"]
    assert_no_full_numbers(patients)


def test_patient_detail_scrubs_calls_messages_and_follow_ups(api, db):
    asha = patient_id(db)
    call = db.create_telephony_call(
        provider="mock", direction="outbound", from_e164=NURSE_PHONE,
        to_e164=PATIENT_PHONE, from_masked="****0001", to_masked="****3210",
        patient_id=asha, state="completed",
    )
    db.create_message(
        provider="mock", direction="outbound", channel="sms",
        from_e164=NURSE_PHONE, to_e164=PATIENT_PHONE, body="Take your tablets.",
        patient_id=asha, state="sent",
    )
    db.create_job(
        kind="follow_up_call", run_at=db.utc_offset(600), patient_id=asha,
        payload={"to_number": PATIENT_PHONE, "body": "Check in"},
    )
    response = api.client.get(f"/api/platform/patients/{asha}")
    assert response.status_code == 200
    body = response.json()
    assert body["patient"]["display_name"] == "Asha Rao"
    assert body["calls"][0]["id"] == call["id"]
    assert body["calls"][0]["to_masked"] == "****3210"
    assert body["messages"][0]["to_masked"] == PATIENT_MASKED
    assert body["follow_ups"][0]["payload"]["to_masked"] == PATIENT_MASKED
    assert_no_full_numbers(body)


def test_patient_detail_404_and_nurse_scoping(api, db):
    missing = api.client.get("/api/platform/patients/999999")
    assert missing.status_code == 404

    asha = patient_id(db, "CS-1001")
    ravi = patient_id(db, "CS-1002")
    become(role="nurse", patient_id=asha)
    assert api.client.get(f"/api/platform/patients/{asha}").status_code == 200
    forbidden = api.client.get(f"/api/platform/patients/{ravi}")
    assert forbidden.status_code == 403
    assert error_code(forbidden) == "forbidden_patient"


# ---------------------------------------------------------------------------
# contacts
# ---------------------------------------------------------------------------
def test_contact_create_returns_masked_and_list_stays_masked(api, db):
    asha = patient_id(db)
    response = api.client.post(
        "/api/platform/contacts",
        json={
            "patient_id": asha,
            "role": "family",
            "display_name": "Priya Rao",
            "phone": "9876543210",
            "consent_status": "granted",
            "permissions": {"can_receive_updates": True},
        },
    )
    assert response.status_code == 200
    contact = response.json()["contact"]
    assert contact["phone_masked"].endswith("3210")
    assert_no_full_numbers(response.json())

    # The full number is normalised in the database but never echoed.
    assert db.get_contact(contact["id"])["phone_e164"] == PATIENT_PHONE
    listed = api.client.get("/api/platform/contacts", params={"patient_id": asha}).json()
    assert len(listed["contacts"]) == 1
    assert_no_full_numbers(listed)


def test_contact_create_rejects_an_invalid_number(api, db):
    asha = patient_id(db)
    response = api.client.post(
        "/api/platform/contacts",
        json={
            "patient_id": asha, "role": "family", "display_name": "Bad",
            "phone": "+123",
        },
    )
    assert response.status_code == 400
    assert detail_code(response) == "invalid_number"


def detail_code(response) -> str:
    detail = response.json().get("detail")
    return detail.get("code", "") if isinstance(detail, dict) else ""


def test_contact_revoke_and_missing_contact(api, db):
    asha = patient_id(db)
    contact_id = add_contact(db, patient=asha)
    assert api.client.post(f"/api/platform/contacts/{contact_id}/revoke").status_code == 200
    assert db.get_contact(contact_id)["active"] is False
    assert api.client.post("/api/platform/contacts/999999/revoke").status_code == 404


def test_only_staff_can_mutate_contacts(api, db):
    asha = patient_id(db)
    become(role="family", patient_id=asha)
    response = api.client.post(
        "/api/platform/contacts",
        json={"patient_id": asha, "role": "family", "display_name": "X", "phone": "9876543210"},
    )
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# verification challenges
# ---------------------------------------------------------------------------
def test_verification_happy_path_with_a_simulated_code(api, db):
    asha = patient_id(db)
    contact_id = add_contact(db, patient=asha)

    started = api.client.post(
        f"/api/platform/contacts/{contact_id}/verify", json={"channel": "sms"}
    )
    assert started.status_code == 200
    body = started.json()
    # The mock carrier cannot deliver SMS, so the code is surfaced for the demo.
    assert body["delivery"]["sent"] is False
    assert body["delivery"]["mode"] == "mock"
    code = body["simulated_code"]
    assert code and len(code) == 6
    assert_no_full_numbers(body)

    wrong = api.client.post(
        f"/api/platform/contacts/{contact_id}/verify/confirm", json={"code": "000000"}
    )
    assert wrong.status_code == 400
    assert error_code(wrong) == "incorrect_code"
    assert wrong.json()["detail"]["attempts_remaining"] == 4

    right = api.client.post(
        f"/api/platform/contacts/{contact_id}/verify/confirm", json={"code": code}
    )
    assert right.status_code == 200
    assert right.json() == {"ok": True, "verified": True}
    assert db.get_contact(contact_id)["verification_status"] == "verified"

    # The challenge is single-use.
    replay = api.client.post(
        f"/api/platform/contacts/{contact_id}/verify/confirm", json={"code": code}
    )
    assert replay.status_code == 400
    assert error_code(replay) == "challenge_closed"


def test_verification_requires_a_challenge(api, db):
    asha = patient_id(db)
    contact_id = add_contact(db, patient=asha)
    response = api.client.post(
        f"/api/platform/contacts/{contact_id}/verify/confirm", json={"code": "123456"}
    )
    assert response.status_code == 400
    assert error_code(response) == "no_challenge"


def test_expired_challenge_is_closed(api, db):
    asha = patient_id(db)
    contact_id = add_contact(db, patient=asha)
    started = api.client.post(
        f"/api/platform/contacts/{contact_id}/verify", json={"channel": "sms"}
    ).json()
    with db.connection() as conn:
        conn.execute(
            "UPDATE verification_challenges SET expires_at = ? WHERE id = ?",
            (db.utc_offset(-10), started["challenge_id"]),
        )
    response = api.client.post(
        f"/api/platform/contacts/{contact_id}/verify/confirm",
        json={"code": started["simulated_code"]},
    )
    assert response.status_code == 400
    assert error_code(response) == "challenge_expired"
    assert db.get_challenge(started["challenge_id"])["state"] == "expired"


def test_too_many_wrong_codes_fail_the_contact(api, db):
    asha = patient_id(db)
    contact_id = add_contact(db, patient=asha)
    api.client.post(
        f"/api/platform/contacts/{contact_id}/verify", json={"channel": "sms"}
    )
    last = None
    for _ in range(5):
        last = api.client.post(
            f"/api/platform/contacts/{contact_id}/verify/confirm", json={"code": "000000"}
        )
    assert last.status_code == 400
    assert error_code(last) == "too_many_attempts"
    assert db.get_contact(contact_id)["verification_status"] == "failed"


def test_verification_404_for_unknown_contact(api):
    assert api.client.post(
        "/api/platform/contacts/999999/verify", json={"channel": "sms"}
    ).status_code == 404
    assert api.client.post(
        "/api/platform/contacts/999999/verify/confirm", json={"code": "123456"}
    ).status_code == 404


# ---------------------------------------------------------------------------
# calls
# ---------------------------------------------------------------------------
def test_list_calls_is_masked(api, db):
    asha = patient_id(db)
    db.create_telephony_call(
        provider="mock", direction="outbound", from_e164=NURSE_PHONE,
        to_e164=PATIENT_PHONE, from_masked="****0001", to_masked="****3210",
        patient_id=asha, state="ringing",
    )
    response = api.client.get("/api/platform/calls")
    assert response.status_code == 200
    assert len(response.json()["calls"]) == 1
    assert_no_full_numbers(response.json())


def test_call_detail_scrubs_provider_event_payloads(api, db):
    asha = patient_id(db)
    call = db.create_telephony_call(
        provider="mock", direction="outbound", from_e164=NURSE_PHONE,
        to_e164=PATIENT_PHONE, from_masked="****0001", to_masked="****3210",
        patient_id=asha, state="ringing",
    )
    db.add_call_event(
        call["id"], event_type="status", state="ringing",
        payload={"From": NURSE_PHONE, "To": PATIENT_PHONE, "CallStatus": "ringing"},
    )
    response = api.client.get(f"/api/platform/calls/{call['id']}")
    assert response.status_code == 200
    body = response.json()
    assert body["call"]["to_masked"] == "****3210"
    assert "payload_json" not in body["events"][0]
    assert body["events"][0]["payload"] == {"CallStatus": "ringing"}
    assert_no_full_numbers(body)
    assert api.client.get("/api/platform/calls/missing").status_code == 404


def test_start_call_requires_a_registered_patient_number(api, db):
    asha = patient_id(db)
    response = api.client.post("/api/platform/calls", json={"patient_id": asha})
    assert response.status_code == 400
    assert error_code(response) == "no_number"


def test_start_and_end_a_mock_call(api, db):
    asha = patient_id(db)
    add_contact(db, patient=asha)
    started = api.client.post("/api/platform/calls", json={"patient_id": asha})
    assert started.status_code == 200
    body = started.json()
    assert body["ok"] is True
    assert body["mode"] == "mock"
    assert body["call"]["state"] == "ringing"
    assert_no_full_numbers(body)

    ended = api.client.post(f"/api/platform/calls/{body['call']['id']}/end")
    assert ended.status_code == 200
    assert ended.json()["call"]["state"] == "completed"
    assert_no_full_numbers(ended.json())


def test_call_routes_enforce_patient_scope(api, db):
    asha = patient_id(db, "CS-1001")
    ravi = patient_id(db, "CS-1002")
    become(role="nurse", patient_id=asha)
    assert api.client.get("/api/platform/calls", params={"patient_id": ravi}).status_code == 403
    assert api.client.post(
        "/api/platform/calls", json={"patient_id": ravi}
    ).status_code == 403


# ---------------------------------------------------------------------------
# messages
# ---------------------------------------------------------------------------
def test_list_messages_is_masked(api, db):
    asha = patient_id(db)
    db.create_message(
        provider="mock", direction="outbound", channel="sms",
        from_e164=NURSE_PHONE, to_e164=PATIENT_PHONE, body="Hello",
        patient_id=asha, state="sent",
    )
    response = api.client.get("/api/platform/messages")
    assert response.status_code == 200
    assert_no_full_numbers(response.json())


def test_send_message_without_a_number_is_refused(api, db):
    asha = patient_id(db)
    response = api.client.post(
        "/api/platform/messages", json={"patient_id": asha, "body": "Hi"}
    )
    assert response.status_code == 400
    assert error_code(response) == "no_number"


def test_send_message_success_and_quiet_hours(api, db, monkeypatch):
    asha = patient_id(db)
    add_contact(db, patient=asha)
    sent = api.client.post(
        "/api/platform/messages", json={"patient_id": asha, "body": "Take your tablets."}
    )
    assert sent.status_code == 200
    assert sent.json()["ok"] is True
    assert sent.json()["message"]["state"] == "sent"
    assert_no_full_numbers(sent.json())

    monkeypatch.setattr(
        TelephonyService, "in_quiet_hours", lambda self, now=None: True
    )
    blocked = api.client.post(
        "/api/platform/messages", json={"patient_id": asha, "body": "Late message"}
    )
    assert blocked.status_code == 200
    assert blocked.json()["ok"] is False
    assert blocked.json()["reason"] == "quiet_hours"

    forced = api.client.post(
        "/api/platform/messages",
        json={"patient_id": asha, "body": "Urgent", "allow_quiet_hours": True},
    )
    assert forced.json()["ok"] is True


def test_family_role_cannot_send_messages(api, db):
    asha = patient_id(db)
    add_contact(db, patient=asha)
    become(role="family", patient_id=asha)
    response = api.client.post(
        "/api/platform/messages", json={"patient_id": asha, "body": "Hi"}
    )
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# escalations
# ---------------------------------------------------------------------------
def test_escalation_listing_and_actions_are_scrubbed(api, db):
    asha = patient_id(db)
    record = db.create_escalation(
        patient_id=asha, severity="urgent", category="worry",
        reason="Patient is worried.", requires_ack=True,
        metadata={"contact_phone": PATIENT_PHONE},
    )
    db.add_escalation_action(
        record["id"], action_type="call_primary_nurse", state="done",
        target_masked="****0001", result=f"Dialled {NURSE_PHONE}",
    )

    listed = api.client.get("/api/platform/escalations")
    assert listed.status_code == 200
    body = listed.json()
    assert body["escalations"][0]["id"] == record["id"]
    assert body["actions"][record["id"]][0]["target_masked"] == "****0001"
    assert_no_full_numbers(body)

    detail = api.client.get(f"/api/platform/escalations/{record['id']}")
    assert detail.status_code == 200
    assert_no_full_numbers(detail.json())
    assert api.client.get("/api/platform/escalations/missing").status_code == 404


def test_acknowledge_and_resolve_escalations(api, db):
    asha = patient_id(db)
    record = db.create_escalation(
        patient_id=asha, severity="urgent", category="worry",
        reason="Patient is worried.", requires_ack=True,
    )
    acked = api.client.post(
        f"/api/platform/escalations/{record['id']}/ack", json={"note": "On my way"}
    )
    assert acked.status_code == 200
    assert acked.json()["escalation"]["state"] == "acknowledged"

    resolved = api.client.post(
        f"/api/platform/escalations/{record['id']}/resolve", json={"note": "Done"}
    )
    assert resolved.status_code == 200
    assert resolved.json()["escalation"]["state"] == "resolved"
    assert db.get_escalation(record["id"])["state"] == "resolved"

    assert api.client.post("/api/platform/escalations/missing/ack").status_code == 404
    assert api.client.post("/api/platform/escalations/missing/resolve").status_code == 404


def test_family_role_cannot_acknowledge_escalations(api, db):
    asha = patient_id(db)
    record = db.create_escalation(
        patient_id=asha, severity="urgent", category="worry", reason="r",
    )
    become(role="family", patient_id=asha)
    response = api.client.post(f"/api/platform/escalations/{record['id']}/ack", json={})
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# family permissions and requests
# ---------------------------------------------------------------------------
def test_family_permission_grant_and_revoke(api, db):
    asha = patient_id(db)
    contact_id = add_contact(db, patient=asha, role="family", name="Priya")
    granted = api.client.post(
        "/api/platform/family/permissions",
        json={"patient_id": asha, "contact_id": contact_id, "scope": {"read": True}},
    )
    assert granted.status_code == 200
    permissions = api.client.get(
        "/api/platform/family/permissions", params={"patient_id": asha}
    ).json()["permissions"]
    assert permissions[0]["scope"] == {"read": True}
    assert permissions[0]["revoked"] is False

    revoked = api.client.post(
        f"/api/platform/family/permissions/{asha}/{contact_id}/revoke"
    )
    assert revoked.status_code == 200
    assert db.get_family_permission(asha, contact_id)["revoked"] is True


def test_family_permission_rejects_a_foreign_contact(api, db):
    asha = patient_id(db)
    ravi = patient_id(db, "CS-1002")
    foreign = add_contact(db, patient=ravi, phone="+919000000009", name="Other")
    response = api.client.post(
        "/api/platform/family/permissions",
        json={"patient_id": asha, "contact_id": foreign, "scope": {"read": True}},
    )
    assert response.status_code == 400
    assert error_code(response) == "bad_contact"


def test_family_request_lifecycle(api, db):
    asha = patient_id(db)
    contact_id = add_contact(db, patient=asha, role="family", name="Priya")
    created = api.client.post(
        "/api/platform/family/requests",
        json={"patient_id": asha, "contact_id": contact_id, "mode": "visit"},
    )
    assert created.status_code == 200
    request = created.json()["request"]
    assert request["state"] == "pending"

    approved = api.client.post(
        f"/api/platform/family/requests/{request['id']}/approve", json={"note": "ok"}
    )
    assert approved.status_code == 200
    assert approved.json()["request"]["state"] == "approved"

    # A decided request cannot be decided again.
    again = api.client.post(f"/api/platform/family/requests/{request['id']}/deny", json={})
    assert again.status_code == 400
    assert error_code(again) == "already_decided"

    listing = api.client.get("/api/platform/family/requests", params={"state": "approved"})
    assert [r["id"] for r in listing.json()["requests"]] == [request["id"]]


def test_expired_and_missing_family_requests(api, db):
    asha = patient_id(db)
    contact_id = add_contact(db, patient=asha, role="family", name="Priya")
    created = api.client.post(
        "/api/platform/family/requests",
        json={"patient_id": asha, "contact_id": contact_id, "mode": "visit"},
    ).json()["request"]
    with db.connection() as conn:
        conn.execute(
            "UPDATE family_requests SET expires_at = ? WHERE id = ?",
            (db.utc_offset(-10), created["id"]),
        )
    expired = api.client.post(f"/api/platform/family/requests/{created['id']}/approve", json={})
    assert expired.status_code == 400
    assert error_code(expired) == "expired"
    assert db.get_family_request(created["id"])["state"] == "expired"

    assert api.client.post("/api/platform/family/requests/missing/deny", json={}).status_code == 404


# ---------------------------------------------------------------------------
# follow-ups
# ---------------------------------------------------------------------------
def test_follow_up_scheduling_masks_the_number(api, db):
    asha = patient_id(db)
    add_contact(db, patient=asha)
    created = api.client.post(
        "/api/platform/follow-ups",
        json={"patient_id": asha, "kind": "follow_up_call", "delay_minutes": 30},
    )
    assert created.status_code == 200
    job = created.json()["job"]
    assert job["payload"]["to_masked"] == PATIENT_MASKED
    assert "to_number" not in job["payload"]
    assert_no_full_numbers(created.json())

    db_job = db.get_job(job["id"])
    assert db_job["payload"]["to_number"] == PATIENT_PHONE

    listed = api.client.get("/api/platform/follow-ups", params={"patient_id": asha})
    assert listed.status_code == 200
    assert_no_full_numbers(listed.json())

    cancelled = api.client.post(f"/api/platform/follow-ups/{job['id']}/cancel")
    assert cancelled.status_code == 200
    assert db.get_job(job["id"])["state"] == "cancelled"
    assert api.client.post("/api/platform/follow-ups/missing/cancel").status_code == 404


def test_follow_up_requires_a_number(api, db):
    asha = patient_id(db)
    response = api.client.post("/api/platform/follow-ups", json={"patient_id": asha})
    assert response.status_code == 400
    assert error_code(response) == "no_number"


# ---------------------------------------------------------------------------
# providers
# ---------------------------------------------------------------------------
def test_provider_summary_reports_the_mock_mode(api):
    response = api.client.get("/api/platform/provider")
    assert response.status_code == 200
    provider = response.json()["provider"]
    assert provider["resolved"] == "mock"
    assert provider["mode_label"].startswith("Simulated")


def test_provider_secrets_are_write_only_and_admin_only(api, monkeypatch):
    stored_values: dict[str, str] = {}

    def fake_set_many(values):
        stored_values.update(
            {key: ("set" if value else "") for key, value in values.items()}
        )
        return dict(stored_values)

    monkeypatch.setattr(secrets_store, "set_many", fake_set_many)
    response = api.client.post(
        "/api/platform/provider/secrets",
        json={"values": {"TWILIO_AUTH_TOKEN": "super-secret"}},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["stored"] == ["TWILIO_AUTH_TOKEN"]
    # The secret value itself is never echoed back.
    assert "super-secret" not in json.dumps(body)

    become(role="nurse")
    forbidden = api.client.post(
        "/api/platform/provider/secrets", json={"values": {"X": "y"}}
    )
    assert forbidden.status_code == 403


def test_provider_test_reports_webhook_readiness(api):
    response = api.client.post("/api/platform/provider/test")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert "webhook_ready" in body
    assert "not proof of reachability" in body["note"]


# ---------------------------------------------------------------------------
# audit and reports
# ---------------------------------------------------------------------------
def test_audit_log_and_chain(api, db):
    asha = patient_id(db)
    db.append_audit(action="patient.view", actor_id="1", actor_role="admin", patient_id=asha)
    response = api.client.get("/api/platform/audit")
    assert response.status_code == 200
    body = response.json()
    assert [e["action"] for e in body["entries"]] == ["patient.view"]
    assert body["chain"] == {"ok": True, "entries": 1}


def test_audit_is_scoped_for_an_assigned_nurse(api, db):
    asha = patient_id(db, "CS-1001")
    ravi = patient_id(db, "CS-1002")
    db.append_audit(action="a", actor_id="1", actor_role="nurse", patient_id=asha)
    db.append_audit(action="b", actor_id="1", actor_role="nurse", patient_id=ravi)
    db.append_audit(action="global", actor_id="1", actor_role="nurse", patient_id=None)

    become(role="nurse", patient_id=asha)
    entries = api.client.get("/api/platform/audit").json()["entries"]
    assert {e["action"] for e in entries} == {"a", "global"}


def test_audit_requires_staff(api):
    become(role="family")
    assert api.client.get("/api/platform/audit").status_code == 403


def test_reports_aggregate_without_phone_numbers(api, db):
    asha = patient_id(db)
    db.create_telephony_call(
        provider="mock", direction="outbound", from_e164=NURSE_PHONE,
        to_e164=PATIENT_PHONE, patient_id=asha, state="completed",
    )
    db.create_message(
        provider="mock", direction="outbound", channel="sms",
        from_e164=NURSE_PHONE, to_e164=PATIENT_PHONE, body="hi",
        patient_id=asha, state="delivered",
    )
    db.create_escalation(
        patient_id=asha, severity="urgent", category="worry", reason="r",
    )
    response = api.client.get("/api/platform/reports")
    assert response.status_code == 200
    body = response.json()
    assert body["totals"] == {"calls": 1, "messages": 1, "escalations": 1}
    assert body["calls_by_state"] == {"completed": 1}
    assert body["messages_by_state"] == {"delivered": 1}
    assert body["escalations_by_severity"] == {"urgent": 1}
    assert_no_full_numbers(body)


def test_overview_is_scoped_for_an_assigned_nurse(api, db):
    asha = patient_id(db, "CS-1001")
    ravi = patient_id(db, "CS-1002")
    db.create_telephony_call(
        provider="mock", direction="outbound", from_e164=NURSE_PHONE,
        to_e164=PATIENT_PHONE, patient_id=asha, state="ringing",
    )
    db.create_telephony_call(
        provider="mock", direction="outbound", from_e164=NURSE_PHONE,
        to_e164="+919000000009", patient_id=ravi, state="ringing",
    )
    become(role="nurse", patient_id=asha)
    body = api.client.get("/api/platform/overview").json()
    assert {c["patient_id"] for c in body["active_calls"]} == {asha}
    assert_no_full_numbers(body)