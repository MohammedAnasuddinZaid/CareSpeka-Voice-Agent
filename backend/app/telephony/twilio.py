"""Real Twilio adapter.

Implemented against the published Twilio REST API and Media Streams protocol:

* ``POST /2010-04-01/Accounts/{AccountSid}/Calls.json`` - outbound call; the
  answer URL returns TwiML with ``<Connect><Stream/>`` for bidirectional audio.
* ``POST /2010-04-01/Accounts/{AccountSid}/Messages.json`` - SMS/WhatsApp.
* Media Streams WebSocket - base64 G.711 mu-law, 8 kHz, events
  ``connected`` / ``start`` / ``media`` / ``stop``.
* Webhook authenticity - ``X-Twilio-Signature`` HMAC-SHA1 over the request URL
  plus the sorted form parameters, keyed by the account auth token.

Twilio can place calls to Indian mobile numbers only from specific number
classes and cannot dial Indian emergency numbers; see ``PROVIDER_DECISION.md``.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

import httpx

from app.telephony.audio import AudioFormat
from app.telephony.base import (
    CallResult,
    MessageResult,
    ProviderCapabilities,
    ProviderEvent,
    TelephonyProvider,
)
from app.telephony.models import ProviderMode

API_BASE = "https://api.twilio.com/2010-04-01"


class TwilioProvider(TelephonyProvider):
    name = "twilio"
    mode = ProviderMode.REAL
    media_format = AudioFormat(encoding="mulaw", sample_rate=8000, frame_ms=20)
    # Twilio Media Streams use camelCase ``streamSid`` in both directions.
    stream_id_field = "streamSid"

    def __init__(
        self,
        *,
        account_sid: str = "",
        auth_token: str = "",
        from_number: str = "",
        messaging_number: str = "",
        webhook_base_url: str = "",
        timeout_s: float = 20.0,
    ) -> None:
        self.account_sid = (account_sid or "").strip()
        self.auth_token = (auth_token or "").strip()
        self.from_number = (from_number or "").strip()
        self.messaging_number = (messaging_number or from_number or "").strip()
        self.webhook_base_url = (webhook_base_url or "").strip().rstrip("/")
        self.timeout_s = timeout_s

    # --- config --------------------------------------------------------
    def is_configured(self) -> bool:
        return bool(self.account_sid and self.auth_token and self.from_number)

    def missing_configuration(self) -> list[str]:
        missing = []
        if not self.account_sid:
            missing.append("TWILIO_ACCOUNT_SID")
        if not self.auth_token:
            missing.append("TWILIO_AUTH_TOKEN")
        if not self.from_number:
            missing.append("TWILIO_PHONE_NUMBER")
        return missing

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            outbound_calls=True,
            inbound_calls=True,
            bidirectional_audio=True,
            sms=True,
            whatsapp=True,
            call_control=True,
            recording=True,
            message_status_callbacks=True,
        )

    def _auth(self) -> tuple[str, str]:
        return (self.account_sid, self.auth_token)

    async def health(self) -> dict[str, Any]:
        if not self.is_configured():
            return {
                "provider": self.name,
                "ok": False,
                "operating_mode": "disabled",
                "missing": self.missing_configuration(),
            }
        return {
            "provider": self.name,
            "ok": True,
            "operating_mode": self.operating_mode(),
            "unverified": True,
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
        if not self.is_configured():
            return CallResult(
                ok=False,
                detail=f"Twilio is not configured ({', '.join(self.missing_configuration())}).",
                mode="disabled",
            )
        data = {
            "To": to_number,
            "From": (from_number or self.from_number).strip(),
            "Url": answer_url,
            "StatusCallback": status_url,
            "StatusCallbackEvent": ["initiated", "ringing", "answered", "completed"],
            "Timeout": "25",
        }
        if record:
            data["Record"] = "true"
        url = f"{API_BASE}/Accounts/{self.account_sid}/Calls.json"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.post(url, data=data, auth=self._auth())
        except httpx.HTTPError as exc:
            return CallResult(ok=False, detail=f"Twilio request failed: {exc}")
        if response.status_code >= 400:
            return CallResult(
                ok=False,
                detail=f"Twilio rejected the call ({response.status_code}): {response.text[:300]}",
            )
        payload = response.json()
        return CallResult(
            ok=bool(payload.get("sid")),
            provider_call_id=payload.get("sid"),
            state=_map_twilio_call_status(payload.get("status")),
            accepted=True,
            detail="Twilio accepted the call request (ringing is confirmed by webhook).",
            raw=payload,
        )

    async def get_call_status(self, provider_call_id: str) -> dict[str, Any]:
        url = f"{API_BASE}/Accounts/{self.account_sid}/Calls/{provider_call_id}.json"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.get(url, auth=self._auth())
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            return {"ok": False, "state": "unknown", "detail": str(exc)}
        return {
            "ok": True,
            "provider_call_id": provider_call_id,
            "state": _map_twilio_call_status(payload.get("status")),
            "raw": payload,
        }

    async def end_call(self, provider_call_id: str) -> dict[str, Any]:
        url = f"{API_BASE}/Accounts/{self.account_sid}/Calls/{provider_call_id}.json"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.post(url, data={"Status": "completed"}, auth=self._auth())
        except httpx.HTTPError as exc:
            return {"ok": False, "detail": str(exc)}
        return {
            "ok": response.status_code < 400,
            "provider_call_id": provider_call_id,
            "state": "completed" if response.status_code < 400 else "unknown",
        }

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
        if not self.is_configured():
            return MessageResult(
                ok=False,
                detail=f"Twilio is not configured ({', '.join(self.missing_configuration())}).",
                mode="disabled",
            )
        sender = (from_number or self.messaging_number).strip()
        data = {
            "To": to_number,
            "From": sender,
            "Body": body,
            "StatusCallback": status_url,
        }
        if channel == "whatsapp":
            data["To"] = f"whatsapp:{to_number}"
            data["From"] = f"whatsapp:{sender}"
        elif channel not in {"sms", "ai", "voice"}:
            return MessageResult(ok=False, detail=f"Twilio adapter does not send '{channel}'.")
        url = f"{API_BASE}/Accounts/{self.account_sid}/Messages.json"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.post(url, data=data, auth=self._auth())
        except httpx.HTTPError as exc:
            return MessageResult(ok=False, detail=f"Twilio message request failed: {exc}")
        if response.status_code >= 400:
            return MessageResult(
                ok=False,
                detail=f"Twilio rejected the message ({response.status_code}): {response.text[:300]}",
            )
        payload = response.json()
        return MessageResult(
            ok=bool(payload.get("sid")),
            provider_message_id=payload.get("sid"),
            state=_map_twilio_message_status(payload.get("status")),
            accepted=True,
            detail="Twilio accepted the message (delivery is confirmed by callback).",
            raw=payload,
        )

    async def get_message_status(self, provider_message_id: str) -> dict[str, Any]:
        url = f"{API_BASE}/Accounts/{self.account_sid}/Messages/{provider_message_id}.json"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.get(url, auth=self._auth())
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            return {"ok": False, "state": "unknown", "detail": str(exc)}
        return {
            "ok": True,
            "provider_message_id": provider_message_id,
            "state": _map_twilio_message_status(payload.get("status")),
            "raw": payload,
        }

    # --- webhooks ------------------------------------------------------
    def verify_webhook(self, headers: dict[str, str], body: bytes, url: str) -> bool:
        lowered = {k.lower(): v for k, v in headers.items()}
        signature = lowered.get("x-twilio-signature")
        if not signature or not self.auth_token:
            return False
        parsed = urlparse(url)
        # Twilio signs the full URL including scheme/host/path but without the
        # port for the default 443. Rebuild a candidate set for both cases.
        candidates = {url}
        if ":" in parsed.netloc:
            candidates.add(f"{parsed.scheme}://{parsed.hostname}{parsed.path}")
        if parsed.query:
            candidates.add(f"{parsed.scheme}://{parsed.netloc}{parsed.path}")
        params = _parse_params(headers.get("content-type", ""), body)
        for candidate in candidates:
            signing = candidate + "".join(f"{k}{params[k]}" for k in sorted(params))
            digest = hmac.new(
                self.auth_token.encode(), signing.encode("utf-8"), hashlib.sha1
            ).digest()
            if hmac.compare_digest(base64.b64encode(digest).decode(), signature):
                return True
        return False

    def parse_event(
        self, payload: dict[str, Any], *, kind_hint: Optional[str] = None
    ) -> Optional[ProviderEvent]:
        if payload.get("MessageSid") or payload.get("SmsSid"):
            sid = payload.get("MessageSid") or payload.get("SmsSid")
            return ProviderEvent(
                event_id=f"{sid}:{payload.get('MessageStatus') or payload.get('SmsStatus')}",
                kind="message.status",
                provider=self.name,
                provider_message_id=sid,
                state=_map_twilio_message_status(
                    payload.get("MessageStatus") or payload.get("SmsStatus")
                ),
                from_number=payload.get("From"),
                to_number=payload.get("To"),
                raw=payload,
            )
        call_sid = payload.get("CallSid")
        return ProviderEvent(
            event_id=f"{call_sid}:{payload.get('CallStatus')}",
            kind=kind_hint or "call.status",
            provider=self.name,
            provider_call_id=call_sid,
            state=_map_twilio_call_status(payload.get("CallStatus")),
            direction=payload.get("Direction"),
            from_number=payload.get("From"),
            to_number=payload.get("To"),
            raw=payload,
        )


def _parse_params(content_type: str, body: bytes) -> dict[str, str]:
    if "application/json" in content_type:
        try:
            import json

            data = json.loads(body.decode("utf-8"))
            return {k: str(v) for k, v in data.items()}
        except Exception:
            return {}
    text = body.decode("utf-8", errors="replace")
    return {k: v[0] for k, v in parse_qs(text, keep_blank_values=True).items()}


def _map_twilio_call_status(status: Any) -> str:
    return {
        "queued": "queued",
        "accepted": "queued",
        "initiated": "dialing",
        "ringing": "ringing",
        "in-progress": "connected",
        "completed": "completed",
        "busy": "busy",
        "failed": "failed",
        "no-answer": "no_answer",
        "canceled": "cancelled",
    }.get(str(status or "").lower(), "unknown")


def _map_twilio_message_status(status: Any) -> str:
    return {
        "accepted": "queued",
        "queued": "queued",
        "sending": "queued",
        "sent": "sent",
        "delivered": "delivered",
        "read": "delivered",
        "failed": "failed",
        "undelivered": "undelivered",
    }.get(str(status or "").lower(), "unknown")
