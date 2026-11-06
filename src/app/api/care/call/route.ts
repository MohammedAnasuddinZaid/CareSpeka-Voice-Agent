import type { NextRequest } from "next/server";
import { appendAudit } from "@/lib/care/repo";
import { fail, ok, readBody, voiceBaseUrl } from "@/lib/care/http";
import { authorizeSession } from "@/lib/care/sessionAccess";
import {
  buildWebhookUrl,
  checkCooldown,
  clearCooldown,
  emergencyNumbers,
  isPublicHttpsUrl,
  placeCall,
  twilioConfigured,
} from "@/lib/care/voice";

export const dynamic = "force-dynamic";

/**
 * Places a real phone call to the nurse's number where a CareSpeak agent speaks
 * the patient's situation and answers questions.
 *
 *  POST { session, pair?, reason?: "emergency" | "demo" }
 *
 * Scoped to a CareSpeak session exactly like /api/care/portal, so both the nurse
 * portal (cookie) and the patient laptop (pair token) can trigger it.
 *
 * Cooldowns protect the free Twilio balance: an emergency dial is limited to one
 * per 90s per session, a demo dial to one per 8s. No call is ever placed when
 * Twilio is not configured, or when the webhook URL is not publicly reachable.
 */

const SESSION_RE = /^[A-Z0-9_-]{3,32}$/i;
const EMERGENCY_COOLDOWN_MS = 90_000;
const DEMO_COOLDOWN_MS = 8_000;

interface CallBody {
  session?: string;
  pair?: string;
  reason?: string;
}

interface Attempt {
  to: string;
  ok: boolean;
  sid?: string;
  status?: string;
  error?: string;
}

export async function POST(req: NextRequest) {
  const body = await readBody<CallBody>(req);
  const sessionRaw = typeof body?.session === "string" ? body.session.trim().toUpperCase() : "";
  const session = SESSION_RE.test(sessionRaw) ? sessionRaw : "";
  if (!session) return fail("A valid session id is required.", 400);

  const access = await authorizeSession(req, session, body?.pair);
  if (!access.allowed) return fail("Scan the patient's QR code, or sign in, before calling.", 401);

  const reason = body?.reason === "emergency" ? "emergency" : "demo";

  if (!twilioConfigured()) {
    return fail(
      "Calling is not configured yet. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.",
      503
    );
  }

  const base = voiceBaseUrl(req);
  const allowInsecure = process.env.CARE_VOICE_ALLOW_INSECURE === "1";
  if (!isPublicHttpsUrl(base) && !allowInsecure) {
    return fail(
      "Twilio needs a public HTTPS URL to fetch the call script. Deploy the app, or set CARE_VOICE_BASE_URL to a public tunnel address.",
      400,
      { webhook: buildWebhookUrl(base, session, 0) }
    );
  }

  const numbers = emergencyNumbers();
  if (!numbers.length) return fail("No emergency number is configured. Set CARE_EMERGENCY_PHONE.", 400);

  // Only start the free-plan-protecting cooldown once the dial is actually
  // viable, so a misconfiguration never blocks the next real attempt.
  const cooldownMs = reason === "emergency" ? EMERGENCY_COOLDOWN_MS : DEMO_COOLDOWN_MS;
  const gate = await checkCooldown(`${session}:${reason}`, cooldownMs);
  if (!gate.allowed) {
    return fail(
      `Just a moment — a call was placed seconds ago. Try again in ${Math.ceil(gate.retryAfterMs / 1000)}s.`,
      429,
      { retryAfterMs: gate.retryAfterMs }
    );
  }

  const webhookUrl = buildWebhookUrl(base, session, 0);
  const attempts: Attempt[] = [];
  for (const to of numbers) {
    const placed = await placeCall({ to, url: webhookUrl });
    attempts.push(
      placed.ok
        ? { to, ok: true, sid: placed.sid, status: placed.status }
        : { to, ok: false, error: placed.error }
    );
  }

  const first = attempts.find((a) => a.ok);
  // The dial never landed (bad sender, unverified number, Twilio outage).
  // Release the window before any bookkeeping so a retry is never blocked.
  if (!first) await clearCooldown(`${session}:${reason}`);

  await appendAudit({
    actorRole: access.actor?.role ?? "system",
    actorId: access.actor?.userId,
    action: reason === "emergency" ? "care.emergency_call" : "care.demo_call",
    sessionId: session,
    detail: {
      reason,
      numbers,
      webhook: webhookUrl,
      placed: attempts.map((a) => ({ to: a.to, ok: a.ok })),
    },
  });

  if (!first) {
    return fail(attempts[0]?.error ?? "Twilio could not place the call.", 502, { attempts });
  }

  return ok({
    reason,
    to: first.to,
    callSid: first.sid,
    status: first.status,
    attempts: attempts.length,
    webhook: webhookUrl,
  });
}
