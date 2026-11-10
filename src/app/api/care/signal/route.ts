import type { NextRequest } from "next/server";
import {
  findSessionByParticipantToken,
  getSessionLoose,
  listSignals,
  pushSignal,
} from "@/lib/care/repo";
import { nurseFromRequest, participantFromRequest } from "@/lib/care/auth";
import { fail, ok, readBody, unauthorized } from "@/lib/care/http";
import type { CareSignalKind } from "@/lib/care/types";

export const dynamic = "force-dynamic";

const KINDS = new Set<CareSignalKind>(["offer", "answer", "ice", "ready", "bye", "beacon"]);

async function resolveRole(
  req: NextRequest,
  sessionId: string
): Promise<"nurse" | "patient" | null> {
  const nurse = await nurseFromRequest(req);
  if (nurse) return "nurse";
  const token = await participantFromRequest(req);
  if (token) {
    const session = await findSessionByParticipantToken(token);
    if (session && session.id === sessionId && session.status !== "ended") return "patient";
  }
  return null;
}

export async function POST(req: NextRequest) {
  const body = await readBody<{ sessionId?: string; kind?: string; data?: unknown }>(req);
  const sessionId = body?.sessionId?.trim();
  if (!sessionId) return fail("A session is required.", 400);
  const kind = (body?.kind ?? "") as CareSignalKind;
  if (!KINDS.has(kind)) return fail("Unknown signal kind.", 400);

  const session = await getSessionLoose(sessionId);
  if (!session) return fail("Session not found.", 404);
  if (session.status === "ended" && kind !== "beacon" && kind !== "bye") {
    return fail("This session has ended.", 410);
  }

  const role = await resolveRole(req, session.id);
  if (!role) return unauthorized("Not authorised to signal on this session.");

  const to = role === "nurse" ? "patient" : "nurse";
  const payload = JSON.stringify(body?.data ?? null);
  if (payload.length > 24_000) return fail("Signal payload too large.", 413);

  const stored = await pushSignal(session.id, to, { from: role, kind, data: body?.data ?? null });
  return ok({ signal: stored });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) return fail("A session is required.", 400);
  const since = Number(url.searchParams.get("since") || "0");

  const session = await getSessionLoose(sessionId);
  if (!session) return fail("Session not found.", 404);

  const role = await resolveRole(req, session.id);
  if (!role) return unauthorized("Not authorised to read signals for this session.");

  const signals = await listSignals(session.id, role, Number.isFinite(since) ? since : 0);
  return ok({ signals, role });
}
