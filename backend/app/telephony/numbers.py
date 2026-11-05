"""Phone-number normalisation, validation and masking.

All numbers are stored internally in E.164 form (``+`` followed by 8-15 digits,
the first of which is not zero).  Human input is accepted in several local
formats and normalised against a default region.  Nothing here asserts that a
number is *reachable* - only that it is well formed.  Reachability is decided by
the provider, never by string inspection.
"""
from __future__ import annotations

import re
from typing import Optional

try:  # Python 3.10 ships phonenumbers only if explicitly installed.
    import phonenumbers  # type: ignore

    _HAS_PHONENUMBERS = True
except Exception:  # pragma: no cover - exercised only when the library is absent
    phonenumbers = None  # type: ignore
    _HAS_PHONENUMBERS = False


class NumberError(ValueError):
    """Raised when a value cannot be interpreted as a valid phone number."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


#: Calling codes for the regions VoiceLink documents.  Not exhaustive by design;
#: unknown regions fall back to a strict E.164 check.
REGION_CODES: dict[str, str] = {
    "IN": "91",
    "US": "1",
    "CA": "1",
    "GB": "44",
    "AE": "971",
    "SG": "65",
    "AU": "61",
}

DEFAULT_REGION = "IN"

_E164_RE = re.compile(r"^\+[1-9]\d{7,14}$")
_DIGITS_RE = re.compile(r"[^\d+]")

#: Numbers that are emergency / short codes and must never be dialled by the
#: platform as an ordinary outbound call.
EMERGENCY_NUMBERS = {"112", "911", "999", "100", "101", "102", "108", "1098"}


def region_calling_code(region: str) -> Optional[str]:
    return REGION_CODES.get((region or "").upper())


def normalize(value: str | None, region: str = DEFAULT_REGION) -> str:
    """Return *value* as E.164, or raise :class:`NumberError`.

    Full international numbers (``+`` prefix) are accepted verbatim.  Local
    formats such as ``09876543210`` or ``98765 43210`` are prefixed with the
    region's calling code.
    """
    if value is None:
        raise NumberError("number_missing", "A phone number is required.")
    raw = str(value).strip()
    if not raw:
        raise NumberError("number_missing", "A phone number is required.")

    if _HAS_PHONENUMBERS:
        try:
            parsed = phonenumbers.parse(raw, region or DEFAULT_REGION)
            if phonenumbers.is_valid_number(parsed):
                return phonenumbers.format_number(
                    parsed, phonenumbers.PhoneNumberFormat.E164
                )
        except Exception:
            pass

    cleaned = _DIGITS_RE.sub("", raw)
    if cleaned.startswith("+"):
        candidate = "+" + cleaned[1:].lstrip("0")
    elif cleaned.startswith("00"):
        candidate = "+" + cleaned[2:]
    else:
        digits = cleaned.lstrip("0")
        code = region_calling_code(region or DEFAULT_REGION)
        if digits.startswith(code or ""):
            candidate = "+" + digits
        elif code:
            candidate = "+" + code + digits
        else:
            raise NumberError(
                "unknown_region",
                f"No calling code is known for region '{region}'.",
            )

    if not _E164_RE.fullmatch(candidate):
        raise NumberError(
            "invalid_number",
            "That does not look like a valid phone number.",
        )
    return candidate


def try_normalize(value: str | None, region: str = DEFAULT_REGION) -> Optional[str]:
    try:
        return normalize(value, region)
    except NumberError:
        return None


def is_valid(value: str | None) -> bool:
    return bool(value) and bool(_E164_RE.fullmatch(str(value)))


def is_emergency_number(value: str | None) -> bool:
    if not value:
        return False
    digits = _DIGITS_RE.sub("", str(value)).lstrip("+")
    return digits in EMERGENCY_NUMBERS


def mask(value: str | None, keep_last: int = 4) -> str:
    """Return a masked form safe to display and log."""
    if not value:
        return ""
    text = str(value)
    digits = re.sub(r"\D", "", text)
    if len(digits) <= keep_last:
        return "*" * len(digits)
    return "*" * (len(digits) - keep_last) + digits[-keep_last:]


def country_code(value: str | None) -> str:
    """Best-effort calling-code extraction; used only for coarse grouping."""
    if not is_valid(value):
        return ""
    digits = re.sub(r"\D", "", str(value))
    for code in sorted(REGION_CODES.values(), key=len, reverse=True):
        if digits.startswith(code):
            return f"+{code}"
    return ""


def redact_for_log(value: str | None) -> str:
    return mask(value)
