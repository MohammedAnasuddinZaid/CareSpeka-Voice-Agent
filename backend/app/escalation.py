"""Deterministic escalation engine.

Emergency classification never depends on a language model alone.  It combines:

1. explicit clinical phrase rules (the same conservative patterns the browser
   demo already used), with negation handling;
2. a bounded language-model *hint* that can only ever raise severity, never
   lower it, and only within an allow-listed vocabulary;
3. a confirmation step for ambiguous cases raised by a hint alone; and
4. a deterministic policy that maps the result to a severity and an action plan.

The mapping from severity to *actions* lives in :mod:`app.telephony.service`; this
module only decides *what the situation is*.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from app.security import detect_emergency
from app.telephony.models import EscalationSeverity, SEVERITY_RANK

# Categories that must go straight to the emergency tier.
EMERGENCY_CATEGORIES = {
    "cardiac",
    "breathing",
    "stroke",
    "bleeding",
    "consciousness",
    "self_harm",
}

_URGENT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "severe_pain",
        re.compile(
            r"\b(severe|unbearable|excruciating|worst ever|10 out of 10)\s+(pain|ache|headache)\b"
            r"|\b(pain|ache)\s+(is\s+)?(severe|unbearable|getting worse|getting really bad)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "fall",
        re.compile(r"\b(i (just )?fell|fell down|had a fall|collapsed)\b", re.IGNORECASE),
    ),
    (
        "high_fever",
        re.compile(r"\b(high fever|very high temperature|fever (of|at) 10[2-9])\b", re.IGNORECASE),
    ),
    (
        "vomiting_blood",
        re.compile(r"\b(vomiting blood|throwing up blood|blood in my vomit)\b", re.IGNORECASE),
    ),
    (
        "cannot_walk",
        re.compile(
            r"\b(can'?t|cannot|can not)\s+(walk|move|get up)"
            r"|\b(unable to (walk|move|stand))\b",
            re.IGNORECASE,
        ),
    ),
    (
        "very_dizzy",
        re.compile(r"\b(very dizzy|really dizzy|room is spinning|about to faint)\b", re.IGNORECASE),
    ),
]

_FOLLOWUP_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("worsening", re.compile(r"\b(getting worse|feeling worse|more pain|pain is back|not improving)\b", re.IGNORECASE)),
    ("worry", re.compile(r"\b(i'?m worried|i am worried|something feels wrong|not feeling right)\b", re.IGNORECASE)),
    ("missed_medication", re.compile(r"\b(missed my (medicine|medication|tablet|dose)|forgot to take)\b", re.IGNORECASE)),
    ("side_effect", re.compile(r"\b(rash|swelling|swollen|allergic|reaction to)\b", re.IGNORECASE)),
]

# Bounded vocabulary the optional LLM classifier is allowed to use.
LLM_ALLOWED_LABELS = {"routine", "follow_up", "urgent", "emergency"}


@dataclass
class EscalationDecision:
    severity: EscalationSeverity
    category: str
    reason: str
    source: str  # rules | rules+llm | llm_hint
    requires_confirmation: bool = False
    matched_terms: list[str] = field(default_factory=list)
    confirmation_question: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "severity": self.severity.value,
            "category": self.category,
            "reason": self.reason,
            "source": self.source,
            "requires_confirmation": self.requires_confirmation,
            "matched_terms": self.matched_terms,
            "confirmation_question": self.confirmation_question,
        }


def _severity_from_label(label: str) -> Optional[EscalationSeverity]:
    label = (label or "").strip().lower()
    if label not in LLM_ALLOWED_LABELS:
        return None
    return EscalationSeverity(label)


def classify(text: str, *, llm_hint: Optional[str] = None) -> EscalationDecision:
    """Return the escalation decision for a patient utterance."""
    clean = (text or "").strip()

    emergency_category = detect_emergency(clean)
    if emergency_category:
        return EscalationDecision(
            severity=EscalationSeverity.EMERGENCY,
            category=emergency_category,
            reason=f"Explicit emergency phrasing detected ({emergency_category.replace('_', ' ')}).",
            source="rules",
            requires_confirmation=False,
            matched_terms=[emergency_category],
        )

    for category, pattern in _URGENT_PATTERNS:
        match = pattern.search(clean)
        if match:
            return EscalationDecision(
                severity=EscalationSeverity.URGENT,
                category=category,
                reason=f"Urgent symptom phrasing detected ({category.replace('_', ' ')}).",
                source="rules",
                requires_confirmation=False,
                matched_terms=[match.group(0)],
            )

    for category, pattern in _FOLLOWUP_PATTERNS:
        match = pattern.search(clean)
        if match:
            return EscalationDecision(
                severity=EscalationSeverity.FOLLOW_UP,
                category=category,
                reason=f"Follow-up phrasing detected ({category.replace('_', ' ')}).",
                source="rules",
                requires_confirmation=False,
                matched_terms=[match.group(0)],
            )

    hinted = _severity_from_label(llm_hint or "")
    if hinted and hinted != EscalationSeverity.ROUTINE:
        # The model is used only as a bounded hint and only to raise awareness.
        # Because no explicit clinical phrase corroborates it, we require a
        # spoken confirmation before any escalation action is taken.
        return EscalationDecision(
            severity=hinted,
            category="llm_reported",
            reason="The conversation suggested a concern; confirmation is required.",
            source="llm_hint",
            requires_confirmation=True,
            matched_terms=[],
            confirmation_question=CANONICAL_CONFIRMATION,
        )

    return EscalationDecision(
        severity=EscalationSeverity.ROUTINE,
        category="general",
        reason="No escalation criteria matched.",
        source="rules",
    )


def apply_confirmation(
    decision: EscalationDecision, confirmed: bool, *, free_category: str = "patient_confirmed"
) -> EscalationDecision:
    """Resolve a hint-only decision once the patient has confirmed or denied it."""
    if not decision.requires_confirmation:
        return decision
    if confirmed:
        return EscalationDecision(
            severity=decision.severity,
            category=free_category,
            reason="The patient confirmed the concern when asked.",
            source="llm_hint+confirmation",
            requires_confirmation=False,
            matched_terms=decision.matched_terms,
        )
    return EscalationDecision(
        severity=EscalationSeverity.ROUTINE,
        category="general",
        reason="The patient denied the concern when asked.",
        source="llm_hint+confirmation",
    )


CANONICAL_CONFIRMATION = (
    "I want to make sure I understand - are you saying this is happening right now and "
    "you need help urgently? Please answer yes or no."
)


def safety_message(severity: EscalationSeverity, *, emergency_number: str = "112") -> str:
    """Approved guidance spoken to the patient. Never implies the AI sends help."""
    if severity == EscalationSeverity.EMERGENCY:
        return (
            f"This sounds like it could be a medical emergency. Please call {emergency_number} "
            "right now, or ask the person with you to call, and tell the nearest nurse. "
            "I am an AI assistant and cannot send help myself, but I am alerting your care team "
            "now and I will stay on the line."
        )
    if severity == EscalationSeverity.URGENT:
        return (
            "Thank you for telling me. I am letting your care team know that you need attention "
            "soon. If your symptoms get much worse or you feel in danger, please call "
            f"{emergency_number} immediately."
        )
    if severity == EscalationSeverity.FOLLOW_UP:
        return (
            "Thanks for telling me. I have noted this so your nurse can follow up with you."
        )
    return ""


def dedupe_key(patient_id: Optional[int], category: str, severity: EscalationSeverity, bucket: str) -> str:
    """Stable key so one emergency never raises unlimited duplicate records."""
    return f"esc:{patient_id}:{category}:{severity.value}:{bucket}"


def ack_escalation_severity(severity: str) -> int:
    try:
        return SEVERITY_RANK[EscalationSeverity(str(severity))]
    except (ValueError, KeyError):
        return 0
