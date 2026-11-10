"""Dashboard REST API for the VoiceLink care platform.

Every mutating route is authorised server-side and audited.  Phone numbers are
always returned masked; full E.164 values never leave the server.  The module is
deliberately verbose about *why* an action was refused so the UI can explain the
real state instead of guessing.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from app import auth, database, secrets_store
from app.auth import AuthError, audit, current_user, ensure_patient_access, require_roles
from app.config import settings
from app.telephony import numbers, registry
from app.telephony.models import FamilyRequestState, MessageChannel, UserRole
from app.telephony.service import (
    public_call,
    public_escalation,
    public_message,
    strip_full_numbers,
)

router = APIRouter(prefix="/api/platform", tags=["platform"])


# ---------------------------------------------------------------------------
# Input models
# ---------------------------------------------------------------------------
class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


class ContactBody(BaseModel):
    patient_id: int
    role: str
    display_name: str = Field(min_length=1, max_length=120)
    phone: str = Field(min_length=4, max_length=40)
    preferred_channel: str = "sms"
    is_primary: bool = False
    consent_status: str = "unknown"
    permissions: dict[str, Any] = Field(default_factory=dict)


class StartCallBody(BaseModel):
    patient_id: int
    purpose: str = "nurse_to_patient_ai"
    contact_id: Optional[int] = None


class MessageBody(BaseModel):
    patient_id: int
    body: str = Field(min_length=1, max_length=900)
    channel: str = "sms"
    contact_id: Optional[int] = None
    allow_quiet_hours: bool = False


class PermissionBody(BaseModel):
    patient_id: int
    contact_id: int
    scope: dict[str, Any] = Field(default_factory=dict)


class FamilyRequestBody(BaseModel):
    patient_id: int
    contact_id: int
    mode: str = "family_ai"
    detail: str = ""


class DecisionBody(BaseModel):
    note: str = ""


class VerifyStartBody(BaseModel):
    channel: str = "sms"


class VerifyConfirmBody(BaseModel):
    code: str = Field(min_length=1, max_length=12)


class ProviderSecretsBody(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)


class FollowUpBody(BaseModel):
    patient_id: int
    kind: str = "follow_up_call"
    delay_minutes: int = Field(default=60, ge=1, le=60 * 24 * 30)
    body: str = ""
    channel: str = "sms"


# ---------------------------------------------------------------------------
# Serialisation helpers (never leak E.164)
# ---------------------------------------------------------------------------
def _public_contact(contact: dict[str, Any]) -> dict[str, Any]:
    data = dict(contact)
    data.pop("phone_e164", None)
    return data


def _masked(value: Optional[str]) -> str:
    return numbers.mask(value)


def _public_event(event: dict[str, Any]) -> dict[str, Any]:
    """Serialise a stored provider event without full phone numbers.

    Provider webhook payloads routinely contain the caller/callee numbers, and
    the raw JSON is kept for diagnostics.  It is parsed and scrubbed here so the
    dashboard never sees a complete E.164 string.
    """
    data = dict(event)
    raw = data.pop("payload_json", None)
    payload: Any = {}
    if isinstance(raw, str) and raw.strip():
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            payload = {}
    elif isinstance(raw, (dict, list)):
        payload = raw
    data["payload"] = strip_full_numbers(payload)
    return strip_full_numbers(data)


def _public_job(job: dict[str, Any]) -> dict[str, Any]:
    """Serialise a scheduled job, masking the dialled number in its payload.

    Follow-up jobs keep the full E.164 string so the scheduler can dial it; the
    dashboard only ever sees the masked tail.
    """
    data = dict(job)
    payload = data.get("payload")
    if isinstance(payload, dict):
        payload = dict(payload)
        for full_key in ("to_number", "from_number", "phone_e164"):
            raw = payload.pop(full_key, None)
            if raw:
                payload.setdefault("to_masked", numbers.mask(raw))
        # Internal convenience fields that must not reach the dashboard.
        payload.pop("patient_name", None)
        data["payload"] = strip_full_numbers(payload)
    return strip_full_numbers(data)


def _refresh_provider_from_secrets() -> None:
    registry.reset_cache()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def _cookie_secure(request: Request) -> bool:
    """Only mark the session cookie Secure when the client is actually on TLS.

    Using ``PUBLIC_BASE_URL`` here would break the local dashboard because the
    browser talks to the backend over plain HTTP on localhost.
    """
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    return forwarded == "https" or request.url.scheme == "https"


@router.post("/auth/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict[str, Any]:
    await asyncio.to_thread(database.init_db)
    user = await asyncio.to_thread(auth.authenticate, body.username, body.password)
    if user is None:
        # Do not reveal whether the username exists.
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_credentials", "message": "Sign-in failed. Check your username and password."},
        )
    raw = await asyncio.to_thread(auth.start_session, user, request.headers.get("user-agent", ""))
    response.set_cookie(
        auth.SESSION_COOKIE,
        raw,
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(request),
        max_age=settings.session_minutes * 60,
        path="/",
    )
    await asyncio.to_thread(
        audit, {"id": user["id"], "role": user["role"]}, "auth.login", entity_type="user", entity_id=str(user["id"])
    )
    return {"ok": True, "user": _session_user(user)}


@router.post("/auth/logout")
async def logout(request: Request, response: Response) -> dict[str, Any]:
    raw = request.cookies.get(auth.SESSION_COOKIE)
    if raw:
        await asyncio.to_thread(auth.end_session, raw)
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/auth/me")
async def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"ok": True, "user": _session_user(user)}


def _session_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "display_name": user.get("display_name"),
        "role": user.get("role"),
        "patient_id": user.get("patient_id"),
        "dev_bypass": bool(user.get("dev_bypass")),
    }


# ---------------------------------------------------------------------------
# Overview / bootstrap
# ---------------------------------------------------------------------------
@router.get("/overview")
async def overview(request: Request, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    service = request.app.state.service
    data = await asyncio.to_thread(service.overview)
    # Restrict the patient-scoped lists for a nurse assigned to a single patient.
    if not (auth.is_admin(user) or user.get("dev_bypass")):
        assigned = user.get("patient_id")
        if assigned is not None:

            def _keep(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
                return [i for i in items if i.get("patient_id") in (None, assigned)]

            data["active_calls"] = _keep(data.get("active_calls", []))
            data["open_escalations"] = _keep(data.get("open_escalations", []))
            data["unacknowledged_alerts"] = _keep(data.get("unacknowledged_alerts", []))
            data["missed_calls"] = _keep(data.get("missed_calls", []))
    return {"ok": True, **data}


@router.get("/bootstrap")
async def bootstrap(_user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    patients = await asyncio.to_thread(database.list_patients)
    contacts = await asyncio.to_thread(database.list_contacts)
    return {
        "ok": True,
        "patients": patients,
        "contacts": [_public_contact(c) for c in contacts],
        "telephony": registry.provider_summary(),
    }


# ---------------------------------------------------------------------------
# Patients
# ---------------------------------------------------------------------------
@router.get("/patients")
async def list_patients(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    patients = await asyncio.to_thread(database.list_patients)
    contacts = await asyncio.to_thread(database.list_contacts)
    by_patient: dict[int, list[dict[str, Any]]] = {}
    for contact in contacts:
        by_patient.setdefault(contact.get("patient_id") or 0, []).append(_public_contact(contact))
    for patient in patients:
        patient["contacts"] = by_patient.get(patient["id"], [])
    return {"ok": True, "patients": patients, "synthetic_only": True}


@router.get("/patients/{patient_id}")
async def patient_detail(patient_id: int, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    ensure_patient_access(user, patient_id)
    patient = await asyncio.to_thread(database.get_patient_by_id, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Patient not found."})
    contacts = await asyncio.to_thread(database.list_contacts, patient_id)
    calls = await asyncio.to_thread(
        lambda: database.list_telephony_calls(patient_id=patient_id, limit=25)
    )
    messages = await asyncio.to_thread(
        lambda: database.list_messages(patient_id=patient_id, limit=25)
    )
    escalations = await asyncio.to_thread(
        lambda: database.list_escalations(patient_id=patient_id, limit=25)
    )
    permissions = await asyncio.to_thread(database.list_family_permissions, patient_id)
    jobs = await asyncio.to_thread(
        lambda: database.list_jobs(patient_id=patient_id, states=["pending", "leased"], limit=25)
    )
    await asyncio.to_thread(
        audit, user, "patient.view", entity_type="patient", entity_id=str(patient_id), patient_id=patient_id
    )
    return {
        "ok": True,
        "patient": patient,
        "contacts": [_public_contact(c) for c in contacts],
        "calls": [public_call(c) for c in calls],
        "messages": [public_message(m) for m in messages],
        "escalations": [public_escalation(e) for e in escalations],
        "permissions": permissions,
        "follow_ups": [_public_job(j) for j in jobs],
    }


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------
@router.get("/contacts")
async def list_contacts(
    patient_id: Optional[int] = Query(None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if patient_id is not None:
        ensure_patient_access(user, patient_id)
    contacts = await asyncio.to_thread(database.list_contacts, patient_id, False)
    return {"ok": True, "contacts": [_public_contact(c) for c in contacts]}


@router.post("/contacts")
async def add_contact(
    body: ContactBody,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    ensure_patient_access(user, body.patient_id)
    try:
        e164 = numbers.normalize(body.phone, settings.default_region)
    except numbers.NumberError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": exc.message})
    contact_id = await asyncio.to_thread(
        database.add_contact,
        patient_id=body.patient_id,
        role=body.role,
        display_name=body.display_name,
        phone_e164=e164,
        phone_masked=_masked(e164),
        preferred_channel=body.preferred_channel,
        permissions=body.permissions,
        consent_status=body.consent_status,
        is_primary=body.is_primary,
    )
    await asyncio.to_thread(
        audit,
        user,
        "contact.create",
        entity_type="contact",
        entity_id=str(contact_id),
        patient_id=body.patient_id,
        detail={"role": body.role, "phone_masked": _masked(e164)},
    )
    contact = await asyncio.to_thread(database.get_contact, contact_id)
    return {"ok": True, "contact": _public_contact(contact) if contact else {}}


@router.post("/contacts/{contact_id}/revoke")
async def revoke_contact(
    contact_id: int,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    contact = await asyncio.to_thread(database.get_contact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Contact not found."})
    ensure_patient_access(user, contact.get("patient_id"))
    await asyncio.to_thread(database.revoke_contact, contact_id)
    await asyncio.to_thread(
        audit, user, "contact.revoke", entity_type="contact", entity_id=str(contact_id),
        patient_id=contact.get("patient_id"),
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Verification challenges
# ---------------------------------------------------------------------------
@router.post("/contacts/{contact_id}/verify")
async def start_verification(
    contact_id: int,
    body: VerifyStartBody,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    contact = await asyncio.to_thread(database.get_contact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Contact not found."})
    ensure_patient_access(user, contact.get("patient_id"))

    code = f"{int.from_bytes(__import__('os').urandom(3), 'big') % 1000000:06d}"
    secret = secrets_store.session_secret()
    challenge = await asyncio.to_thread(
        database.create_challenge,
        contact_id=contact_id,
        phone_masked=contact.get("phone_masked", ""),
        channel=body.channel,
        purpose="contact_ownership",
        code_hash=_challenge_hash(secret, code),
        ttl_seconds=settings.verification_ttl_seconds,
        max_attempts=settings.verification_max_attempts,
    )

    provider = registry.get_provider()
    # A mock (or a real provider without credentials) must never be treated as
    # having delivered an SMS.  Only a real, configured carrier counts.
    real_provider = provider.name in {"exotel", "twilio"} and provider.is_configured()
    delivery = {"sent": False, "mode": provider.operating_mode(), "detail": "No real carrier configured."}
    if provider.capabilities().sms and real_provider:
        result = await provider.send_message(
            to_number=contact["phone_e164"],
            from_number=getattr(provider, "caller_id", "") or getattr(provider, "from_number", "") or None,
            body=f"Your CareSpeak verification code is {code}. It expires in {settings.verification_ttl_seconds // 60} minutes.",
            channel="sms",
            status_url="",
            metadata={"purpose": "contact_verification"},
        )
        delivery = {
            "sent": bool(result.ok),
            "accepted": bool(result.accepted),
            "mode": provider.operating_mode(),
            "detail": result.detail,
        }
    await asyncio.to_thread(
        audit, user, "contact.verify.start", entity_type="contact", entity_id=str(contact_id),
        patient_id=contact.get("patient_id"), detail={"channel": body.channel, "delivery": delivery},
    )
    # Surface the code only when no real SMS was handed to a carrier, so the
    # offline flow is testable without ever defeating real verification.
    simulated_code = code if not (real_provider and delivery["sent"]) else None
    return {
        "ok": True,
        "challenge_id": challenge["id"],
        "phone_masked": contact.get("phone_masked"),
        "expires_at": challenge.get("expires_at"),
        "delivery": delivery,
        "simulated_code": simulated_code,
    }


@router.post("/contacts/{contact_id}/verify/confirm")
async def confirm_verification(
    contact_id: int,
    body: VerifyConfirmBody,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    contact = await asyncio.to_thread(database.get_contact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Contact not found."})
    ensure_patient_access(user, contact.get("patient_id"))
    challenge = await asyncio.to_thread(_latest_open_challenge, contact_id)
    if challenge is None:
        raise HTTPException(status_code=400, detail={"code": "no_challenge", "message": "Start a verification first."})
    if challenge["state"] != "pending":
        raise HTTPException(status_code=400, detail={"code": "challenge_closed", "message": "That challenge is no longer open."})
    if challenge["expires_at"] < database.utc_now():
        await asyncio.to_thread(database.update_challenge, challenge["id"], state="expired")
        raise HTTPException(status_code=400, detail={"code": "challenge_expired", "message": "The code expired. Send a new one."})
    secret = secrets_store.session_secret()
    if hmac.compare_digest(challenge["code_hash"], _challenge_hash(secret, body.code.strip())):
        await asyncio.to_thread(database.update_challenge, challenge["id"], state="verified", used=True)
        await asyncio.to_thread(database.update_contact_verification, contact_id, "verified")
        await asyncio.to_thread(
            audit, user, "contact.verify.confirm", entity_type="contact", entity_id=str(contact_id),
            patient_id=contact.get("patient_id"), detail={"result": "verified"},
        )
        return {"ok": True, "verified": True}
    attempts = int(challenge["attempts"]) + 1
    if attempts >= int(challenge["max_attempts"]):
        await asyncio.to_thread(database.update_challenge, challenge["id"], state="failed", attempts=attempts)
        await asyncio.to_thread(database.update_contact_verification, contact_id, "failed")
        raise HTTPException(status_code=400, detail={"code": "too_many_attempts", "message": "Too many incorrect codes."})
    await asyncio.to_thread(database.update_challenge, challenge["id"], attempts=attempts)
    raise HTTPException(
        status_code=400,
        detail={"code": "incorrect_code", "message": "That code is not correct.", "attempts_remaining": int(challenge["max_attempts"]) - attempts},
    )


def _challenge_hash(secret: str, code: str) -> str:
    return hmac.new(secret.encode(), code.encode(), hashlib.sha256).hexdigest()


def _latest_open_challenge(contact_id: int) -> Optional[dict[str, Any]]:
    # A tiny scan over the challenge table (bounded rows) keeps this dependency-free.
    with database.connection() as conn:
        row = conn.execute(
            "SELECT * FROM verification_challenges WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1",
            (contact_id,),
        ).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Calls
# ---------------------------------------------------------------------------
@router.get("/calls")
async def list_calls(
    patient_id: Optional[int] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if patient_id is not None:
        ensure_patient_access(user, patient_id)
    calls = await asyncio.to_thread(
        lambda: database.list_telephony_calls(patient_id=patient_id, limit=limit)
    )
    return {"ok": True, "calls": [public_call(c) for c in calls], "telephony": registry.provider_summary()}


@router.post("/calls")
async def start_call(
    body: StartCallBody,
    request: Request,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    ensure_patient_access(user, body.patient_id)
    patient = await asyncio.to_thread(database.get_patient_by_id, body.patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Patient not found."})
    contact = await asyncio.to_thread(_patient_contact, body.patient_id, body.contact_id)
    if contact is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_number", "message": "Register a verified phone number for this patient before calling."},
        )
    service = request.app.state.service
    result = await service.start_nurse_call(
        patient_id=body.patient_id,
        patient_name=patient.get("display_name", "patient"),
        to_number=contact["phone_e164"],
        contact_id=contact.get("id"),
        purpose=body.purpose,
        actor=user,
    )
    await asyncio.to_thread(
        audit, user, "call.start", entity_type="call",
        entity_id=(result.get("call") or {}).get("id"), patient_id=body.patient_id,
        detail={"ok": result.get("ok"), "mode": result.get("mode"), "reason": result.get("reason")},
    )
    return result


@router.get("/calls/{call_id}")
async def call_detail(call_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    call = await asyncio.to_thread(database.get_telephony_call, call_id)
    if call is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Call not found."})
    ensure_patient_access(user, call.get("patient_id"))
    events = await asyncio.to_thread(database.list_call_events, call_id)
    return {"ok": True, "call": public_call(call), "events": [_public_event(e) for e in events]}


@router.post("/calls/{call_id}/end")
async def end_call(
    call_id: str,
    request: Request,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    call = await asyncio.to_thread(database.get_telephony_call, call_id)
    if call is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Call not found."})
    ensure_patient_access(user, call.get("patient_id"))
    result = await request.app.state.service.end_call(call_id, actor=user)
    await asyncio.to_thread(audit, user, "call.end", entity_type="call", entity_id=call_id, patient_id=call.get("patient_id"))
    return result


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------
@router.get("/messages")
async def list_messages(
    patient_id: Optional[int] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if patient_id is not None:
        ensure_patient_access(user, patient_id)
    messages = await asyncio.to_thread(lambda: database.list_messages(patient_id=patient_id, limit=limit))
    return {"ok": True, "messages": [public_message(m) for m in messages], "telephony": registry.provider_summary()}


@router.post("/messages")
async def send_message(
    body: MessageBody,
    request: Request,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    ensure_patient_access(user, body.patient_id)
    contact = await asyncio.to_thread(_patient_contact, body.patient_id, body.contact_id)
    if contact is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_number", "message": "Register a phone number for this patient before messaging."},
        )
    channel = body.channel if body.channel in {c.value for c in MessageChannel} else "sms"
    service = request.app.state.service
    result = await service.send_message(
        patient_id=body.patient_id,
        to_number=contact["phone_e164"],
        body=body.body,
        channel=channel,
        contact_id=contact.get("id"),
        actor=user,
        allow_quiet_hours=body.allow_quiet_hours,
    )
    # ``message`` is the stored record on success, or a human-readable string on
    # a refusal (e.g. quiet hours); guard before reading it as a mapping.
    stored_message = result.get("message") if isinstance(result.get("message"), dict) else None
    await asyncio.to_thread(
        audit, user, "message.send", entity_type="message",
        entity_id=(stored_message or {}).get("id"), patient_id=body.patient_id,
        detail={"ok": result.get("ok"), "channel": channel, "reason": result.get("reason")},
    )
    return result


# ---------------------------------------------------------------------------
# Escalations
# ---------------------------------------------------------------------------
@router.get("/escalations")
async def list_escalations(
    state: Optional[str] = Query(None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    escalations = await asyncio.to_thread(lambda: database.list_escalations(state=state, limit=100))
    if not (auth.is_admin(user) or user.get("dev_bypass")):
        assigned = user.get("patient_id")
        if assigned is not None:
            escalations = [e for e in escalations if e.get("patient_id") == assigned]
    actions = {
        e["id"]: await asyncio.to_thread(database.list_escalation_actions, e["id"])
        for e in escalations[:20]
    }
    return {
        "ok": True,
        "escalations": [public_escalation(e) for e in escalations],
        "actions": {
            key: [strip_full_numbers(action) for action in value]
            for key, value in actions.items()
        },
    }


@router.get("/escalations/{escalation_id}")
async def escalation_detail(escalation_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    escalation = await asyncio.to_thread(database.get_escalation, escalation_id)
    if escalation is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Escalation not found."})
    ensure_patient_access(user, escalation.get("patient_id"))
    actions = await asyncio.to_thread(database.list_escalation_actions, escalation_id)
    return {
        "ok": True,
        "escalation": public_escalation(escalation),
        "actions": [strip_full_numbers(action) for action in actions],
    }


@router.post("/escalations/{escalation_id}/ack")
async def acknowledge_escalation(
    escalation_id: str,
    request: Request,
    body: DecisionBody = Body(default=DecisionBody()),
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    escalation = await asyncio.to_thread(database.get_escalation, escalation_id)
    if escalation is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Escalation not found."})
    ensure_patient_access(user, escalation.get("patient_id"))
    result = await asyncio.to_thread(
        request.app.state.service.acknowledge_escalation,
        escalation_id,
        actor=user,
        note=body.note,
    )
    await asyncio.to_thread(
        audit, user, "escalation.ack", entity_type="escalation", entity_id=escalation_id,
        patient_id=escalation.get("patient_id"),
    )
    return result


@router.post("/escalations/{escalation_id}/resolve")
async def resolve_escalation(
    escalation_id: str,
    request: Request,
    body: DecisionBody = Body(default=DecisionBody()),
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    escalation = await asyncio.to_thread(database.get_escalation, escalation_id)
    if escalation is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Escalation not found."})
    ensure_patient_access(user, escalation.get("patient_id"))
    result = await asyncio.to_thread(
        request.app.state.service.resolve_escalation,
        escalation_id,
        actor=user,
        note=body.note,
    )
    await asyncio.to_thread(
        audit, user, "escalation.resolve", entity_type="escalation", entity_id=escalation_id,
        patient_id=escalation.get("patient_id"),
    )
    return result


# ---------------------------------------------------------------------------
# Family access
# ---------------------------------------------------------------------------
@router.get("/family/permissions")
async def family_permissions(
    patient_id: Optional[int] = Query(None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if patient_id is not None:
        ensure_patient_access(user, patient_id)
    permissions = await asyncio.to_thread(database.list_family_permissions, patient_id)
    return {"ok": True, "permissions": permissions}


@router.post("/family/permissions")
async def grant_permission(
    body: PermissionBody,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    ensure_patient_access(user, body.patient_id)
    contact = await asyncio.to_thread(database.get_contact, body.contact_id)
    if contact is None or contact.get("patient_id") != body.patient_id:
        raise HTTPException(status_code=400, detail={"code": "bad_contact", "message": "That contact does not belong to this patient."})
    await asyncio.to_thread(
        database.upsert_family_permission,
        patient_id=body.patient_id,
        contact_id=body.contact_id,
        scope=body.scope or {"mode1": True, "mode2": False, "share_notes": False},
        granted_by=(user.get("display_name") or user.get("username") or "staff"),
    )
    await asyncio.to_thread(database.update_contact_permissions, body.contact_id, body.scope)
    await asyncio.to_thread(
        audit, user, "family.permission.grant", entity_type="contact", entity_id=str(body.contact_id),
        patient_id=body.patient_id, detail={"scope": body.scope},
    )
    return {"ok": True}


@router.post("/family/permissions/{patient_id}/{contact_id}/revoke")
async def revoke_permission(
    patient_id: int,
    contact_id: int,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    ensure_patient_access(user, patient_id)
    await asyncio.to_thread(database.revoke_family_permission, patient_id, contact_id)
    await asyncio.to_thread(
        audit, user, "family.permission.revoke", entity_type="contact", entity_id=str(contact_id),
        patient_id=patient_id,
    )
    return {"ok": True}


@router.get("/family/requests")
async def family_requests(
    state: Optional[str] = Query(None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    requests = await asyncio.to_thread(lambda: database.list_family_requests(state, 100))
    if not (auth.is_admin(user) or user.get("dev_bypass")):
        assigned = user.get("patient_id")
        if assigned is not None:
            requests = [r for r in requests if r.get("patient_id") == assigned]
    return {"ok": True, "requests": requests}


@router.post("/family/requests")
async def create_family_request(
    body: FamilyRequestBody,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    ensure_patient_access(user, body.patient_id)
    contact = await asyncio.to_thread(database.get_contact, body.contact_id)
    if contact is None or contact.get("patient_id") != body.patient_id:
        raise HTTPException(status_code=400, detail={"code": "bad_contact", "message": "That contact does not belong to this patient."})
    record = await asyncio.to_thread(
        database.create_family_request,
        patient_id=body.patient_id,
        contact_id=body.contact_id,
        mode=body.mode,
        requested_by=(user.get("display_name") or user.get("username") or "staff"),
        expires_in_seconds=settings.family_request_ttl_seconds,
        detail=body.detail,
    )
    await asyncio.to_thread(
        audit, user, "family.request.create", entity_type="family_request", entity_id=record["id"],
        patient_id=body.patient_id, detail={"mode": body.mode},
    )
    return {"ok": True, "request": record}


@router.post("/family/requests/{request_id}/approve")
async def approve_family_request(
    request_id: str,
    body: DecisionBody = Body(default=DecisionBody()),
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    return await _decide_family(request_id, FamilyRequestState.APPROVED.value, user, body.note)


@router.post("/family/requests/{request_id}/deny")
async def deny_family_request(
    request_id: str,
    body: DecisionBody = Body(default=DecisionBody()),
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    return await _decide_family(request_id, FamilyRequestState.DENIED.value, user, body.note)


async def _decide_family(request_id: str, decision: str, user: dict[str, Any], note: str) -> dict[str, Any]:
    request = await asyncio.to_thread(database.get_family_request, request_id)
    if request is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Request not found."})
    ensure_patient_access(user, request.get("patient_id"))
    if request.get("expires_at") and request["expires_at"] < database.utc_now():
        await asyncio.to_thread(database.update_family_request, request_id, state=FamilyRequestState.EXPIRED.value)
        raise HTTPException(status_code=400, detail={"code": "expired", "message": "That request link has expired."})
    if request["state"] != FamilyRequestState.PENDING.value:
        raise HTTPException(status_code=400, detail={"code": "already_decided", "message": "That request was already decided."})
    updated = await asyncio.to_thread(
        database.update_family_request,
        request_id,
        state=decision,
        verification_state="verified" if decision == FamilyRequestState.APPROVED.value else request.get("verification_state"),
        decided_by=(user.get("display_name") or user.get("username") or "staff"),
    )
    await asyncio.to_thread(
        audit, user, f"family.request.{decision}", entity_type="family_request", entity_id=request_id,
        patient_id=request.get("patient_id"), detail={"note": note},
    )
    return {"ok": True, "request": updated}


# ---------------------------------------------------------------------------
# Follow-up scheduling
# ---------------------------------------------------------------------------
@router.post("/follow-ups")
async def schedule_follow_up(
    body: FollowUpBody,
    request: Request,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    ensure_patient_access(user, body.patient_id)
    patient = await asyncio.to_thread(database.get_patient_by_id, body.patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Patient not found."})
    contact = await asyncio.to_thread(_patient_contact, body.patient_id, None)
    if contact is None:
        raise HTTPException(status_code=400, detail={"code": "no_number", "message": "Register a phone number before scheduling follow-up."})
    scheduler = request.app.state.scheduler
    job = await asyncio.to_thread(
        scheduler.schedule_follow_up,
        kind=body.kind,
        patient_id=body.patient_id,
        run_at=database.utc_offset(body.delay_minutes * 60),
        payload={
            "patient_id": body.patient_id,
            "patient_name": patient.get("display_name"),
            "to_number": contact["phone_e164"],
            "contact_id": contact.get("id"),
            "body": body.body,
            "channel": body.channel,
        },
        dedupe_key=None,
    )
    await asyncio.to_thread(
        audit, user, "followup.schedule", entity_type="job", entity_id=job["id"],
        patient_id=body.patient_id, detail={"kind": body.kind, "delay_minutes": body.delay_minutes},
    )
    return {"ok": True, "job": _public_job(job)}


@router.get("/follow-ups")
async def list_follow_ups(
    patient_id: Optional[int] = Query(None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if patient_id is not None:
        ensure_patient_access(user, patient_id)
    jobs = await asyncio.to_thread(
        lambda: database.list_jobs(patient_id=patient_id, limit=100)
    )
    return {"ok": True, "jobs": [_public_job(j) for j in jobs]}


@router.post("/follow-ups/{job_id}/cancel")
async def cancel_follow_up(
    job_id: str,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    job = await asyncio.to_thread(database.get_job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found."})
    ensure_patient_access(user, job.get("patient_id"))
    await asyncio.to_thread(database.complete_job, job_id, state="cancelled")
    await asyncio.to_thread(
        audit, user, "followup.cancel", entity_type="job", entity_id=job_id, patient_id=job.get("patient_id")
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Provider settings
# ---------------------------------------------------------------------------
@router.get("/provider")
async def provider_settings(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    summary = registry.provider_summary()
    summary["health"] = await _provider_health()
    return {"ok": True, "provider": summary}


@router.post("/provider/secrets")
async def store_provider_secrets(
    body: ProviderSecretsBody,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN)),
) -> dict[str, Any]:
    stored = await asyncio.to_thread(secrets_store.set_many, body.values)
    _refresh_provider_from_secrets()
    await asyncio.to_thread(
        audit, user, "provider.secrets.update", entity_type="provider",
        detail={"names": sorted(stored.keys())},
    )
    # Never echo secret values back.
    return {"ok": True, "stored": sorted(k for k, v in stored.items() if v), "provider": registry.provider_summary()}


@router.post("/provider/test")
async def test_provider(
    request: Request,
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN)),
) -> dict[str, Any]:
    health = await _provider_health()
    webhook_ready = await asyncio.to_thread(request.app.state.service.webhook_ready)
    await asyncio.to_thread(audit, user, "provider.test", entity_type="provider")
    return {
        "ok": True,
        "health": health,
        "webhook_ready": webhook_ready,
        "webhook_base_url": registry.provider_summary().get("webhook_base_url"),
        "note": (
            "A configured provider is not proof of reachability. Place a real call to a "
            "number you control to verify end to end."
        ),
    }


async def _provider_health() -> dict[str, Any]:
    provider = registry.get_provider()
    try:
        return await provider.health()
    except Exception as exc:  # pragma: no cover - defensive
        return {"provider": provider.name, "ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Audit / reports
# ---------------------------------------------------------------------------
@router.get("/audit")
async def audit_log(
    limit: int = Query(100, ge=1, le=500),
    user: dict[str, Any] = Depends(require_roles(UserRole.ADMIN, UserRole.NURSE)),
) -> dict[str, Any]:
    entries = await asyncio.to_thread(database.list_audit, limit)
    if not (auth.is_admin(user) or user.get("dev_bypass")):
        assigned = user.get("patient_id")
        if assigned is not None:
            entries = [e for e in entries if e.get("patient_id") in (None, assigned)]
    chain = await asyncio.to_thread(database.verify_audit_chain)
    return {"ok": True, "entries": entries, "chain": chain}


@router.get("/reports")
async def reports(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    calls = await asyncio.to_thread(lambda: database.list_telephony_calls(limit=200))
    messages = await asyncio.to_thread(lambda: database.list_messages(limit=200))
    escalations = await asyncio.to_thread(lambda: database.list_escalations(limit=200))
    by_call_state: dict[str, int] = {}
    for call in calls:
        by_call_state[call["state"]] = by_call_state.get(call["state"], 0) + 1
    by_message_state: dict[str, int] = {}
    for message in messages:
        by_message_state[message["state"]] = by_message_state.get(message["state"], 0) + 1
    by_severity: dict[str, int] = {}
    for escalation in escalations:
        by_severity[escalation["severity"]] = by_severity.get(escalation["severity"], 0) + 1
    return {
        "ok": True,
        "totals": {
            "calls": len(calls),
            "messages": len(messages),
            "escalations": len(escalations),
        },
        "calls_by_state": by_call_state,
        "messages_by_state": by_message_state,
        "escalations_by_severity": by_severity,
        "telephony": registry.provider_summary(),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _patient_contact(patient_id: int, contact_id: Optional[int]) -> Optional[dict[str, Any]]:
    if contact_id is not None:
        contact = database.get_contact(contact_id)
        if contact and contact.get("patient_id") == patient_id and contact.get("active"):
            return contact
        return None
    contacts = [c for c in database.list_contacts(patient_id) if c.get("active")]
    if not contacts:
        return None
    # Prefer a verified primary patient contact, then any patient contact.
    for contact in contacts:
        if contact.get("role") == "patient" and contact.get("is_primary") and contact.get("verification_status") == "verified":
            return contact
    for contact in contacts:
        if contact.get("role") == "patient" and contact.get("is_primary"):
            return contact
    for contact in contacts:
        if contact.get("role") == "patient":
            return contact
    return contacts[0]
