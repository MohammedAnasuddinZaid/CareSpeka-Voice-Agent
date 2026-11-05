# Telephony setup — connecting VoiceLink to a real carrier

This document is the operator's path from the offline mock to real phone calls.
Nothing here is automatic: real calls require a funded carrier account, a
verified caller id, and a **public HTTPS address** the carrier can reach.

> **Read first.** With no credentials, VoiceLink runs with the mock provider and
> places **no** real call or message. The dashboard always shows the current
> mode, e.g. “Simulated (mock) — no real telephone call is placed” or
> “Provider configured — not yet verified with a real call”.

---

## 1. Prerequisites

| Item | Why |
|---|---|
| Carrier account (Exotel or Twilio) | Credentials to authorise calls/SMS |
| A voice-capable number (ExoPhone / Twilio number) | The caller id that dials out and receives inbound |
| A verified destination number you control | The only safe way to test end to end |
| A public HTTPS endpoint reaching this backend | Carriers deliver status webhooks and the media stream over the internet |
| (India SMS) DLT entity + template + sender id | Required by law for outbound SMS |

**Never call a real patient number while testing.** Use a number you own.

---

## 2. Configure credentials

Credentials are stored outside the database and never returned by the API. Two
supported locations (environment variables win over the file):

1. A git-ignored `.env.voicelink` at the repository root, **or**
2. The dashboard → **Provider** tab (administrator only), which writes to the
   git-ignored `backend/runtime/provider_secrets.json` with best-effort `0600`
   permissions.

> Secrets are never written to the database, never logged, and the API only ever
> reports whether a value is *set* — never the value itself.

### Exotel

```
TELEPHONY_PROVIDER=exotel
EXOTEL_API_KEY=...
EXOTEL_API_TOKEN=...
EXOTEL_ACCOUNT_SID=...
EXOTEL_CALLER_ID=+91XXXXXXXXXX      # your ExoPhone
EXOTEL_WEBHOOK_SECRET=<random long string>
EXOTEL_SUBDOMAIN=api.in.exotel.com  # or api.exotel.com (Singapore)
EXOTEL_SENDER_ID=...                # SMS only
EXOTEL_DLT_ENTITY_ID=...            # SMS only (India)
EXOTEL_DLT_TEMPLATE_ID=...          # SMS only (India)
```

`EXOTEL_WEBHOOK_SECRET` is **required**: Exotel does not sign callbacks, so
VoiceLink authenticates them with this shared secret appended to the callback
URL. Without it, webhook verification fails closed.

### Twilio

```
TELEPHONY_PROVIDER=twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX     # voice caller id
TWILIO_MESSAGING_NUMBER=+1XXXXXXXXXX # optional, for SMS
```

Twilio webhooks are authenticated with `X-Twilio-Signature`
(HMAC-SHA1 over the URL + sorted parameters) using `TWILIO_AUTH_TOKEN`; no
shared secret is needed.

---

## 3. Publish a public HTTPS callback

A carrier must reach this server from the internet to deliver:

- `POST /api/telephony/{provider}/voice` — the answer URL (Twilio returns TwiML).
- `POST /api/telephony/{provider}/events` — call and message status callbacks.
- `WS   /api/telephony/{provider}/media` — the bidirectional audio stream.

Set the public address once, and use it for **both**:

```
PUBLIC_BASE_URL=https://voicelink.example.com
# or, to override only telephony callbacks:
TELEPHONY_WEBHOOK_BASE_URL=https://voicelink.example.com
```

VoiceLink derives the `wss://` media URL automatically and appends the Exotel
shared-secret token.

### Ways to expose the backend (choose one)

- **Deploy the backend** behind a TLS-terminating reverse proxy (Caddy, nginx,
  a cloud load balancer). Preferred for anything beyond a short test.
- **An authenticated tunnel** (e.g. an HTTPS tunnel with access control) while
  testing. Document the tunnel, keep it authenticated, and shut it down when
  finished.

**Never** expose the local `127.0.0.1:8000` port directly. The backend binds to
loopback by default; the phone gateway (`:3443`) accepts only private-network
clients.

The dashboard **Provider** tab shows the current callback base and flags it
`public HTTPS` or `not public HTTPS`, and explains that a reachable URL is still
not proof of a working call.

---

## 4. Register the callback URLs with the carrier

VoiceLink builds these automatically; register the equivalents in the carrier
console if the carrier requires it.

For Exotel, requests carry:
- `From` — the number to dial,
- `CallerId` — your ExoPhone,
- `StreamUrl` + `StreamType=bidirectional` — the media WebSocket,
- `StatusCallback` + `StatusCallbackEvents[]=answered|terminal|ringing`.

For Twilio, configure the number's voice webhook to the `answer_url`; the
backend responds with TwiML that opens the Media Stream to the `stream_url`.

---

## 5. Verify — in this order

Do not describe a step as working until you have observed it.

1. **Configuration check.** Dashboard → Provider → *Run configuration check*.
   A `configured-unverified` result means credentials parsed; it is **not** proof
   of reachability.
2. **Outbound call to a number you control.** Dashboard → Patients → select the
   patient → *Start call*. Watch the state move through queued → ringing →
   answered → connected from real provider events, then hang up. Confirm a live
   two-way AI conversation: the patient hears the AI and the AI responds to the
   patient.
3. **Inbound call** (where the carrier supports it). Dial the carrier number from
   your phone; the answer URL and media stream should identify the caller and
   connect the AI.
4. **Message delivery.** Send an SMS from the patient workspace. Confirm the
   state progresses to **delivered** only when the carrier reports delivery —
   “accepted/sent” is never shown as delivered.
5. **Webhook authenticity.** Confirm events are accepted and bad tokens are
   rejected (`401`/`403`), and that duplicate events do not double-apply.

Record real results (or the exact failure) in your operator notes. Do not record
a capability as finished from configuration alone.

---

## 6. What is finished in this repository vs. what remains

**Finished and tested automatically (mock provider):** provider abstraction and
selection, phone-number normalisation/masking, call and message state machines,
duplicate/out-of-order webhook handling, idempotency, signature verification,
verification challenge expiry/replay, family approval/revocation, escalation
thresholds, retry/backoff, the scheduler, and persistence across a restart.

**Requires an operator with real credentials to complete:** a real outbound
call, real two-way PSTN AI audio, real inbound calls, and real SMS delivery.
These cannot be demonstrated without a funded carrier account and a public HTTPS
endpoint, and are therefore reported honestly as *not yet verified here* until
you perform them.

---

## 7. Costs and trial restrictions (operator's responsibility)

- Carriers bill per call/minute and per SMS. A funded, verified account is
  required.
- Indian SMS additionally requires DLT registration of the sender id, entity and
  template.
- Trial accounts commonly restrict destination countries/numbers, volume, and
  caller-id, and may prepend trial notices. These are not bypassed in code.

See [`PROVIDER_DECISION.md`](PROVIDER_DECISION.md) for the provider rationale and
honest limitations.
