"""Real Exotel adapter (India-first carrier).

Implemented against the published Exotel developer documentation:

* ``POST /v1/Accounts/{AccountSid}/Calls/connect`` - outbound call + bidirectional
  AgentStream (``StreamType=bidirectional``).
* ``POST /v1/Accounts/{AccountSid}/Sms/send`` - SMS (India requires DLT ids).
* AgentStream media WebSocket - raw 16-bit little-endian PCM, base64, default
  8 kHz (``?sample-rate=`` may request 8000/16000/24000).

Authentication is HTTP Basic (API Key : API Token).  Base URL is
``https://api.in.exotel.com`` for India and ``https://api.exotel.com`` for the
Singapore region.

Field names follow the published docs.  When real credentials are available the
first live run should re-confirm the response field names against the account, as
noted in ``TELEPHONY_SETUP.md``.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Optional
from urllib.parse import parse_qs, urlencode, urlparse

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


class ExotelProvider(TelephonyProvider):
    name = "exotel"
    mode = ProviderMode.REAL
    # Exotel AgentStream streams raw linear PCM (audio/x-raw), not G.711.
    media_format = AudioFormat(encoding="pcm16", sample_rate=8000, frame_ms=20)
    # Exotel's protocol uses snake_case ``stream_sid``.
    stream_id_field = "stream_sid"
    # Exotel requires each outbound media chunk to be 3200-100000 bytes and a
    # multiple of 320.  Batch 20 ms frames (320 bytes) into 100 ms (3200 bytes).
    outbound_chunk_bytes = 3200

    def __init__(
        self,
        *,
        api_key: str = "",
        api_token: str = "",
        account_sid: str = "",
        caller_id: str = "",
        subdomain: str = "api.in.exotel.com",
        webhook_secret: str = "",
        dlt_entity_id: str = "",
        dlt_template_id: str = "",
        sender_id: str = "EXOTEL",
        timeout_s: float = 20.0,
    ) -> None:
        self.api_key = (api_key or "").strip()
        self.api_token = (api_token or "").strip()
        self.account_sid = (account_sid or "").strip()
        self.caller_id = (caller_id or "").strip()
        self.subdomain = (subdomain or "api.in.exotel.com").strip()
        self.webhook_secret = (webhook_secret or "").strip()
        self.dlt_entity_id = (dlt_entity_id or "").strip()
        self.dlt_template_id = (dlt_template_id or "").strip()
        self.sender_id = (sender_id or "EXOTEL").strip()
        self.timeout_s = timeout_s

    # --- config --------------------------------------------------------
    def is_configured(self) -> bool:
        return bool(
            self.api_key
            and self.api_token
            and self.account_sid
            and self.caller_id
            and self.webhook_secret
        )

    def missing_configuration(self) -> list[str]:
        missing = []
        if not self.api_key:
            missing.append("EXOTEL_API_KEY")
        if not self.api_token:
            missing.append("EXOTEL_API_TOKEN")
        if not self.account_sid:
            missing.append("EXOTEL_ACCOUNT_SID")
        if not self.caller_id:
            missing.append("EXOTEL_CALLER_ID")
        if not self.webhook_secret:
            # Exotel does not sign callbacks, so VoiceLink requires a shared
            # token in the callback URL.  Without it every webhook would be
            # (correctly) rejected, so the adapter must not report itself as
            # ready.
            missing.append("EXOTEL_WEBHOOK_SECRET")
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

    @property
    def base_url(self) -> str:
        return f"https://{self.subdomain}"

    def _auth(self) -> tuple[str, str]:
        return (self.api_key, self.api_token)

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
            "base_url": self.base_url,
            "region": "IN" if ".in." in self.subdomain else "SG",
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
                detail=f"Exotel is not configured ({', '.join(self.missing_configuration())}).",
                mode="disabled",
            )
        caller_id = (from_number or self.caller_id).strip()
        data: list[tuple[str, str]] = [
            ("From", to_number),
            ("CallerId", caller_id),
            ("StreamUrl", stream_url),
            ("StreamType", "bidirectional"),
            ("StatusCallback", status_url),
            ("StatusCallbackEvents[]", "answered"),
            ("StatusCallbackEvents[]", "terminal"),
            ("StatusCallbackEvents[]", "ringing"),
        ]
        if record:
            data.append(("Record", "true"))
        custom = ""
        if metadata:
            custom = str(metadata.get("call_record_id") or metadata.get("id") or "")[:128]
        if custom:
            data.append(("CustomField", custom))

        url = f"{self.base_url}/v1/Accounts/{self.account_sid}/Calls/connect"
        # ``data`` must be a mapping or httpx treats a list of pairs as raw
        # content (which produces a synchronous stream and breaks AsyncClient).
        # Encode the repeated StatusCallbackEvents[] fields explicitly instead.
        payload_body = urlencode(data).encode("utf-8")
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.post(
                    url,
                    content=payload_body,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    auth=self._auth(),
                )
        except httpx.HTTPError as exc:
            return CallResult(ok=False, detail=f"Exotel request failed: {exc}", mode="error")
        if response.status_code >= 400:
            return CallResult(
                ok=False,
                detail=f"Exotel rejected the call ({response.status_code}): {response.text[:300]}",
                raw={"status_code": response.status_code},
            )
        try:
            payload = response.json()
        except ValueError:
            return CallResult(ok=False, detail="Exotel returned a non-JSON response.")
        call = payload.get("Call") or payload
        sid = call.get("Sid") or call.get("sid")
        # Exotel's connect response can say "in-progress" before the callee has
        # answered.  Only webhooks may advance the call beyond "queued", so the
        # dashboard never reports an answer that did not happen.
        return CallResult(
            ok=bool(sid),
            provider_call_id=sid,
            state="queued",
            accepted=True,
            detail="Exotel accepted the call request (ringing is confirmed by webhook).",
            raw=payload,
        )

    async def get_call_status(self, provider_call_id: str) -> dict[str, Any]:
        url = f"{self.base_url}/v1/Accounts/{self.account_sid}/Calls/{provider_call_id}.json"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.get(url, auth=self._auth())
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            return {"ok": False, "state": "unknown", "detail": str(exc)}
        call = payload.get("Call") or payload
        return {
            "ok": True,
            "provider_call_id": provider_call_id,
            "state": _map_exotel_call_status(call.get("Status")),
            "raw": payload,
        }

    async def end_call(self, provider_call_id: str) -> dict[str, Any]:
        url = f"{self.base_url}/v1/Accounts/{self.account_sid}/Calls/{provider_call_id}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.post(
                    url, data={"Status": "completed"}, auth=self._auth()
                )
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
                detail=f"Exotel is not configured ({', '.join(self.missing_configuration())}).",
                mode="disabled",
            )
        if channel not in {"sms", "whatsapp"}:
            return MessageResult(
                ok=False, detail=f"Exotel adapter does not send the '{channel}' channel."
            )
        data = {
            "From": (from_number or self.sender_id).strip(),
            "To": to_number,
            "Body": body,
            "StatusCallback": status_url,
        }
        if self.dlt_entity_id:
            data["DltEntityId"] = self.dlt_entity_id
        if self.dlt_template_id:
            data["DltTemplateId"] = self.dlt_template_id
        url = f"{self.base_url}/v1/Accounts/{self.account_sid}/Sms/send"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.post(url, data=data, auth=self._auth())
        except httpx.HTTPError as exc:
            return MessageResult(ok=False, detail=f"Exotel SMS request failed: {exc}")
        if response.status_code >= 400:
            return MessageResult(
                ok=False,
                detail=f"Exotel rejected the SMS ({response.status_code}): {response.text[:300]}",
            )
        try:
            payload = response.json()
        except ValueError:
            return MessageResult(ok=False, detail="Exotel returned a non-JSON response.")
        message = payload.get("SMSMessage") or payload
        sid = message.get("Sid") or message.get("sid")
        return MessageResult(
            ok=bool(sid),
            provider_message_id=sid,
            state="queued",
            accepted=True,
            detail="Exotel accepted the SMS (delivery is confirmed by callback).",
            raw=payload,
        )

    async def get_message_status(self, provider_message_id: str) -> dict[str, Any]:
        url = (
            f"{self.base_url}/v1/Accounts/{self.account_sid}/SMS/Messages/"
            f"{provider_message_id}.json"
        )
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.get(url, auth=self._auth())
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            return {"ok": False, "state": "unknown", "detail": str(exc)}
        message = payload.get("SMSMessage") or payload
        detailed = message.get("DetailedStatus") or message.get("Status")
        return {
            "ok": True,
            "provider_message_id": provider_message_id,
            "state": _map_exotel_sms_status(detailed),
            "raw": payload,
        }

    # --- webhooks ------------------------------------------------------
    def verify_webhook(self, headers: dict[str, str], body: bytes, url: str) -> bool:
        """Exotel webhooks are authenticated with a shared secret.

        Exotel does not publish a request signature, so VoiceLink appends a
        secret token to the callback URL and re-checks it here in constant time.
        Additionally, a custom ``X-VoiceLink-Signature`` HMAC header is accepted
        when an operator configures Exotel to add it.
        """
        if not self.webhook_secret:
            return False
        lowered = {k.lower(): v for k, v in headers.items()}
        hmac_header = lowered.get("x-voicelink-signature")
        if hmac_header:
            expected = hmac.new(
                self.webhook_secret.encode(), body, hashlib.sha256
            ).hexdigest()
            return hmac.compare_digest(expected, hmac_header.strip())
        query = parse_qs(urlparse(url).query)
        token = (query.get("token") or [""])[0] or lowered.get("x-voicelink-token", "")
        return hmac.compare_digest(self.webhook_secret, token)

    def parse_event(
        self, payload: dict[str, Any], *, kind_hint: Optional[str] = None
    ) -> Optional[ProviderEvent]:
        status = payload.get("Status") or payload.get("status")
        call_sid = payload.get("CallSid") or payload.get("call_sid") or payload.get("Sid")
        sms_sid = payload.get("SmsSid") or payload.get("SMSMessage", {}).get("Sid")
        if sms_sid:
            return ProviderEvent(
                event_id=str(payload.get("EventId") or sms_sid),
                kind="message.status",
                provider=self.name,
                provider_message_id=sms_sid,
                state=_map_exotel_sms_status(
                    payload.get("DetailedStatus") or payload.get("Status")
                ),
                from_number=payload.get("From"),
                to_number=payload.get("To"),
                raw=payload,
            )
        return ProviderEvent(
            event_id=str(payload.get("EventId") or f"{call_sid}:{status}"),
            kind=kind_hint or "call.status",
            provider=self.name,
            provider_call_id=call_sid,
            state=_map_exotel_call_status(status),
            direction=payload.get("Direction"),
            from_number=payload.get("From"),
            to_number=payload.get("To"),
            detail=str(payload.get("ErrorCode") or ""),
            raw=payload,
        )


def _map_exotel_call_status(status: Any) -> str:
    value = str(status or "").strip().lower()
    return {
        "queued": "queued",
        "in-progress": "connected",
        "in_progress": "connected",
        "ringing": "ringing",
        "answered": "answered",
        "completed": "completed",
        "failed": "failed",
        "busy": "busy",
        "no-answer": "no_answer",
        "no_answer": "no_answer",
        "canceled": "cancelled",
        "cancelled": "cancelled",
    }.get(value, "queued" if not value else "provider_timeout")


def _map_exotel_sms_status(status: Any) -> str:
    value = str(status or "").strip().lower()
    return {
        "queued": "queued",
        "sent": "sent",
        "submitted": "sent",
        "delivered_to_handset": "delivered",
        "delivered": "delivered",
        "failed": "failed",
        "undelivered": "undelivered",
        "rejected": "failed",
        "invalid": "failed",
    }.get(value, "unknown")
