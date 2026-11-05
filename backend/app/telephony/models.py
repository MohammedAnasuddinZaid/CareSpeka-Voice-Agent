"""Explicit, persistent state machines for the telephony platform.

Every lifecycle in the product (calls, messages, verification challenges, family
requests, escalations, scheduled jobs) is modelled as a finite state machine with
an allow-listed transition table.  Ad-hoc booleans are avoided so duplicate and
out-of-order provider events can be rejected deterministically.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class CallDirection(str, Enum):
    OUTBOUND = "outbound"
    INBOUND = "inbound"


class CallState(str, Enum):
    CREATED = "created"
    QUEUED = "queued"
    DIALING = "dialing"
    RINGING = "ringing"
    ANSWERED = "answered"
    CONNECTED = "connected"
    COMPLETED = "completed"
    BUSY = "busy"
    NO_ANSWER = "no_answer"
    REJECTED = "rejected"
    FAILED = "failed"
    CANCELLED = "cancelled"
    DISCONNECTED = "disconnected"
    PROVIDER_TIMEOUT = "provider_timeout"


CALL_TERMINAL_STATES = {
    CallState.COMPLETED,
    CallState.BUSY,
    CallState.NO_ANSWER,
    CallState.REJECTED,
    CallState.FAILED,
    CallState.CANCELLED,
    CallState.DISCONNECTED,
    CallState.PROVIDER_TIMEOUT,
}

CALL_TRANSITIONS: dict[CallState, set[CallState]] = {
    CallState.CREATED: {CallState.QUEUED, CallState.DIALING, CallState.FAILED, CallState.CANCELLED},
    CallState.QUEUED: {
        CallState.DIALING,
        CallState.RINGING,
        CallState.FAILED,
        CallState.BUSY,
        CallState.NO_ANSWER,
        CallState.CANCELLED,
        CallState.PROVIDER_TIMEOUT,
    },
    CallState.DIALING: {
        CallState.RINGING,
        CallState.ANSWERED,
        CallState.CONNECTED,
        CallState.BUSY,
        CallState.NO_ANSWER,
        CallState.FAILED,
        CallState.REJECTED,
        CallState.CANCELLED,
        CallState.PROVIDER_TIMEOUT,
    },
    CallState.RINGING: {
        CallState.ANSWERED,
        CallState.CONNECTED,
        CallState.BUSY,
        CallState.NO_ANSWER,
        CallState.REJECTED,
        CallState.FAILED,
        CallState.CANCELLED,
        CallState.PROVIDER_TIMEOUT,
    },
    CallState.ANSWERED: {CallState.CONNECTED, CallState.COMPLETED, CallState.DISCONNECTED, CallState.FAILED},
    CallState.CONNECTED: {CallState.COMPLETED, CallState.DISCONNECTED, CallState.FAILED},
    CallState.COMPLETED: set(),
    CallState.BUSY: set(),
    CallState.NO_ANSWER: {CallState.QUEUED},  # an explicit retry re-queues the record
    CallState.REJECTED: set(),
    CallState.FAILED: {CallState.QUEUED},  # retry policy may re-queue a failed call
    CallState.CANCELLED: set(),
    CallState.DISCONNECTED: set(),
    CallState.PROVIDER_TIMEOUT: {CallState.QUEUED},
}


class MessageState(str, Enum):
    CREATED = "created"
    QUEUED = "queued"
    SENT = "sent"
    DELIVERED = "delivered"
    FAILED = "failed"
    UNDELIVERED = "undelivered"
    UNKNOWN = "unknown"


MESSAGE_TERMINAL_STATES = {
    MessageState.DELIVERED,
    MessageState.FAILED,
    MessageState.UNDELIVERED,
    MessageState.UNKNOWN,
}

MESSAGE_TRANSITIONS: dict[MessageState, set[MessageState]] = {
    MessageState.CREATED: {MessageState.QUEUED, MessageState.SENT, MessageState.FAILED, MessageState.UNKNOWN},
    MessageState.QUEUED: {MessageState.SENT, MessageState.FAILED, MessageState.UNDELIVERED, MessageState.UNKNOWN},
    MessageState.SENT: {MessageState.DELIVERED, MessageState.FAILED, MessageState.UNDELIVERED, MessageState.UNKNOWN},
    MessageState.DELIVERED: set(),
    MessageState.FAILED: set(),
    MessageState.UNDELIVERED: set(),
    MessageState.UNKNOWN: {MessageState.DELIVERED, MessageState.FAILED, MessageState.UNDELIVERED, MessageState.SENT},
}


class MessageChannel(str, Enum):
    SMS = "sms"
    VOICE = "voice"
    AI = "ai"
    WHATSAPP = "whatsapp"


class EscalationSeverity(str, Enum):
    ROUTINE = "routine"
    FOLLOW_UP = "follow_up"
    URGENT = "urgent"
    EMERGENCY = "emergency"


SEVERITY_RANK = {
    EscalationSeverity.ROUTINE: 0,
    EscalationSeverity.FOLLOW_UP: 1,
    EscalationSeverity.URGENT: 2,
    EscalationSeverity.EMERGENCY: 3,
}


class EscalationState(str, Enum):
    OPEN = "open"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"
    CANCELLED = "cancelled"


ESCALATION_TRANSITIONS: dict[EscalationState, set[EscalationState]] = {
    EscalationState.OPEN: {EscalationState.ACKNOWLEDGED, EscalationState.RESOLVED, EscalationState.CANCELLED},
    EscalationState.ACKNOWLEDGED: {EscalationState.RESOLVED, EscalationState.CANCELLED},
    EscalationState.RESOLVED: set(),
    EscalationState.CANCELLED: set(),
}


class VerificationState(str, Enum):
    PENDING = "pending"
    VERIFIED = "verified"
    FAILED = "failed"
    EXPIRED = "expired"


class VerificationPurpose(str, Enum):
    CONTACT_OWNERSHIP = "contact_ownership"
    FAMILY_ACCESS = "family_access"
    SENSITIVE_ACTION = "sensitive_action"


class FamilyRequestState(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    EXPIRED = "expired"
    FULFILLED = "fulfilled"
    REVOKED = "revoked"


FAMILY_REQUEST_TRANSITIONS: dict[FamilyRequestState, set[FamilyRequestState]] = {
    FamilyRequestState.PENDING: {
        FamilyRequestState.APPROVED,
        FamilyRequestState.DENIED,
        FamilyRequestState.EXPIRED,
        FamilyRequestState.REVOKED,
    },
    FamilyRequestState.APPROVED: {FamilyRequestState.FULFILLED, FamilyRequestState.EXPIRED, FamilyRequestState.REVOKED},
    FamilyRequestState.FULFILLED: {FamilyRequestState.REVOKED},
    FamilyRequestState.DENIED: set(),
    FamilyRequestState.EXPIRED: set(),
    FamilyRequestState.REVOKED: set(),
}


class JobState(str, Enum):
    PENDING = "pending"
    LEASED = "leased"
    DONE = "done"
    FAILED = "failed"
    DEAD = "dead"
    CANCELLED = "cancelled"


class ContactRole(str, Enum):
    PATIENT = "patient"
    PRIMARY_NURSE = "primary_nurse"
    BACKUP_NURSE = "primary_nurse_backup"
    FAMILY = "family"
    ADMIN = "admin"


class UserRole(str, Enum):
    ADMIN = "admin"
    NURSE = "nurse"
    PATIENT = "patient"
    FAMILY = "family"


class ProviderMode(str, Enum):
    REAL = "real"
    MOCK = "mock"


@dataclass
class TransitionResult:
    ok: bool
    previous: str
    current: str
    reason: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "previous": self.previous, "current": self.current, "reason": self.reason}


def _coerce(enum_cls: Any, value: Any) -> Any:
    if isinstance(value, enum_cls):
        return value
    return enum_cls(str(value))


def can_transition_call(current: str, target: str) -> bool:
    try:
        cur = _coerce(CallState, current)
        tgt = _coerce(CallState, target)
    except ValueError:
        return False
    if cur == tgt:
        return True
    return tgt in CALL_TRANSITIONS.get(cur, set())


def transition_call(current: str, target: str) -> TransitionResult:
    cur = _coerce(CallState, current)
    tgt = _coerce(CallState, target)
    if cur == tgt:
        return TransitionResult(True, cur.value, tgt.value, "noop")
    if tgt in CALL_TRANSITIONS.get(cur, set()):
        return TransitionResult(True, cur.value, tgt.value)
    return TransitionResult(False, cur.value, tgt.value, "illegal_transition")


def transition_message(current: str, target: str) -> TransitionResult:
    cur = _coerce(MessageState, current)
    tgt = _coerce(MessageState, target)
    if cur == tgt:
        return TransitionResult(True, cur.value, tgt.value, "noop")
    if tgt in MESSAGE_TRANSITIONS.get(cur, set()):
        return TransitionResult(True, cur.value, tgt.value)
    return TransitionResult(False, cur.value, tgt.value, "illegal_transition")


def transition_escalation(current: str, target: str) -> TransitionResult:
    cur = _coerce(EscalationState, current)
    tgt = _coerce(EscalationState, target)
    if cur == tgt:
        return TransitionResult(True, cur.value, tgt.value, "noop")
    if tgt in ESCALATION_TRANSITIONS.get(cur, set()):
        return TransitionResult(True, cur.value, tgt.value)
    return TransitionResult(False, cur.value, tgt.value, "illegal_transition")


def transition_family_request(current: str, target: str) -> TransitionResult:
    cur = _coerce(FamilyRequestState, current)
    tgt = _coerce(FamilyRequestState, target)
    if cur == tgt:
        return TransitionResult(True, cur.value, tgt.value, "noop")
    if tgt in FAMILY_REQUEST_TRANSITIONS.get(cur, set()):
        return TransitionResult(True, cur.value, tgt.value)
    return TransitionResult(False, cur.value, tgt.value, "illegal_transition")


def is_call_terminal(state: str) -> bool:
    try:
        return _coerce(CallState, state) in CALL_TERMINAL_STATES
    except ValueError:
        return True


def severity_at_least(value: str, threshold: str) -> bool:
    try:
        return SEVERITY_RANK[_coerce(EscalationSeverity, value)] >= SEVERITY_RANK[
            _coerce(EscalationSeverity, threshold)
        ]
    except (ValueError, KeyError):
        return False
