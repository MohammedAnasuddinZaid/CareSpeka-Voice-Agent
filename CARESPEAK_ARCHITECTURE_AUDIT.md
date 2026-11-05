# CareSpeak Architecture Audit — VoiceLink Integration

This audit records what the existing CareSpeak application is, what was added for
VoiceLink, and — importantly — what was **not** touched. The goal was to add a
voice line without changing or weakening any existing CareSpeak feature.

## 1. Existing application (unchanged)

CareSpeak is a Next.js 15 / React 19 / TypeScript app that turns gestures and eye
movements into speech and clinician alerts. Its existing surface, all preserved:

| Area | Files |
|---|---|
| Pages | `src/app/page.tsx`, `hand-mode`, `eye-mode`, `nurse-view`, `ward`, `cctv`, `logs`, `report`, `emergency` |
| Vision | MediaPipe Tasks Vision WASM (on-device) |
| Realtime | Server-Sent Events under `src/app/api/stream`, sync under `src/app/api/sync` |
| Storage | Optional Upstash Redis with an in-memory fallback |
| Domain logic | Hand/eye classifiers, escalation rules, risk + Shapley engine, forecasting |
| Tests | `vitest` unit tests (`npm test`) |
| PWA / service worker | Existing offline behaviour |

VoiceLink does not modify any of the above logic. The existing pages, API routes,
classifiers, risk engine and tests are untouched.

## 2. What was added

```
backend/                     # new, separate Python service
  app/main.py                # FastAPI REST + WebSocket
  app/call_manager.py        # call state machine, turns, barge-in
  app/vad.py  asr.py  llm.py  tts.py  engine.py  security.py  prompts.py
  app/database.py            # local SQLite, synthetic patient only
  app/config.py  version.py
  tests/test_voicelink_core.py
  phone-gateway.mjs          # HTTPS/WSS LAN gateway + CA download
  requirements.txt

src/app/voicelink/page.tsx   # new dialer page (route: /voicelink)
src/hooks/useVoiceCall.ts    # WebSocket + audio + mic client
public/worklets/voicelink-capture.js   # 16 kHz capture worklet

setup.ps1  start.ps1  stop.ps1  health-check.ps1
README_VOICELINK.md  HARDWARE_REPORT.md  PERFORMANCE_REPORT.md
ZERO_COST_POLICY.md  CARESPEAK_ARCHITECTURE_AUDIT.md
```

The only edits inside existing files are additive navigation and a content
security policy allowance:

| File | Change |
|---|---|
| `src/components/Navbar.tsx` | Added a link to `/voicelink` |
| `src/app/layout.tsx` | Footer link to VoiceLink |
| `src/app/page.tsx` | A VoiceLink feature band on the landing page |
| `next.config.js` | CSP now explicitly allows `ws:` / `wss:` for the call socket |
| `package.json` | Added `http-proxy` (gateway) and its types |
| `.gitignore` | Ignores models, venv, database, logs, certificates, env files |

No existing route, data model, API contract or test was changed.

## 3. Runtime topology

- **Frontend:** Next.js on `127.0.0.1:3000` (dev) — existing app plus `/voicelink`.
- **Backend:** FastAPI on `127.0.0.1:8000` — only bound to loopback.
- **Whisper server:** `127.0.0.1:8178`, started on demand by the backend.
- **Ollama:** `127.0.0.1:11434`, already local.
- **Phone gateway:** `0.0.0.0:3443` (HTTPS/WSS) and `0.0.0.0:3080` (CA download).
  Both reject non-private source addresses.

The two services share no process, no database and no port. Stopping VoiceLink
(`stop.ps1`) leaves the original CareSpeak app unaffected; starting the original
app does not start VoiceLink.

## 4. Data and privacy

- SQLite at `backend/data/voicelink.db` holds one **synthetic** patient
  (`CS-1001`, "Asha Rao") and call transcripts. No real patient data exists.
- Audio frames are processed in memory and are never written to disk.
- Transcript logging to the console is off by default
  (`VOICELINK_LOG_TRANSCRIPTS=false`); storage is on by default and can be
  disabled (`VOICELINK_STORE_TRANSCRIPTS=false`).
- Origins are restricted to `localhost`, `127.0.0.1` and RFC1918 LAN ranges by
  both CORS and the gateway. A public origin cannot pass the check.
- The emergency guard in `security.py` refuses to let the demo agent pretend to
  call emergency services; it tells the caller to dial 112 instead.

## 5. Repository and remotes

- The original repository remote (`origin`) points at the legacy CareSpeak repo
  and was **not** pushed to.
- VoiceLink is pushed only to the dedicated
  `CareSpeka-Voice-Agent` repository through a separate remote alias.

## 6. Deliberate non-goals

- Not a PSTN telephone (see `ZERO_COST_POLICY.md`).
- Not a medical device and not a doctor; Aria never diagnoses or prescribes.
- Not multi-tenant: the SQLite store and the gateway are single-household LAN
  scoped, which matches the ₹0, on-device requirement.
- No cloud sync of VoiceLink data, by design.
