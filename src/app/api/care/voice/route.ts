import type { NextRequest } from "next/server";
import {
  askPortal,
  buildPortalContext,
  executePortalAction,
  voiceOpening,
  type PortalContext,
} from "@/lib/care/portalBrain";
import { appendAudit } from "@/lib/care/repo";
import { voiceBaseUrl } from "@/lib/care/http";
import { buildWebhookUrl, twimlHangup, twimlPrompt, voiceSecret } from "@/lib/care/voice";

export const dynamic = "force-dynamic";

/**
 * TwiML webhook for the CareSpeak voice agent. Twilio calls this URL (POST) to
 * fetch the script for a call, and again after every spoken turn.
 *
 *   turn 0 / no SpeechResult -> speak the situation with a DTMF menu, then listen
 *   Digits                   -> repeat, read the live readings, flag urgent, hang up
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

/** Short spoken summary of the live readings, used by the DTMF menu. */
function liveLine(ctx: PortalContext | null): string {
  if (!ctx) return "I could not load the live readings just now. Please check the nurse portal.";
  if (ctx.findings.length) {
    return `Readings needing attention: ${ctx.findings
      .map((f) => `${f.label} ${f.reading}, ${f.note}`)
      .join("; ")}.`;
  }
  const parts: string[] = [];
  if (ctx.metrics?.alertnessScore != null) parts.push(`alertness ${Math.round(ctx.metrics.alertnessScore)} percent`);
  if (ctx.metrics?.blinkRate != null) parts.push(`blink rate ${ctx.metrics.blinkRate.toFixed(1)} per minute`);
  if (ctx.metrics?.eyeClosureDuration != null)
    parts.push(`eye closure ${(ctx.metrics.eyeClosureDuration / 1000).toFixed(1)} seconds`);
  if (ctx.metrics?.movementActivity != null) parts.push(`movement ${Math.round(ctx.metrics.movementActivity * 100)} percent`);
  return parts.length
    ? `Latest readings: ${parts.join(", ")}. All monitored readings are inside their thresholds.`
    : "No live readings are arriving from this session yet.";
}

async function handle(req: NextRequest, speech: string, digits: string): Promise<Response> {
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

  // Some handsets deliver a spoken "two" instead of a DTMF tone. Only the turn
  // immediately after the opening menu treats a lone digit as a menu choice.
  if (!digits && turn === 1 && /^[1-9]$/.test(speech.trim())) {
    digits = speech.trim();
    speech = "";
  }

  // DTMF menu. Only the opening prompt advertises it, so digits cannot collide
  // with ordinary speech later in the call.
  if (digits) {
    if (digits === "9") return xml(twimlHangup("Ending the call now. Goodbye."));
    const ctx = await buildPortalContext(session).catch(() => null);
    if (digits === "1") {
      const line = ctx
        ? voiceOpening(ctx)
        : "I could not load the patient record just now. Please check the nurse portal.";
      return xml(twimlPrompt(line, actionUrl));
    }
    if (digits === "2") return xml(twimlPrompt(liveLine(ctx), actionUrl));
    if (digits === "3") {
      await appendAudit({
        actorRole: "system",
        actorId: "voice-agent",
        action: "care.voice_urgent_flag",
        sessionId: session,
        patientId: ctx?.patientId ?? undefined,
        detail: { via: "phone-menu" },
      }).catch(() => undefined);
      return xml(
        twimlPrompt(
          "I have flagged this call as urgent in the nurse portal. I cannot transfer calls or contact emergency services. If this is an emergency, hang up and call 112 now.",
          actionUrl
        )
      );
    }
    return xml(
      twimlPrompt(
        "I did not recognise that option. You can say things like, what are the latest readings, what is the care plan, or tell me a message for the patient.",
        actionUrl
      )
    );
  }

  // Opening: no speech captured yet.
  if (turn === 0) {
    const ctx = await buildPortalContext(session).catch(() => null);
    const line = ctx
      ? voiceOpening(ctx)
      : "CareSpeak agent here. I could not load the patient record just now. Please check the nurse portal.";
    return xml(
      twimlPrompt(
        `${line} For quick options, press 1 to hear that again, 2 for the latest readings, 3 to flag this call as urgent, or 9 to end the call. You can also just ask your question.`,
        actionUrl,
        {
          menu: true,
          noInputLine:
            "I did not catch that. Press 2 for the latest readings, or call back and ask the nurse directly. Goodbye.",
        }
      )
    );
  }

  // An empty speech result on an established call: ask once more, without
  // replaying the whole opening and without leaving the line open.
  if (!speech) {
    return xml(
      twimlPrompt(
        "I did not catch that. Please ask your question about the patient, or say the latest readings.",
        actionUrl,
        { noInputLine: "I still could not hear you. Please call back and ask the nurse directly. Goodbye." }
      )
    );
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
  return handle(req, "", "");
}

export async function POST(req: NextRequest) {
  let speech = "";
  let digits = "";
  try {
    const form = await req.formData();
    speech = String(form.get("SpeechResult") ?? "").trim();
    digits = String(form.get("Digits") ?? "").trim();
  } catch {
    // No form body — treat as the opening request.
  }
  return handle(req, speech, digits);
}
