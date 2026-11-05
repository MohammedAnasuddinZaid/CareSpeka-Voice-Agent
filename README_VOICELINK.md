# CareSpeak VoiceLink

**A fully local, zero-cost, real-time AI voice line built on top of CareSpeak.**

VoiceLink adds a browser dialer to CareSpeak. One tab is a sample patient
(`CS-1001`), another is the AI care assistant (`CS-0000`, named **Aria**). You
speak into a microphone, a local VAD finds the end of your sentence, a local
whisper.cpp model transcribes it, a local Ollama model writes the reply, and a
local sherpa-onnx voice speaks it back — all on this computer. Nothing is sent
to a cloud API, and there is no billing account of any kind.

- Desktop UI: <http://127.0.0.1:3000/voicelink>
- Nurse/admin dashboard: <http://127.0.0.1:3000/dashboard>
- Phone UI (same Wi-Fi): `https://<your-LAN-IP>:3443/voicelink`
- Backend API: <http://127.0.0.1:8000> (docs at `/docs`)

VoiceLink now also ships a **care communication and escalation platform**: a
provider-agnostic telephony layer (Exotel, Twilio, or an honest mock), real
inbound/outbound call handling, an escalation engine, permission-controlled
family access, scheduled follow-ups, and a nurse/admin dashboard. Everything
above still works exactly as before. See [`TELEPHONY_SETUP.md`](TELEPHONY_SETUP.md),
[`PROVIDER_DECISION.md`](PROVIDER_DECISION.md), [`SECURITY.md`](SECURITY.md) and
[`OPERATIONS.md`](OPERATIONS.md).

---

## What it does

| Area | Implemented |
|---|---|
| Dialer | Extensions `CS-1001` (sample patient) and `CS-0000` (AI agent), call/answer/hang up |
| Call states | `IDLE → DIALING → CONNECTING → CONNECTED → LISTENING / PROCESSING / SPEAKING → ENDED` |
| Speech in | Browser mic → AudioWorklet → 16 kHz mono PCM → WebSocket → Silero VAD → whisper.cpp |
| Speech out | Ollama reply → sherpa-onnx VITS → WAV chunks → browser playback |
| Turns | Multi-turn conversation with per-call history and a cap of 40 turns / 30 minutes |
| Barge-in | Talk over Aria and the in-flight reply is cancelled and acknowledged |
| Push-to-talk | Hold-to-talk fallback that bypasses VAD entirely |
| Text fallback | Type a turn when a microphone is unavailable |
| Waveforms | Live mic level and agent playback level drawn from the real audio graph |
| Transcript | Live per-turn transcript with timestamps and ASR latency |
| History | Local SQLite history with detail view and clear, stored on this PC only |
| Phone | HTTPS LAN gateway with a locally generated CA for microphone access |
| Status | Real health checks for SQLite, Ollama, the LLM model, whisper, TTS and VAD |
| Demo mode | `CS-1001` is clearly labelled synthetic data; no real records are used |

---

## Quick start (Windows, PowerShell)

```powershell
./setup.ps1     # one time: venv, npm packages, models, local TLS certificate
./start.ps1     # starts Ollama, backend, frontend and the phone gateway
./health-check.ps1
./stop.ps1      # stops what start.ps1 started
```

Then open <http://127.0.0.1:3000/voicelink>, dial `CS-1001` → `CS-0000`, allow
the microphone, and talk. Type a turn instead if you have no microphone.

`setup.ps1` needs Python 3.10, Node.js, Ollama, and OpenSSL (bundled with Git for
Windows). It downloads the model files once; after that the stack runs offline.
The downloads are large (whisper ~148 MB, VITS-LJS ~109 MB) and are stored under
`backend/models/`, which is git-ignored.

### Latest measured results on this machine

Full numbers, method and caveats are in [`PERFORMANCE_REPORT.md`](PERFORMANCE_REPORT.md).

| Stage | Measured |
|---|---|
| Speech recognition (whisper base.en, 2–3 s utterance, CPU) | 448–621 ms |
| Text-to-speech (sherpa-onnx VITS-LJS, 4 threads, CPU) | RTF 0.17–0.39 |
| LLM first token (qwen2.5:3b, warm, CPU) | 63–245 ms |
| LLM throughput (warm, CPU) | 19–23 tokens/s |
| End-to-end first audio, typed turn (CPU contention) | ~5.9 s hardware/turn-dependent, see report |
| End-to-end first audio, spoken turn | ~1.5–2.5 s |

The GPU on this machine is currently occupied by another process, so VoiceLink is
running on the CPU. `WHISPER_BACKEND=cuda` is supported when the GPU is free.

---

## Using a phone as the microphone (real, over Wi-Fi)

Mobile browsers only grant microphone access on a secure origin, so VoiceLink
serves the phone over HTTPS with a certificate signed by a **local** CA that only
this network trusts.

1. Keep the PC and phone on the same private Wi-Fi network.
2. On the phone, open the CA link printed by `start.ps1`: `http://<LAN-IP>:3080/ca.crt`.
   - **Android:** download → Settings → Security → Encryption & credentials →
     Install a certificate → CA certificate → pick the downloaded file.
   - **iOS:** download → Settings → General → VPN & Device Management → install
     the profile → then Settings → General → About → Certificate Trust Settings →
     enable full trust for `CareSpeak Local CA`.
3. Open `https://<LAN-IP>:3443/voicelink` and allow the microphone.

The certificate is created by `setup.ps1` with OpenSSL and is re-signed
automatically when the PC's LAN address changes. Certificate and key files live in
`backend/runtime/` and are git-ignored. The gateway refuses any request that does
not come from a private (`127.x`, `10.x`, `192.168.x`, `172.16–31.x`) address.

> **Honest limit:** calling between browser tabs or devices on your own network
> is real, and it costs nothing. Calling an ordinary **telephone (PSTN)** number
> requires a paid carrier (Exotel primary, Twilio secondary). VoiceLink supports
> that path fully, but it is the operator's responsibility to supply credentials,
> a verified number, and a public HTTPS callback. With no credentials the
> platform deliberately runs in **mock** mode and never places a real call. See
> [`TELEPHONY_SETUP.md`](TELEPHONY_SETUP.md).

---

## Care platform (telephony + dashboard)

Beyond the browser dialer, VoiceLink provides a durable care workflow. The
browser demo is unchanged; the platform is additive.

| Area | Implemented |
|---|---|
| Telephony abstraction | `startOutboundCall`, `handleInboundCall`, `getCallStatus`, `endCall`, `sendMessage`, `verifyWebhook`, `handleProviderEvent` — one interface, real adapters + a mock |
| Providers | Exotel (primary, India, raw PCM AgentStream), Twilio (secondary, µ-law Media Streams, signed webhooks), mock (offline) |
| Honest status | Every surface distinguishes **live** / **configured-unverified** / **mock** / **unavailable** / **disabled**; “accepted” is never shown as “delivered” |
| Real calls | Outbound nurse→patient-AI calls and inbound calls where the carrier supports them; bidirectional audio bridged to the same local ASR/LLM/TTS engines, with barge-in and stale-response cancellation |
| Escalations | Deterministic rules + a bounded language check with confirmation; routine / follow-up / urgent / emergency; durable records, nurse notification, retry and backup, unacknowledged alerts; immediate danger is routed to the emergency number |
| Messages | SMS / voice / AI messages with real delivery states (sent **is not** delivered); quiet hours and rate limits |
| Family access | Mode 1 (family ↔ AI within granted scope) and Mode 2 (approval-gated direct call), both expiring and revocable |
| Scheduling | Durable server-side follow-ups with quiet hours, retry/backoff, and no duplicate calls |
| Security | Dashboard auth, RBAC, per-patient access, number verification, short-lived single-use challenges, signed/authenticated webhooks, replay protection, idempotency, audit hash chain |
| Dashboard | Overview, Patient workspace, Escalation center, Family access, Provider settings, Audit & reports |

The dashboard reads only real backend state; nothing is hard-coded. See the docs
linked above for setup, security and operations.

---

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────────────────────┐
│ Browser (Next.js)        │        │ Local backend (FastAPI, 127.0.0.1:8000)   │
│ /voicelink               │  WS    │                                          │
│  mic → AudioWorklet ─────┼────────▶ /ws/voicelink                             │
│  playback ← Web Audio ◀──┼────────┤   Silero VAD (ONNX, 256-sample windows)   │
│  transcript / history ◀──┼── REST │        │                                 │
└──────────────────────────┘        │        ▼                                 │
                                    │   whisper.cpp server :8178 (base.en)     │
┌──────────────────────────┐        │        │                                 │
│ Phone browser            │ HTTPS  │        ▼                                 │
│ https://LAN-IP:3443 ─────┼───────▶│   Ollama qwen2.5:3b :11434               │
└──────────────────────────┘        │        │                                 │
      ▲  local CA on :3080          │        ▼                                 │
      └── phone-gateway.mjs ────────┤   sherpa-onnx VITS-LJS (22.05 kHz)       │
                                    └──────────────────────────────────────────┘
```

- `backend/app/main.py` — REST + WebSocket routes.
- `backend/app/call_manager.py` — call state machine, turn orchestration, barge-in.
- `backend/app/vad.py` — streaming Silero VAD and utterance segmentation.
- `backend/app/asr.py` — whisper.cpp client, auto-starts the server, CPU fallback.
- `backend/app/llm.py` — streaming Ollama client with cancellation.
- `backend/app/tts.py` — sherpa-onnx VITS synthesis, sentence chunking.
- `backend/app/engine.py` — real health checks and warm-up.
- `backend/app/security.py` — extension validation, emergency guard, local-only checks.
- `backend/phone-gateway.mjs` — HTTPS/WSS reverse proxy plus CA download server.
- `src/app/voicelink/page.tsx` and `src/hooks/useVoiceCall.ts` — the client.
- `public/worklets/voicelink-capture.js` — native-rate → 16 kHz resampling worklet.

Platform modules:

- `backend/app/telephony/` — provider interface, `registry` (selection + honest mode), `exotel`/`twilio`/`mock` adapters, `audio` (PCM/µ-law + resampling), `webhooks` (signature + replay + idempotency), `router` (webhook + media WebSocket), `service` (orchestration), `bridge` (carrier audio ↔ local AI), `numbers`, `models` (state machines).
- `backend/app/escalation.py` — deterministic + bounded-language classification.
- `backend/app/scheduler.py` — durable leased jobs with retry/backoff.
- `backend/app/auth.py` — scrypt passwords, sessions, RBAC, audit.
- `backend/app/secrets_store.py` — git-ignored secret storage, never returned.
- `backend/app/platform_api.py` — dashboard REST API.
- `src/lib/platformApi.ts` and `src/components/dashboard/*` — the dashboard client and panels.

The WebSocket protocol is JSON control messages (`start_call`, `text_input`,
`playback_done`, `ptt_start`/`ptt_end`, `barge_in`, `muted`, `end_call`) plus raw
binary frames of little-endian 16-bit 16 kHz mono PCM.

---

## Configuration

Everything has a safe local default. Optional overrides can be placed in a
git-ignored `.env.voicelink` at the repository root (see `backend/app/config.py`):

```
WHISPER_BACKEND=cpu        # auto | cpu | cuda
OLLAMA_MODEL=qwen2.5:3b
TTS_THREADS=4
VAD_THRESHOLD=0.55
VOICELINK_STORE_TRANSCRIPTS=true
VOICELINK_LOG_TRANSCRIPTS=false
VOICELINK_DEMO_MODE=true
```

Never put API keys in these files; VoiceLink does not use keys and the files are
purely local.

---

## Testing

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest tests -q     # backend: 36 tests
cd ..
npm test                                          # frontend: 58 tests
```

The backend suite runs entirely against the deterministic **mock** provider and
an isolated database; it never places a real call. It covers number
normalisation/masking, RBAC, consent, provider-config validation, call and
message transitions, duplicate/out-of-order webhooks, signature verification,
idempotency, challenge expiry/replay, family approval/revocation, escalation
thresholds, retry/backoff, the scheduler, provider failure/recovery and
persistence across a restart. Real end-to-end PSTN testing requires credentials
and a verified number and is performed manually (see
[`TELEPHONY_SETUP.md`](TELEPHONY_SETUP.md)).

The health endpoint is a live functional check, not a hard-coded indicator:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/voicelink/health?refresh=true
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Backend: OFFLINE` | Run `./start.ps1`, then check `backend/logs/backend.err.log` |
| Microphone blocked | Use `https://` (phone) or `http://127.0.0.1` (desktop); allow mic permission |
| Phone can't connect | Same Wi-Fi network? CA installed and trusted? Check `health-check.ps1` |
| First reply is slow | The first LLM call loads the model; later turns are fast |
| Whisper not ready | Its server is started on first use; watch `backend/logs/whisper-server.log` |
| Port already in use | Run `./stop.ps1`, then `./start.ps1` |

## License

VoiceLink is part of CareSpeak (MIT). Third-party components keep their own
licenses: whisper.cpp and Silero VAD are MIT, sherpa-onnx and the VITS-LJS model
card are Apache-2.0, qwen2.5:3b is Apache-2.0. See
[`ZERO_COST_POLICY.md`](ZERO_COST_POLICY.md).
