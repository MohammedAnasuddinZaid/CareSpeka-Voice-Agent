"""Secure local secret storage.

Secrets are never written to the database, never logged, and never returned by
the API.  They live either in environment variables (loaded from the
git-ignored ``.env.voicelink``) or in a git-ignored JSON file under
``backend/runtime/`` whose permission bits are tightened on write.

The design deliberately avoids home-grown cryptography: no secret is encrypted
with a bespoke scheme.  Filesystem access control plus environment variables are
the storage mechanism, which is the same trust boundary the rest of the local
stack already uses.
"""
from __future__ import annotations

import json
import os
import secrets
import stat
import threading
from pathlib import Path
from typing import Any, Optional

from app.config import settings

_lock = threading.Lock()

#: Secret keys the platform understands.  Kept as an allow-list so a typo cannot
#: silently persist an unexpected value.
KNOWN_SECRETS = {
    "EXOTEL_API_KEY",
    "EXOTEL_API_TOKEN",
    "EXOTEL_ACCOUNT_SID",
    "EXOTEL_CALLER_ID",
    "EXOTEL_WEBHOOK_SECRET",
    "EXOTEL_SUBDOMAIN",
    "EXOTEL_DLT_ENTITY_ID",
    "EXOTEL_DLT_TEMPLATE_ID",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_MESSAGING_NUMBER",
    "TWILIO_WEBHOOK_BASE_URL",
    "TELEPHONY_WEBHOOK_BASE_URL",
    "SESSION_SECRET",
    "PUBLIC_BASE_URL",
}


def _secrets_path() -> Path:
    override = os.getenv("VOICELINK_SECRETS_PATH")
    return Path(override) if override else settings.runtime_dir / "provider_secrets.json"


def _read_file() -> dict[str, str]:
    path = _secrets_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
    except (OSError, json.JSONDecodeError):
        return {}
    return {}


def _tighten(path: Path) -> None:
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:  # pragma: no cover - best effort on Windows
        pass


def load_all() -> dict[str, str]:
    """Environment variables win over the file (explicit operator override)."""
    values = dict(_read_file())
    for key in KNOWN_SECRETS:
        env_value = os.getenv(key)
        if env_value is not None and env_value.strip():
            values[key] = env_value.strip()
    return values


def get(name: str, default: str = "") -> str:
    env_value = os.getenv(name)
    if env_value is not None and env_value.strip():
        return env_value.strip()
    return _read_file().get(name, default)


def set_many(values: dict[str, str]) -> dict[str, str]:
    """Persist known secrets to the git-ignored file. Returns names stored."""
    stored: dict[str, str] = {}
    with _lock:
        current = _read_file()
        for key, value in values.items():
            if key not in KNOWN_SECRETS:
                continue
            if value is None:
                continue
            value = str(value).strip()
            if value == "":
                current.pop(key, None)
            else:
                current[key] = value
            stored[key] = value
        path = _secrets_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(current, indent=2), encoding="utf-8")
        _tighten(path)
    return stored


def clear(names: list[str]) -> None:
    with _lock:
        current = _read_file()
        for name in names:
            current.pop(name, None)
        path = _secrets_path()
        path.write_text(json.dumps(current, indent=2), encoding="utf-8")
        _tighten(path)


def is_set(name: str) -> bool:
    return bool(get(name, ""))


def mask(value: Optional[str]) -> str:
    """Render a stored secret for display without revealing it."""
    value = (value or "").strip()
    if not value:
        return ""
    if len(value) <= 4:
        return "•" * len(value)
    return f"{value[:2]}{'•' * (len(value) - 4)}{value[-2:]}"


def session_secret() -> str:
    """Stable per-installation secret used to sign session tokens."""
    existing = get("SESSION_SECRET")
    if existing:
        return existing
    generated = secrets.token_urlsafe(48)
    set_many({"SESSION_SECRET": generated})
    return generated


def secret_status() -> dict[str, Any]:
    values = load_all()
    return {name: bool(values.get(name)) for name in sorted(KNOWN_SECRETS)}
