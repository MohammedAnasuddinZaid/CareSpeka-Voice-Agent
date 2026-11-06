/**
 * Twilio voice calling for CareSpeak emergencies and demo calls. Server-only.
 *
 * Design — no websockets, no media streams:
 *   1. `placeCall()` places an outbound call through Twilio's REST API with a
 *      TwiML webhook URL.
 *   2. Twilio fetches that URL; we answer with `<Say>` (the situation) followed
 *      by `<Gather input="speech">`.
 *   3. Whatever the human says is posted back to the same URL, we run one
 *      portal-brain turn and answer with the next TwiML.
 *
 * Every turn is a plain HTTP request, so it survives serverless cold starts and
 * works on the free Twilio plan (which only calls verified numbers and plays a
 * short trial preamble).
 *
 * Nothing here places a call unless it is explicitly asked to. Missing
 * configuration is reported honestly rather than failing silently.
 */
import { createHash } from "node:crypto";
import { getRedis, isRedisConfigured } from "@/lib/redis";

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

export function twilioAccountSid(): string | null {
  return process.env.TWILIO_ACCOUNT_SID?.trim() || null;
}

export function twilioAuthToken(): string | null {
  return process.env.TWILIO_AUTH_TOKEN?.trim() || null;
}

/** Normalises a phone number to E.164. Bare 10-digit Indian numbers get +91. */
export function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  let t = raw.trim().replace(/[^\d+]/g, "");
  if (!t) return null;
  if (!t.startsWith("+")) t = t.length === 10 ? `+91${t}` : `+${t}`;
  return /^\+\d{8,15}$/.test(t) ? t : null;
}

/** The verified Twilio sender number. Required before any call can be placed. */
const DEFAULT_FROM_NUMBER = "+919908786211";

export function twilioFromNumber(): string | null {
  return normalizePhone(process.env.TWILIO_FROM_NUMBER) ?? normalizePhone(DEFAULT_FROM_NUMBER);
}

export function twilioConfigured(): boolean {
  return Boolean(twilioAccountSid() && twilioAuthToken() && twilioFromNumber());
}

/**
 * Who gets called on an emergency. `CARE_EMERGENCY_PHONE` may hold several
 * numbers separated by commas or semicolons; the default is the hackathon
 * number. Every number must be verified in the Twilio console on a trial.
 */
export function emergencyNumbers(): string[] {
  const raw = process.env.CARE_EMERGENCY_PHONE?.trim() || "+919849130407";
  const out: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const n = normalizePhone(part);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Shared secret for the TwiML webhook. Prefers `CARE_VOICE_SECRET`; otherwise
 * derives a stable token from the Twilio auth token. Empty only when Twilio is
 * not configured at all (local rules-only demo), in which case the webhook is
 * left open on purpose.
 */
export function voiceSecret(): string {
  const explicit = process.env.CARE_VOICE_SECRET?.trim();
  if (explicit) return explicit;
  const token = twilioAuthToken();
  if (token) return createHash("sha256").update(`care-voice:${token}`).digest("hex").slice(0, 32);
  return "";
}

// ---------------------------------------------------------------------------
// TwiML
// ---------------------------------------------------------------------------

export const VOICE_NAME = "Polly.Aditi";
export const VOICE_LANG = "en-IN";

const XML_ENTITIES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&apos;",
  '"': "&quot;",
};

export function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => XML_ENTITIES[ch] ?? ch);
}

function say(text: string): string {
  return `<Say voice="${VOICE_NAME}" language="${VOICE_LANG}">${escapeXml(text)}</Say>`;
}

function gather(actionUrl: string): string {
  return (
    `<Gather input="speech" language="${VOICE_LANG}" speechTimeout="auto" ` +
    `speechModel="phone_call" method="POST" action="${escapeXml(actionUrl)}"></Gather>`
  );
}

function wrap(parts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join("")}</Response>`;
}

/** Speak a line, then listen for the caller's next utterance. */
export function twimlPrompt(text: string, actionUrl: string): string {
  // If the caller says nothing, Twilio falls through past <Gather>; give a
  // graceful closing line and hang up rather than leaving the line open (which
  // would burn the free plan's minutes).
  return wrap([
    say(text),
    gather(actionUrl),
    say("I did not hear anything. Please call back, or ask the nurse directly. Goodbye."),
    "<Hangup/>",
  ]);
}

/** Speak a closing line and hang up. */
export function twimlHangup(text: string): string {
  return wrap([say(text), "<Hangup/>"]);
}

// ---------------------------------------------------------------------------
// webhook URL
// ---------------------------------------------------------------------------

export function buildWebhookUrl(base: string, session: string, turn: number): string {
  const root = base.replace(/\/+$/, "");
  const params = new URLSearchParams({ session, turn: String(turn) });
  const secret = voiceSecret();
  if (secret) params.set("k", secret);
  return `${root}/api/care/voice?${params.toString()}`;
}

/** True for a public HTTPS origin Twilio can actually reach. */
export function isPublicHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const host = u.hostname;
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// placing the call
// ---------------------------------------------------------------------------

export interface PlaceCallInput {
  to: string;
  url: string;
  statusCallback?: string;
}

export type PlaceCallResult =
  | { ok: true; sid: string; status: string }
  | { ok: false; status: number; error: string };

export async function placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
  const sid = twilioAccountSid();
  const token = twilioAuthToken();
  const from = twilioFromNumber();
  if (!sid || !token || !from) {
    return {
      ok: false,
      status: 0,
      error:
        "Twilio is not fully configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.",
    };
  }

  const body = new URLSearchParams({
    To: input.to,
    From: from,
    Url: input.url,
    Method: "POST",
  });
  if (input.statusCallback) body.set("StatusCallback", input.statusCallback);

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        cache: "no-store",
      }
    );
    const json = (await res.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      message?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: json.message ?? `Twilio rejected the call (${res.status}).`,
      };
    }
    return { ok: true, sid: json.sid ?? "", status: json.status ?? "queued" };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "Could not reach Twilio." };
  }
}

// ---------------------------------------------------------------------------
// cooldown (protects the free Twilio balance from repeat dials)
// ---------------------------------------------------------------------------

const memoryCooldowns = new Map<string, number>();

/** Test hook. */
export function resetCooldownsForTests(): void {
  memoryCooldowns.clear();
}

export async function checkCooldown(
  key: string,
  windowMs: number
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const now = Date.now();

  if (isRedisConfigured()) {
    try {
      const redis = getRedis();
      const redisKey = `care:callcooldown:${key}`;
      const existing = await redis.get<number>(redisKey);
      if (existing && now - existing < windowMs) {
        return { allowed: false, retryAfterMs: windowMs - (now - existing) };
      }
      await redis.set(redisKey, now, { px: windowMs });
      return { allowed: true, retryAfterMs: 0 };
    } catch {
      // Redis unavailable — fall through to the in-process guard.
    }
  }

  const existing = memoryCooldowns.get(key);
  if (existing && now - existing < windowMs) {
    return { allowed: false, retryAfterMs: windowMs - (now - existing) };
  }
  memoryCooldowns.set(key, now);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Releases a cooldown that was reserved for a dial which never connected.
 * Without this, a failed Twilio request (wrong sender, unverified number, a
 * transient outage) still locks the button for the whole window.
 */
export async function clearCooldown(key: string): Promise<void> {
  memoryCooldowns.delete(key);
  if (!isRedisConfigured()) return;
  try {
    await getRedis().del(`care:callcooldown:${key}`);
  } catch {
    // Redis unavailable — the in-process entry is already gone.
  }
}
