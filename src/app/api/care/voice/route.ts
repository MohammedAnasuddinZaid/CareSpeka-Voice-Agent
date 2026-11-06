import type { NextRequest } from "next/server";
import { askPortal, buildPortalContext, executePortalAction, voiceOpening } from "@/lib/care/portalBrain";
import { voiceBaseUrl } from "@/lib/care/http";
import { buildWebhookUrl, twimlHangup, twimlPrompt, voiceSecret } from "@/lib/care/voice";

export const dynamic = "force-dynamic";

/**
 * TwiML webhook for the CareSpeak voice agent. Twilio calls this URL (POST) to
 * fetch the script for a call, and again after every spoken turn.
 *
 *   turn 0 / no SpeechResult -> speak the situation, then listen
 *   SpeechResult             -> one portal-brain turn (grounded answer or a
 *                               dictated message), then listen again
 *   hang-up phrase / cap     -> closing line and <Hangup/>
 *
 * The URL carries an opaque secret (`k`) so the webhook can't be used to have
 * the agent read patient data. GET is supported so the script can be inspected
 * without placing a (charged) call.
 */

const SESSION_RE = /^[A-Z0-9_-]{3,32}$/i;
const MAX_TURNS = 12;
const HANGUP_RE =
  /\b(goodbye|good bye|bye|hang up|end the call|end call|that'?s all|no more questions|stop the call|cancel the call|thank you bye)\b/i;

function xml(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function handle(req: NextRequest, speech: string): Promise<Response> {
  const url = new URL(req.url);
  const sessionRaw = (url.searchParams.get("session") ?? "").trim().toUpperCase();
  const session = SESSION_RE.test(sessionRaw) ? sessionRaw : "";
  const turn = Math.max(0, Number(url.searchParams.get("turn") ?? "0") || 0);

  const secret = voiceSecret();
  if (secret && (url.searchParams.get("k") ?? "") !== secret) {
    return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (!session) return xml(twimlHangup("This call is missing a valid session. Goodbye."));

  const actionUrl = buildWebhookUrl(voiceBaseUrl(req), session, turn + 1);

  // Opening: no speech captured yet.
  if (turn === 0 || !speech) {
    const ctx = await buildPortalContext(session).catch(() => null);
    const line = ctx
      ? voiceOpening(ctx)
      : "CareSpeak agent here. I could not load the patient record just now. Please check the nurse portal.";
    return xml(twimlPrompt(line, actionUrl));
  }

  if (HANGUP_RE.test(speech)) {
    return xml(twimlHangup("Understood. Ending the call now. Goodbye."));
  }

  let answer: string;
  try {
    const result = await askPortal(session, speech, { voice: true });
    if (result.action) {
      await executePortalAction(result.action, {
        role: "system",
        userId: "voice-agent",
        displayName: "CareSpeak voice agent",
      });
    }
    answer = result.answer;
  } catch {
    answer = "Sorry, I could not reach the patient record just now. Please check the nurse portal.";
  }

  if (turn >= MAX_TURNS) {
    return xml(twimlHangup(`${answer} This call has reached its time limit. Goodbye.`));
  }
  return xml(twimlPrompt(answer, actionUrl));
}

/** Inspect the opening script without placing a call. */
export async function GET(req: NextRequest) {
  return handle(req, "");
}

export async function POST(req: NextRequest) {
  let speech = "";
  try {
    const form = await req.formData();
    speech = String(form.get("SpeechResult") ?? "").trim();
  } catch {
    // No form body — treat as the opening request.
  }
  return handle(req, speech);
}
