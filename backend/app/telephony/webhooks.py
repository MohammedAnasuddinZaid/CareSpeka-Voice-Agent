"""Webhook authenticity, replay protection and idempotency helpers.

Providers retry webhooks and may deliver them out of order.  This module:

* verifies the provider's request signature (fail-closed when unconfigured),
* normalises the payload into a :class:`ProviderEvent`,
* keeps a bounded replay window of recently seen event ids, and
* derives stable idempotency keys so a retried call/message creation cannot
  create a second record.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from collections import OrderedDict
from typing import Any, Optional
from urllib.parse import parse_qs

from app.telephony.base import ProviderEvent, TelephonyProvider


class WebhookRejected(Exception):
    def __init__(self, code: str, message: str, status_code: int = 401) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def parse_body(content_type: str, body: bytes) -> dict[str, Any]:
    """Parse a webhook body as JSON or form-encoded data."""
    text = body.decode("utf-8", errors="replace")
    if "application/json" in (content_type or ""):
        try:
            data = json.loads(text or "{}")
            return data if isinstance(data, dict) else {"_value": data}
        except json.JSONDecodeError:
            return {}
    if "form-urlencoded" in (content_type or "") or "=" in text:
        return {k: (v[0] if v else "") for k, v in parse_qs(text, keep_blank_values=True).items()}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {"_value": data}
    except json.JSONDecodeError:
        return {}


def verify(
    provider: TelephonyProvider,
    headers: dict[str, str],
    body: bytes,
    url: str,
) -> None:
    """Raise :class:`WebhookRejected` unless the request is authentic."""
    if not provider.verify_webhook(headers, body, url):
        raise WebhookRejected(
            "invalid_signature",
            "Webhook signature could not be verified for this provider.",
        )


def extract_event(
    provider: TelephonyProvider,
    headers: dict[str, str],
    body: bytes,
    url: str,
    *,
    kind_hint: Optional[str] = None,
) -> ProviderEvent:
    verify(provider, headers, body, url)
    content_type = headers.get("content-type", headers.get("Content-Type", ""))
    payload = parse_body(content_type, body)
    event = provider.parse_event(payload, kind_hint=kind_hint)
    if event is None:
        raise WebhookRejected("unhandled_event", "The provider event was not understood.", 202)
    if not event.event_id:
        event.event_id = hashlib.sha256(body).hexdigest()
    return event


class ReplayGuard:
    """Bounded, thread-safe record of recently processed webhook event ids."""

    def __init__(self, max_entries: int = 4096, ttl_seconds: float = 3600.0) -> None:
        self.max_entries = max_entries
        self.ttl_seconds = ttl_seconds
        self._seen: "OrderedDict[str, float]" = OrderedDict()
        self._lock = threading.Lock()

    def _purge(self, now: float) -> None:
        while self._seen:
            key, stamp = next(iter(self._seen.items()))
            if now - stamp > self.ttl_seconds:
                self._seen.pop(key, None)
            else:
                break

    def seen(self, event_id: str) -> bool:
        if not event_id:
            return False
        now = time.monotonic()
        with self._lock:
            self._purge(now)
            if event_id in self._seen:
                return True
            self._seen[event_id] = now
            while len(self._seen) > self.max_entries:
                self._seen.popitem(last=False)
            return False


def idempotency_key(*parts: Any) -> str:
    """Deterministic key derived from stable inputs, never from wall-clock time."""
    material = "|".join("" if part is None else str(part) for part in parts)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:40]


def signature_for(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
