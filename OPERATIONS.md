# Operations — running and maintaining VoiceLink

## Local URLs

| Surface | URL |
|---|---|
| Nurse / admin dashboard | <http://127.0.0.1:3000/dashboard> |
| Browser demo (local voice line) | <http://127.0.0.1:3000/voicelink> |
| Backend API | <http://127.0.0.1:8000> |
| Backend API docs | <http://127.0.0.1:8000/docs> |
| Phone UI (same Wi‑Fi) | `https://<LAN-IP>:3443/voicelink` |
| Local CA download | `http://<LAN-IP>:3080/ca.crt` |

The browser demo still works exactly as before; the dashboard is an additional
surface. Both are served by the same Next.js app and talk to the same backend.

## Start / stop

```powershell
./setup.ps1        # one time: venv, npm packages, models, local TLS certificate
./start.ps1        # Ollama + backend + frontend + phone gateway
./health-check.ps1 # functional health checks
./stop.ps1         # stops what start.ps1 started
```

The backend is started as `uvicorn app.main:app --host 127.0.0.1 --port 8000`.
Its lifespan seeds the default users and starts the scheduler. If the dashboard
login page cannot reach the backend, confirm the backend process is running and
check `backend/logs/backend.err.log`.

## Dashboard sign-in

- Administrator: username `admin`; the generated password is in
  `backend/runtime/admin_credentials.txt` (git-ignored).
- Demo nurse: `nurse.demo` / `nurse.demo` (created when
  `VOICELINK_SEED_DEMO_USERS=1`).
- Change both before any real use.

## Background jobs & quiet hours

- The scheduler runs inside the backend process and polls every
  `VOICELINK_SCHEDULER_POLL_S` seconds. Follow-ups and retries are **durable**
  records in SQLite, not browser timers, so they survive a page close and a
  process restart.
- Jobs are leased (`VOICELINK_JOB_LEASE_S`) so two workers cannot run the same
  job, and retried with backoff up to `VOICELINK_JOB_MAX_ATTEMPTS`.
- Quiet hours (`VOICELINK_QUIET_HOURS`, default on, 21:00–07:00) suppress routine
  calls/messages. An **emergency** always overrides quiet hours and soft rate
  limits. A staff member can require an explicit override per message.
- Soft rate limits: `VOICELINK_RATE_LIMIT_CALLS_PER_HOUR` and
  `VOICELINK_RATE_LIMIT_MESSAGES_PER_HOUR`.

## Data, storage & retention

- SQLite database and runtime secrets live under `backend/` and are git-ignored
  (`backend/runtime/`, `backend/data/`). They are never committed.
- Demonstration data (e.g. **Asha Rao**, `CS-1001`) is **synthetic**.
- To reduce data retention, transcripts can be disabled
  (`VOICELINK_STORE_TRANSCRIPTS=false`), and old records can be purged with the
  helper `database.purge_older_than(...)` (see `backend/app/database.py`). Run
  purges during a maintenance window and keep a backup first.
- **Backups:** stop the backend, copy `backend/runtime/` and the SQLite database
  file. Never commit them.

## Observability

- Backend logs: `backend/logs/backend.out.log` and `backend/logs/backend.err.log`.
- Audit trail with integrity verification: dashboard → **Audit & reports**, or
  `GET /api/platform/audit`.
- Reports: dashboard → **Audit & reports** (counts derived from stored records,
  not estimates).
- Provider state: dashboard → **Provider**.

## Public callback tunnel (testing only)

Carriers cannot reach `127.0.0.1`. For a short test, run a Cloudflare quick
tunnel against the backend and record its URL in the two ignored config values:

```powershell
D:\voicelink-tools\cloudflared.exe tunnel --url http://127.0.0.1:8000 `
    --no-autoupdate --logfile D:\voicelink-tools\cloudflared.log
```

- Put the printed `https://<random>.trycloudflare.com` into `PUBLIC_BASE_URL`
  and `TELEPHONY_WEBHOOK_BASE_URL` in `.env.voicelink`, then restart.
- The URL is **ephemeral**: it changes on every tunnel restart, so update the
  config and the carrier console together.
- Tunnel traffic is restricted to `/api/telephony/*`; the dashboard and data
  APIs return `404` through the tunnel. Do not disable that guard on a public
  host.
- Logs and the tunnel binary stay on `D:`, never in the repository.

## Where build artifacts live

- Source stays in the repository (on `C:` for this machine).
- New dependency caches, npm cache and temporary files are kept on `D:`
  (`D:\npm-cache`) to avoid filling the system drive. The backend test suite
  accepts `VOICELINK_TEST_TMPDIR` (e.g. `D:\voicelink-test-tmp`) so its temporary
  databases and secrets stay off `C:`.
- `backend/models/`, `backend/data/`, `backend/logs/`, `backend/runtime/` and
  `.next/` are git-ignored.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Login fails with “Sign-in failed” | Wrong credentials; after repeated failures the account is locked for the lockout window |
| Dashboard shows “Simulated (mock)” | No carrier credentials configured — expected offline |
| Real call refused: `webhook_not_public` | Set `PUBLIC_BASE_URL`/`TELEPHONY_WEBHOOK_BASE_URL` to a public HTTPS endpoint |
| Tunnel URL stopped working | Quick-tunnel URLs change on restart; copy the new URL into `.env.voicelink` and restart the backend |
| Carrier webhook returns `404` through the tunnel | Only `/api/telephony/*` is public by design; dashboard and data routes are not exposed |
| Messages stay “sent”, never “delivered” | The carrier has not reported delivery, or delivery receipts are not configured |
| Escalation action trail empty | The escalation was just created; actions appear as the policy runs |
| Dashboard cannot load data | Backend offline — run `./start.ps1`, check `backend/logs/backend.err.log` |
| Port already in use | Run `./stop.ps1`, then `./start.ps1` |

## Safety reminder

VoiceLink’s AI is an assistant, not a nurse and not an emergency service. It does
not provide a diagnosis or emergency dispatch. Immediate danger is routed to the
configured emergency number. See [`SECURITY.md`](SECURITY.md).
