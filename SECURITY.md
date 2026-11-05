# Security model — VoiceLink care platform

This document describes what the platform actually enforces. It makes **no
compliance claims** and uses no home-grown cryptography.

## Authentication & sessions

- Passwords are hashed with **scrypt** (`hashlib.scrypt`) using a per-password
  random salt. Plaintext passwords are never stored.
- Sessions use an opaque, random token in an `httpOnly`, `SameSite=Lax` cookie
  (`voicelink_session`); the cookie is marked `Secure` when `PUBLIC_BASE_URL` is
  HTTPS. Sessions expire after `VOICELINK_SESSION_MINUTES` (default 480) and are
  invalidated on sign-out.
- Repeated failed sign-ins trigger a lockout (`VOICELINK_LOGIN_MAX_ATTEMPTS`
  then `VOICELINK_LOGIN_LOCKOUT_S`).
- Sign-in failures do not reveal whether a username exists (enumeration
  protection).
- The first administrator password is generated on first run and written to the
  git-ignored `backend/runtime/admin_credentials.txt`. Change it after first
  sign-in.

## Authorisation (server-side, on every sensitive action)

- Roles: **admin**, **nurse**, **patient**, **family**.
- A nurse assigned to a single patient is refused for other patients
  (`ensure_patient_access`), independent of what the UI shows.
- Write actions (start call, send message, add/revoke contact, verify, grant or
  revoke family access, decide requests, provider credentials, follow-ups) are
  guarded by role checks on the server. The dashboard hides controls a role
  cannot use, but the server is the source of truth.
- Admin-only: changing provider credentials, provider tests.

## Phone numbers & verification

- Numbers are normalised to **E.164** and stored alongside a **masked** form.
  The API never returns the full E.164 value; only the mask (e.g. `******3210`).
- A contact is **not** treated as reachable merely because its format is valid.
  Ownership is proven with a **short-lived, single-use challenge** code
  (`VOICELINK_VERIFICATION_TTL_S`, `VOICELINK_VERIFICATION_MAX_ATTEMPTS`).
  Codes are stored only as an HMAC of the code, never in plaintext.
- Caller id received on inbound calls is **never trusted** for identity; it is
  used only to look up a registered contact.

## Provider credentials

- Stored outside the database, in environment variables or the git-ignored
  `backend/runtime/provider_secrets.json` (best-effort `0600`).
- Never logged, never returned by the API. The Provider tab reports only whether
  each value is *set*.
- No bespoke encryption is used; the trust boundary is filesystem permissions and
  the environment, consistent with the rest of the local stack.

## Webhook authenticity & replay protection

- **Twilio**: `X-Twilio-Signature` verified (HMAC-SHA1 over URL + sorted params)
  before any state change.
- **Exotel**: callbacks carry a shared-secret token appended to the registered
  URL; mismatches are rejected. If the secret is unconfigured, verification
  **fails closed**.
- Every event is recorded by its provider event id; **replays are ignored** and
  do not double-apply. Idempotency keys prevent duplicate call/message creation.
- State transitions are validated against explicit state machines; terminal
  states cannot be resurrected by a late event.

## Emergency & escalation safety

- An **emergency** classification overrides quiet hours and soft rate limits;
  genuine immediate danger is routed to the emergency number (`112` by default)
  with honest wording.
- Escalations are durable records with an action trail; unacknowledged alerts
  remain visible in the dashboard.
- The AI is an **assistant**, not a nurse and not an emergency service, and never
  claims to have completed an action it did not.

## Data minimisation, consent & retention

- Demonstration data is **synthetic** and labelled as such; no real patient
  records ship with the repository.
- Message bodies and transcript excerpts are stored only as needed to operate and
  audit; transcripts can be turned off (`VOICELINK_STORE_TRANSCRIPTS=false`) and
  are never logged by default (`VOICELINK_LOG_TRANSCRIPTS=false`).
- Call recording is **opt-in** (`TELEPHONY_RECORD_CALLS=false` by default) and
  requires consent.
- Family access is explicit, scope-limited, expiring, and **revocable** at any
  time.
- A retention purge helper (`database.purge_older_than`) supports deleting old
  records; see [`OPERATIONS.md`](OPERATIONS.md).

## Audit trail

- Security-relevant actions are written to an append-only audit table with a
  **hash chain**; `GET /api/platform/audit` verifies the chain and reports
  integrity. A broken chain is surfaced loudly in the dashboard.
- Emergency-related audit entries are part of the same tamper-evident chain.

## Network exposure

- The backend binds to loopback (`127.0.0.1:8000`) by default. The phone gateway
  (`:3443`) refuses non-private clients.
- CORS allows only localhost and RFC1918 origins, with credentials enabled. A
  public origin cannot pass the configured origin regex.
- Carriers reach the backend only through the operator-provided public HTTPS
  endpoint. The local port must never be exposed directly.

## Out of scope / not claimed

- No HIPAA, GDPR, DPDP or other compliance certification is claimed.
- No third-party penetration test has been performed.
- No guarantee that a configured carrier is reachable; only a real, observed
  call proves that.
