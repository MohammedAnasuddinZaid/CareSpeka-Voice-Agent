"""Durable follow-up scheduler.

Follow-ups are persisted jobs executed by a background worker, never browser
timers.  Jobs are leased atomically so a restart or a second worker cannot run
the same job twice, and every job carries a dedupe key so retries cannot create
duplicate calls.
"""
from __future__ import annotations

import asyncio
import contextlib
from typing import Any, Awaitable, Callable, Optional

from app import database
from app.config import settings
from app.telephony.models import CallState, EscalationState

JobHandler = Callable[[dict[str, Any]], Awaitable[None]]


class Scheduler:
    def __init__(self, service: Any) -> None:
        self.service = service
        self._task: Optional[asyncio.Task] = None
        self._stopping = asyncio.Event()
        self.handlers: dict[str, JobHandler] = {
            "ack_check": self._handle_ack_check,
            "retry_call": self._handle_retry_call,
            "follow_up_call": self._handle_follow_up_call,
            "follow_up_message": self._handle_follow_up_message,
            "purge_expired": self._handle_purge,
        }

    # --- lifecycle -----------------------------------------------------
    async def start(self) -> None:
        if self._task is not None:
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stopping.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _loop(self) -> None:
        while not self._stopping.is_set():
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - keep the worker alive
                pass
            try:
                await asyncio.wait_for(
                    self._stopping.wait(), timeout=settings.scheduler_poll_seconds
                )
            except asyncio.TimeoutError:
                continue

    async def tick(self) -> int:
        jobs = await asyncio.to_thread(
            database.claim_due_jobs, 10, settings.job_lease_seconds
        )
        processed = 0
        for job in jobs:
            await self._run_job(job)
            processed += 1
        return processed

    async def _run_job(self, job: dict[str, Any]) -> None:
        handler = self.handlers.get(job["kind"])
        if handler is None:
            await asyncio.to_thread(database.complete_job, job["id"], state="dead", error="no_handler")
            return
        try:
            await handler(job)
        except Exception as exc:
            attempts = int(job.get("attempts") or 0)
            max_attempts = int(job.get("max_attempts") or settings.job_max_attempts)
            if attempts >= max_attempts:
                await asyncio.to_thread(
                    database.complete_job, job["id"], state="dead", error=str(exc)[:300]
                )
            else:
                backoff = settings.outbound_retry_backoff_seconds * attempts
                await asyncio.to_thread(
                    database.retry_job,
                    job["id"],
                    run_at=database.utc_offset(max(5, backoff)),
                    error=str(exc)[:300],
                )
        else:
            await asyncio.to_thread(database.complete_job, job["id"], state="done")

    # --- scheduling helpers -------------------------------------------
    def schedule_ack_check(self, escalation_id: str, delay: Optional[int] = None) -> dict[str, Any]:
        delay = settings.escalation_ack_timeout_seconds if delay is None else delay
        return database.create_job(
            kind="ack_check",
            run_at=database.utc_offset(delay),
            payload={"escalation_id": escalation_id},
            dedupe_key=f"ack:{escalation_id}",
            max_attempts=2,
        )

    def schedule_retry_call(self, call_id: str) -> dict[str, Any]:
        return database.create_job(
            kind="retry_call",
            run_at=database.utc_offset(settings.outbound_retry_backoff_seconds),
            payload={"call_id": call_id},
            dedupe_key=f"retry:{call_id}",
            max_attempts=settings.outbound_max_retries + 1,
        )

    def schedule_follow_up(
        self,
        *,
        kind: str,
        patient_id: int,
        run_at: str,
        payload: Optional[dict[str, Any]] = None,
        dedupe_key: Optional[str] = None,
    ) -> dict[str, Any]:
        return database.create_job(
            kind=kind,
            run_at=run_at,
            patient_id=patient_id,
            payload=payload or {},
            dedupe_key=dedupe_key,
            max_attempts=settings.job_max_attempts,
        )

    def schedule_purge(self, every_seconds: int = 3600) -> dict[str, Any]:
        return database.create_job(
            kind="purge_expired",
            run_at=database.utc_offset(every_seconds),
            dedupe_key="purge",
            max_attempts=1,
        )

    # --- handlers ------------------------------------------------------
    async def _handle_ack_check(self, job: dict[str, Any]) -> None:
        escalation_id = job["payload"].get("escalation_id")
        if not escalation_id:
            return
        escalation = await asyncio.to_thread(database.get_escalation, escalation_id)
        if escalation is None or escalation["state"] != EscalationState.OPEN.value:
            return
        # The escalation is still unacknowledged: alert the backup chain and
        # leave durable evidence, then re-check once more.
        patient_id = escalation.get("patient_id")
        contacts = await asyncio.to_thread(database.list_contacts, patient_id)
        backup = next(
            (c for c in contacts if c["role"] == "primary_nurse_backup" and c.get("active", True)),
            None,
        )
        await asyncio.to_thread(
            database.add_escalation_action,
            escalation_id,
            action_type="unacknowledged_alert",
            state="done",
            result=(
                f"Not acknowledged within {settings.escalation_ack_timeout_seconds}s; "
                + (
                    f"backup nurse {backup.get('phone_masked')} flagged."
                    if backup
                    else "no backup nurse is registered - escalation remains prominently open."
                )
            ),
        )
        if backup and self.service.provider.is_configured():
            with contextlib.suppress(Exception):
                await self.service._notify_by_call(
                    escalation_id, backup, self.service.provider, True, 2, "backup_nurse"
                )
        escalation = await asyncio.to_thread(database.get_escalation, escalation_id)
        metadata = (escalation or {}).get("metadata", {})
        rechecks = int(metadata.get("rechecks") or 0) if isinstance(metadata, dict) else 0
        if rechecks < 2:
            metadata = dict(metadata) if isinstance(metadata, dict) else {}
            metadata["rechecks"] = rechecks + 1
            database.create_job(
                kind="ack_check",
                run_at=database.utc_offset(settings.escalation_ack_timeout_seconds),
                payload={"escalation_id": escalation_id},
                dedupe_key=f"ack:{escalation_id}:{rechecks + 1}",
                max_attempts=1,
            )

    async def _handle_retry_call(self, job: dict[str, Any]) -> None:
        call_id = job["payload"].get("call_id")
        if not call_id:
            return
        call = await asyncio.to_thread(database.get_telephony_call, call_id)
        if call is None:
            return
        if call["state"] not in {CallState.FAILED.value, CallState.NO_ANSWER.value, CallState.BUSY.value}:
            return
        if self.service.in_quiet_hours():
            raise RuntimeError("quiet_hours")
        await self.service.retry_outbound_call(call, reason="retry")

    async def _handle_follow_up_call(self, job: dict[str, Any]) -> None:
        payload = job["payload"]
        patient_id = job.get("patient_id") or payload.get("patient_id")
        to_number = payload.get("to_number")
        if not patient_id or not to_number:
            return
        if self.service.in_quiet_hours():
            raise RuntimeError("quiet_hours")
        await self.service.start_nurse_call(
            patient_id=int(patient_id),
            patient_name=payload.get("patient_name", "patient"),
            to_number=to_number,
            contact_id=payload.get("contact_id"),
            purpose="follow_up",
            actor={"username": "scheduler"},
        )

    async def _handle_follow_up_message(self, job: dict[str, Any]) -> None:
        payload = job["payload"]
        patient_id = job.get("patient_id") or payload.get("patient_id")
        to_number = payload.get("to_number")
        if not patient_id or not to_number:
            return
        if self.service.in_quiet_hours():
            raise RuntimeError("quiet_hours")
        await self.service.send_message(
            patient_id=int(patient_id),
            to_number=to_number,
            body=payload.get("body", "Checking in from your care team."),
            channel=payload.get("channel", "sms"),
            contact_id=payload.get("contact_id"),
            actor={"username": "scheduler"},
        )

    async def _handle_purge(self, job: dict[str, Any]) -> None:
        await asyncio.to_thread(database.purge_expired_sessions)
        database.create_job(
            kind="purge_expired",
            run_at=database.utc_offset(3600),
            dedupe_key=f"purge:{database.utc_now()[:13]}",
            max_attempts=1,
        )
