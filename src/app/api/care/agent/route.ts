import type { NextRequest } from "next/server";
import {
  appendEvent,
  appendTranscript,
  getPatient,
  getSessionLoose,
  getTranscriptRaw,
  updateSession,
} from "@/lib/care/repo";
import { nurseFromRequest } from "@/lib/care/auth";
import { fail, ok, readBody, unauthorized } from "@/lib/care/http";
import { analyze, askedTopicsFrom, composeReply, greeting } from "@/lib/care/agent";

export const dynamic = "force-dynamic";

const ENGINE = "rule-based-care-engine";

/**
 * Deterministic fallback care agent. The nurse browser normally runs the LLM
 * locally; this endpoint guarantees a clinically cautious reply even when no
 * browser model is loaded. It is clearly labelled as the fallback engine.
 */
export async function POST(req: NextRequest) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();

  const body = await readBody<{ sessionId?: string; mode?: "greeting" | "reply" }>(req);
  const sessionId = body?.sessionId?.trim();
  if (!sessionId) return fail("A session is required.", 400);

  const session = await getSessionLoose(sessionId);
  if (!session) return fail("Session not found.", 404);
  if (session.status === "ended") return fail("This session has ended.", 410);

  const patient = await getPatient(session.patientId);
  const entries = await getTranscriptRaw(session.id);

  const wantsGreeting = body?.mode === "greeting" || !entries.some((e) => e.role === "agent");
  let text: string;
  let escalate = false;
  let escalationReason: string | undefined;

  if (wantsGreeting) {
    text = greeting(patient);
  } else {
    const reply = composeReply({ patient, entries, askedTopics: askedTopicsFrom(entries) });
    text = reply.text;
    escalate = reply.escalate;
    escalationReason = reply.escalationReason;
  }

  if (escalate) {
    await updateSession(session.id, { escalated: true });
    await appendEvent(session.id, "escalation.created", "system", {
      symptoms: escalationReason,
      source: "fallback-agent",
    });
  }

  const entry = await appendTranscript(session.id, { role: "agent", text, engine: ENGINE });
  await appendEvent(session.id, "agent.response.completed", "agent", { engine: ENGINE, seq: entry.seq });

  return ok({
    entry,
    text,
    escalate,
    escalationReason,
    engine: ENGINE,
    insights: analyze(patient, [...entries, entry]),
  });
}
