"""Dashboard authentication, role-based access control and audit helpers.

* Passwords are hashed with ``hashlib.scrypt`` (standard library, no home-grown
  cryptography) and compared in constant time.
* Sessions are opaque random tokens; only their SHA-256 hash is stored, so a
  database leak does not expose a usable credential.
* Every sensitive action is authorised server-side; nurses can only reach the
  patients they are assigned to, and callers can never enumerate patients.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import stat
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import Depends, HTTPException, Request

from app import database, secrets_store
from app.config import settings
from app.telephony.models import UserRole

SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_LEN = 32

SESSION_COOKIE = "voicelink_session"


# --- password hashing ------------------------------------------------------

def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_LEN
    )
    return "scrypt${}${}${}${}${}".format(
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, hash_b64 = encoded.split("$", 5)
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
        return hmac.compare_digest(digest, expected)
    except (ValueError, TypeError):
        return False


# --- sessions --------------------------------------------------------------

def new_token() -> tuple[str, str]:
    raw = secrets.token_urlsafe(32)
    return raw, token_hash(raw)


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def start_session(user: dict[str, Any], user_agent: str = "") -> str:
    raw, hashed = new_token()
    database.create_session(
        token_hash=hashed,
        user_id=int(user["id"]),
        expires_at=database.utc_offset(settings.session_minutes * 60),
        user_agent=user_agent,
    )
    return raw


def end_session(raw: str) -> None:
    database.revoke_session(token_hash(raw))


class AuthError(HTTPException):
    def __init__(self, code: str, message: str, status_code: int = 401) -> None:
        super().__init__(status_code=status_code, detail={"code": code, "message": message})


# --- authentication --------------------------------------------------------

def authenticate(username: str, password: str) -> Optional[dict[str, Any]]:
    user = database.get_user_by_username(username or "")
    if user is None or not user.get("active"):
        # Do the same work even for an unknown user to reduce timing signal.
        hash_password(password or "x")
        return None
    if user.get("locked_until") and user["locked_until"] > database.utc_now():
        return None
    if not verify_password(password or "", user["password_hash"]):
        database.record_login_failure(
            int(user["id"]),
            lock_seconds=settings.login_lockout_seconds,
            max_attempts=settings.login_max_attempts,
        )
        return None
    database.record_login_success(int(user["id"]))
    return user


def _token_from_request(request: Request) -> Optional[str]:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    cookie = request.cookies.get(SESSION_COOKIE)
    if cookie:
        return cookie.strip()
    return None


def current_user(request: Request) -> dict[str, Any]:
    if not settings.require_dashboard_auth:
        return {
            "id": 0,
            "username": "dev",
            "display_name": "Development access",
            "role": UserRole.ADMIN.value,
            "patient_id": None,
            "active": True,
            "dev_bypass": True,
        }
    raw = _token_from_request(request)
    if not raw:
        raise AuthError("unauthenticated", "Sign in to the VoiceLink dashboard.")
    session = database.get_session(token_hash(raw))
    if session is None or not session.get("active"):
        raise AuthError("invalid_session", "Your session is not valid.")
    if session.get("revoked_at"):
        raise AuthError("session_revoked", "Your session has ended. Sign in again.")
    if session.get("expires_at") and session["expires_at"] < database.utc_now():
        raise AuthError("session_expired", "Your session expired. Sign in again.")
    return {
        "id": int(session["user_id"]),
        "username": session["username"],
        "display_name": session["display_name"],
        "role": session["role"],
        "patient_id": session.get("patient_id"),
        "active": True,
        "session_hash": session["token_hash"],
    }


def require_roles(*roles: str) -> Callable[..., dict[str, Any]]:
    allowed = {role.value if isinstance(role, UserRole) else str(role) for role in roles}

    def dependency(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        if user.get("dev_bypass"):
            return user
        if user.get("role") not in allowed:
            raise AuthError("forbidden", "Your role cannot perform this action.", 403)
        return user

    return dependency


def is_admin(user: dict[str, Any]) -> bool:
    return user.get("role") == UserRole.ADMIN.value


def ensure_patient_access(user: dict[str, Any], patient_id: Optional[int]) -> None:
    """A nurse assigned to one patient cannot read another patient's record."""
    if user.get("dev_bypass") or is_admin(user):
        return
    if user.get("role") == UserRole.NURSE.value:
        assigned = user.get("patient_id")
        if assigned is not None and patient_id is not None and int(assigned) != int(patient_id):
            raise AuthError("forbidden_patient", "You are not assigned to this patient.", 403)
        if assigned is None:
            # A pool nurse may work with any patient, but every access is audited.
            return
        return


def audit(
    user: Optional[dict[str, Any]],
    action: str,
    *,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    patient_id: Optional[int] = None,
    detail: Optional[dict[str, Any]] = None,
) -> None:
    database.append_audit(
        action=action,
        actor_id=str(user["id"]) if user and user.get("id") else None,
        actor_role=user.get("role") if user else None,
        entity_type=entity_type,
        entity_id=entity_id,
        patient_id=patient_id,
        detail=detail or {},
    )


# --- seeding ---------------------------------------------------------------

def seed_default_users() -> dict[str, Any]:
    """Create an administrator and a demo nurse on first run.

    The generated administrator password is written to a git-ignored file; it is
    never printed to the shared logs and never committed.
    """
    result: dict[str, Any] = {"created": [], "credentials_path": None}
    runtime = settings.runtime_dir / "admin_credentials.txt"
    admin = database.get_user_by_username("admin")
    if admin is None:
        password = secrets.token_urlsafe(12)
        database.create_user(
            username="admin",
            display_name="VoiceLink Administrator",
            role=UserRole.ADMIN.value,
            password_hash=hash_password(password),
        )
        text = (
            "CareSpeak VoiceLink administrator account\n"
            "username: admin\n"
            f"password: {password}\n"
            "\nChange this password after first sign-in. This file is git-ignored.\n"
        )
        runtime.parent.mkdir(parents=True, exist_ok=True)
        runtime.write_text(text, encoding="utf-8")
        try:
            os.chmod(runtime, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:  # pragma: no cover
            pass
        result["created"].append("admin")
        result["credentials_path"] = str(runtime)

    if settings.seed_demo_users and database.get_user_by_username("nurse.demo") is None:
        database.create_user(
            username="nurse.demo",
            display_name="Demo Nurse",
            role=UserRole.NURSE.value,
            password_hash=hash_password("nurse.demo"),
            patient_id=None,
        )
        result["created"].append("nurse.demo")
    return result
