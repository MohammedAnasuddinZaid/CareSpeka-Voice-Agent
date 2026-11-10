"""Unit tests for the live-call state machine, session bookkeeping and scheduler.

The engine and database are replaced with fakes where a real model or a real
phone call would otherwise be needed.  No audio device, no carrier and no LLM
are involved.
"""
from __future__ import annotations

import asyncio

import numpy as np
import pytest

from app.call_manager import CallManager, CallSession, CallState, CallStateMachine
from app.scheduler import Scheduler
from app.security import ValidationError


class FakeWebSocket:
    def __init__(self) -> None:
        self.events: list[dict] = []
        self.closed = False
        self.fail_next = False

    async def send_json(self, event: dict) -> None:
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("socket closed")
        self.events.append(event)

    def types(self) -> list[str]:
        return [event.get("type", "") for event in self.events]


class _FakeTTS:
    async def synthesize(self, text: str):
        raise RuntimeError("tts offline in tests")


class _FakeEngine:
    def __init__(self) -> None:
        self.tts = _FakeTTS()

    def new_vad_stream(self):
        raise RuntimeError("vad offline in tests")


def run(coro):
    return asyncio.run(coro)


def make_session(**overrides) -> CallSession:
    websocket = overrides.pop("websocket", FakeWebSocket())
    session = CallSession(
        call_id=overrides.pop("call_id", "call_1"),
        caller=overrides.pop("caller", "CS-1001"),
        callee=overrides.pop("callee", "CS-0000"),
        patient=overrides.pop("patient", {"display_name": "Asha Rao"}),
        demo_mode=overrides.pop("demo_mode", True),
        websocket=websocket,
        vad=overrides.pop("vad", None),
    )
    return session


# ---------------------------------------------------------------------------
# state machine
# ---------------------------------------------------------------------------
def test_state_machine_valid_chain():
    machine = CallStateMachine()
    assert machine.state == CallState.IDLE
    for state in (
        CallState.DIALING,
        CallState.CONNECTING,
        CallState.CONNECTED,
        CallState.LISTENING,
        CallState.PROCESSING,
        CallState.SPEAKING,
        CallState.LISTENING,
        CallState.ENDED,
    ):
        assert machine.transition(state) is True
        assert machine.state == state


def test_state_machine_rejects_illegal_and_supports_force():
    machine = CallStateMachine()
    assert machine.transition(CallState.CONNECTED) is False
    assert machine.state == CallState.IDLE
    assert machine.transition(CallState.CONNECTED, force=True) is True
    assert machine.state == CallState.CONNECTED
    # A no-op transition to the current state always succeeds.
    assert machine.transition(CallState.CONNECTED) is True


def test_state_machine_terminal_state_has_no_exits():
    machine = CallStateMachine()
    machine.transition(CallState.DIALING)
    machine.transition(CallState.ENDED)
    assert machine.transition(CallState.LISTENING) is False


# ---------------------------------------------------------------------------
# CallSession bookkeeping
# ---------------------------------------------------------------------------
def test_session_remember_trims_and_caps_history(monkeypatch):
    from app import call_manager

    monkeypatch.setattr(call_manager.database, "append_transcript", lambda *a, **k: None)
    session = make_session()
    session.remember("assistant", "  hello   world ")
    assert session.history[0]["text"] == "hello world"
    session.remember("user", "   ")  # ignored
    assert len(session.history) == 1
    for i in range(30):
        session.remember("user", f"m{i}")
    assert len(session.history) == 24  # only the newest 24 are kept


def test_session_remember_survives_a_transcript_write_failure(monkeypatch):
    from app import call_manager

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(call_manager.database, "append_transcript", boom)
    session = make_session()
    session.remember("user", "still recorded")  # must not raise
    assert session.history[-1]["text"] == "still recorded"
    assert session.transcript[-1]["text"] == "still recorded"


def test_session_snapshot_metrics_average():
    session = make_session()
    session.metrics = [
        {"e2e_first_audio_ms": 100},
        {"e2e_first_audio_ms": 300},
        {"e2e_first_audio_ms": None},
    ]
    session.turn_count = 3
    session.audio_seconds = 2.5
    snapshot = session.snapshot_metrics()
    assert snapshot["turns"] == 3
    assert snapshot["avg_e2e_first_audio_ms"] == 200
    assert snapshot["audio_seconds"] == 2.5


def test_session_active_reflects_state():
    session = make_session()
    assert session.active is True
    session.transition(CallState.DIALING)
    session.transition(CallState.ENDED)
    assert session.active is False

    # An ERROR session is not active either, and finalization alone is enough.
    errored = make_session(call_id="call_2")
    errored.transition(CallState.DIALING)
    errored.transition(CallState.ERROR)
    assert errored.active is False
    finalized = make_session(call_id="call_3")
    finalized.finalized = True
    assert finalized.active is False


def test_session_send_handles_a_broken_socket():
    websocket = FakeWebSocket()
    session = make_session(websocket=websocket)
    assert run(session.send({"type": "ping"})) is True
    websocket.fail_next = True
    assert run(session.send({"type": "ping"})) is False
    assert session.closed is True
    # Once closed, nothing more is sent.
    assert run(session.send({"type": "ping"})) is False


# ---------------------------------------------------------------------------
# CallManager control plane
# ---------------------------------------------------------------------------
def test_manager_ping_and_config(monkeypatch):
    from app import call_manager

    monkeypatch.setattr(call_manager.database, "append_transcript", lambda *a, **k: None)
    websocket = FakeWebSocket()
    session = make_session(websocket=websocket)
    manager = CallManager(_FakeEngine())

    assert run(manager.handle_control(session, {"type": "ping"})) is True
    assert websocket.events[-1]["type"] == "pong"

    run(manager.handle_control(session, {"type": "config", "barge_in": False, "muted": True}))
    assert session.barge_in_enabled is False
    assert session.mic_muted is True
    assert websocket.events[-1] == {
        "type": "config_ack",
        "barge_in": False,
        "muted": True,
    }


def test_manager_unknown_message_is_reported(monkeypatch):
    from app import call_manager

    monkeypatch.setattr(call_manager.database, "append_transcript", lambda *a, **k: None)
    websocket = FakeWebSocket()
    session = make_session(websocket=websocket)
    manager = CallManager(_FakeEngine())
    assert run(manager.handle_control(session, {"type": "nonsense"})) is True
    assert websocket.events[-1]["code"] == "unknown_message"


def test_manager_empty_text_is_rejected(monkeypatch):
    from app import call_manager

    monkeypatch.setattr(call_manager.database, "append_transcript", lambda *a, **k: None)
    websocket = FakeWebSocket()
    session = make_session(websocket=websocket)
    manager = CallManager(_FakeEngine())
    run(manager.handle_control(session, {"type": "text_input", "text": "   "}))
    assert websocket.events[-1]["code"] == "empty_text"


def test_manager_push_to_talk_without_speech(monkeypatch):
    from app import call_manager

    monkeypatch.setattr(call_manager.database, "append_transcript", lambda *a, **k: None)
    websocket = FakeWebSocket()
    session = make_session(websocket=websocket)
    manager = CallManager(_FakeEngine())

    run(manager.handle_control(session, {"type": "ptt_start"}))
    assert session.ptt_active is True
    assert websocket.events[-1]["event"] == "speech_start"

    # Releasing the button with no captured audio yields the no_speech notice.
    run(manager.handle_control(session, {"type": "ptt_stop"}))
    assert session.ptt_active is False
    assert websocket.events[-1]["code"] == "no_speech"


def test_manager_end_call_closes_once(monkeypatch):
    from app import call_manager

    monkeypatch.setattr(call_manager.database, "append_transcript", lambda *a, **k: None)
    finished = {}
    monkeypatch.setattr(
        call_manager.database, "finish_call", lambda **kw: finished.update(kw)
    )
    websocket = FakeWebSocket()
    session = make_session(websocket=websocket)
    manager = CallManager(_FakeEngine())

    assert run(manager.handle_control(session, {"type": "end_call"})) is False
    assert session.finalized is True
    assert websocket.events[-1]["type"] == "call_ended"
    assert finished["status"] == "completed"

    # A second end_call must not emit another call_ended event.
    count = len(websocket.events)
    run(manager.end_call(session, reason="again"))
    assert len(websocket.events) == count


# ---------------------------------------------------------------------------
# CallManager.start_call
# ---------------------------------------------------------------------------
def _patch_directory(monkeypatch, known: set[str]):
    from app import call_manager

    monkeypatch.setattr(
        call_manager.database,
        "get_patient",
        lambda ext: {"extension": ext, "display_name": "Asha Rao"} if ext in known else None,
    )
    monkeypatch.setattr(call_manager.database, "new_call_id", lambda: "call_test")
    monkeypatch.setattr(call_manager.database, "create_call", lambda **kw: None)
    monkeypatch.setattr(call_manager.database, "append_transcript", lambda *a, **k: None)
    monkeypatch.setattr(call_manager.database, "finish_call", lambda **kw: None)


def test_start_call_emits_handshake_and_capabilities(monkeypatch):
    _patch_directory(monkeypatch, {"CS-1001"})
    websocket = FakeWebSocket()
    manager = CallManager(_FakeEngine())

    async def scenario():
        session = await manager.start_call(websocket, caller="cs-1001", callee="cs-0000")
        await asyncio.sleep(0.05)  # let the greeting task settle
        await manager.end_call(session, reason="test_done", notify=False)
        return session

    session = run(scenario())
    first = websocket.events[0]
    assert first["type"] == "call_started"
    assert first["caller"] == "CS-1001"
    assert first["callee"] == "CS-0000"
    # VAD is unavailable in this fake engine, so the capability must be honest.
    assert first["capabilities"]["vad"] is False
    assert first["capabilities"]["push_to_talk"] is True
    assert "state" in websocket.types()
    assert session.finalized is True


def test_start_call_rejects_an_unknown_caller(monkeypatch):
    _patch_directory(monkeypatch, {"CS-1001"})
    manager = CallManager(_FakeEngine())
    with pytest.raises(ValidationError) as exc:
        run(manager.start_call(FakeWebSocket(), caller="cs-9999", callee="cs-0000"))
    assert exc.value.code == "unknown_caller"
    assert exc.value.status_code == 404


def test_start_call_refuses_when_at_capacity(monkeypatch):
    _patch_directory(monkeypatch, {"CS-1001"})
    manager = CallManager(_FakeEngine())

    from app.config import settings

    # Fill the line to exactly the configured limit with live sessions.
    for index in range(settings.max_active_calls):
        existing = make_session(call_id=f"existing-{index}", websocket=FakeWebSocket())
        existing.transition(CallState.DIALING)
        existing.transition(CallState.CONNECTING)
        existing.transition(CallState.CONNECTED)
        manager.sessions[existing.call_id] = existing

    assert manager.active_count == settings.max_active_calls
    with pytest.raises(ValidationError) as exc:
        run(manager.start_call(FakeWebSocket(), caller="cs-1001", callee="cs-0000"))
    assert exc.value.code == "capacity"
    assert exc.value.status_code == 503

    # A finished session frees a slot.
    manager.sessions.pop("existing-0")
    assert manager.active_count == settings.max_active_calls - 1


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------
class _FakeService:
    def __init__(self):
        self.provider = None

    def in_quiet_hours(self) -> bool:
        return False


def test_scheduler_schedule_helpers_create_jobs(clean_db):
    scheduler = Scheduler(_FakeService())
    ack = scheduler.schedule_ack_check("esc-1")
    assert ack["kind"] == "ack_check"
    assert ack["payload"]["escalation_id"] == "esc-1"
    # A second identical schedule is de-duplicated.
    assert scheduler.schedule_ack_check("esc-1")["created"] is False

    retry = scheduler.schedule_retry_call("call-9")
    assert retry["kind"] == "retry_call"
    assert retry["dedupe_key"] == "retry:call-9"
    assert retry["max_attempts"] >= 2

    follow = scheduler.schedule_follow_up(
        kind="follow_up_call", patient_id=1, run_at=clean_db.utc_offset(60)
    )
    assert follow["patient_id"] == 1

    purge = scheduler.schedule_purge()
    assert purge["kind"] == "purge_expired"


def test_scheduler_run_job_marks_done(clean_db):
    scheduler = Scheduler(_FakeService())
    seen: list[str] = []

    async def handler(job):
        seen.append(job["id"])

    scheduler.handlers["custom"] = handler
    job = clean_db.create_job(kind="custom", run_at=clean_db.utc_offset(-1))
    run(scheduler._run_job(clean_db.get_job(job["id"])))
    assert seen == [job["id"]]
    assert clean_db.get_job(job["id"])["state"] == "done"


def test_scheduler_run_job_without_handler_is_dead(clean_db):
    scheduler = Scheduler(_FakeService())
    job = clean_db.create_job(kind="no_such_kind", run_at=clean_db.utc_offset(-1))
    run(scheduler._run_job(clean_db.get_job(job["id"])))
    stored = clean_db.get_job(job["id"])
    assert stored["state"] == "dead"
    assert stored["last_error"] == "no_handler"


def test_scheduler_run_job_retries_then_gives_up(clean_db):
    scheduler = Scheduler(_FakeService())

    async def boom(job):
        raise RuntimeError("kaboom")

    scheduler.handlers["boom"] = boom
    job = clean_db.create_job(kind="boom", run_at=clean_db.utc_offset(-1), max_attempts=1)
    # First attempt (attempts=0) is below the cap -> retried.
    run(scheduler._run_job({**clean_db.get_job(job["id"]), "attempts": 0, "max_attempts": 3}))
    assert clean_db.get_job(job["id"])["state"] == "pending"

    # At the cap -> permanently dead, with the error recorded.
    run(scheduler._run_job({**clean_db.get_job(job["id"]), "attempts": 3, "max_attempts": 3}))
    stored = clean_db.get_job(job["id"])
    assert stored["state"] == "dead"
    assert "kaboom" in stored["last_error"]


def test_scheduler_tick_processes_due_jobs(clean_db):
    scheduler = Scheduler(_FakeService())
    done: list[str] = []

    async def handler(job):
        done.append(job["id"])

    scheduler.handlers["custom"] = handler
    job = clean_db.create_job(kind="custom", run_at=clean_db.utc_offset(-5))
    processed = run(scheduler.tick())
    assert processed >= 1
    assert job["id"] in done
    assert clean_db.get_job(job["id"])["state"] == "done"
