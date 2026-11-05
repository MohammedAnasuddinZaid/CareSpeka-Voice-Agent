"""Provider selection.

The active provider is chosen from configuration and secrets.  The mock provider
is only ever selected explicitly or when no real provider is configured, and the
dashboard always shows the resulting operating mode so a simulated call can never
be mistaken for a real one.
"""
from __future__ import annotations

import threading
from typing import Any, Optional

from app import secrets_store
from app.config import settings
from app.telephony.base import (
    MODE_CONFIGURED_UNVERIFIED,
    MODE_DISABLED,
    MODE_LIVE,
    MODE_MOCK,
    MODE_UNAVAILABLE,
    TelephonyProvider,
)
from app.telephony.exotel import ExotelProvider
from app.telephony.mock import MockProvider
from app.telephony.twilio import TwilioProvider

_lock = threading.Lock()
_cache: dict[str, TelephonyProvider] = {}


def build_provider(name: str) -> TelephonyProvider:
    name = (name or "mock").strip().lower()
    if name == "exotel":
        return ExotelProvider(
            api_key=secrets_store.get("EXOTEL_API_KEY"),
            api_token=secrets_store.get("EXOTEL_API_TOKEN"),
            account_sid=secrets_store.get("EXOTEL_ACCOUNT_SID"),
            caller_id=secrets_store.get("EXOTEL_CALLER_ID") or settings.exotel_caller_id,
            subdomain=secrets_store.get("EXOTEL_SUBDOMAIN") or settings.exotel_subdomain,
            webhook_secret=secrets_store.get("EXOTEL_WEBHOOK_SECRET"),
            dlt_entity_id=secrets_store.get("EXOTEL_DLT_ENTITY_ID") or settings.exotel_dlt_entity_id,
            dlt_template_id=secrets_store.get("EXOTEL_DLT_TEMPLATE_ID")
            or settings.exotel_dlt_template_id,
            sender_id=settings.exotel_sender_id,
            timeout_s=settings.telephony_request_timeout_s,
        )
    if name == "twilio":
        return TwilioProvider(
            account_sid=secrets_store.get("TWILIO_ACCOUNT_SID"),
            auth_token=secrets_store.get("TWILIO_AUTH_TOKEN"),
            from_number=secrets_store.get("TWILIO_PHONE_NUMBER") or settings.twilio_phone_number,
            messaging_number=secrets_store.get("TWILIO_MESSAGING_NUMBER")
            or settings.twilio_messaging_number,
            webhook_base_url=secrets_store.get("TWILIO_WEBHOOK_BASE_URL")
            or settings.webhook_base_url,
            timeout_s=settings.telephony_request_timeout_s,
        )
    return MockProvider()


def resolve_name(configured: Optional[str] = None) -> str:
    requested = (configured or settings.telephony_provider or "auto").strip().lower()
    if requested in {"exotel", "twilio", "mock"}:
        return requested
    # auto: prefer a real provider whose credentials are present.
    for candidate in ("exotel", "twilio"):
        provider = build_provider(candidate)
        if provider.is_configured():
            return candidate
    return "mock"


def get_provider(name: Optional[str] = None) -> TelephonyProvider:
    resolved = resolve_name(name)
    with _lock:
        if resolved not in _cache:
            _cache[resolved] = build_provider(resolved)
        return _cache[resolved]


def reset_cache() -> None:
    with _lock:
        _cache.clear()


def active_mode() -> str:
    if not settings.telephony_enabled:
        return MODE_DISABLED
    provider = get_provider()
    if provider.mode.value == "mock":
        return MODE_MOCK
    if not provider.is_configured():
        return MODE_DISABLED
    return MODE_CONFIGURED_UNVERIFIED


def provider_summary() -> dict[str, Any]:
    """Everything the dashboard needs to describe the current telephony mode."""
    active = get_provider()
    available = []
    for name in ("exotel", "twilio", "mock"):
        provider = build_provider(name)
        available.append(
            {
                "provider": name,
                "configured": provider.is_configured(),
                "mode": provider.mode.value,
                "operating_mode": provider.operating_mode(),
                "missing": provider.missing_configuration(),
                "capabilities": provider.capabilities().to_dict(),
            }
        )
    summary = active.describe()
    summary["telephony_enabled"] = settings.telephony_enabled
    summary["requested"] = settings.telephony_provider
    summary["resolved"] = active.name
    summary["available"] = available
    summary["webhook_base_url"] = settings.webhook_base_url or settings.public_base_url
    summary["public_base_url"] = settings.public_base_url
    summary["secrets"] = secrets_store.secret_status()
    summary["mode_label"] = _mode_label(summary.get("operating_mode"))
    return summary


def _mode_label(mode: Optional[str]) -> str:
    return {
        MODE_LIVE: "Live carrier connected",
        MODE_CONFIGURED_UNVERIFIED: "Provider configured - not yet verified with a real call",
        MODE_MOCK: "Simulated (mock) - no real telephone call is placed",
        MODE_UNAVAILABLE: "Provider unavailable",
        MODE_DISABLED: "Calls disabled - credentials or compliance missing",
    }.get(mode or "", "Unknown telephony mode")
