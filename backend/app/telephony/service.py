"""Durable orchestration for calls, messages, escalations and family access.

This is the layer the API routes and webhook handlers talk to.  It owns the
business rules that must not live in a route handler:

* rate limits, quiet hours and duplicate-call prevention;
* idempotent creation of calls/messages/escalations;
* the escalation action plan (notify nurse, retry, backup, unacknowledged alert);
* honest status: an *accepted* request is never reported as *delivered*.
"""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Optional
from urllib.parse import quote

from app import database
from app.config import settings
from app.escalation import EscalationDecision, ack_escalation_severity, safety_message
from app.telephony import numbers, registry
from app.telephony.models import (
    CallState,
    EscalationSeverity,
    MessageChannel,
    MessageState,
    ProviderMode,
    severity_at_least,
    transition_call,
    transition_escalation,
    transition_message,
)
from app.telephony.webhooks import idempotency_key


class RateLimited(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class TelephonyService:
    def __init__(self, engine: Any, scheduler: Any = None) -> None:
        self.engine = engine
        self.scheduler = scheduler

    # --- provider / URLs ----------------------------------------------
    @property
    def provider(self) -> Any:
        return registry.get_provider()

    def webhook_base(self) -> str:
        base = settings.webhook_base_url or settings.public_base_url
        return base.rstrip("/")

    def webhook_ready(self) -> bool:
        base = self.webhook_base()
        return base.startswith("https://")

    def urls(self, provider_name: str) -> dict[str, str]:
        base = self.webhook_base()
        ws_base = base.replace("https://", "wss://").replace("http://", "ws://")
        # Exotel does not sign webhooks; we append a shared-secret token to the
        # callback URLs we register and re-check it on the way in.
        token = getattr(registry.get_provider(provider_name), "webhook_secret", "") or ""
        suffix = f"?token={quote(token, safe='')}" if token else ""
        return {
            "answer_url": f"{base}/api/telephony/{provider_name}/voice{suffix}",
            "stream_url": f"{ws_base}/api/telephony/{provider_name}/media{suffix}",
            "status_url": f"{base}/api/telephony/{provider_name}/events{suffix}",
        }

    # --- rate limits / quiet hours ------------------------------------
    def _hour_bucket(self) -> str:
        return datetime.utcnow().strftime("%Y%m%d%H")

    def calls_last_hour(self, patient_id: Optional[int]) -> int:
        return database.count_calls_since(patient_id, database.utc_offset(-3600))

    def messages_last_hour(self, patient_id: Optional[int]) -> int:
        return database.count_messages_since(patient_id, database.utc_offset(-3600))

    def in_quiet_hours(self, now: Optional[datetime] = None) -> bool:
        if not settings.quiet_hours_enabled:
            return False
        hour = (now or datetime.now()).hour
        start, end = settings.quiet_hours_start, settings.quiet_hours_end
        if start == end:
            return False
        if start < end:
            return start <= hour < end
        return hour >= start or hour < end

    def check_call_allowed(self, patient_id: Optional[int], *, is_emergency: bool = False) -> None:
        if is_emergency:
            return  # emergencies always override quiet hours and soft limits
        if self.calls_last_hour(patient_id) >= settings.rate_limit_calls_per_hour:
            raise RateLimited(
                f"Rate limit reached: {settings.rate_limit_calls_per_hour} calls per hour for this patient."
            )

    # --- calls ---------------------------------------------------------
    async def start_nurse_call(
        self,
        *,
        patient_id: int,
        patient_name: str,
        to_number: str,
        contact_id: Optional[int] = None,
        purpose: str = "nurse_to_patient_ai",
        actor: Optional[dict[str, Any]] = None,
        idempotency: Optional[str] = None,
        is_emergency: bool = False,
    ) -> dict[str, Any]:
        provider = self.provider
        self.check_call_allowed(patient_id, is_emergency=is_emergency)
        base = self.webhook_base()
        if provider.mode.value != ProviderMode.MOCK.value and not base.startswith("https://"):
            return {
                "ok": False,
                "reason": "webhook_not_public",
                "message": (
                    "A carrier needs a public HTTPS address for callbacks and media. "
                    "Set PUBLIC_BASE_URL (or TELEPHONY_WEBHOOK_BASE_URL) to a public HTTPS "
                    "endpoint and expose it through an authenticated tunnel or deployment."
                ),
                "mode": provider.operating_mode(),
            }

        key = idempotency or idempotency_key("call", patient_id, purpose, contact_id, self._hour_bucket())
        record = database.create_telephony_call(
            provider=provider.name,
            direction="outbound",
            from_e164=provider_settings_caller(provider),
            to_e164=to_number,
            from_masked=numbers.mask(provider_settings_caller(provider)),
            to_masked=numbers.mask(to_number),
            patient_id=patient_id,
            contact_id=contact_id,
            purpose=purpose,
            state=CallState.CREATED.value,
            provider_mode=provider.mode.value,
            idempotency_key=key,
            recording=settings.telephony_record_calls,
            metadata={"patient_name": patient_name, "requested_by": (actor or {}).get("username")},
        )
        if not record.get("created"):
            return {"ok": True, "duplicate": True, "call": _public_call(record), "mode": provider.operating_mode()}

        urls = self.urls(provider.name)
        result = await provider.start_outbound_call(
            to_number=to_number,
            from_number=provider_settings_caller(provider) or None,
            answer_url=urls["answer_url"],
            stream_url=_with_sample_rate(urls["stream_url"], provider),
            status_url=urls["status_url"],
            record=settings.telephony_record_calls,
            metadata={"call_record_id": record["id"], "purpose": purpose},
        )

        state = result.state if result.ok else CallState.FAILED.value
        database.set_provider_call_id(record["id"], result.provider_call_id) if result.provider_call_id else None
        database.update_telephony_call(
            record["id"], state=state, error=None if result.ok else result.detail
        )
        database.add_call_event(
            record["id"],
            event_type="provider.request",
            state=state,
            payload={"accepted": result.accepted, "provider_call_id": result.provider_call_id, "ok": result.ok},
            provider_event_id=f"request:{key}",
        )
        if not result.ok:
            self._schedule_retry(record["id"], patient_id, purpose)
        return {
            "ok": result.ok,
            "call": _public_call(database.get_telephony_call(record["id"]) or record),
            "mode": provider.operating_mode(),
            "accepted": result.accepted,
            "detail": result.detail,
        }

    async def retry_outbound_call(self, call: dict[str, Any], *, reason: str = "retry") -> dict[str, Any]:
        """Re-attempt an outbound call on the same record (no duplicate row)."""
        provider = registry.get_provider(call["provider"])
        if not provider.is_configured() and provider.mode.value != ProviderMode.MOCK.value:
            return {"ok": False, "detail": "Provider is no longer configured."}
        urls = self.urls(provider.name)
        database.update_telephony_call(call["id"], state=CallState.QUEUED.value)
        result = await provider.start_outbound_call(
            to_number=call["to_e164"],
            from_number=provider_settings_caller(provider) or None,
            answer_url=urls["answer_url"],
            stream_url=_with_sample_rate(urls["stream_url"], provider),
            status_url=urls["status_url"],
            record=False,
            metadata={"call_record_id": call["id"], "retry": reason},
        )
        if result.provider_call_id:
            database.set_provider_call_id(call["id"], result.provider_call_id)
        database.update_telephony_call(
            call["id"],
            state=result.state if result.ok else CallState.FAILED.value,
            error=None if result.ok else result.detail,
        )
        database.add_call_event(
            call["id"],
            event_type=f"retry.{reason}",
            state=result.state if result.ok else CallState.FAILED.value,
            payload={"ok": result.ok, "detail": result.detail},
            provider_event_id=idempotency_key("retry", call["id"], reason, database.utc_now()),
        )
        return {"ok": result.ok, "detail": result.detail}

    async def end_call(self, call_id: str, actor: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        record = database.get_telephony_call(call_id)
        if record is None:
            return {"ok": False, "message": "Call not found."}
        provider = registry.get_provider(record["provider"])
        if record.get("provider_call_id"):
            await provider.end_call(record["provider_call_id"])
        _apply_call_state(call_id, CallState.COMPLETED.value, provider_event_id=f"manual:{call_id}")
        return {"ok": True, "call": _public_call(database.get_telephony_call(call_id) or record)}

    # --- messages ------------------------------------------------------
    async def send_message(
        self,
        *,
        patient_id: int,
        to_number: str,
        body: str,
        channel: str = MessageChannel.SMS.value,
        contact_id: Optional[int] = None,
        actor: Optional[dict[str, Any]] = None,
        idempotency: Optional[str] = None,
        allow_quiet_hours: bool = False,
    ) -> dict[str, Any]:
        provider = self.provider
        if not allow_quiet_hours and self.in_quiet_hours():
            return {
                "ok": False,
                "reason": "quiet_hours",
                "message": "Quiet hours are active. Pause, or override with an explicit acknowledgement.",
            }
        if self.messages_last_hour(patient_id) >= settings.rate_limit_messages_per_hour:
            raise RateLimited("Rate limit reached for messages to this patient.")
        base = self.webhook_base()
        if provider.mode.value != ProviderMode.MOCK.value and not base.startswith("https://"):
            return {
                "ok": False,
                "reason": "webhook_not_public",
                "message": "A carrier needs a public HTTPS callback URL for delivery receipts.",
                "mode": provider.operating_mode(),
            }
        key = idempotency or idempotency_key("msg", patient_id, channel, to_number, body[:80], self._hour_bucket())
        record = database.create_message(
            provider=provider.name,
            direction="outbound",
            channel=channel,
            from_e164=provider_settings_caller(provider),
            to_e164=to_number,
            from_masked=numbers.mask(provider_settings_caller(provider)),
            to_masked=numbers.mask(to_number),
            patient_id=patient_id,
            contact_id=contact_id,
            body=body,
            state=MessageState.CREATED.value,
            provider_mode=provider.mode.value,
            idempotency_key=key,
            metadata={"requested_by": (actor or {}).get("username")},
        )
        if not record.get("created"):
            return {"ok": True, "duplicate": True, "message": _public_message(record), "mode": provider.operating_mode()}

        urls = self.urls(provider.name)
        result = await provider.send_message(
            to_number=to_number,
            from_number=provider_settings_caller(provider) or None,
            body=body,
            channel=channel,
            status_url=urls["status_url"],
            metadata={"message_record_id": record["id"]},
        )
        state = result.state if result.ok else MessageState.FAILED.value
        if result.provider_message_id:
            database.set_message_provider_id(record["id"], result.provider_message_id)
        database.update_message_state(
            record["id"], state=state, error=None if result.ok else result.detail
        )
        database.add_message_event(
            record["id"],
            event_type="provider.request",
            state=state,
            payload={"accepted": result.accepted, "provider_message_id": result.provider_message_id, "ok": result.ok},
            provider_event_id=f"request:{key}",
        )
        return {
            "ok": result.ok,
            "message": _public_message(database.get_message(record["id"]) or record),
            "mode": provider.operating_mode(),
            "accepted": result.accepted,
            "detail": result.detail,
        }

    # --- provider events ----------------------------------------------
    async def handle_provider_event(self, event: Any) -> dict[str, Any]:
        """Apply a normalised, signature-verified provider event idempotently."""
        first_seen = database.record_webhook_event(event.provider, event.event_id)
        if event.kind == "message.status" and event.provider_message_id:
            return self._apply_message_event(event, first_seen)
        if event.provider_call_id:
            return self._apply_call_event(event, first_seen)
        return {"ok": True, "applied": False, "reason": "unmatched_event", "duplicate": not first_seen}

    def _apply_call_event(self, event: Any, first_seen: bool) -> dict[str, Any]:
        record = database.get_telephony_call_by_provider_id(event.provider_call_id)
        if record is None:
            return {"ok": True, "applied": False, "reason": "unknown_call"}
        database.add_call_event(
            record["id"],
            event_type=event.kind,
            state=event.state,
            payload=event.raw,
            provider_event_id=event.event_id,
        )
        if not first_seen:
            return {"ok": True, "applied": False, "reason": "replay", "duplicate": True}
        if event.state and event.state != record["state"]:
            _apply_call_state(
                record["id"],
                event.state,
                provider_event_id=event.event_id,
                detail=event.detail,
            )
        if event.state in {CallState.FAILED.value, CallState.BUSY.value, CallState.NO_ANSWER.value}:
            self._schedule_retry(record["id"], record.get("patient_id"), record.get("purpose"))
        return {"ok": True, "applied": True, "call": _public_call(database.get_telephony_call(record["id"]))}

    def _apply_message_event(self, event: Any, first_seen: bool) -> dict[str, Any]:
        record = database.get_message_by_provider_id(event.provider_message_id)
        if record is None:
            return {"ok": True, "applied": False, "reason": "unknown_message"}
        database.add_message_event(
            record["id"],
            event_type=event.kind,
            state=event.state,
            payload=event.raw,
            provider_event_id=event.event_id,
        )
        if not first_seen:
            return {"ok": True, "applied": False, "reason": "replay", "duplicate": True}
        if event.state and event.state != record["state"]:
            result = transition_message(record["state"], event.state)
            if result.ok:
                database.update_message_state(
                    record["id"],
                    state=event.state,
                    delivered=event.state == MessageState.DELIVERED.value,
                    error=event.detail or None,
                )
        return {"ok": True, "applied": True, "message": _public_message(database.get_message(record["id"]))}

    # --- inbound -------------------------------------------------------
    def handle_inbound_call(
        self, *, from_number: str, to_number: str, provider_name: str, metadata: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        """Identify an inbound caller and decide the persona for the AI.

        Caller ID is *never* treated as proof of identity.  It only selects a
        persona; family access still requires a permission and, where applicable,
        a completed request before any patient information is shared.
        """
        normalized = numbers.try_normalize(from_number, settings.default_region) or from_number
        contacts = database.find_contacts_by_phone(normalized) if normalized else []
        persona = "unknown"
        patient_id: Optional[int] = None
        contact_id: Optional[int] = None
        display = "caller"
        if contacts:
            contact = contacts[0]
            contact_id = int(contact["id"])
            patient_id = contact.get("patient_id")
            display = contact["display_name"]
            role = contact["role"]
            if role == "patient":
                persona = "patient"
            elif role in {"primary_nurse", "primary_nurse_backup"}:
                persona = "nurse"
            elif role == "family":
                permission = (
                    database.get_family_permission(int(patient_id), contact_id)
                    if patient_id
                    else None
                )
                consented = contact.get("consent_status") == "granted"
                if permission and not permission.get("revoked") and consented:
                    persona = "family"
                else:
                    persona = "family_unverified"
        record = database.create_telephony_call(
            provider=provider_name,
            direction="inbound",
            from_e164=normalized,
            to_e164=numbers.try_normalize(to_number, settings.default_region) or to_number,
            from_masked=numbers.mask(normalized),
            to_masked=numbers.mask(to_number),
            patient_id=patient_id,
            contact_id=contact_id,
            purpose="inbound_call",
            state=CallState.RINGING.value,
            provider_mode=self.provider.mode.value,
            metadata={"persona": persona, "display": display, **(metadata or {})},
        )
        return {
            "ok": True,
            "call": _public_call(record),
            "persona": persona,
            "display_name": display,
            "patient_id": patient_id,
            "contact_id": contact_id,
            "identified": persona not in {"unknown", "family_unverified"},
        }

    # --- escalations ---------------------------------------------------
    async def raise_escalation(
        self,
        *,
        patient_id: Optional[int],
        decision: EscalationDecision,
        call_id: Optional[str] = None,
        excerpt: str = "",
        bucket: Optional[str] = None,
        actor: Optional[str] = None,
    ) -> dict[str, Any]:
        from app.escalation import dedupe_key as make_key

        severity = decision.severity
        key = make_key(patient_id, decision.category, severity, bucket or self._hour_bucket())
        record = database.create_escalation(
            patient_id=patient_id,
            severity=severity.value,
            category=decision.category,
            reason=decision.reason,
            call_id=call_id,
            transcript_excerpt=(excerpt or "")[:240],
            dedupe_key=key,
            requires_ack=severity_at_least(severity, EscalationSeverity.URGENT),
            metadata={"source": decision.source, "matched_terms": decision.matched_terms, "raised_by": actor},
        )
        if not record.get("created"):
            return {"ok": True, "duplicate": True, "escalation": _public_escalation(record)}
        await self._run_escalation_actions(record, patient_id)
        if self.scheduler is not None:
            self.scheduler.schedule_ack_check(record["id"])
        return {"ok": True, "escalation": _public_escalation(database.get_escalation(record["id"]) or record)}

    async def _run_escalation_actions(self, escalation: dict[str, Any], patient_id: Optional[int]) -> None:
        severity = escalation["severity"]
        escalation_id = escalation["id"]
        contacts = database.list_contacts(patient_id) if patient_id is not None else []
        nurse = _pick_nurse(contacts, backup=False)
        backup = _pick_nurse(contacts, backup=True)
        provider = self.provider
        provider_ok = provider.is_configured() and (
            provider.mode.value == ProviderMode.MOCK.value or self.webhook_ready()
        )

        attempt = 1
        # 1. Direct the patient to emergency services for immediate danger.
        if severity == EscalationSeverity.EMERGENCY.value:
            database.add_escalation_action(
                escalation_id,
                action_type="advise_emergency_services",
                state="done",
                attempt=attempt,
                target_masked=settings.emergency_number,
                result=f"Patient directed to {settings.emergency_number}.",
            )
        # 2. Notify the responsible nurse by message, then by call for urgent+.
        for target, label in ((nurse, "primary_nurse"), (backup, "backup_nurse")):
            if target is None:
                continue
            if severity_at_least(severity, EscalationSeverity.URGENT):
                await self._notify_by_call(escalation_id, target, provider, provider_ok, attempt, label)
                attempt += 1
            await self._notify_by_message(escalation_id, target, provider, provider_ok, attempt, label, severity)
            attempt += 1
        if nurse is None and backup is None:
            database.add_escalation_action(
                escalation_id,
                action_type="notify_nurse",
                state="unavailable",
                attempt=attempt,
                result="No nurse contact number is registered for this patient.",
            )
        # 3. Always leave durable evidence and a fallback alert path.
        database.add_escalation_action(
            escalation_id,
            action_type="dashboard_alert",
            state="done",
            attempt=attempt,
            result="Escalation is visible in the VoiceLink escalation center.",
        )

    async def _notify_by_call(
        self,
        escalation_id: str,
        contact: dict[str, Any],
        provider: Any,
        provider_ok: bool,
        attempt: int,
        label: str,
    ) -> None:
        if not provider_ok:
            database.add_escalation_action(
                escalation_id,
                action_type=f"call_{label}",
                state="unavailable",
                attempt=attempt,
                target_masked=contact.get("phone_masked"),
                result="No working telephony provider is configured, so no call was placed.",
            )
            return
        try:
            result = await provider.start_outbound_call(
                to_number=contact["phone_e164"],
                from_number=provider_settings_caller(provider) or None,
                answer_url=self.urls(provider.name)["answer_url"],
                stream_url=_with_sample_rate(self.urls(provider.name)["stream_url"], provider),
                status_url=self.urls(provider.name)["status_url"],
                record=False,
                metadata={"escalation_id": escalation_id, "purpose": f"escalate_{label}"},
            )
        except Exception as exc:  # pragma: no cover - defensive
            database.add_escalation_action(
                escalation_id,
                action_type=f"call_{label}",
                state="failed",
                attempt=attempt,
                target_masked=contact.get("phone_masked"),
                result=f"Provider error: {exc}",
            )
            return
        database.add_escalation_action(
            escalation_id,
            action_type=f"call_{label}",
            state="attempted" if result.ok else "failed",
            attempt=attempt,
            target_masked=contact.get("phone_masked"),
            result=(
                "Call request accepted by the provider (ringing is not yet confirmed)."
                if result.ok
                else result.detail
            ),
        )
        if result.ok:
            database.create_telephony_call(
                provider=provider.name,
                direction="outbound",
                from_e164=provider_settings_caller(provider),
                to_e164=contact["phone_e164"],
                from_masked=numbers.mask(provider_settings_caller(provider)),
                to_masked=contact.get("phone_masked", ""),
                patient_id=None,
                contact_id=contact.get("id"),
                purpose=f"escalate_{label}",
                state=result.state,
                provider_mode=provider.mode.value,
                idempotency_key=idempotency_key("escalation-call", escalation_id, label),
                metadata={"escalation_id": escalation_id},
            )

    async def _notify_by_message(
        self,
        escalation_id: str,
        contact: dict[str, Any],
        provider: Any,
        provider_ok: bool,
        attempt: int,
        label: str,
        severity: str,
    ) -> None:
        text = f"VoiceLink alert ({severity}): a patient you support may need attention. Open the escalation center now."
        if not provider_ok or not provider.capabilities().sms:
            database.add_escalation_action(
                escalation_id,
                action_type=f"message_{label}",
                state="unavailable",
                attempt=attempt,
                target_masked=contact.get("phone_masked"),
                result="SMS is not available for the configured provider.",
            )
            return
        try:
            result = await provider.send_message(
                to_number=contact["phone_e164"],
                from_number=provider_settings_caller(provider) or None,
                body=text,
                channel="sms",
                status_url=self.urls(provider.name)["status_url"],
                metadata={"escalation_id": escalation_id},
            )
        except Exception as exc:  # pragma: no cover - defensive
            database.add_escalation_action(
                escalation_id,
                action_type=f"message_{label}",
                state="failed",
                attempt=attempt,
                target_masked=contact.get("phone_masked"),
                result=f"Provider error: {exc}",
            )
            return
        database.add_escalation_action(
            escalation_id,
            action_type=f"message_{label}",
            state="accepted" if result.ok else "failed",
            attempt=attempt,
            target_masked=contact.get("phone_masked"),
            result="SMS accepted by the provider (delivery not yet confirmed)." if result.ok else result.detail,
        )

    def acknowledge_escalation(
        self, escalation_id: str, *, actor: Optional[dict[str, Any]] = None, note: str = ""
    ) -> dict[str, Any]:
        record = database.get_escalation(escalation_id)
        if record is None:
            return {"ok": False, "message": "Escalation not found."}
        result = transition_escalation(record["state"], "acknowledged")
        if not result.ok:
            return {"ok": False, "message": f"Cannot acknowledge from state '{record['state']}'."}
        actor_name = (actor or {}).get("display_name") or "dashboard"
        database.update_escalation_state(escalation_id, state="acknowledged", actor=actor_name)
        database.add_escalation_action(
            escalation_id, action_type="acknowledged", state="done", result=note or f"Acknowledged by {actor_name}."
        )
        return {"ok": True, "escalation": _public_escalation(database.get_escalation(escalation_id))}

    def resolve_escalation(
        self, escalation_id: str, *, actor: Optional[dict[str, Any]] = None, note: str = ""
    ) -> dict[str, Any]:
        record = database.get_escalation(escalation_id)
        if record is None:
            return {"ok": False, "message": "Escalation not found."}
        actor_name = (actor or {}).get("display_name") or "dashboard"
        database.update_escalation_state(
            escalation_id, state="resolved", actor=actor_name, resolved=True
        )
        database.add_escalation_action(
            escalation_id, action_type="resolved", state="done", result=note or f"Resolved by {actor_name}."
        )
        return {"ok": True, "escalation": _public_escalation(database.get_escalation(escalation_id))}

    # --- retries -------------------------------------------------------
    def _schedule_retry(self, call_id: str, patient_id: Optional[int], purpose: Optional[str]) -> None:
        if self.scheduler is None:
            return
        if purpose in {"escalate_primary_nurse", "escalate_backup_nurse"}:
            return  # retries for escalation calls are handled by the escalation policy
        attempts = database.count_calls_since(patient_id, database.utc_offset(-3600))
        if attempts > settings.outbound_max_retries + 1:
            return
        self.scheduler.schedule_retry_call(call_id)

    # --- dashboard -----------------------------------------------------
    def overview(self) -> dict[str, Any]:
        active = database.list_telephony_calls(
            states=[
                CallState.QUEUED.value,
                CallState.DIALING.value,
                CallState.RINGING.value,
                CallState.ANSWERED.value,
                CallState.CONNECTED.value,
            ],
            limit=50,
        )
        open_escalations = database.list_escalations(state="open", limit=50)
        unack = [e for e in open_escalations if e.get("requires_ack")]
        missed = database.list_telephony_calls(
            states=[CallState.NO_ANSWER.value, CallState.BUSY.value, CallState.FAILED.value], limit=20
        )
        pending_messages = [
            m
            for m in database.list_messages(limit=50)
            if m["state"] in {MessageState.CREATED.value, MessageState.QUEUED.value, MessageState.SENT.value}
        ]
        summary = registry.provider_summary()
        summary["webhook_ready"] = self.webhook_ready()
        return {
            "active_calls": [_public_call(c) for c in active],
            "open_escalations": [_public_escalation(e) for e in open_escalations],
            "unacknowledged_alerts": [_public_escalation(e) for e in unack],
            "missed_calls": [_public_call(c) for c in missed],
            "pending_messages": [_public_message(m) for m in pending_messages],
            "escalation_actions": {
                escalation["id"]: database.list_escalation_actions(escalation["id"])
                for escalation in open_escalations[:10]
            },
            "counts": {
                "active_calls": len(active),
                "open_escalations": len(open_escalations),
                "unacknowledged": len(unack),
                "missed_calls": len(missed),
                "pending_messages": len(pending_messages),
                "scheduled_jobs": len(database.list_jobs(states=["pending", "leased"], limit=200)),
            },
            "telephony": summary,
        }


# --- helpers ---------------------------------------------------------------

def provider_settings_caller(provider: Any) -> str:
    return getattr(provider, "caller_id", "") or getattr(provider, "from_number", "") or ""


def _with_sample_rate(stream_url: str, provider: Any) -> str:
    if provider.name != "exotel":
        return stream_url
    separator = "&" if "?" in stream_url else "?"
    return f"{stream_url}{separator}sample-rate=8000"


def _pick_nurse(contacts: list[dict[str, Any]], *, backup: bool) -> Optional[dict[str, Any]]:
    wanted = "primary_nurse_backup" if backup else "primary_nurse"
    for contact in contacts:
        if contact["role"] == wanted and contact.get("active", True):
            return contact
    return None


def _apply_call_state(call_id: str, state: str, *, provider_event_id: Optional[str] = None, detail: str = "") -> None:
    record = database.get_telephony_call(call_id)
    if record is None:
        return
    result = transition_call(record["state"], state)
    if not result.ok:
        # Allow terminal state to win over an earlier non-terminal one from an
        # out-of-order webhook, but never resurrect a terminal record.
        from app.telephony.models import is_call_terminal

        if is_call_terminal(record["state"]):
            return
    answered = state in {CallState.ANSWERED.value, CallState.CONNECTED.value}
    ended = state in {
        CallState.COMPLETED.value,
        CallState.DISCONNECTED.value,
        CallState.FAILED.value,
        CallState.BUSY.value,
        CallState.NO_ANSWER.value,
        CallState.REJECTED.value,
        CallState.CANCELLED.value,
        CallState.PROVIDER_TIMEOUT.value,
    }
    database.update_telephony_call(
        call_id,
        state=state,
        answered=answered,
        ended=ended,
        error=detail or None if state in {CallState.FAILED.value, CallState.PROVIDER_TIMEOUT.value} else None,
    )
    database.add_call_event(
        call_id,
        event_type="state",
        state=state,
        payload={"detail": detail},
        provider_event_id=provider_event_id,
    )


def _public_call(record: Optional[dict[str, Any]]) -> dict[str, Any]:
    if record is None:
        return {}
    data = dict(record)
    data.pop("metadata_json", None)
    if isinstance(data.get("metadata"), dict):
        meta = dict(data["metadata"])
        meta.pop("patient_name", None)
        data["metadata"] = meta
    return data


def _public_message(record: Optional[dict[str, Any]]) -> dict[str, Any]:
    if record is None:
        return {}
    data = dict(record)
    data.pop("metadata_json", None)
    return data


def _public_escalation(record: Optional[dict[str, Any]]) -> dict[str, Any]:
    if record is None:
        return {}
    data = dict(record)
    data.pop("metadata_json", None)
    return data
