"""Validation, local-only origin checks and clinical safety guardrails."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

from app.config import settings

EXTENSION_RE = re.compile(r"^CS-\d{4}$")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
MARKDOWN_RE = re.compile(r"[*_`#>]+")
EMOJI_RE = re.compile(
    "[\U0001F1E0-\U0001F1FF\U0001F300-\U0001FAFF\U00002600-\U000027BF]"
)


class ValidationError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class DialTarget:
    caller: str
    callee: str


def normalize_extension(value: str | None) -> str:
    return (value or "").strip().upper().replace(" ", "")


def validate_dial(caller: str | None, callee: str | None) -> DialTarget:
    caller_norm = normalize_extension(caller)
    callee_norm = normalize_extension(callee)
    if not caller_norm or not EXTENSION_RE.fullmatch(caller_norm):
        raise ValidationError(
            "invalid_caller",
            "Caller extension must look like CS-1001.",
        )
    if not callee_norm or not EXTENSION_RE.fullmatch(callee_norm):
        raise ValidationError(
            "invalid_callee",
            "Callee extension must look like CS-0000.",
        )
    if callee_norm != "CS-0000":
        raise ValidationError(
            "callee_not_available",
            "This local demo can only receive calls on the AI agent extension CS-0000.",
            409,
        )
    return DialTarget(caller=caller_norm, callee=callee_norm)


def guard_user_text(text: str, limit: int = 1200) -> str:
    clean = CONTROL_RE.sub(" ", text or "")
    clean = " ".join(clean.split())
    if len(clean) > limit:
        clean = clean[:limit].rsplit(" ", 1)[0] + "..."
    return clean.strip()


def clean_assistant_text(text: str, limit: int = 1200) -> str:
    clean = CONTROL_RE.sub(" ", text or "")
    clean = URL_RE.sub("", clean)
    clean = MARKDOWN_RE.sub("", clean)
    clean = EMOJI_RE.sub("", clean)
    clean = clean.replace("\r", " ").replace("\n", " ")
    clean = " ".join(clean.split())
    if len(clean) > limit:
        clean = clean[:limit].rsplit(" ", 1)[0] + "."
    return clean.strip()


def trim_for_call(text: str, max_sentences: int = 2, max_words: int = 55) -> str:
    """Keep spoken replies short even when a small model ignores the prompt."""
    clean = clean_assistant_text(text)
    if not clean:
        return ""
    sentences = re.split(r"(?<=[.!?])\s+", clean)
    kept: list[str] = []
    words = 0
    for sentence in sentences:
        count = len(sentence.split())
        if kept and words + count > max_words:
            break
        if not kept and count > max_words:
            trimmed = " ".join(sentence.split()[:max_words])
            kept.append(trimmed.rstrip(".,;:") + ".")
            break
        kept.append(sentence)
        words += count
        if len(kept) >= max_sentences:
            break
    return " ".join(kept).strip()


# Phrases that must never be handled as an ordinary conversational turn.
_EMERGENCY_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "cardiac",
        re.compile(
            r"\b(chest pain|crushing chest|heart attack|pressure in my chest)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "breathing",
        re.compile(
            r"\b(can'?t breathe|cannot breathe|difficulty breathing|"
            r"short(?:ness)? of breath|gasping|choking)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "stroke",
        re.compile(
            r"\b(stroke|face droop|drooping face|slurred speech|"
            r"numb(?:ness)? (?:on|in) one side|sudden weakness)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "bleeding",
        re.compile(
            r"\b(severe bleeding|bleeding heavily|blood loss|won'?t stop bleeding)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "consciousness",
        re.compile(
            r"\b(unconscious|passed out|fainted|not breathing|unresponsive)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "self_harm",
        re.compile(
            r"\b(suicid(?:e|al)|kill myself|end my life|overdose|"
            r"harmed myself|want to die)\b",
            re.IGNORECASE,
        ),
    ),
]

_NEGATION_RE = re.compile(
    r"(?:no|not|without|don't have|do not have|never had)\s+(?:\w+\s+){0,2}$",
    re.IGNORECASE,
)


def detect_emergency(text: str) -> Optional[str]:
    """Return the first emergency category detected in *text*.

    A simple negation check avoids firing on phrases such as "no chest pain".
    It is deliberately conservative: a false alarm is safer than missing a
    genuine emergency.
    """
    for category, pattern in _EMERGENCY_PATTERNS:
        for match in pattern.finditer(text or ""):
            prefix = text[max(0, match.start() - 24) : match.start()]
            if _NEGATION_RE.search(prefix):
                continue
            return category
    return None


EMERGENCY_REPLY = (
    "This may be a medical emergency. Please call 112 or your local emergency "
    "number right now, and tell the nearest nurse or person with you. I am an AI "
    "assistant and cannot send help myself. I can stay on the line while you get help."
)

SELF_HARM_REPLY = (
    "I am really sorry you are feeling this way. Please call 112 now, or reach a "
    "local crisis helpline and tell someone nearby that you need help immediately. "
    "I am an AI assistant and cannot contact anyone for you. Please stay with someone "
    "you trust while you call."
)


def emergency_reply(category: str) -> str:
    if category == "self_harm":
        return SELF_HARM_REPLY
    return EMERGENCY_REPLY


def is_local_origin(origin: str | None) -> bool:
    """Allow same-machine and RFC1918 LAN origins only.

    Browsers omit Origin for some non-browser clients; those are accepted
    because the API is bound to loopback and the gateway performs the LAN hop.
    """
    if not origin:
        return True
    if origin == "null":
        return False
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        return False
    return bool(
        re.fullmatch(
            # urlparse strips the brackets from an IPv6 literal, so the loopback
            # address arrives as "::1" (never "[::1]").  Match the bare form.
            r"(localhost|127\.0\.0\.1|::1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
            r"192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})",
            parsed.hostname or "",
        )
    )


def assert_local_service_url(url: str) -> None:
    """Reject a configuration that would send health data or prompts to a cloud host."""
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Local service URL must use http or https.")
    if not (
        host in {"localhost", "127.0.0.1", "::1"}
        or re.fullmatch(
            r"(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|"
            r"172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})",
            host,
        )
    ):
        raise ValueError(
            f"Refusing non-local service host '{host}'. VoiceLink is local-only."
        )


assert_local_service_url(settings.ollama_url)
