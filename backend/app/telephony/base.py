"""The provider interface every telephony adapter implements.

Nothing outside :mod:`app.telephony` imports a carrier SDK or HTTP client.  The
service layer talks only to :class:`TelephonyProvider`, which keeps the mock and
the real adapters interchangeable and testable.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

from app.telephony.audio import AudioFormat
from app.telephony.models import ProviderMode

#: UI-facing operating states.  The dashboard renders these strings verbatim so
#: a human can never mistake a mock for a live carrier.
MODE_LIVE = "live"
MODE_CONFIGURED_UNVERIFIED = "configured-unverified"
MODE_MOCK = "mock"
MODE_UNAVAILABLE = "unavailable"
MODE_DISABLED = "disabled"


@dataclass
class ProviderCapabilities:
    outbound_calls: bool = False
    inbound_calls: bool = False
    bidirectional_audio: bool = False
    sms: bool = False
    whatsapp: bool = False
    call_control: bool = False
    recording: bool = False
    message_status_callbacks: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "outbound_calls": self.outbound_calls,
            "inbound_calls": self.inbound_calls,
            "bidirectional_audio": self.bidirectional_audio,
            "sms": self.sms,
            "whatsapp": self.whatsapp,
            "call_control": self.call_control,
            "recording": self.recording,
            "message_status_callbacks": self.message_status_callbacks,
        }


@dataclass
class CallResult:
    ok: bool
    provider_call_id: Optional[str] = None
    state: str = "created"
    detail: str = ""
    raw: dict[str, Any] = field(default_factory=dict)
    accepted: bool = False  # provider accepted the request (not proof of delivery)
    mode: str = ProviderMode.REAL.value


@dataclass
class MessageResult:
    ok: bool
    provider_message_id: Optional[str] = None
    state: str = "created"
    detail: str = ""
    raw: dict[str, Any] = field(default_factory=dict)
    accepted: bool = False
    mode: str = ProviderMode.REAL.value


@dataclass
class ProviderEvent:
    """A single normalised event derived from a provider webhook or stream."""

    event_id: str
    kind: str  # call.status | call.answered | call.ended | message.status | media.start | media.stop | ...
    provider: str
    provider_call_id: Optional[str] = None
    provider_message_id: Optional[str] = None
    state: Optional[str] = None
    direction: Optional[str] = None
    from_number: Optional[str] = None
    to_number: Optional[str] = None
    detail: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


class ProviderNotConfigured(RuntimeError):
    """Raised when a real provider is selected but its credentials are missing."""

    def __init__(self, provider: str, missing: list[str]) -> None:
        super().__init__(
            f"Provider '{provider}' is not configured. Missing: {', '.join(missing)}."
        )
        self.provider = provider
        self.missing = missing


class TelephonyProvider(ABC):
    """Common interface for real and mock telephony adapters."""

    name: str = "unknown"
    mode: ProviderMode = ProviderMode.REAL
    media_format: AudioFormat = AudioFormat()

    # --- configuration -------------------------------------------------
    @abstractmethod
    def is_configured(self) -> bool:
        ...

    @abstractmethod
    def missing_configuration(self) -> list[str]:
        ...

    @abstractmethod
    def capabilities(self) -> ProviderCapabilities:
        ...

    def operating_mode(self) -> str:
        """Return one of the MODE_* strings for honest UI display."""
        if not self.is_configured():
            return MODE_DISABLED if self.mode == ProviderMode.REAL else MODE_MOCK
        if self.mode == ProviderMode.MOCK:
            return MODE_MOCK
        return MODE_CONFIGURED_UNVERIFIED

    def describe(self) -> dict[str, Any]:
        return {
            "provider": self.name,
            "mode": self.mode.value,
            "operating_mode": self.operating_mode(),
            "configured": self.is_configured(),
            "missing": self.missing_configuration(),
            "capabilities": self.capabilities().to_dict(),
            "media": {
                "encoding": self.media_format.encoding,
                "sample_rate": self.media_format.sample_rate,
                "frame_ms": self.media_format.frame_ms,
            },
        }

    # --- calls ---------------------------------------------------------
    @abstractmethod
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
        ...

    @abstractmethod
    async def get_call_status(self, provider_call_id: str) -> dict[str, Any]:
        ...

    @abstractmethod
    async def end_call(self, provider_call_id: str) -> dict[str, Any]:
        ...

    # --- messages ------------------------------------------------------
    @abstractmethod
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
        ...

    @abstractmethod
    async def get_message_status(self, provider_message_id: str) -> dict[str, Any]:
        ...

    # --- webhooks ------------------------------------------------------
    @abstractmethod
    def verify_webhook(self, headers: dict[str, str], body: bytes, url: str) -> bool:
        ...

    @abstractmethod
    def parse_event(
        self, payload: dict[str, Any], *, kind_hint: Optional[str] = None
    ) -> Optional[ProviderEvent]:
        ...

    # --- health --------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        return {
            "provider": self.name,
            "ok": self.is_configured(),
            "operating_mode": self.operating_mode(),
        }
