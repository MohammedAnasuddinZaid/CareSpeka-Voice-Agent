"""SQLite persistence for CareSpeak VoiceLink.

Only synthetic demo patients are seeded.  The database is a single local file
and is never replicated to a cloud service.
"""
from __future__ import annotations

import json
import os
import hashlib
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from app.config import settings

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    extension TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    age INTEGER,
    room TEXT,
    primary_concern TEXT,
    language TEXT NOT NULL DEFAULT 'en',
    notes TEXT,
    synthetic INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    caller_extension TEXT NOT NULL,
    callee_extension TEXT NOT NULL,
    patient_name TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    avg_latency_ms INTEGER,
    demo_mode INTEGER NOT NULL DEFAULT 1,
    error TEXT
);

CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    latency_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_transcripts_call ON transcripts(call_id);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at DESC);

-- ---------------------------------------------------------------------------
-- VoiceLink 2.0 platform tables.  Added with CREATE TABLE IF NOT EXISTS so an
-- existing VoiceLink database is upgraded in place and no prior data is lost.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    display_name TEXT NOT NULL,
    phone_e164 TEXT NOT NULL,
    phone_masked TEXT NOT NULL,
    preferred_channel TEXT NOT NULL DEFAULT 'sms',
    permissions_json TEXT NOT NULL DEFAULT '{}',
    consent_status TEXT NOT NULL DEFAULT 'unknown',
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    verified_at TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_patient ON contacts(patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_unique ON contacts(patient_id, role, phone_e164);

CREATE TABLE IF NOT EXISTS telephony_calls (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_call_id TEXT,
    direction TEXT NOT NULL,
    from_e164 TEXT,
    to_e164 TEXT,
    from_masked TEXT,
    to_masked TEXT,
    patient_id INTEGER,
    contact_id INTEGER,
    purpose TEXT NOT NULL DEFAULT 'nurse_to_patient_ai',
    state TEXT NOT NULL,
    provider_mode TEXT NOT NULL DEFAULT 'real',
    idempotency_key TEXT,
    recording INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER,
    error TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tcalls_idempotency ON telephony_calls(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tcalls_patient ON telephony_calls(patient_id);
CREATE INDEX IF NOT EXISTS idx_tcalls_created ON telephony_calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tcalls_provider_call ON telephony_calls(provider_call_id);

CREATE TABLE IF NOT EXISTS call_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL REFERENCES telephony_calls(id) ON DELETE CASCADE,
    provider_event_id TEXT,
    event_type TEXT NOT NULL,
    state TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    received_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_events_dedupe
    ON call_events(call_id, provider_event_id);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_message_id TEXT,
    direction TEXT NOT NULL,
    channel TEXT NOT NULL,
    from_e164 TEXT,
    to_e164 TEXT,
    from_masked TEXT,
    to_masked TEXT,
    patient_id INTEGER,
    contact_id INTEGER,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    provider_mode TEXT NOT NULL DEFAULT 'real',
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    delivered_at TEXT,
    error TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_messages_patient ON messages(patient_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

CREATE TABLE IF NOT EXISTS message_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    provider_event_id TEXT,
    event_type TEXT NOT NULL,
    state TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    received_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_events_dedupe
    ON message_events(message_id, provider_event_id);

CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    patient_id INTEGER,
    call_id TEXT,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    reason TEXT NOT NULL,
    transcript_excerpt TEXT,
    state TEXT NOT NULL,
    dedupe_key TEXT,
    requires_ack INTEGER NOT NULL DEFAULT 1,
    acknowledged_by TEXT,
    acknowledged_at TEXT,
    resolved_by TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_escalations_dedupe ON escalations(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_escalations_state ON escalations(state, created_at DESC);

CREATE TABLE IF NOT EXISTS escalation_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escalation_id TEXT NOT NULL REFERENCES escalations(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL DEFAULT 1,
    action_type TEXT NOT NULL,
    target_masked TEXT,
    state TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_escalation_actions ON escalation_actions(escalation_id, id);

CREATE TABLE IF NOT EXISTS family_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '{}',
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE(patient_id, contact_id)
);

CREATE TABLE IF NOT EXISTS family_requests (
    id TEXT PRIMARY KEY,
    patient_id INTEGER NOT NULL,
    contact_id INTEGER,
    mode TEXT NOT NULL,
    state TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'pending',
    ticket_token_hash TEXT,
    requested_by TEXT,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    decided_by TEXT,
    decided_at TEXT,
    detail TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_family_requests_state
    ON family_requests(state, requested_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    patient_id INTEGER,
    payload_json TEXT NOT NULL DEFAULT '{}',
    run_at TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 4,
    lease_until TEXT,
    last_error TEXT,
    dedupe_key TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON scheduled_jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON scheduled_jobs(state, run_at);

CREATE TABLE IF NOT EXISTS verification_challenges (
    id TEXT PRIMARY KEY,
    contact_id INTEGER,
    phone_masked TEXT,
    channel TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_challenges_state ON verification_challenges(state, expires_at);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    patient_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Append-only audit trail.  Each row chains to the previous row's hash so
-- tampering with an earlier record is detectable.
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_id TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    patient_id INTEGER,
    detail_json TEXT NOT NULL DEFAULT '{}',
    prev_hash TEXT,
    entry_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (provider, event_id)
);

CREATE TABLE IF NOT EXISTS provider_config (
    provider TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);
"""

SYNTHETIC_PATIENTS = [
    {
        "extension": "CS-1001",
        "display_name": "Asha Rao",
        "age": 67,
        "room": "12B",
        "primary_concern": "Hypertension follow-up; occasional dizziness",
        "language": "en",
        "notes": (
            "Synthetic demo patient. Not a real person. Used to demonstrate a "
            "local AI care line without exposing personal health information."
        ),
        "synthetic": 1,
    }
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_call_id() -> str:
    return f"call_{uuid.uuid4().hex[:12]}"


@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
    """One short-lived connection per operation (safe across threads)."""
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(settings.db_path), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    settings.ensure_dirs()
    with connection() as conn:
        conn.executescript(SCHEMA)
        for patient in SYNTHETIC_PATIENTS:
            conn.execute(
                """
                INSERT INTO patients
                    (extension, display_name, age, room, primary_concern, language,
                     notes, synthetic, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(extension) DO UPDATE SET
                    display_name = excluded.display_name,
                    age = excluded.age,
                    room = excluded.room,
                    primary_concern = excluded.primary_concern,
                    notes = excluded.notes,
                    synthetic = excluded.synthetic
                """,
                (
                    patient["extension"],
                    patient["display_name"],
                    patient["age"],
                    patient["room"],
                    patient["primary_concern"],
                    patient["language"],
                    patient["notes"],
                    patient["synthetic"],
                    utc_now(),
                ),
            )


def _row_to_patient(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    data = dict(row)
    data["synthetic"] = bool(data.get("synthetic"))
    return data


def get_patient(extension: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM patients WHERE extension = ?", (extension.upper(),)
        ).fetchone()
        return _row_to_patient(row)


def list_patients() -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute("SELECT * FROM patients ORDER BY extension").fetchall()
        return [_row_to_patient(row) for row in rows if row is not None]


def get_patient_by_id(patient_id: int) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM patients WHERE id = ?", (patient_id,)
        ).fetchone()
        return _row_to_patient(row)


def create_call(
    *,
    call_id: str,
    caller_extension: str,
    callee_extension: str,
    patient_name: str | None,
    demo_mode: bool,
) -> None:
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO calls
                (id, caller_extension, callee_extension, patient_name, started_at,
                 status, demo_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                call_id,
                caller_extension,
                callee_extension,
                patient_name,
                utc_now(),
                "CONNECTING",
                1 if demo_mode else 0,
            ),
        )


def append_transcript(
    call_id: str, role: str, text: str, latency_ms: int | None = None
) -> None:
    if not settings.store_transcripts:
        return
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO transcripts (call_id, role, text, created_at, latency_ms)
            VALUES (?, ?, ?, ?, ?)
            """,
            (call_id, role, text, utc_now(), latency_ms),
        )


def finish_call(
    *,
    call_id: str,
    status: str,
    turns: int,
    avg_latency_ms: int | None = None,
    error: str | None = None,
) -> None:
    with connection() as conn:
        row = conn.execute(
            "SELECT started_at FROM calls WHERE id = ?", (call_id,)
        ).fetchone()
        if row is None:
            return
        started = datetime.fromisoformat(row["started_at"].replace("Z", "+00:00"))
        duration_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        conn.execute(
            """
            UPDATE calls
               SET ended_at = ?, duration_ms = ?, status = ?, turns = ?,
                   avg_latency_ms = ?, error = ?
             WHERE id = ?
            """,
            (
                utc_now(),
                duration_ms,
                status,
                turns,
                avg_latency_ms,
                error,
                call_id,
            ),
        )


def list_calls(limit: int = 20) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 100))
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT c.*,
                   (SELECT COUNT(*) FROM transcripts t WHERE t.call_id = c.id) AS transcript_rows
              FROM calls c
             ORDER BY c.started_at DESC
             LIMIT ?
            """,
            (limit,),
        ).fetchall()
        calls = []
        for row in rows:
            item = dict(row)
            item["demo_mode"] = bool(item.get("demo_mode"))
            calls.append(item)
        return calls


def get_call(call_id: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
        if row is None:
            return None
        call = dict(row)
        call["demo_mode"] = bool(call.get("demo_mode"))
        call["transcripts"] = [
            dict(item)
            for item in conn.execute(
                "SELECT role, text, created_at, latency_ms FROM transcripts "
                "WHERE call_id = ? ORDER BY id",
                (call_id,),
            ).fetchall()
        ]
        return call


def delete_history() -> int:
    with connection() as conn:
        count = conn.execute("SELECT COUNT(*) FROM calls").fetchone()[0]
        conn.execute("DELETE FROM calls")
        return int(count)


def healthcheck() -> dict[str, Any]:
    """Real read/write check of the local SQLite database."""
    try:
        with connection() as conn:
            conn.execute("SELECT COUNT(*) FROM patients").fetchone()
            conn.execute("CREATE TEMP TABLE IF NOT EXISTS _voicelink_health (x INTEGER)")
            conn.execute("DELETE FROM _voicelink_health")
            conn.execute("INSERT INTO _voicelink_health (x) VALUES (1)")
            value = conn.execute("SELECT x FROM _voicelink_health").fetchone()[0]
            patient_count = conn.execute("SELECT COUNT(*) FROM patients").fetchone()[0]
        size = os.path.getsize(settings.db_path) if Path(settings.db_path).exists() else 0
        return {
            "ok": value == 1,
            "path": str(settings.db_path),
            "size_bytes": size,
            "patients": patient_count,
        }
    except Exception as exc:  # pragma: no cover - depends on filesystem state
        return {"ok": False, "path": str(settings.db_path), "error": str(exc)}


# ===========================================================================
# VoiceLink 2.0 platform persistence.
# ===========================================================================


def _loads(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def _dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, separators=(",", ":"))


def utc_offset(seconds: int) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(seconds=seconds)
    ).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _boolify(data: dict[str, Any], *keys: str) -> dict[str, Any]:
    for key in keys:
        if key in data and data[key] is not None:
            data[key] = bool(data[key])
    return data


# --- contacts --------------------------------------------------------------

def add_contact(
    *,
    patient_id: Optional[int],
    role: str,
    display_name: str,
    phone_e164: str,
    phone_masked: str,
    preferred_channel: str = "sms",
    permissions: Optional[dict[str, Any]] = None,
    consent_status: str = "unknown",
    verification_status: str = "unverified",
    is_primary: bool = False,
) -> int:
    now = utc_now()
    with connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO contacts
                (patient_id, role, display_name, phone_e164, phone_masked,
                 preferred_channel, permissions_json, consent_status,
                 verification_status, is_primary, active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(patient_id, role, phone_e164) DO UPDATE SET
                display_name = excluded.display_name,
                phone_masked = excluded.phone_masked,
                preferred_channel = excluded.preferred_channel,
                permissions_json = excluded.permissions_json,
                consent_status = excluded.consent_status,
                verification_status = excluded.verification_status,
                is_primary = excluded.is_primary,
                active = 1,
                revoked_at = NULL,
                updated_at = excluded.updated_at
            """,
            (
                patient_id,
                role,
                display_name,
                phone_e164,
                phone_masked,
                preferred_channel,
                _dumps(permissions or {}),
                consent_status,
                verification_status,
                1 if is_primary else 0,
                now,
                now,
            ),
        )
        if cur.lastrowid:
            return int(cur.lastrowid)
        row = conn.execute(
            "SELECT id FROM contacts WHERE patient_id IS ? AND role = ? AND phone_e164 = ?",
            (patient_id, role, phone_e164),
        ).fetchone()
        return int(row["id"]) if row else 0


def get_contact(contact_id: int) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["permissions"] = _loads(data.pop("permissions_json", "{}"), {})
    return _boolify(data, "is_primary", "active")


def list_contacts(patient_id: Optional[int] = None, include_inactive: bool = False) -> list[dict[str, Any]]:
    with connection() as conn:
        if patient_id is None:
            rows = conn.execute(
                "SELECT * FROM contacts ORDER BY patient_id, role, id"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM contacts WHERE patient_id = ? ORDER BY role, id",
                (patient_id,),
            ).fetchall()
    contacts = []
    for row in rows:
        data = dict(row)
        data["permissions"] = _loads(data.pop("permissions_json", "{}"), {})
        _boolify(data, "is_primary", "active")
        if not include_inactive and not data["active"]:
            continue
        contacts.append(data)
    return contacts


def find_contacts_by_phone(phone_e164: str) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM contacts WHERE phone_e164 = ? AND active = 1", (phone_e164,)
        ).fetchall()
    result = []
    for row in rows:
        data = dict(row)
        data["permissions"] = _loads(data.pop("permissions_json", "{}"), {})
        result.append(_boolify(data, "is_primary", "active"))
    return result


def update_contact_verification(contact_id: int, status: str) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE contacts SET verification_status = ?, verified_at = ?, updated_at = ? WHERE id = ?",
            (status, utc_now() if status == "verified" else None, utc_now(), contact_id),
        )


def revoke_contact(contact_id: int) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE contacts SET active = 0, revoked_at = ?, updated_at = ? WHERE id = ?",
            (utc_now(), utc_now(), contact_id),
        )


def update_contact_permissions(contact_id: int, permissions: dict[str, Any]) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE contacts SET permissions_json = ?, updated_at = ? WHERE id = ?",
            (_dumps(permissions), utc_now(), contact_id),
        )


# --- telephony calls -------------------------------------------------------

def create_telephony_call(
    *,
    provider: str,
    direction: str,
    from_e164: Optional[str],
    to_e164: Optional[str],
    from_masked: str = "",
    to_masked: str = "",
    patient_id: Optional[int] = None,
    contact_id: Optional[int] = None,
    purpose: str = "nurse_to_patient_ai",
    state: str = "created",
    provider_mode: str = "real",
    idempotency_key: Optional[str] = None,
    recording: bool = False,
    metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    call_id = new_id("tcall")
    now = utc_now()
    with connection() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO telephony_calls
                (id, provider, direction, from_e164, to_e164, from_masked, to_masked,
                 patient_id, contact_id, purpose, state, provider_mode,
                 idempotency_key, recording, created_at, updated_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                call_id,
                provider,
                direction,
                from_e164,
                to_e164,
                from_masked,
                to_masked,
                patient_id,
                contact_id,
                purpose,
                state,
                provider_mode,
                idempotency_key,
                1 if recording else 0,
                now,
                now,
                _dumps(metadata or {}),
            ),
        )
        if idempotency_key:
            row = conn.execute(
                "SELECT * FROM telephony_calls WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM telephony_calls WHERE id = ?", (call_id,)
            ).fetchone()
    result = _row_to_telephony_call(row)
    assert result is not None
    result["created"] = result["id"] == call_id
    return result


def _row_to_telephony_call(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    data = dict(row)
    data["metadata"] = _loads(data.pop("metadata_json", "{}"), {})
    return _boolify(data, "recording")


def get_telephony_call(call_id: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute("SELECT * FROM telephony_calls WHERE id = ?", (call_id,)).fetchone()
    return _row_to_telephony_call(row)


def get_telephony_call_by_provider_id(provider_call_id: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM telephony_calls WHERE provider_call_id = ? ORDER BY id DESC LIMIT 1",
            (provider_call_id,),
        ).fetchone()
    return _row_to_telephony_call(row)


def set_provider_call_id(call_id: str, provider_call_id: str) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE telephony_calls SET provider_call_id = ?, updated_at = ? WHERE id = ?",
            (provider_call_id, utc_now(), call_id),
        )


def update_telephony_call(
    call_id: str,
    *,
    state: Optional[str] = None,
    error: Optional[str] = None,
    answered: bool = False,
    ended: bool = False,
    duration_ms: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    fields = ["updated_at = ?"]
    values: list[Any] = [utc_now()]
    if state is not None:
        fields.append("state = ?")
        values.append(state)
    if error is not None:
        fields.append("error = ?")
        values.append(error)
    if answered:
        fields.append("answered_at = ?")
        values.append(utc_now())
    if ended:
        fields.append("ended_at = ?")
        values.append(utc_now())
    if duration_ms is not None:
        fields.append("duration_ms = ?")
        values.append(duration_ms)
    values.append(call_id)
    with connection() as conn:
        conn.execute(f"UPDATE telephony_calls SET {', '.join(fields)} WHERE id = ?", values)
    return get_telephony_call(call_id)


def add_call_event(
    call_id: str, *, event_type: str, state: Optional[str], payload: dict[str, Any], provider_event_id: Optional[str] = None
) -> bool:
    with connection() as conn:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO call_events
                (call_id, provider_event_id, event_type, state, payload_json, received_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (call_id, provider_event_id, event_type, state, _dumps(payload), utc_now()),
        )
        return cur.rowcount > 0


def list_call_events(call_id: str) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM call_events WHERE call_id = ? ORDER BY id", (call_id,)
        ).fetchall()
    return [dict(row) for row in rows]


def list_telephony_calls(
    *, patient_id: Optional[int] = None, states: Optional[list[str]] = None, limit: int = 50
) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    clauses: list[str] = []
    values: list[Any] = []
    if patient_id is not None:
        clauses.append("patient_id = ?")
        values.append(patient_id)
    if states:
        clauses.append(f"state IN ({','.join('?' for _ in states)})")
        values.extend(states)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with connection() as conn:
        rows = conn.execute(
            f"SELECT * FROM telephony_calls {where} ORDER BY created_at DESC LIMIT ?",
            values,
        ).fetchall()
    return [_row_to_telephony_call(row) for row in rows if row is not None]


def count_calls_since(patient_id: Optional[int], since_iso: str) -> int:
    with connection() as conn:
        if patient_id is None:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM telephony_calls WHERE created_at >= ?", (since_iso,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM telephony_calls WHERE patient_id = ? AND created_at >= ?",
                (patient_id, since_iso),
            ).fetchone()
    return int(row["n"]) if row else 0


# --- messages --------------------------------------------------------------

def _row_to_message(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    data = dict(row)
    data["metadata"] = _loads(data.pop("metadata_json", "{}"), {})
    return data


def create_message(
    *,
    provider: str,
    direction: str,
    channel: str,
    from_e164: Optional[str],
    to_e164: Optional[str],
    body: str,
    from_masked: str = "",
    to_masked: str = "",
    patient_id: Optional[int] = None,
    contact_id: Optional[int] = None,
    state: str = "created",
    provider_mode: str = "real",
    idempotency_key: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    message_id = new_id("msg")
    now = utc_now()
    with connection() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO messages
                (id, provider, direction, channel, from_e164, to_e164, from_masked,
                 to_masked, patient_id, contact_id, body, state, provider_mode,
                 idempotency_key, created_at, updated_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                provider,
                direction,
                channel,
                from_e164,
                to_e164,
                from_masked,
                to_masked,
                patient_id,
                contact_id,
                body,
                state,
                provider_mode,
                idempotency_key,
                now,
                now,
                _dumps(metadata or {}),
            ),
        )
        if idempotency_key:
            row = conn.execute(
                "SELECT * FROM messages WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
        else:
            row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    result = _row_to_message(row)
    assert result is not None
    result["created"] = result["id"] == message_id
    return result


def set_message_provider_id(message_id: str, provider_message_id: str) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE messages SET provider_message_id = ?, updated_at = ? WHERE id = ?",
            (provider_message_id, utc_now(), message_id),
        )


def update_message_state(
    message_id: str, *, state: str, error: Optional[str] = None, delivered: bool = False
) -> Optional[dict[str, Any]]:
    fields = ["state = ?", "updated_at = ?"]
    values: list[Any] = [state, utc_now()]
    if error is not None:
        fields.append("error = ?")
        values.append(error)
    if delivered:
        fields.append("delivered_at = ?")
        values.append(utc_now())
    values.append(message_id)
    with connection() as conn:
        conn.execute(f"UPDATE messages SET {', '.join(fields)} WHERE id = ?", values)
    return get_message(message_id)


def get_message(message_id: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    return _row_to_message(row)


def get_message_by_provider_id(provider_message_id: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM messages WHERE provider_message_id = ? ORDER BY id DESC LIMIT 1",
            (provider_message_id,),
        ).fetchone()
    return _row_to_message(row)


def add_message_event(
    message_id: str, *, event_type: str, state: Optional[str], payload: dict[str, Any], provider_event_id: Optional[str] = None
) -> bool:
    with connection() as conn:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO message_events
                (message_id, provider_event_id, event_type, state, payload_json, received_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (message_id, provider_event_id, event_type, state, _dumps(payload), utc_now()),
        )
        return cur.rowcount > 0


def list_messages(
    *, patient_id: Optional[int] = None, limit: int = 50
) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    with connection() as conn:
        if patient_id is None:
            rows = conn.execute(
                "SELECT * FROM messages ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM messages WHERE patient_id = ? ORDER BY created_at DESC LIMIT ?",
                (patient_id, limit),
            ).fetchall()
    return [_row_to_message(row) for row in rows if row is not None]


def count_messages_since(patient_id: Optional[int], since_iso: str) -> int:
    with connection() as conn:
        if patient_id is None:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?", (since_iso,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND created_at >= ?",
                (patient_id, since_iso),
            ).fetchone()
    return int(row["n"]) if row else 0


# --- escalations -----------------------------------------------------------

def _row_to_escalation(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    data = dict(row)
    data["metadata"] = _loads(data.pop("metadata_json", "{}"), {})
    return _boolify(data, "requires_ack")


def create_escalation(
    *,
    patient_id: Optional[int],
    severity: str,
    category: str,
    reason: str,
    call_id: Optional[str] = None,
    transcript_excerpt: Optional[str] = None,
    dedupe_key: Optional[str] = None,
    requires_ack: bool = True,
    state: str = "open",
    metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    escalation_id = new_id("esc")
    now = utc_now()
    with connection() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO escalations
                (id, patient_id, call_id, severity, category, reason, transcript_excerpt,
                 state, dedupe_key, requires_ack, created_at, updated_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                escalation_id,
                patient_id,
                call_id,
                severity,
                category,
                reason,
                transcript_excerpt,
                state,
                dedupe_key,
                1 if requires_ack else 0,
                now,
                now,
                _dumps(metadata or {}),
            ),
        )
        if dedupe_key:
            row = conn.execute(
                "SELECT * FROM escalations WHERE dedupe_key = ?", (dedupe_key,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM escalations WHERE id = ?", (escalation_id,)
            ).fetchone()
    result = _row_to_escalation(row)
    assert result is not None
    result["created"] = result["id"] == escalation_id
    return result


def update_escalation_state(
    escalation_id: str,
    *,
    state: str,
    actor: Optional[str] = None,
    resolved: bool = False,
) -> Optional[dict[str, Any]]:
    fields = ["state = ?", "updated_at = ?"]
    values: list[Any] = [state, utc_now()]
    if state == "acknowledged" and actor:
        fields += ["acknowledged_by = ?", "acknowledged_at = ?"]
        values += [actor, utc_now()]
    if resolved:
        fields += ["resolved_by = ?", "resolved_at = ?"]
        values += [actor, utc_now()]
    values.append(escalation_id)
    with connection() as conn:
        conn.execute(f"UPDATE escalations SET {', '.join(fields)} WHERE id = ?", values)
    return get_escalation(escalation_id)


def get_escalation(escalation_id: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM escalations WHERE id = ?", (escalation_id,)
        ).fetchone()
    return _row_to_escalation(row)


def list_escalations(
    *, state: Optional[str] = None, patient_id: Optional[int] = None, limit: int = 100
) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    clauses: list[str] = []
    values: list[Any] = []
    if state:
        clauses.append("state = ?")
        values.append(state)
    if patient_id is not None:
        clauses.append("patient_id = ?")
        values.append(patient_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with connection() as conn:
        rows = conn.execute(
            f"""SELECT * FROM escalations {where}
                ORDER BY CASE severity WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1
                     WHEN 'follow_up' THEN 2 ELSE 3 END, created_at DESC LIMIT ?""",
            values,
        ).fetchall()
    return [_row_to_escalation(row) for row in rows if row is not None]


def add_escalation_action(
    escalation_id: str,
    *,
    action_type: str,
    state: str,
    attempt: int = 1,
    target_masked: Optional[str] = None,
    result: Optional[str] = None,
) -> None:
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO escalation_actions
                (escalation_id, attempt, action_type, target_masked, state, result, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (escalation_id, attempt, action_type, target_masked, state, result, utc_now()),
        )


def list_escalation_actions(escalation_id: str) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM escalation_actions WHERE escalation_id = ? ORDER BY id",
            (escalation_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def unacknowledged_escalations() -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM escalations WHERE state = 'open' AND requires_ack = 1 ORDER BY created_at"
        ).fetchall()
    return [_row_to_escalation(row) for row in rows if row is not None]


# --- family permissions and requests ---------------------------------------

def upsert_family_permission(
    *, patient_id: int, contact_id: int, scope: dict[str, Any], granted_by: str
) -> None:
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO family_permissions (patient_id, contact_id, scope_json, granted_by, granted_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, NULL)
            ON CONFLICT(patient_id, contact_id) DO UPDATE SET
                scope_json = excluded.scope_json,
                granted_by = excluded.granted_by,
                granted_at = excluded.granted_at,
                revoked_at = NULL
            """,
            (patient_id, contact_id, _dumps(scope), granted_by, utc_now()),
        )


def revoke_family_permission(patient_id: int, contact_id: int) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE family_permissions SET revoked_at = ? WHERE patient_id = ? AND contact_id = ?",
            (utc_now(), patient_id, contact_id),
        )


def get_family_permission(patient_id: int, contact_id: int) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM family_permissions WHERE patient_id = ? AND contact_id = ?",
            (patient_id, contact_id),
        ).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["scope"] = _loads(data.pop("scope_json", "{}"), {})
    data["revoked"] = bool(data.get("revoked_at"))
    return data


def list_family_permissions(patient_id: Optional[int] = None) -> list[dict[str, Any]]:
    with connection() as conn:
        if patient_id is None:
            rows = conn.execute("SELECT * FROM family_permissions ORDER BY patient_id, id").fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM family_permissions WHERE patient_id = ? ORDER BY id",
                (patient_id,),
            ).fetchall()
    out = []
    for row in rows:
        data = dict(row)
        data["scope"] = _loads(data.pop("scope_json", "{}"), {})
        data["revoked"] = bool(data.get("revoked_at"))
        out.append(data)
    return out


def create_family_request(
    *,
    patient_id: int,
    contact_id: Optional[int],
    mode: str,
    requested_by: str,
    state: str = "pending",
    verification_state: str = "pending",
    ticket_token_hash: Optional[str] = None,
    expires_in_seconds: int = 86400,
    detail: str = "",
    metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    request_id = new_id("fam")
    now = utc_now()
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO family_requests
                (id, patient_id, contact_id, mode, state, verification_state,
                 ticket_token_hash, requested_by, requested_at, updated_at,
                 expires_at, detail, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                request_id,
                patient_id,
                contact_id,
                mode,
                state,
                verification_state,
                ticket_token_hash,
                requested_by,
                now,
                now,
                utc_offset(expires_in_seconds),
                detail,
                _dumps(metadata or {}),
            ),
        )
    return get_family_request(request_id)


def get_family_request(request_id: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM family_requests WHERE id = ?", (request_id,)
        ).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["metadata"] = _loads(data.pop("metadata_json", "{}"), {})
    return data


def update_family_request(
    request_id: str,
    *,
    state: Optional[str] = None,
    verification_state: Optional[str] = None,
    decided_by: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    fields = ["updated_at = ?"]
    values: list[Any] = [utc_now()]
    if state is not None:
        fields.append("state = ?")
        values.append(state)
    if verification_state is not None:
        fields.append("verification_state = ?")
        values.append(verification_state)
    if decided_by is not None:
        fields += ["decided_by = ?", "decided_at = ?"]
        values += [decided_by, utc_now()]
    values.append(request_id)
    with connection() as conn:
        conn.execute(f"UPDATE family_requests SET {', '.join(fields)} WHERE id = ?", values)
    return get_family_request(request_id)


def list_family_requests(state: Optional[str] = None, limit: int = 100) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    with connection() as conn:
        if state:
            rows = conn.execute(
                "SELECT * FROM family_requests WHERE state = ? ORDER BY requested_at DESC LIMIT ?",
                (state, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM family_requests ORDER BY requested_at DESC LIMIT ?", (limit,)
            ).fetchall()
    out = []
    for row in rows:
        data = dict(row)
        data["metadata"] = _loads(data.pop("metadata_json", "{}"), {})
        out.append(data)
    return out


# --- scheduled jobs --------------------------------------------------------

def create_job(
    *,
    kind: str,
    run_at: str,
    payload: Optional[dict[str, Any]] = None,
    patient_id: Optional[int] = None,
    max_attempts: int = 4,
    dedupe_key: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    state: str = "pending",
) -> dict[str, Any]:
    job_id = new_id("job")
    now = utc_now()
    with connection() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO scheduled_jobs
                (id, kind, patient_id, payload_json, run_at, state, max_attempts,
                 dedupe_key, idempotency_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                kind,
                patient_id,
                _dumps(payload or {}),
                run_at,
                state,
                max_attempts,
                dedupe_key,
                idempotency_key,
                now,
                now,
            ),
        )
        if dedupe_key:
            row = conn.execute(
                "SELECT * FROM scheduled_jobs WHERE dedupe_key = ?", (dedupe_key,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM scheduled_jobs WHERE id = ?", (job_id,)
            ).fetchone()
    result = _row_to_job(row)
    assert result is not None
    result["created"] = result["id"] == job_id
    return result


def _row_to_job(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    data = dict(row)
    data["payload"] = _loads(data.pop("payload_json", "{}"), {})
    return data


def claim_due_jobs(limit: int = 10, lease_seconds: int = 120) -> list[dict[str, Any]]:
    """Atomically lease due jobs so concurrent workers never double-run them."""
    now = utc_now()
    lease = utc_offset(lease_seconds)
    claimed: list[dict[str, Any]] = []
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT id FROM scheduled_jobs
             WHERE (state = 'pending' AND run_at <= ?)
                OR (state = 'leased' AND lease_until IS NOT NULL AND lease_until <= ?)
             ORDER BY run_at ASC LIMIT ?
            """,
            (now, now, limit),
        ).fetchall()
        for row in rows:
            updated = conn.execute(
                """
                UPDATE scheduled_jobs
                   SET state = 'leased', lease_until = ?, attempts = attempts + 1, updated_at = ?
                 WHERE id = ? AND (state = 'pending' OR state = 'leased')
                """,
                (lease, now, row["id"]),
            )
            if updated.rowcount:
                full = conn.execute(
                    "SELECT * FROM scheduled_jobs WHERE id = ?", (row["id"],)
                ).fetchone()
                job = _row_to_job(full)
                if job:
                    claimed.append(job)
    return claimed


def complete_job(job_id: str, *, state: str = "done", error: Optional[str] = None) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE scheduled_jobs SET state = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?",
            (state, error, utc_now(), job_id),
        )


def retry_job(job_id: str, *, run_at: str, error: str) -> dict[str, Any]:
    with connection() as conn:
        conn.execute(
            "UPDATE scheduled_jobs SET state = 'pending', run_at = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?",
            (run_at, error, utc_now(), job_id),
        )
        row = conn.execute("SELECT * FROM scheduled_jobs WHERE id = ?", (job_id,)).fetchone()
    result = _row_to_job(row)
    assert result is not None
    return result


def get_job(job_id: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute("SELECT * FROM scheduled_jobs WHERE id = ?", (job_id,)).fetchone()
    return _row_to_job(row)


def list_jobs(
    *, states: Optional[list[str]] = None, patient_id: Optional[int] = None, limit: int = 100
) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    clauses: list[str] = []
    values: list[Any] = []
    if states:
        clauses.append(f"state IN ({','.join('?' for _ in states)})")
        values.extend(states)
    if patient_id is not None:
        clauses.append("patient_id = ?")
        values.append(patient_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with connection() as conn:
        rows = conn.execute(
            f"SELECT * FROM scheduled_jobs {where} ORDER BY run_at ASC LIMIT ?", values
        ).fetchall()
    return [_row_to_job(row) for row in rows if row is not None]


def cancel_pending_jobs_for_patient(patient_id: int, kind: Optional[str] = None) -> int:
    with connection() as conn:
        if kind:
            cur = conn.execute(
                "UPDATE scheduled_jobs SET state = 'cancelled', updated_at = ? "
                "WHERE patient_id = ? AND kind = ? AND state = 'pending'",
                (utc_now(), patient_id, kind),
            )
        else:
            cur = conn.execute(
                "UPDATE scheduled_jobs SET state = 'cancelled', updated_at = ? "
                "WHERE patient_id = ? AND state = 'pending'",
                (utc_now(), patient_id),
            )
        return cur.rowcount


# --- verification challenges -----------------------------------------------

def create_challenge(
    *,
    contact_id: Optional[int],
    phone_masked: str,
    channel: str,
    purpose: str,
    code_hash: str,
    ttl_seconds: int,
    max_attempts: int,
    metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    challenge_id = new_id("vch")
    now = utc_now()
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO verification_challenges
                (id, contact_id, phone_masked, channel, purpose, code_hash, state,
                 attempts, max_attempts, created_at, expires_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
            """,
            (
                challenge_id,
                contact_id,
                phone_masked,
                channel,
                purpose,
                code_hash,
                max_attempts,
                now,
                utc_offset(ttl_seconds),
                _dumps(metadata or {}),
            ),
        )
    return get_challenge(challenge_id)


def get_challenge(challenge_id: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM verification_challenges WHERE id = ?", (challenge_id,)
        ).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["metadata"] = _loads(data.pop("metadata_json", "{}"), {})
    return data


def update_challenge(
    challenge_id: str, *, state: Optional[str] = None, attempts: Optional[int] = None, used: bool = False
) -> Optional[dict[str, Any]]:
    fields = []
    values: list[Any] = []
    if state is not None:
        fields.append("state = ?")
        values.append(state)
    if attempts is not None:
        fields.append("attempts = ?")
        values.append(attempts)
    if used:
        fields.append("used_at = ?")
        values.append(utc_now())
    if not fields:
        return get_challenge(challenge_id)
    values.append(challenge_id)
    with connection() as conn:
        conn.execute(
            f"UPDATE verification_challenges SET {', '.join(fields)} WHERE id = ?", values
        )
    return get_challenge(challenge_id)


# --- users and sessions ----------------------------------------------------

def create_user(
    *, username: str, display_name: str, role: str, password_hash: str, patient_id: Optional[int] = None
) -> int:
    with connection() as conn:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO users
                (username, display_name, role, password_hash, patient_id, active, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?)
            """,
            (username.lower(), display_name, role, password_hash, patient_id, utc_now()),
        )
        if cur.lastrowid:
            return int(cur.lastrowid)
        row = conn.execute("SELECT id FROM users WHERE username = ?", (username.lower(),)).fetchone()
        return int(row["id"]) if row else 0


def get_user_by_username(username: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?", (username.lower().strip(),)
        ).fetchone()
    return _public_user(row, include_hash=True)


def get_user(user_id: int) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _public_user(row, include_hash=True)


def list_users() -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY role, username").fetchall()
    return [_public_user(row) for row in rows if row is not None]


def _public_user(row: sqlite3.Row | None, include_hash: bool = False) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    data = dict(row)
    if not include_hash:
        data.pop("password_hash", None)
    data["active"] = bool(data.get("active"))
    return data


def record_login_failure(user_id: int, *, lock_seconds: int, max_attempts: int) -> None:
    with connection() as conn:
        row = conn.execute("SELECT failed_attempts FROM users WHERE id = ?", (user_id,)).fetchone()
        attempts = (row["failed_attempts"] if row else 0) + 1
        locked = utc_offset(lock_seconds) if attempts >= max_attempts else None
        conn.execute(
            "UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?",
            (attempts, locked, user_id),
        )


def record_login_success(user_id: int) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?",
            (utc_now(), user_id),
        )


def update_user_password(user_id: int, password_hash: str) -> None:
    with connection() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


def set_user_active(user_id: int, active: bool) -> None:
    with connection() as conn:
        conn.execute("UPDATE users SET active = ? WHERE id = ?", (1 if active else 0, user_id))


def create_session(
    *, token_hash: str, user_id: int, expires_at: str, user_agent: str = ""
) -> None:
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent)
            VALUES (?, ?, ?, ?, ?)
            """,
            (token_hash, user_id, utc_now(), expires_at, user_agent[:200]),
        )


def get_session(token_hash: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            """
            SELECT s.*, u.username, u.display_name, u.role, u.patient_id, u.active
              FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
    return dict(row) if row else None


def revoke_session(token_hash: str) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE sessions SET revoked_at = ? WHERE token_hash = ?", (utc_now(), token_hash)
        )


def revoke_user_sessions(user_id: int) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
            (utc_now(), user_id),
        )


def purge_expired_sessions() -> int:
    with connection() as conn:
        cur = conn.execute(
            "DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL", (utc_now(),)
        )
        return cur.rowcount


# --- audit log (append-only hash chain) ------------------------------------

def append_audit(
    *,
    action: str,
    actor_id: Optional[str] = None,
    actor_role: Optional[str] = None,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    patient_id: Optional[int] = None,
    detail: Optional[dict[str, Any]] = None,
) -> str:
    at = utc_now()
    with connection() as conn:
        prev = conn.execute(
            "SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
        prev_hash = prev["entry_hash"] if prev else ""
        canonical = json.dumps(
            {
                "at": at,
                "actor_id": actor_id,
                "actor_role": actor_role,
                "action": action,
                "entity_type": entity_type,
                "entity_id": entity_id,
                "patient_id": patient_id,
                "detail": detail or {},
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        entry_hash = hashlib.sha256((prev_hash + canonical).encode("utf-8")).hexdigest()
        conn.execute(
            """
            INSERT INTO audit_log
                (at, actor_id, actor_role, action, entity_type, entity_id, patient_id,
                 detail_json, prev_hash, entry_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                at,
                actor_id,
                actor_role,
                action,
                entity_type,
                entity_id,
                patient_id,
                _dumps(detail or {}),
                prev_hash,
                entry_hash,
            ),
        )
    return entry_hash


def list_audit(limit: int = 100, patient_id: Optional[int] = None) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 500))
    with connection() as conn:
        if patient_id is None:
            rows = conn.execute(
                "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM audit_log WHERE patient_id = ? ORDER BY id DESC LIMIT ?",
                (patient_id, limit),
            ).fetchall()
    out = []
    for row in rows:
        data = dict(row)
        data["detail"] = _loads(data.pop("detail_json", "{}"), {})
        out.append(data)
    return out


def verify_audit_chain() -> dict[str, Any]:
    with connection() as conn:
        rows = conn.execute("SELECT * FROM audit_log ORDER BY id ASC").fetchall()
    prev_hash = ""
    for row in rows:
        canonical = json.dumps(
            {
                "at": row["at"],
                "actor_id": row["actor_id"],
                "actor_role": row["actor_role"],
                "action": row["action"],
                "entity_type": row["entity_type"],
                "entity_id": row["entity_id"],
                "patient_id": row["patient_id"],
                "detail": _loads(row["detail_json"], {}),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        expected = hashlib.sha256((prev_hash + canonical).encode("utf-8")).hexdigest()
        if expected != row["entry_hash"] or row["prev_hash"] != prev_hash:
            return {"ok": False, "broken_at": row["id"], "entries": len(rows)}
        prev_hash = row["entry_hash"]
    return {"ok": True, "entries": len(rows)}


# --- webhook idempotency and provider config -------------------------------

def record_webhook_event(provider: str, event_id: str) -> bool:
    """Return True the first time an event is seen; False on a replay."""
    with connection() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO webhook_events (provider, event_id, received_at) VALUES (?, ?, ?)",
            (provider, event_id, utc_now()),
        )
        return cur.rowcount > 0


def upsert_provider_config(
    provider: str, *, enabled: bool, verified: bool, metadata: Optional[dict[str, Any]] = None
) -> None:
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO provider_config (provider, enabled, verified, verified_at, metadata_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET
                enabled = excluded.enabled,
                verified = excluded.verified,
                verified_at = excluded.verified_at,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at
            """,
            (
                provider,
               1 if enabled else 0,
               1 if verified else 0,
                utc_now() if verified else None,
                _dumps(metadata or {}),
                utc_now(),
            ),
        )


def get_provider_config(provider: str) -> Optional[dict[str, Any]]:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM provider_config WHERE provider = ?", (provider,)
        ).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["metadata"] = _loads(data.pop("metadata_json", "{}"), {})
    return _boolify(data, "enabled", "verified")


def list_provider_configs() -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute("SELECT * FROM provider_config ORDER BY provider").fetchall()
    out = []
    for row in rows:
        data = dict(row)
        data["metadata"] = _loads(data.pop("metadata_json", "{}"), {})
        out.append(_boolify(data, "enabled", "verified"))
    return out


# --- retention -------------------------------------------------------------

def purge_older_than(days: int) -> dict[str, int]:
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=max(1, days))
    ).isoformat(timespec="seconds").replace("+00:00", "Z")
    removed: dict[str, int] = {}
    with connection() as conn:
        for table, column in (
            ("transcripts", "created_at"),
            ("messages", "created_at"),
            ("telephony_calls", "created_at"),
            ("escalations", "created_at"),
            ("webhook_events", "received_at"),
            ("verification_challenges", "created_at"),
        ):
            cur = conn.execute(f"DELETE FROM {table} WHERE {column} < ?", (cutoff,))
            removed[table] = cur.rowcount
    return removed

