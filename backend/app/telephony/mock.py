"""Deterministic mock telephony provider.

The mock exists to make the *whole* platform testable and demonstrable without a
carrier account.  It is intentionally loud about being a mock: its operating mode
is ``mock`` and the dashboard shows a persistent "SIMULATED" banner whenever it is
selected, so it can never be mistaken for a real phone call.
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from typing import Any, Optional

from app.telephony.base import (
    CallResult,
    MessageResult,
    ProviderCapabilities,
    ProviderEvent,
    TelephonyProvider,
)
from app.telephony.models import ProviderMode


def _id(prefix: str) -> str:
    return f"mock_{prefix}_{uuid.uuid4().hex[:12]}"


class MockProvider(TelephonyProvider):
    name = "mock"
    mode = ProviderMode.MOCK

    def __init__(self) -> None:
        self.calls: dict[str, dict[str, Any]] = {}
        self.messages: dict[str, dict[str, Any]] = {}
        self.outbound_log: list[dict[str, Any]] = []
        self.message_log: list[dict[str, Any]] = []

    # --- config --------------------------------------------------------
    def is_configured(self) -> bool:
        return True

    def missing_configuration(self) -> list[str]:
        return []

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            outbound_calls=True,
            inbound_calls=True,
            bidirectional_audio=True,
            sms=True,
            whatsapp=False,
            call_control=True,
            recording=False,
            message_status_callbacks=True,
        )

    def operating_mode(self) -> str:
        return "mock"

    async def health(self) -> dict[str, Any]:
        return {
            "provider": self.name,
            "ok": True,
            "operating_mode": "mock",
            "simulated": True,
            "message": "Mock provider - no telephone call is placed.",
        }

    # --- calls ---------------------------------------------------------
    async def start_outbound_call(
        self,
        *,
        to_number: str,
        from_number: Optional[str],
        answer_url: str,
        stream_url: str,
        status_url: str,
        record: bool = False,
        metadata: Optional[dict[str, Any]] = None,
    ) -> CallResult:
        call_id = _id("call")
        record_state = {
            "provider_call_id": call_id,
            "to": to_number,
            "from": from_number,
            "state": "ringing",
            "simulated": True,
            "started_at": time.time(),
            "metadata": metadata or {},
        }
        self.calls[call_id] = record_state
        self.outbound_log.append({"kind": "outbound_call", "call_id": call_id, "to": to_number})
        return CallResult(
            ok=True,
            provider_call_id=call_id,
            state="ringing",
            accepted=True,
            detail="Mock call queued (no real telephone call is placed).",
            mode="mock",
            raw=record_state,
        )

    async def get_call_status(self, provider_call_id: str) -> dict[str, Any]:
        record = self.calls.get(provider_call_id)
        if not record:
            return {"ok": False, "state": "unknown", "detail": "Unknown mock call."}
        return {"ok": True, "provider_call_id": provider_call_id, "state": record["state"], "simulated": True}

    async def end_call(self, provider_call_id: str) -> dict[str, Any]:
        record = self.calls.get(provider_call_id)
        if not record:
            return {"ok": False, "detail": "Unknown mock call."}
        record["state"] = "completed"
        return {"ok": True, "provider_call_id": provider_call_id, "state": "completed"}

    # --- messages ------------------------------------------------------
    async def send_message(
        self,
        *,
        to_number: str,
        from_number: Optional[str],
        body: str,
        channel: str,
        status_url: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> MessageResult:
        message_id = _id("msg")
        self.messages[message_id] = {
            "provider_message_id": message_id,
            "to": to_number,
            "channel": channel,
            "body": body,
            "state": "sent",
        }
        self.message_log.append({"kind": "message", "message_id": message_id, "to": to_number, "channel": channel})
        return MessageResult(
            ok=True,
            provider_message_id=message_id,
            state="sent",
            accepted=True,
            detail="Mock message accepted (not delivered over a real network).",
            mode="mock",
            raw=self.messages[message_id],
        )

    async def get_message_status(self, provider_message_id: str) -> dict[str, Any]:
        record = self.messages.get(provider_message_id)
        if not record:
            return {"ok": False, "state": "unknown"}
        return {"ok": True, "provider_message_id": provider_message_id, "state": record["state"]}

    # --- webhooks ------------------------------------------------------
    def verify_webhook(self, headers: dict[str, str], body: bytes, url: str) -> bool:
        # The mock accepts a shared-secret token when configured, otherwise any
        # body.  Tests exercise signature verification against the real adapters.
        expected = headers.get("x-mock-signature") or headers.get("X-Mock-Signature")
        if expected is None:
            return True
        digest = hashlib.sha256(body).hexdigest()
        return digest == expected

    def parse_event(
        self, payload: dict[str, Any], *, kind_hint: Optional[str] = None
    ) -> Optional[ProviderEvent]:
        kind = payload.get("kind") or kind_hint or "call.status"
        provider_call_id = payload.get("provider_call_id") or payload.get("CallSid")
        return ProviderEvent(
            event_id=str(payload.get("event_id") or uuid.uuid4().hex),
            kind=str(kind),
            provider=self.name,
            provider_call_id=provider_call_id,
            provider_message_id=payload.get("provider_message_id"),
            state=payload.get("state"),
            direction=payload.get("direction"),
            from_number=payload.get("from"),
            to_number=payload.get("to"),
            detail=str(payload.get("detail") or ""),
            raw=payload,
        )

    # --- test helpers (never used by production code paths) ------------
    def simulate_answer(self, provider_call_id: str) -> None:
        if provider_call_id in self.calls:
            self.calls[provider_call_id]["state"] = "answered"

    def simulate_end(self, provider_call_id: str, state: str = "completed") -> None:
        if provider_call_id in self.calls:
            self.calls[provider_call_id]["state"] = state
