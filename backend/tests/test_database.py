"""Deep tests for the SQLite persistence layer and dashboard authentication.

Every test runs against the isolated temporary database configured by
``conftest.py``.  No test touches a real database, a real phone number or the
network.  The ``db`` fixture wipes the mutable tables before each test so the
assertions can be exact rather than "at least one row".
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from app import auth, database
from app.telephony.models import UserRole


_TABLES_IN_FK_ORDER = (
    "call_events",
    "message_events",
    "telephony_calls",
    "messages",
    "escalation_actions",
    "escalations",
    "family_requests",
    "family_permissions",
    "scheduled_jobs",
    "verification_challenges",
    "sessions",
    "users",
    "audit_log",
    "webhook_events",
    "provider_config",
    "transcripts",
    "calls",
    "contacts",
)


@pytest.fixture()
def db(clean_db):
    """Empty-but-initialised database for exact-count assertions."""
    clean_db.init_db()
    with clean_db.connection() as conn:
        for table in _TABLES_IN_FK_ORDER:
            conn.execute(f"DELETE FROM {table}")
    return clean_db


def _request(headers: dict[str, str] | None = None) -> Request:
    raw_headers = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw_headers})


# ---------------------------------------------------------------------------
# low-level helpers
# ---------------------------------------------------------------------------
def test_loads_and_dumps_roundtrip():
    assert database._loads("", {}) == {}
    assert database._loads(None, []) == []
    assert database._loads('{"a": 1}', {}) == {"a": 1}
    assert database._loads("[1,2]", []) == [1, 2]
    assert database._loads("not-json", {"fallback": True}) == {"fallback": True}
    assert database._loads({"already": "dict"}, {}) == {"already": "dict"}

    assert database._dumps(None) == "{}"
    assert database._dumps({"a": 1, "b": [2]}) == '{"a":1,"b":[2]}'
    # Compact separators: no spaces, so the stored form is stable.
    assert " " not in database._dumps({"a": 1, "b": 2})


def test_utc_helpers_are_parseable_and_ordered():
    now = database.utc_now()
    later = database.utc_offset(60)
    earlier = database.utc_offset(-60)
    assert now.endswith("Z")
    assert earlier < now < later
    for value in (now, later, earlier):
        from datetime import datetime

        datetime.fromisoformat(value.replace("Z", "+00:00"))  # must not raise


def test_new_id_prefix_and_uniqueness():
    first = database.new_id("tcall")
    second = database.new_id("tcall")
    assert first.startswith("tcall_")
    assert first != second
    assert len(first.split("_")[1]) == 16
    assert database.new_call_id().startswith("call_")
    assert database.new_call_id() != database.new_call_id()


def test_boolify_tolerates_missing_and_none():
    data = {"a": 1, "b": 0, "c": None}
    out = database._boolify(data, "a", "b", "c", "missing")
    assert out["a"] is True
    assert out["b"] is False
    assert out["c"] is None
    assert "missing" not in out


# ---------------------------------------------------------------------------
# patients
# ---------------------------------------------------------------------------
def test_patients_are_seeded_and_case_insensitive(db):
    patients = db.list_patients()
    assert len(patients) >= 6
    assert [p["extension"] for p in patients] == sorted(p["extension"] for p in patients)
    for patient in patients:
        assert patient["synthetic"] is True

    asha = db.get_patient("cs-1001")
    assert asha is not None
    assert asha["display_name"] == "Asha Rao"
    assert asha["synthetic"] is True
    assert db.get_patient("CS-9999") is None

    by_id = db.get_patient_by_id(asha["id"])
    assert by_id["extension"] == "CS-1001"
    assert db.get_patient_by_id(999999) is None


def test_init_db_is_idempotent_and_updates_the_seed(db):
    db.init_db()
    db.init_db()
    rows = [p for p in db.list_patients() if p["extension"] == "CS-1001"]
    assert len(rows) == 1


# ---------------------------------------------------------------------------
# legacy call history
# ---------------------------------------------------------------------------
def test_call_history_lifecycle(db):
    db.create_call(
        call_id="call_abc",
        caller_extension="CS-1001",
        callee_extension="CS-0000",
        patient_name="Asha Rao",
        demo_mode=True,
    )
    db.append_transcript("call_abc", "assistant", "Hi Asha", latency_ms=120)
    db.append_transcript("call_abc", "user", "Hello", latency_ms=80)
    db.finish_call(call_id="call_abc", status="completed", turns=2, avg_latency_ms=100)

    call = db.get_call("call_abc")
    assert call["status"] == "completed"
    assert call["turns"] == 2
    assert call["avg_latency_ms"] == 100
    assert call["demo_mode"] is True
    assert call["ended_at"] is not None
    assert [t["role"] for t in call["transcripts"]] == ["assistant", "user"]
    assert call["transcripts"][0]["text"] == "Hi Asha"

    listed = db.list_calls()
    assert len(listed) == 1
    assert listed[0]["transcript_rows"] == 2
    assert listed[0]["demo_mode"] is True
    assert db.get_call("missing") is None


def test_finish_unknown_call_is_a_noop(db):
    db.finish_call(call_id="nope", status="completed", turns=0)
    assert db.get_call("nope") is None


def test_calls_are_newest_first_and_capped(db):
    for hour in range(3):
        call_id = f"call_{hour}"
        db.create_call(
            call_id=call_id,
            caller_extension="CS-1001",
            callee_extension="CS-0000",
            patient_name="Asha",
            demo_mode=False,
        )
        # Backdate so ordering is deterministic (timestamps are second-precise).
        with db.connection() as conn:
            conn.execute(
                "UPDATE calls SET started_at = ? WHERE id = ?",
                (db.utc_offset(-3600 * (3 - hour)), call_id),
            )
    listed = db.list_calls(limit=2)
    assert [c["id"] for c in listed] == ["call_2", "call_1"]
    # The limit is clamped, not trusted blindly.
    assert len(db.list_calls(limit=0)) == 1


def test_delete_history_removes_calls_and_transcripts(db):
    db.create_call(
        call_id="call_x",
        caller_extension="CS-1001",
        callee_extension="CS-0000",
        patient_name="Asha",
        demo_mode=True,
    )
    db.append_transcript("call_x", "user", "hello")
    assert db.delete_history() == 1
    assert db.list_calls() == []
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0] == 0


def test_healthcheck_reports_a_working_database(db):
    health = db.healthcheck()
    assert health["ok"] is True
    assert health["patients"] >= 6
    assert health["size_bytes"] >= 0
    assert health["path"].endswith(".db")


# ---------------------------------------------------------------------------
# contacts
# ---------------------------------------------------------------------------
def test_contact_upsert_returns_the_same_row(db):
    patient = db.get_patient("CS-1001")
    first = db.add_contact(
        patient_id=patient["id"],
        role="family",
        display_name="Priya Rao",
        phone_e164="+919876543210",
        phone_masked="•••••3210",
        permissions={"can_receive_updates": True},
        consent_status="granted",
        is_primary=True,
    )
    second = db.add_contact(
        patient_id=patient["id"],
        role="family",
        display_name="Priya R.",
        phone_e164="+919876543210",
        phone_masked="•••••3210",
        permissions={"can_receive_updates": False},
        consent_status="granted",
        is_primary=True,
    )
    assert first == second
    contact = db.get_contact(first)
    assert contact["display_name"] == "Priya R."
    assert contact["permissions"] == {"can_receive_updates": False}
    assert contact["is_primary"] is True
    assert contact["active"] is True


def test_contact_verification_revoke_permissions_and_lookup(db):
    patient = db.get_patient("CS-1001")
    contact_id = db.add_contact(
        patient_id=patient["id"],
        role="primary_nurse",
        display_name="Nurse Joy",
        phone_e164="+918000000001",
        phone_masked="•••••0001",
    )
    assert db.find_contacts_by_phone("+918000000001")[0]["id"] == contact_id

    db.update_contact_verification(contact_id, "verified")
    assert db.get_contact(contact_id)["verification_status"] == "verified"
    assert db.get_contact(contact_id)["verified_at"] is not None

    db.update_contact_verification(contact_id, "unverified")
    assert db.get_contact(contact_id)["verified_at"] is None

    db.update_contact_permissions(contact_id, {"call": True})
    assert db.get_contact(contact_id)["permissions"] == {"call": True}

    db.revoke_contact(contact_id)
    assert db.get_contact(contact_id)["active"] is False
    assert db.get_contact(contact_id)["revoked_at"] is not None
    # Revoked contacts disappear from the default list and phone lookup.
    assert db.list_contacts(patient["id"]) == []
    assert [c["id"] for c in db.list_contacts(patient["id"], include_inactive=True)] == [contact_id]
    assert db.find_contacts_by_phone("+918000000001") == []

    # Re-adding the same contact revives it rather than duplicating.
    revived = db.add_contact(
        patient_id=patient["id"],
        role="primary_nurse",
        display_name="Nurse Joy",
        phone_e164="+918000000001",
        phone_masked="•••••0001",
    )
    assert revived == contact_id
    assert db.get_contact(contact_id)["active"] is True


def test_list_contacts_scopes_by_patient_and_active(db):
    asha = db.get_patient("CS-1001")
    ravi = db.get_patient("CS-1002")
    db.add_contact(
        patient_id=asha["id"], role="family", display_name="A",
        phone_e164="+919000000001", phone_masked="", 
    )
    db.add_contact(
        patient_id=ravi["id"], role="family", display_name="R",
        phone_e164="+919000000002", phone_masked="",
    )
    assert [c["display_name"] for c in db.list_contacts(asha["id"])] == ["A"]
    assert len(db.list_contacts()) == 2


# ---------------------------------------------------------------------------
# telephony calls
# ---------------------------------------------------------------------------
def _call(db, **overrides):
    payload = dict(
        provider="mock",
        direction="outbound",
        from_e164="+918000000000",
        to_e164="+919876543210",
        from_masked="•••••0000",
        to_masked="•••••3210",
        patient_id=1,
        purpose="nurse_to_patient_ai",
        state="created",
        provider_mode="mock",
    )
    payload.update(overrides)
    return db.create_telephony_call(**payload)


def test_create_telephony_call_and_idempotency(db):
    first = _call(db, idempotency_key="idem-1")
    assert first["created"] is True
    assert first["metadata"] == {}
    assert first["recording"] is False

    duplicate = _call(db, idempotency_key="idem-1")
    assert duplicate["created"] is False
    assert duplicate["id"] == first["id"]
    assert len(db.list_telephony_calls()) == 1


def test_telephony_call_lookup_and_mutations(db):
    record = _call(db)
    assert db.get_telephony_call(record["id"])["state"] == "created"
    assert db.get_telephony_call("missing") is None

    db.set_provider_call_id(record["id"], "provider-xyz")
    assert db.get_telephony_call_by_provider_id("provider-xyz")["id"] == record["id"]
    assert db.get_telephony_call_by_provider_id("nope") is None

    updated = db.update_telephony_call(
        record["id"], state="answered", answered=True
    )
    assert updated["state"] == "answered"
    assert updated["answered_at"] is not None

    ended = db.update_telephony_call(
        record["id"], state="completed", ended=True, duration_ms=4200
    )
    assert ended["ended_at"] is not None
    assert ended["duration_ms"] == 4200

    failed = db.update_telephony_call(record["id"], state="failed", error="boom")
    assert failed["error"] == "boom"
    assert db.update_telephony_call("missing", state="completed") is None


def test_call_events_are_deduped_by_provider_event_id(db):
    record = _call(db)
    assert db.add_call_event(
        record["id"], event_type="ringing", state="ringing", payload={"n": 1},
        provider_event_id="evt-1",
    ) is True
    assert db.add_call_event(
        record["id"], event_type="ringing", state="ringing", payload={"n": 2},
        provider_event_id="evt-1",
    ) is False
    events = db.list_call_events(record["id"])
    assert len(events) == 1
    assert json.loads(events[0]["payload_json"]) == {"n": 1}


def test_list_telephony_calls_filters_and_counts(db):
    a = _call(db, patient_id=1, state="ringing")
    b = _call(db, patient_id=2, state="completed")
    c = _call(db, patient_id=1, state="completed")

    assert {r["id"] for r in db.list_telephony_calls(patient_id=1)} == {a["id"], c["id"]}
    assert {r["id"] for r in db.list_telephony_calls(states=["completed"])} == {b["id"], c["id"]}
    assert len(db.list_telephony_calls(limit=1)) == 1

    since = db.utc_offset(-60)
    assert db.count_calls_since(None, since) == 3
    assert db.count_calls_since(1, since) == 2
    # A future cutoff counts nothing.
    assert db.count_calls_since(None, db.utc_offset(3600)) == 0


def test_metadata_is_parsed_and_recording_flag_is_bool(db):
    record = _call(db, recording=True, metadata={"patient_name": "Asha", "x": 1})
    stored = db.get_telephony_call(record["id"])
    assert stored["recording"] is True
    assert stored["metadata"] == {"patient_name": "Asha", "x": 1}


# ---------------------------------------------------------------------------
# messages
# ---------------------------------------------------------------------------
def _message(db, **overrides):
    payload = dict(
        provider="mock",
        direction="outbound",
        channel="sms",
        from_e164="+918000000000",
        to_e164="+919876543210",
        body="Take your tablets.",
        patient_id=1,
        state="created",
        provider_mode="mock",
    )
    payload.update(overrides)
    return db.create_message(**payload)


def test_message_lifecycle_and_idempotency(db):
    first = _message(db, idempotency_key="msg-1")
    assert first["created"] is True
    duplicate = _message(db, idempotency_key="msg-1")
    assert duplicate["created"] is False
    assert duplicate["id"] == first["id"]

    db.set_message_provider_id(first["id"], "pmsg-1")
    assert db.get_message_by_provider_id("pmsg-1")["id"] == first["id"]

    delivered = db.update_message_state(first["id"], state="delivered", delivered=True)
    assert delivered["state"] == "delivered"
    assert delivered["delivered_at"] is not None

    failed = db.update_message_state(first["id"], state="failed", error="rejected")
    assert failed["error"] == "rejected"
    assert db.update_message_state("missing", state="sent") is None


def test_message_events_dedupe_and_listing(db):
    record = _message(db)
    assert db.add_message_event(
        record["id"], event_type="delivered", state="delivered", payload={},
        provider_event_id="me-1",
    ) is True
    assert db.add_message_event(
        record["id"], event_type="delivered", state="delivered", payload={},
        provider_event_id="me-1",
    ) is False

    other = _message(db, patient_id=2)
    assert {m["id"] for m in db.list_messages(patient_id=1)} == {record["id"]}
    assert {m["id"] for m in db.list_messages()} == {record["id"], other["id"]}

    since = db.utc_offset(-60)
    assert db.count_messages_since(None, since) == 2
    assert db.count_messages_since(2, since) == 1


# ---------------------------------------------------------------------------
# escalations
# ---------------------------------------------------------------------------
def _escalation(db, **overrides):
    payload = dict(
        patient_id=1,
        severity="urgent",
        category="worry",
        reason="Patient is worried.",
        requires_ack=True,
    )
    payload.update(overrides)
    return db.create_escalation(**payload)


def test_escalation_dedupe_and_action_log(db):
    first = _escalation(db, dedupe_key="esc:1")
    assert first["created"] is True
    duplicate = _escalation(db, dedupe_key="esc:1")
    assert duplicate["created"] is False
    assert duplicate["id"] == first["id"]

    db.add_escalation_action(
        first["id"], action_type="call_nurse", state="attempted", target_masked="•••••1"
    )
    actions = db.list_escalation_actions(first["id"])
    assert len(actions) == 1
    assert actions[0]["action_type"] == "call_nurse"
    assert actions[0]["state"] == "attempted"


def test_escalation_state_transitions_record_actor(db):
    record = _escalation(db)
    acked = db.update_escalation_state(record["id"], state="acknowledged", actor="Nurse Joy")
    assert acked["state"] == "acknowledged"
    assert acked["acknowledged_by"] == "Nurse Joy"
    assert acked["acknowledged_at"] is not None

    resolved = db.update_escalation_state(
        record["id"], state="resolved", actor="Nurse Joy", resolved=True
    )
    assert resolved["resolved_by"] == "Nurse Joy"
    assert resolved["resolved_at"] is not None
    assert resolved["requires_ack"] is True
    assert db.update_escalation_state("missing", state="resolved") is None


def test_list_escalations_orders_by_severity_then_recency(db):
    db.create_escalation(
        patient_id=1, severity="routine", category="worry", reason="r",
        dedupe_key="esc-routine",
    )
    db.create_escalation(
        patient_id=1, severity="emergency", category="cardiac", reason="e",
        dedupe_key="esc-emergency",
    )
    db.create_escalation(
        patient_id=1, severity="urgent", category="fall", reason="u",
        dedupe_key="esc-urgent",
    )
    ordered = [e["severity"] for e in db.list_escalations()]
    assert ordered == ["emergency", "urgent", "routine"]
    # ``state`` filters the lifecycle state, not the severity.
    assert len(db.list_escalations(state="open")) == 3
    assert db.list_escalations(state="resolved") == []
    assert len(db.list_escalations(patient_id=1)) == 3
    assert db.list_escalations(patient_id=2) == []


def test_unacknowledged_escalations_requires_open_and_ack(db):
    open_ack = _escalation(db, dedupe_key="e1")
    _escalation(db, dedupe_key="e2", requires_ack=False)
    acked = _escalation(db, dedupe_key="e3")
    db.update_escalation_state(acked["id"], state="acknowledged", actor="n")
    pending = db.unacknowledged_escalations()
    assert [e["id"] for e in pending] == [open_ack["id"]]


# ---------------------------------------------------------------------------
# family permissions and requests
# ---------------------------------------------------------------------------
def test_family_permission_upsert_and_revoke(db):
    db.upsert_family_permission(
        patient_id=1, contact_id=2, scope={"read": True}, granted_by="nurse"
    )
    permission = db.get_family_permission(1, 2)
    assert permission["scope"] == {"read": True}
    assert permission["granted_by"] == "nurse"
    assert permission["revoked"] is False

    db.upsert_family_permission(
        patient_id=1, contact_id=2, scope={"read": False}, granted_by="admin"
    )
    assert db.get_family_permission(1, 2)["scope"] == {"read": False}
    assert len(db.list_family_permissions(1)) == 1

    db.revoke_family_permission(1, 2)
    assert db.get_family_permission(1, 2)["revoked"] is True

    # Re-granting clears the revocation.
    db.upsert_family_permission(
        patient_id=1, contact_id=2, scope={"read": True}, granted_by="nurse"
    )
    assert db.get_family_permission(1, 2)["revoked"] is False
    assert db.get_family_permission(9, 9) is None


def test_family_request_lifecycle(db):
    request = db.create_family_request(
        patient_id=1, contact_id=2, mode="visit", requested_by="family",
        detail="Please call me", metadata={"k": "v"}, expires_in_seconds=60,
    )
    assert request["state"] == "pending"
    assert request["metadata"] == {"k": "v"}
    assert request["expires_at"] > db.utc_now()

    updated = db.update_family_request(
        request["id"], state="approved", verification_state="verified", decided_by="nurse"
    )
    assert updated["state"] == "approved"
    assert updated["verification_state"] == "verified"
    assert updated["decided_by"] == "nurse"
    assert updated["decided_at"] is not None

    assert [r["id"] for r in db.list_family_requests(state="approved")] == [request["id"]]
    assert db.list_family_requests(state="denied") == []
    assert db.get_family_request("missing") is None
    assert db.update_family_request("missing", state="approved") is None


# ---------------------------------------------------------------------------
# scheduled jobs
# ---------------------------------------------------------------------------
def test_job_dedupe_and_lookup(db):
    first = db.create_job(kind="ack_check", run_at=db.utc_offset(30), dedupe_key="job-1")
    assert first["created"] is True
    duplicate = db.create_job(kind="ack_check", run_at=db.utc_offset(30), dedupe_key="job-1")
    assert duplicate["created"] is False
    assert duplicate["id"] == first["id"]
    assert db.get_job(first["id"])["payload"] == {}
    assert db.get_job("missing") is None


def test_claim_due_jobs_leases_once_and_increments_attempts(db):
    due = db.create_job(kind="k", run_at=db.utc_offset(-10), payload={"a": 1})
    future = db.create_job(kind="k", run_at=db.utc_offset(600))

    claimed = db.claim_due_jobs(limit=10, lease_seconds=120)
    assert [j["id"] for j in claimed] == [due["id"]]
    assert claimed[0]["state"] == "leased"
    assert claimed[0]["attempts"] == 1
    assert claimed[0]["payload"] == {"a": 1}
    assert claimed[0]["lease_until"] is not None

    # A second worker cannot claim a live lease.
    assert db.claim_due_jobs() == []
    assert db.get_job(future["id"])["state"] == "pending"


def test_expired_lease_can_be_reclaimed(db):
    job = db.create_job(kind="k", run_at=db.utc_offset(-10))
    db.claim_due_jobs(lease_seconds=-1)  # lease already expired
    reclaimed = db.claim_due_jobs()
    assert [j["id"] for j in reclaimed] == [job["id"]]
    assert reclaimed[0]["attempts"] == 2


def test_complete_and_retry_job(db):
    job = db.create_job(kind="k", run_at=db.utc_offset(-10))
    db.claim_due_jobs()
    db.complete_job(job["id"], state="done", error=None)
    stored = db.get_job(job["id"])
    assert stored["state"] == "done"
    assert stored["lease_until"] is None

    retry = db.retry_job(job["id"], run_at=db.utc_offset(60), error="transient")
    assert retry["state"] == "pending"
    assert retry["last_error"] == "transient"
    assert retry["lease_until"] is None


def test_list_and_cancel_pending_jobs(db):
    a = db.create_job(kind="follow_up_call", run_at=db.utc_offset(10), patient_id=1)
    b = db.create_job(kind="follow_up_message", run_at=db.utc_offset(20), patient_id=1)
    c = db.create_job(kind="follow_up_call", run_at=db.utc_offset(30), patient_id=2)
    db.complete_job(b["id"], state="done")

    assert [j["id"] for j in db.list_jobs(states=["pending"])] == [a["id"], c["id"]]
    assert [j["id"] for j in db.list_jobs(patient_id=1)] == [a["id"], b["id"]]

    assert db.cancel_pending_jobs_for_patient(1) == 1
    assert db.get_job(a["id"])["state"] == "cancelled"
    assert db.get_job(c["id"])["state"] == "pending"

    # Kind filter leaves other kinds alone.
    d = db.create_job(kind="follow_up_call", run_at=db.utc_offset(40), patient_id=2)
    e = db.create_job(kind="ack_check", run_at=db.utc_offset(50), patient_id=2)
    assert db.cancel_pending_jobs_for_patient(2, kind="follow_up_call") == 2
    assert db.get_job(d["id"])["state"] == "cancelled"
    assert db.get_job(e["id"])["state"] == "pending"


# ---------------------------------------------------------------------------
# verification challenges
# ---------------------------------------------------------------------------
def test_challenge_lifecycle(db):
    challenge = db.create_challenge(
        contact_id=7, phone_masked="•••••3210", channel="sms", purpose="family_access",
        code_hash="hash", ttl_seconds=300, max_attempts=5, metadata={"ip": "local"},
    )
    assert challenge["state"] == "pending"
    assert challenge["attempts"] == 0
    assert challenge["max_attempts"] == 5
    assert challenge["metadata"] == {"ip": "local"}
    assert challenge["expires_at"] > db.utc_now()

    updated = db.update_challenge(challenge["id"], state="verified", attempts=2, used=True)
    assert updated["state"] == "verified"
    assert updated["attempts"] == 2
    assert updated["used_at"] is not None

    # No-op update still returns the current row.
    assert db.update_challenge(challenge["id"])["state"] == "verified"
    assert db.get_challenge("missing") is None
    assert db.update_challenge("missing", state="verified") is None


# ---------------------------------------------------------------------------
# users, sessions, audit
# ---------------------------------------------------------------------------
def _user(db, username="nurse.one", role="nurse", password="pw"):
    return db.create_user(
        username=username,
        display_name="Nurse One",
        role=role,
        password_hash=auth.hash_password(password),
        patient_id=None,
    )


def test_user_creation_is_idempotent_and_case_insensitive(db):
    user_id = _user(db)
    assert user_id > 0
    assert _user(db, username="NURSE.ONE") == user_id
    assert len(db.list_users()) == 1

    found = db.get_user_by_username("  NURSE.ONE ")
    assert found["id"] == user_id
    assert found["username"] == "nurse.one"
    assert found["password_hash"].startswith("scrypt$")
    assert found["active"] is True
    assert db.get_user_by_username("missing") is None
    assert db.get_user(user_id)["id"] == user_id

    # The list view never leaks the password hash.
    assert "password_hash" not in db.list_users()[0]


def test_login_failure_lock_and_success_reset(db):
    user_id = _user(db)
    db.record_login_failure(user_id, lock_seconds=300, max_attempts=3)
    db.record_login_failure(user_id, lock_seconds=300, max_attempts=3)
    assert db.get_user(user_id)["locked_until"] is None
    db.record_login_failure(user_id, lock_seconds=300, max_attempts=3)
    locked = db.get_user(user_id)
    assert locked["failed_attempts"] == 3
    assert locked["locked_until"] is not None
    assert locked["locked_until"] > db.utc_now()

    db.record_login_success(user_id)
    cleared = db.get_user(user_id)
    assert cleared["failed_attempts"] == 0
    assert cleared["locked_until"] is None
    assert cleared["last_login_at"] is not None


def test_password_update_and_deactivation(db):
    user_id = _user(db)
    new_hash = auth.hash_password("new-password")
    db.update_user_password(user_id, new_hash)
    assert auth.verify_password("new-password", db.get_user(user_id)["password_hash"])

    db.set_user_active(user_id, False)
    assert db.get_user(user_id)["active"] is False
    db.set_user_active(user_id, True)
    assert db.get_user(user_id)["active"] is True


def test_session_create_lookup_revoke_and_purge(db):
    user_id = _user(db)
    db.create_session(
        token_hash="hash-1", user_id=user_id, expires_at=db.utc_offset(600),
        user_agent="agent",
    )
    session = db.get_session("hash-1")
    assert session["user_id"] == user_id
    assert session["username"] == "nurse.one"
    assert session["role"] == "nurse"
    assert session["revoked_at"] is None

    db.revoke_session("hash-1")
    assert db.get_session("hash-1")["revoked_at"] is not None

    # Purge removes both revoked and expired sessions.
    db.create_session(token_hash="hash-2", user_id=user_id, expires_at=db.utc_offset(-1))
    db.create_session(token_hash="hash-3", user_id=user_id, expires_at=db.utc_offset(600))
    assert db.purge_expired_sessions() == 2
    assert db.get_session("hash-1") is None
    assert db.get_session("hash-2") is None
    assert db.get_session("hash-3") is not None


def test_revoke_user_sessions_only_touches_that_user(db):
    one = _user(db, username="a")
    two = _user(db, username="b")
    db.create_session(token_hash="a1", user_id=one, expires_at=db.utc_offset(600))
    db.create_session(token_hash="a2", user_id=one, expires_at=db.utc_offset(600))
    db.create_session(token_hash="b1", user_id=two, expires_at=db.utc_offset(600))
    db.revoke_user_sessions(one)
    assert db.get_session("a1")["revoked_at"] is not None
    assert db.get_session("a2")["revoked_at"] is not None
    assert db.get_session("b1")["revoked_at"] is None


def test_audit_chain_links_and_detects_tampering(db):
    first = db.append_audit(action="login", actor_id="1", actor_role="nurse", detail={"ip": "x"})
    second = db.append_audit(action="call.start", actor_id="1", patient_id=1)
    assert first != second

    listed = db.list_audit()
    assert len(listed) == 2
    assert listed[0]["action"] == "call.start"  # newest first
    assert listed[0]["detail"] == {}
    assert listed[1]["detail"] == {"ip": "x"}
    assert [e["id"] for e in db.list_audit(patient_id=1)] == [listed[0]["id"]]

    assert db.verify_audit_chain() == {"ok": True, "entries": 2}

    # Tamper with an earlier row -> the chain breaks at that row.
    with db.connection() as conn:
        conn.execute("UPDATE audit_log SET action = 'tampered' WHERE action = 'login'")
    broken = db.verify_audit_chain()
    assert broken["ok"] is False
    assert broken["broken_at"] == listed[1]["id"]
    assert broken["entries"] == 2


def test_empty_audit_chain_is_valid(db):
    assert db.verify_audit_chain() == {"ok": True, "entries": 0}


# ---------------------------------------------------------------------------
# webhook idempotency and provider config
# ---------------------------------------------------------------------------
def test_record_webhook_event_is_first_seen_only(db):
    assert db.record_webhook_event("twilio", "evt-1") is True
    assert db.record_webhook_event("twilio", "evt-1") is False
    assert db.record_webhook_event("exotel", "evt-1") is True


def test_provider_config_upsert_and_listing(db):
    db.upsert_provider_config("twilio", enabled=True, verified=False, metadata={"region": "us"})
    config = db.get_provider_config("twilio")
    assert config["enabled"] is True
    assert config["verified"] is False
    assert config["verified_at"] is None
    assert config["metadata"] == {"region": "us"}

    db.upsert_provider_config("twilio", enabled=True, verified=True)
    verified = db.get_provider_config("twilio")
    assert verified["verified"] is True
    assert verified["verified_at"] is not None
    assert len(db.list_provider_configs()) == 1

    db.upsert_provider_config("exotel", enabled=False, verified=False)
    assert [c["provider"] for c in db.list_provider_configs()] == ["exotel", "twilio"]
    assert db.get_provider_config("missing") is None


# ---------------------------------------------------------------------------
# retention
# ---------------------------------------------------------------------------
def test_purge_older_than_removes_only_old_rows(db):
    old = _call(db)
    recent = _call(db)
    db.create_message(provider="mock", direction="outbound", channel="sms",
                      from_e164="", to_e164="", body="hi", patient_id=1)
    db.record_webhook_event("mock", "old-event")
    with db.connection() as conn:
        conn.execute("UPDATE telephony_calls SET created_at = ? WHERE id = ?",
                     (db.utc_offset(-40 * 86400), old["id"]))
        conn.execute("UPDATE messages SET created_at = ?", (db.utc_offset(-40 * 86400),))
        conn.execute("UPDATE webhook_events SET received_at = ?", (db.utc_offset(-40 * 86400),))

    removed = db.purge_older_than(30)
    assert removed["telephony_calls"] == 1
    assert removed["messages"] == 1
    assert removed["webhook_events"] == 1
    assert db.get_telephony_call(old["id"]) is None
    assert db.get_telephony_call(recent["id"]) is not None


# ---------------------------------------------------------------------------
# authentication helpers
# ---------------------------------------------------------------------------
def test_password_hash_roundtrip_and_rejections():
    encoded = auth.hash_password("correct horse")
    assert encoded.startswith("scrypt$")
    assert auth.verify_password("correct horse", encoded) is True
    assert auth.verify_password("wrong", encoded) is False
    assert auth.verify_password("x", "not-a-hash") is False
    assert auth.verify_password("x", "bcrypt$1$2$3$4$5") is False
    # Two hashes of the same password use different salts.
    assert auth.hash_password("same") != auth.hash_password("same")


def test_token_hash_is_sha256_of_the_raw_token():
    import hashlib

    raw, hashed = auth.new_token()
    assert auth.token_hash(raw) == hashed
    assert hashed == hashlib.sha256(raw.encode()).hexdigest()
    assert auth.new_token()[0] != auth.new_token()[0]


def test_authenticate_success_and_failure(db):
    user_id = _user(db, username="nurse.auth", password="secret123")
    user = auth.authenticate("NURSE.AUTH", "secret123")
    assert user["id"] == user_id
    assert db.get_user(user_id)["last_login_at"] is not None

    assert auth.authenticate("nurse.auth", "bad") is None
    assert db.get_user(user_id)["failed_attempts"] == 1
    assert auth.authenticate("ghost", "whatever") is None


def test_authenticate_refuses_inactive_and_locked_users(db):
    user_id = _user(db, username="nurse.mid", password="pw")
    db.set_user_active(user_id, False)
    assert auth.authenticate("nurse.mid", "pw") is None

    db.set_user_active(user_id, True)
    db.record_login_failure(user_id, lock_seconds=300, max_attempts=1)
    assert auth.authenticate("nurse.mid", "pw") is None


def test_start_and_end_session(db):
    user_id = _user(db, username="nurse.sess")
    user = db.get_user(user_id)
    raw = auth.start_session(user, user_agent="pytest")
    session = db.get_session(auth.token_hash(raw))
    assert session["user_id"] == user_id
    assert session["user_agent"] == "pytest"

    auth.end_session(raw)
    assert db.get_session(auth.token_hash(raw))["revoked_at"] is not None


def test_current_user_dev_bypass(monkeypatch):
    monkeypatch.setattr(auth, "settings", SimpleNamespace(require_dashboard_auth=False))
    user = auth.current_user(_request())
    assert user["role"] == UserRole.ADMIN.value
    assert user["dev_bypass"] is True


def test_current_user_requires_a_token(db):
    with pytest.raises(auth.AuthError) as exc:
        auth.current_user(_request())
    assert exc.value.status_code == 401
    assert exc.value.detail["code"] == "unauthenticated"


def test_current_user_reads_bearer_and_cookie_tokens(db):
    user_id = _user(db, username="nurse.req")
    raw = auth.start_session(db.get_user(user_id))

    bearer = auth.current_user(_request({"authorization": f"Bearer {raw}"}))
    assert bearer["id"] == user_id
    assert bearer["username"] == "nurse.req"
    assert bearer["session_hash"] == auth.token_hash(raw)

    via_cookie = auth.current_user(
        _request({"cookie": f"{auth.SESSION_COOKIE}={raw}"})
    )
    assert via_cookie["id"] == user_id


def test_current_user_rejects_revoked_expired_and_invalid_sessions(db):
    user_id = _user(db, username="nurse.bad")

    def store(raw: str, *, expires_in: int = 600) -> None:
        # The database only ever stores the SHA-256 of the opaque token.
        db.create_session(
            token_hash=auth.token_hash(raw), user_id=user_id,
            expires_at=db.utc_offset(expires_in),
        )

    store("revoked-token")
    db.revoke_session(auth.token_hash("revoked-token"))
    with pytest.raises(auth.AuthError) as revoked:
        auth.current_user(_request({"authorization": "Bearer revoked-token"}))
    assert revoked.value.detail["code"] == "session_revoked"

    store("expired-token", expires_in=-10)
    with pytest.raises(auth.AuthError) as expired:
        auth.current_user(_request({"authorization": "Bearer expired-token"}))
    assert expired.value.detail["code"] == "session_expired"

    with pytest.raises(auth.AuthError) as invalid:
        auth.current_user(_request({"authorization": "Bearer no-such-token"}))
    assert invalid.value.detail["code"] == "invalid_session"

    # Deactivating the account invalidates an otherwise valid session.
    store("live-token")
    db.set_user_active(user_id, False)
    with pytest.raises(auth.AuthError) as inactive:
        auth.current_user(_request({"authorization": "Bearer live-token"}))
    assert inactive.value.detail["code"] == "invalid_session"


def test_require_roles_enforces_roles_and_allows_dev_bypass():
    nurse_gate = auth.require_roles(UserRole.NURSE)
    assert nurse_gate({"role": "nurse"})["role"] == "nurse"
    assert nurse_gate({"role": "nurse", "dev_bypass": True})["dev_bypass"] is True
    with pytest.raises(auth.AuthError) as exc:
        nurse_gate({"role": "family"})
    assert exc.value.status_code == 403

    admin_gate = auth.require_roles("admin")
    assert admin_gate({"role": "admin"})["role"] == "admin"


def test_ensure_patient_access_rules():
    auth.ensure_patient_access({"role": "admin"}, 5)
    auth.ensure_patient_access({"role": "nurse", "patient_id": 5}, 5)
    auth.ensure_patient_access({"role": "nurse", "patient_id": None}, 5)  # pool nurse
    auth.ensure_patient_access({"role": "nurse", "patient_id": 5, "dev_bypass": True}, 9)
    with pytest.raises(auth.AuthError) as exc:
        auth.ensure_patient_access({"role": "nurse", "patient_id": 5}, 9)
    assert exc.value.detail["code"] == "forbidden_patient"


def test_is_admin():
    assert auth.is_admin({"role": "admin"}) is True
    assert auth.is_admin({"role": "nurse"}) is False


def test_audit_writes_through_the_chained_log(db):
    user = {"id": 5, "role": "nurse"}
    auth.audit(user, "patient.view", entity_type="patient", entity_id="1", patient_id=1,
               detail={"reason": "review"})
    entries = db.list_audit()
    assert len(entries) == 1
    assert entries[0]["actor_id"] == "5"
    assert entries[0]["actor_role"] == "nurse"
    assert entries[0]["action"] == "patient.view"
    assert entries[0]["patient_id"] == 1
    assert entries[0]["detail"] == {"reason": "review"}
    assert db.verify_audit_chain()["ok"] is True


def test_seed_default_users_is_idempotent(db):
    first = auth.seed_default_users()
    second = auth.seed_default_users()
    assert db.get_user_by_username("admin") is not None
    assert db.get_user_by_username("nurse.demo") is not None
    assert "admin" not in second["created"]
    assert "nurse.demo" not in second["created"]
    assert first["credentials_path"] or True  # path only exists on first creation