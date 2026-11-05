# Deploying Web Voice Call — Demo on Vercel

This guide covers deploying the **Web Voice Call — Demo** (`/care`) to Vercel. The telephony/VoiceLink stack is unaffected and can continue to run wherever it already runs.

> The deployment steps below were **not executed in this environment** (no Vercel account or managed Redis available). They are the verified-against-code instructions; validate on your own project.

---

## 1. Why Vercel needs Redis

Vercel Functions are stateless and may be served by different instances/regions for the same user. The demo stores sessions, transcripts, signalling and reports in a KV driver:

| Driver | When it is used | Multi-instance safe? |
| --- | --- | --- |
| **redis** (Upstash REST) | `UPSTASH_REDIS_REST_URL` **and** `UPSTASH_REDIS_REST_TOKEN` are set | ✅ yes |
| **file** | local dev (`.care-data/`) | ❌ single process only |
| **memory** | `NODE_ENV=test`, `CARE_STORE=memory`, or Vercel without Redis | ❌ no |

**Always configure Redis on Vercel.** Without it the demo still runs, but the header shows a red **NOT persistent** badge and cross-device sessions will flake. The code deliberately refuses to hide this.

### Create the database
1. https://upstash.com → create a **Redis** database (Regional, REST enabled is default).
2. Copy the **REST URL** and **REST TOKEN**.
3. In Vercel → **Project → Settings → Environment Variables**, add:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

   Scope them to Production, Preview and Development as you prefer. The response times are tiny because the lists are small.

---

## 2. Deploy

The repository is a standard Next.js app.

1. Vercel → **Add New → Project** → import the repo.
2. Framework preset: **Next.js**. Build command `npm run build`, output default. No override needed.
3. Add the environment variables from section 1 and from the table below.
4. Deploy.

The build has been verified locally (`npx next build`). All `/api/care/*` routes are dynamic.

---

## 3. Environment variables (complete list)

| Variable | Required | Notes |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` | ✅ prod | Persistence. |
| `UPSTASH_REDIS_REST_TOKEN` | ✅ prod | Persistence. |
| `CARE_NURSE_USER` | ✅ prod | Replace the demo login. |
| `CARE_NURSE_PASS` | ✅ prod | Replace the demo login. |
| `CARE_NURSE_NAME` | recommended | Shown to patients. |
| `NEXT_PUBLIC_CARESPEAK_URL` | recommended | `https://your-app.vercel.app` (no trailing slash). Auto-detected from request headers if omitted. |
| `CARE_TURN_URL` | recommended | e.g. `turn:your-turn-host:3478,turns:your-turn-host:5349`. |
| `CARE_TURN_USERNAME` | with TURN | |
| `CARE_TURN_CREDENTIAL` | with TURN | |
| `CARE_JOIN_TTL_MINUTES` | optional | Default `30`. |
| `CARE_MAX_SESSION_MINUTES` | optional | Default `30`. |
| `CARE_SIGNAL_POLL_MS` | optional | Default `1200`. |
| `CARE_ASR_MODEL` | optional | Default `Xenova/whisper-tiny.en`. |
| `CARE_LLM_MODEL` | optional | Default `Llama-3.2-1B-Instruct-q4f16_1-MLC`. |
| `CARE_STORE` | optional | Force `redis` \| `file` \| `memory`. Do **not** set to `memory` on Vercel unless you want a non-persistent demo. |

The demo credentials (`nurse.demo` / `nurse.demo`) are only a local convenience. If you deploy without setting `CARE_NURSE_*`, anyone can sign in — set them.

---

## 4. TURN relay

Peer-to-peer WebRTC succeeds on many home networks with STUN alone, but corporate networks and some mobile carriers block direct paths. For a reliable hospital-ward demo, configure a TURN relay.

1. Create a TURN service (self-hosted coturn, or a provider such as Twilio Network Traversal, Metered, or Cloudflare Calls TURN).
2. Set `CARE_TURN_URL` (comma-separate multiple URLs for `turn:`/`turns:`), plus username/credential.
3. `/api/care/config` exposes these to the browser as `RTCIceServer`s. No redeploy of client code is needed.

> For production you would mint **short-lived** TURN credentials per session. The demo uses static env credentials for simplicity; rotate them if they leak.

---

## 5. The on-device AI models and CSP

The nurse's browser loads Whisper and WebLLM **from a CDN, on click only**. The existing `next.config.js` CSP already permits:

- `script-src ... https://cdn.jsdelivr.net`
- `connect-src ... https:`

So the model downloads work without a CSP change. If you switch to self-hosted models, either add your origin to the CSP or serve them from the same domain, and update `CARE_ASR_MODEL` / `CARE_LLM_MODEL`.

No model files are ever committed to the repository.

---

## 6. Verifying a deployment

After the first deploy, on the production URL:

1. Open `https://<app>/care` and sign in.
2. The header badge must read **persistent (redis)**. If it reads **NOT persistent**, the Redis env vars are missing or wrong.
3. Start a session, copy the joining link, and open it on a second device (phone).
4. Confirm audio flows **both ways** and the transcript updates on the nurse dashboard.
5. Ask the patient to say *"I have chest pain."* — the nurse dashboard must show a red escalation, and the audit trail must contain `care.session_created`, `care.patient_joined`, `escalation.created` / related, `care.session_ended`, `care.report_generated`.

Only after a real two-device test passes end-to-end should this be described as verified.

---

## 7. Scaling & cost notes

- **Functions**: everything is on the free tier footprint — small JSON payloads, no streaming media.
- **Redis**: append-only lists, capped (events 2000, transcript 4000, signals 1000, audit 5000, sessions index 500, reports index 1000). Small and bounded.
- **Bandwidth**: media is peer-to-peer, so Vercel never carries the audio. Only when a TURN relay is used does media traverse your TURN host, not Vercel.
- **No cron, no queues, no background workers** are required.

---

## 8. Rolling back / isolating the feature

The demo is additive and self-contained:
- UI: `src/app/care/**`, `src/components/care/**`
- API: `src/app/api/care/**`
- Domain: `src/lib/care/**`, `src/lib/careClient.ts`, `src/hooks/useCareRtc.ts`
- Static worklet: `public/worklets/care-capture.js`

Removing these paths (and the two nav entries in `src/components/Navbar.tsx` / `src/app/layout.tsx`) removes the feature without touching the Python/FastAPI backend, the telephony adapters, or any existing CareSpeak page.

The only shared-file edit is `src/app/voicelink/layout.tsx`, which marks the pre-existing client-only `/voicelink` route dynamic so `next build` succeeds under Next 15.5 — behaviour is unchanged.
