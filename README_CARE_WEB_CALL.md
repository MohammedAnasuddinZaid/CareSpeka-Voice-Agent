# Web Voice Call — Demo

Browser-to-browser AI healthcare voice calls, built on top of CareSpeak × VoiceLink and designed to deploy on Vercel with no media server, no VPS and no paid AI API.

> **This is a demonstration channel.** A Web Voice Call — Demo is a peer-to-peer browser call, **not a telephone call**. It never appears in the telephony history and is always labelled "Web Voice Call — Demo" in the UI. The existing VoiceLink telephony integration is untouched and remains a separate mode.

---

## 1. What it does

1. A **nurse** signs in. The console puts a **voice assistant** first: the nurse can *speak or type* any question about a patient ("what medications is Anita on?", "what did she say in the last call?", "who needs follow-up today?") and get an answer read straight from the stored record. The same input can **dictate a message to a patient** ("send Anita a message saying please weigh yourself tomorrow") and it is saved to their record.
2. The nurse picks a synthetic patient and starts a session.
3. CareSpeak shows a **QR code** and a **6-digit joining code** (both expiring, single-use).
4. The **patient** scans the QR (or types the code) on their phone, allows the microphone, and joins — and sees any messages the nurse left.
5. Audio flows **peer-to-peer over native WebRTC**. Only SDP/ICE control messages pass through the API.
6. The **nurse's browser hosts the AI**: it hears the patient, transcribes, reasons, and replies — out loud on the patient's phone.
7. Everything is written to a **live transcript**, and ending the session produces a grounded, **reviewable clinical report** plus an **audit trail**.

Nothing is required from a paid API. If the on-device models are not loaded, a deterministic, clinically cautious **rule-based care engine** keeps the demo working — clearly labelled as such. When `GEMINI_API_KEY` is set, the server can also use Gemini to phrase an answer over the retrieved evidence; without a key, or when the model is unavailable, the same evidence is answered locally.

---

## 1b. Free browser call — no telephony, no charges

`/care/phone?session=…&pair=…` is a single-device voice agent that uses the **same portal brain** as the telephone webhook:

- the agent greets the caller with the linked patient's briefing (name, concern, live readings);
- the caller speaks with the browser Web Speech API, or types when it is unavailable;
- replies are spoken with speech synthesis and always shown as a transcript;
- answers are retrieved from the whole authorised chart (profile, conditions, medications, allergies, observations, encounters, care plan, inserted documents, call transcripts, reports, tasks and messages) and labelled **from chart** or **general guidance**;
- the transcript is saved per session in the browser, restored after a reload, and can be copied or downloaded as a text note;
- "send a message to …" dictation is executed for real against the patient record.

The Twilio webhook offers a phone-keypad menu on the opening turn: **1** repeat the briefing, **2** read the live readings, **3** flag the call as urgent in the audit trail, **9** end the call. Empty speech gets one polite retry rather than a replayed opening.

It needs **no Twilio account, no phone number, and no telephony minutes**. The patient's screen (`DemoCallButton`) and the nurse portal (`PortalAssistant`) both expose it as **Browser call**; the panel also shows a QR that moves the same call to a phone.

> **Twilio trial limitation.** Twilio's free trial rejects every custom-TwiML outbound call (`trial accounts have limited parameter access`). The app detects that error (`kind: "trial_custom_call"`) and opens the free browser call instead of showing the raw provider message. Real PSTN calls work after upgrading Twilio and verifying the sender/recipient numbers.

---

## 2. Architecture

```
   NURSE BROWSER                                  PATIENT PHONE
 ┌───────────────────────────┐                 ┌───────────────────────────┐
 │ Nurse dashboard (/care)    │                 │ Join page (/care/join)     │
 │  • auth (HttpOnly cookie)  │                 │  • QR / code join          │
 │  • WebRTC offerer          │◀── WebRTC ────▶ │  • WebRTC answerer         │
 │  • Browser AI host:        │   audio P2P     │  • Web Speech (optional)   │
 │    VAD → Whisper → WebLLM  │                 │  • goggles in-data channel │
 │  • TTS / reply routing     │                 │  • speaks AI reply         │
 └─────────────┬─────────────┘                 └───────────────┬───────────┘
               │  HTTPS (control plane only)                    │
               ▼                                                 ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  Next.js route handlers on Vercel  (/api/care/*)              │
        │  auth · patients · sessions · QR · join · signal · events ·   │
        │  transcript · agent (fallback) · assistant · messages ·       │
        │  report · audit · tasks                                       │
        └───────────────────────────────┬──────────────────────────────┘
                                        ▼
                     KV driver:  Upstash Redis (prod) │ JSON file (dev) │ memory (tests)
```

- **Media**: native `RTCPeerConnection`, `getUserMedia`, STUN, optional TURN — no LiveKit, no media server.
- **Signalling**: short-lived HTTP-polling records (`offer` / `answer` / `ice` / `bye`) through a Vercel route. This is what lets it survive serverless cross-instance routing without a WebSocket server.
- **AI host**: the nurse's desktop browser. Model downloads are **opt-in** and never automatic.
- **Persistence**: a storage-driver abstraction so one codebase runs on Upstash Redis (Vercel), a local JSON file (dev), or in-memory (tests / no-Redis fallback). The UI reports which driver is active and warns loudly when it is not persistent.

### Why polling instead of WebSockets
Vercel Functions are request/response and may run in different instances or regions. An in-memory WebSocket broker would not be shared. Polling a persistent, append-only list is boring, robust and cheap for a demo. Media never touches the server.

---

## 3. Clinical safety posture

- The report is grounded **only** in the session transcript and the patient's authorised record. Every fact is tagged `record`, `patient` or `AI`.
- The AI **never diagnoses, prescribes, or invents vitals, medications or history**. This is enforced in the system prompt *and* by the deterministic fallback engine.
- Red-flag symptoms (chest pain, breathlessness at rest, fainting, severe bleeding, new confusion, suicidal thoughts, falls) are detected **server-side on every transcript line**, regardless of which ASR produced the text, and raise an escalation.
- A report is a **draft** until a nurse reviews and approves it. Approval is recorded with the reviewer's name and timestamp.
- All patient records in this demo are **synthetic** and flagged `synthetic: true` in the record panel.

---

## 4. Pages & API surface

**Pages**
| Path | Purpose |
| --- | --- |
| `/care` | Nurse console (sign in → voice assistant → patients → start call → live transcript, report, audit). |
| `/care/join?t=<token>` | Patient joining page (also accepts a manual code; shows the nurse's messages). |

**API routes** (all under `src/app/api/care/`, all `force-dynamic`)
`auth/login`, `auth/logout`, `auth/me`, `config`, `patients`, `patients/[id]`, `sessions`, `sessions/[id]`, `sessions/[id]/qr`, `join`, `signal`, `events`, `transcript`, `agent`, `assistant`, `messages`, `report`, `report/[id]`, `audit`, `tasks`.

- `POST /api/care/assistant` — the nurse voice assistant. Answers from the full patient record and executes dictated `send_message` actions. Deterministic and record-grounded; no model needed.
- `GET/POST /api/care/messages` — nurse sends/lists patient messages; a patient can read their own messages with their participant token.

---

## 5. Running it locally

```bash
npm install
npm run dev          # http://localhost:3000
```

Open **http://localhost:3000/care** and sign in with the demo credentials:

| Field | Value |
| --- | --- |
| Username | `nurse.demo` |
| Password | `nurse.demo` |

> Change these with `CARE_NURSE_USER` / `CARE_NURSE_PASS` before any real use. The dashboard shows a warning while the built-in demo account is active.

Local storage defaults to a JSON file under `.care-data/` (git-ignored). To force a driver:

```bash
CARE_STORE=memory npm run dev     # non-persistent, resets on restart
CARE_STORE=file   npm run dev     # .care-data/care-store.json
CARE_STORE=redis  npm run dev     # requires UPSTASH_REDIS_REST_URL + _TOKEN
```

### Seeding
Fourteen synthetic patients are written into the store on first access (`src/lib/care/seedPatients.ts`), each with conditions, medications, allergies, observation series, prior encounters and a care plan. Thirty-one detailed clinical documents (discharge summaries, clinic letters, monitoring logs and telephone notes) are seeded separately (`src/lib/care/seedDemo.ts`) and indexed for retrieval. The first time the store is used, a small, clearly-synthetic **demo history** is also seeded (completed sessions — one escalated and reviewed, one open; grounded reports; follow-up tasks; and messages) so a freshly deployed site is not empty.

Patient seeding and record seeding are **versioned and idempotent**: an existing store receives newly added patients and documents without duplicating old ones, and a patient the nurse deleted is never resurrected. Seeding is skipped in tests and can be disabled with `CARE_SEED_DEMO=false`. To reset a file store, delete `.care-data/care-store.json`.

---

## 6. Exact demo procedure

Do this on **two devices on the same network** (a laptop for the nurse and a phone for the patient). HTTPS or `localhost` is required for microphone access.

1. **Nurse** → `https://<your-host>/care` → sign in (`nurse.demo` / `nurse.demo`).
2. **Nurse** → talk to the **care assistant** (top of the console): type or speak *"What medications is Anita on?"*, *"What did Anita say in the last call?"*, or *"Who needs follow-up today?"*. To leave a note, say *"send a message to Anita saying please weigh yourself tomorrow morning"* — it is saved and shown on her joining page.
3. **Nurse** → in **Patients**, click **Call** next to **Anita Sharma**. A QR card appears — leave the page open (this is also the AI host).
4. **Nurse** (optional) → in the **AI engine** panel, click **Load** next to *Speech recognition* and *Reasoning* to download the on-device models. Skip this to use the built-in care engine.
5. **Patient** → scan the QR with the phone camera → tap the link → see the nurse's message → **Join and allow microphone** → allow the mic.
6. The **Live connection** panel turns green (`Peer: connected`, `ICE: connected`). The AI speaks its greeting through the phone.
7. **Patient** talks. Try:
   - "I've been feeling a bit more tired and my ankles are a little swollen." → AI asks heart-failure-relevant follow-ups.
   - "I have crushing chest pain." → the nurse dashboard raises a **red escalation** in real time; the AI tells the patient their care team is being alerted.
8. Watch the **Live transcript**, **AI insights** and **Session events** update live.
9. **Nurse** → **End session** → a **draft clinical report** is generated.
10. **Nurse** → review, optionally edit the summary, add a review note → **Approve report**.
11. **Nurse** → expand the **Audit trail** — every key action has a timestamped entry.

### WebRTC-specific checks
- Confirm the browser dev console shows no TURN errors and `pc.connectionState === "connected"`.
- Toggle the patient's Wi-Fi off and on: `Peer` moves to `reconnecting` then back to `connected`, or use **Reconnect** on the nurse side to renegotiate.
- Refresh the patient page mid-call: the participant token is stored in `sessionStorage`, so the join resumes automatically.
- Deny the microphone on the patient page: the UI shows a "Microphone off" badge and a plain-language explanation; nothing silently breaks.

---

## 7. Environment variables

Copy `.env.example` to `.env.local`. The Web Voice Call — Demo entries:

| Variable | Required | Purpose |
| --- | --- | --- |
| `CARE_NURSE_USER` / `CARE_NURSE_PASS` | recommended | Nurse sign-in (defaults `nurse.demo`). |
| `CARE_NURSE_NAME` | optional | Display name shown to patients. |
| `CARE_ADMIN_USER` / `CARE_ADMIN_PASS` | optional | Extra admin account. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **required on Vercel** | Persistent, cross-instance store. Without it the store is memory-only and the UI warns. |
| `NEXT_PUBLIC_CARESPEAK_URL` | optional | Public base URL used to build QR links (auto-detected from the request otherwise). No trailing slash. |
| `CARE_TURN_URL` / `CARE_TURN_USERNAME` / `CARE_TURN_CREDENTIAL` | recommended | TURN relay fallback for restrictive/mobile networks. |
| `CARE_JOIN_TTL_MINUTES` | optional | Join-link lifetime (default 30). |
| `CARE_MAX_SESSION_MINUTES` | optional | Session cap (default 30). |
| `CARE_SIGNAL_POLL_MS` | optional | Signalling poll interval (default 1200). |
| `CARE_ASR_MODEL` | optional | Transformers.js model id (default `Xenova/whisper-tiny.en`). |
| `CARE_LLM_MODEL` | optional | WebLLM model id (default `Llama-3.2-1B-Instruct-q4f16_1-MLC`). |
| `GEMINI_API_KEY` | optional | Server-side Gemini key for phrasing answers over retrieved evidence. Without it the local evidence engine answers. |
| `GEMINI_MODEL` / `GEMINI_FAST_MODEL` / `GEMINI_DEEP_MODEL` | optional | Override the primary, low-latency or deep model. The client falls back across a stable model list. |
| `CARE_STORE` | optional | Force `redis` \| `file` \| `memory`. |

---

## 8. Dependencies

The retrieval layer uses **`minisearch`** (local, offline full-text ranking) so answers are deterministic and work without an embedding service. Everything else uses the browser's built-in WebRTC, `AudioWorklet`, `speechSynthesis` and `SpeechRecognition`, plus the already-present `qrcode` (server-side QR) and `@upstash/redis` (persistence). Gemini is an optional server-side enhancement.

The on-device models are fetched **at runtime from a CDN only when a user clicks Load**, and are never bundled:

- `@huggingface/transformers` (Whisper, ~40 MB) — via `https://cdn.jsdelivr.net/...`
- `@mlc-ai/web-llm` (Llama-3.2-1B, ~0.8–1 GB) — via `https://cdn.jsdelivr.net/...`

The existing Content-Security-Policy already allows `cdn.jsdelivr.net` (scripts) and `https:` (connect), so no CSP change is needed. If you self-host the models, update `CARE_ASR_MODEL` / `CARE_LLM_MODEL`.

---

## 9. Known limitations & honest status

**Tested in this repository**
- `npx tsc --noEmit` — clean.
- `npx vitest run` — 148 passing across 12 files, including question routing, retrieval grounding, general-guidance labelling, emergency triage, the Twilio menu, and the care domain.
- `npx next build` — succeeds; all care API routes and both pages are emitted.
- `backend/.venv/Scripts/python.exe -m pytest -q` — 49 passing for the Python VoiceLink service.

**NOT tested here — treat as unverified until you run it on two real devices**
- Native two-device WebRTC audio (no browser/audio devices in this environment).
- Browser ASR/LLM inference (Whisper / WebLLM): download size, memory, latency and WebGPU availability are **unverified** on real hardware.
- A real Vercel deployment (requires your account and a managed Redis).
- TURN relay behaviour on restrictive mobile networks.

**Design limitations**
- Signalling is HTTP polling: expect ~1 s setup latency, not instant.
- On-device WebLLM requires **WebGPU** (Chromium-based desktop). Without it, replies fall back to the rule-based engine.
- The patient's optional device speech recognition uses the browser's Web Speech service, which may require a network connection; it is always labelled `patient device (Web Speech)`.
- The fallback AI voice uses the browser's `speechSynthesis`; it is labelled and never presented as a tested neural TTS. A real WebRTC TTS audio track would supersede it if added.
- The demo patient data is synthetic.
- The store is append-only by design; there is no admin UI to delete individual records.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Header badge reads **NOT persistent** | No Redis configured (or running on Vercel without it) | Set `UPSTASH_REDIS_REST_URL` / `_TOKEN`. |
| `Peer: failed`, no audio | NAT/firewall blocked direct media | Configure `CARE_TURN_*` so a relay is offered. |
| Mic button does nothing | Page not on HTTPS/`localhost` | Serve over HTTPS (Vercel gives you this). |
| "This joining link has expired" | `CARE_JOIN_TTL_MINUTES` elapsed | Click **New QR**. |
| "Someone has already joined" | Link already used | Generate a new link for the next patient. |
| AI replies are scripted | On-device LLM not loaded / no WebGPU | Expected — this is the labelled fallback engine. |

---

## 11. Deployment

See [`docs/CARE_WEB_CALL_DEPLOYMENT.md`](docs/CARE_WEB_CALL_DEPLOYMENT.md) for the Vercel walkthrough (Redis, TURN, domains, verifying persistence).
