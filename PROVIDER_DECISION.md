# Provider decision — VoiceLink telephony

VoiceLink talks to carriers only through the `TelephonyProvider` interface in
`backend/app/telephony/base.py`. The service layer never imports a carrier SDK,
so providers are interchangeable and the mock can never be mistaken for a real
carrier. The active provider is described to the dashboard with an honest
`operating_mode` (`live`, `configured-unverified`, `mock`, `unavailable`,
`disabled`).

## Summary

| Priority | Provider | Role | Status in this repo |
|---|---|---|---|
| 1 | **Exotel** | Primary (India) | Adapter implemented: calls, bidirectional PCM audio, SMS with DLT, status callbacks |
| 2 | **Twilio** | Secondary / fallback | Adapter implemented: REST calls + SMS, Media Streams (µ-law 8 kHz), signed webhooks |
| 3 | **Mock** | Offline demo & tests | Always selected when no real credentials exist; never places a real call |

`TELEPHONY_PROVIDER` is `auto` by default: `auto` picks the first *configured*
real provider in the order Exotel → Twilio, and otherwise falls back to `mock`.
Force one with `TELEPHONY_PROVIDER=exotel|twilio|mock`.

## Why Exotel is primary

- **India-first PSTN reach.** Exotel provides Indian local numbers (ExoPhones)
  and Indian SMS with DLT compliance, which matches the intended deployment.
- **Native bidirectional audio.** Exotel **AgentStream** streams raw linear PCM
  (`audio/x-raw`) as base64 inside JSON events (`connected`, `start`, `media`,
  `dtmf`, `mark`, `stop`). Raw PCM avoids a lossy transcoding step on the path
  from the carrier to the local AI. We request **16-bit little-endian mono at
  8000 Hz**, in chunks that are a multiple of 320 bytes.
- **Simple call initiation.** `POST /v1/Accounts/{AccountSid}/Calls/connect`
  with `From`, `CallerId` (ExoPhone), `StreamUrl`, `StreamType=bidirectional`,
  plus optional `Record`, `CustomField` and `StatusCallback`.
- **HTTP Basic auth** over `https://api.in.exotel.com` (India) or
  `https://api.exotel.com` (Singapore).

### Exotel characteristics this code accounts for

- **No published webhook signature.** Exotel does not sign callbacks, so
  authentication is done by appending a shared secret token to the callback URL
  we register (`?token=<EXOTEL_WEBHOOK_SECRET>`) and re-checking it on the way
  in. If the secret is not configured, verification **fails closed**. Endpoints
  are expected to sit behind HTTPS and, ideally, the provider's source
  allow-list.
- **SMS needs DLT.** Outbound Indian SMS requires a registered sender id and DLT
  entity/template ids (`EXOTEL_SENDER_ID`, `EXOTEL_DLT_ENTITY_ID`,
  `EXOTEL_DLT_TEMPLATE_ID`). Without these, message sending is refused.
- **Media format** is declared as `AudioFormat(encoding="pcm16", sample_rate=8000)`.

## Why Twilio is secondary

- **Global reach and well-documented signing.** Twilio REST covers calls and
  messages; Media Streams deliver base64 **µ-law, 8 kHz**, which the adapter
  decodes to PCM16 for the local engine.
- **Webhook authenticity is verifiable.** Twilio signs requests with
  `X-Twilio-Signature` = HMAC-SHA1(auth token, URL + sorted params), which the
  adapter verifies before any state change.
- **Trade-offs** versus Exotel: µ-law requires a transcode step, and pricing in
  India is generally higher. It is kept as a fallback and as a second reference
  implementation proving the abstraction is not Exotel-specific.

## Why the mock provider exists

- Offline development and the automated test suite must exercise the entire
  state-machine, persistence, escalation and scheduler paths **without** placing
  a call or spending money.
- The mock's `operating_mode()` is always `mock`, and the dashboard prints
  “Simulated (mock) — no real telephone call is placed”. It cannot be silently
  promoted to a real carrier.

## Honest limitations

- **Credentials are required for real calls.** This repository ships no live
  carrier account. With no credentials, the platform runs in mock mode and does
  not contact any external service.
- **A public HTTPS callback is mandatory.** A carrier cannot reach
  `127.0.0.1` or a private LAN address. Until `PUBLIC_BASE_URL` /
  `TELEPHONY_WEBHOOK_BASE_URL` points at a public HTTPS endpoint, the service
  refuses real calls and messages with `reason: webhook_not_public`.
- **Configuration is not proof of reachability.** A configured provider shows
  `configured-unverified` until a real call to a number you control is observed
  end to end.
- **Costs and trial limits are the operator's responsibility.** Exotel and
  Twilio both require a funded/verified account; Indian SMS additionally requires
  DLT registration. Trial accounts commonly restrict destination numbers,
  message volume and caller-id. These limits are not worked around in code.
- **Recording is opt-in.** `TELEPHONY_RECORD_CALLS` defaults to `false`; consent
  must be obtained before enabling it.
