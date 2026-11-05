"""SQLite persistence for CareSpeak VoiceLink.

Only synthetic demo patients are seeded.  The database is a single local file
and is never replicated to a cloud service.
"""
from __future__ import annotations

import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
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
