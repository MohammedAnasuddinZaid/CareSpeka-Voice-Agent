import type { NextRequest } from "next/server";
import {
  appendEvent,
  appendTranscript,
  findSessionByParticipantToken,
  getSession,
  listTranscript,
  updateSession,
} from "@/lib/care/repo";
import { nurseFromRequest, participantFromRequest } from "@/lib/care/auth";
import { fail, ok, readBody, unauthorized } from "@/lib/care/http";
import { extractSymptoms } from "@/lib/care/agent";
import type { CareRole } from "@/lib/care/types";

export const dynamic = "force-dynamic";

const ROLES = new Set<CareRole>(["nurse", "patient", "agent", "system"]);

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) return fail("A session is required.", 400);
  const since = Number(url.searchParams.get("since") || "0");

  const nurse = await nurseFromRequest(req);
  if (!nurse) {
    const token = await participantFromRequest(req);
    const session = token ? await findSessionByParticipantToken(token) : null;
    if (!session || session.id !== sessionId) return unauthorized();
  }

  const transcript = await listTranscript(sessionId, Number.isFinite(since) ? since : 0);
  return ok({ transcript });
}

export async function POST(req: NextRequest) {
  const body = await readBody<{
    sessionId?: string;
    role?: string;
    text?: string;
    engine?: string;
    confidence?: number;
    provisional?: boolean;
  }>(req);
  const sessionId = body?.sessionId?.trim();
  if (!sessionId) return fail("A session is required.", 400);
  const role = (body?.role ?? "") as CareRole;
  if (!ROLES.has(role)) return fail("Unknown speaker role.", 400);
  const text = (body?.text ?? "").trim();
  if (!text) return fail("Empty transcript text.", 400);

  const session = await getSession(sessionId);
  if (!session) return fail("Session not found.", 404);
  if (session.status === "ended") return fail("This session has ended.", 410);

  const nurse = await nurseFromRequest(req);
  if (!nurse) {
    // A patient may only append their own speech, and only to their session.
    const token = await participantFromRequest(req);
    const viaParticipant = token ? await findSessionByParticipantToken(token) : null;
    if (!viaParticipant || viaParticipant.id !== sessionId) return unauthorized();
    if (role !== "patient") return unauthorized("Patients may only submit their own speech.");
  }

  const entry = await appendTranscript(sessionId, {
    role,
    text,
    engine: body?.engine?.slice(0, 80),
    confidence: typeof body?.confidence === "number" ? body.confidence : undefined,
    provisional: Boolean(body?.provisional),
  });

  // Server-side red-flag detection: escalate regardless of which ASR produced it.
  let escalated = false;
  if (role === "patient" && !body?.provisional) {
    const flags = extractSymptoms(text).filter((s) => s.redFlag);
    if (flags.length) {
      escalated = true;
      await updateSession(sessionId, { escalated: true });
      await appendEvent(sessionId, "escalation.created", "system", {
        symptoms: flags.map((f) => f.label),
        source: "server-transcript-scan",
      });
    }
  }

  return ok({ entry, escalated });
}
