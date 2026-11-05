import type { NextRequest } from "next/server";
import { appendEvent, findSessionByParticipantToken, getSession, listEvents } from "@/lib/care/repo";
import { nurseFromRequest, participantFromRequest } from "@/lib/care/auth";
import { fail, ok, readBody, unauthorized } from "@/lib/care/http";
import type { CareEventType } from "@/lib/care/types";

export const dynamic = "force-dynamic";

/** Event types a client is allowed to emit directly. */
const CLIENT_TYPES = new Set<CareEventType>([
  "agent.connected",
  "agent.disconnected",
  "mic.granted",
  "mic.denied",
  "speech.started",
  "speech.ended",
  "agent.response.started",
  "agent.response.completed",
  "participant.connected",
  "participant.disconnected",
  "session.resumed",
  "signal.beacon",
  "error",
]);

export async function POST(req: NextRequest) {
  const body = await readBody<{ sessionId?: string; type?: string; detail?: Record<string, unknown> }>(req);
  const sessionId = body?.sessionId?.trim();
  if (!sessionId) return fail("A session is required.", 400);
  const type = (body?.type ?? "") as CareEventType;
  if (!CLIENT_TYPES.has(type)) return fail("Event type not permitted from clients.", 400);

  const session = await getSession(sessionId);
  if (!session) return fail("Session not found.", 404);

  const nurse = await nurseFromRequest(req);
  let actor: "nurse" | "patient" = "nurse";
  if (!nurse) {
    const token = await participantFromRequest(req);
    const viaParticipant = token ? await findSessionByParticipantToken(token) : null;
    if (!viaParticipant || viaParticipant.id !== sessionId) return unauthorized();
    actor = "patient";
  }

  const detail = body?.detail && typeof body.detail === "object" ? body.detail : undefined;
  if (detail && JSON.stringify(detail).length > 20_000) return fail("Event detail too large.", 413);

  const event = await appendEvent(sessionId, type, actor, detail);
  return ok({ event });
}

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

  const events = await listEvents(sessionId, Number.isFinite(since) ? since : 0);
  return ok({ events });
}
