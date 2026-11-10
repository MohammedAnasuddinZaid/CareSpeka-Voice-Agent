import type { NextRequest } from "next/server";
import {
  appendAudit,
  appendEvent,
  endSession,
  expireIfStale,
  findSessionByParticipantToken,
  getSessionLoose,
  listEvents,
  listTasks,
  listTranscript,
  updateSession,
} from "@/lib/care/repo";
import { nurseFromRequest, participantFromRequest } from "@/lib/care/auth";
import { publicBaseUrl, fail, ok, readBody, unauthorized } from "@/lib/care/http";
import { analyze } from "@/lib/care/agent";
import { sessionView } from "@/lib/care/view";
import { getPatient, createTask } from "@/lib/care/repo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let session = await getSessionLoose(id);
  if (!session) return fail("Session not found.", 404);
  session = await expireIfStale(session);

  const nurse = await nurseFromRequest(req);
  const isNurse = Boolean(nurse);

  if (!isNurse) {
    const token = await participantFromRequest(req);
    const viaParticipant = token ? await findSessionByParticipantToken(token) : null;
    if (!viaParticipant || viaParticipant.id !== session.id) return unauthorized("This session is not available to you.");
  }

  const url = new URL(req.url);
  const sinceEvent = Number(url.searchParams.get("sinceEvent") || "0");
  const sinceTranscript = Number(url.searchParams.get("sinceTranscript") || "0");

  const [events, transcript, patient] = await Promise.all([
    listEvents(session.id, Number.isFinite(sinceEvent) ? sinceEvent : 0),
    listTranscript(session.id, Number.isFinite(sinceTranscript) ? sinceTranscript : 0),
    getPatient(session.patientId),
  ]);

  const baseUrl = publicBaseUrl(req);
  const view = await sessionView(session, { forNurse: isNurse, baseUrl });

  const payload: Record<string, unknown> = { session: view, events, transcript };

  if (isNurse) {
    payload.insights = analyze(patient, [...transcript]);
    payload.tasks = await listTasks(session.patientId);
  }

  return ok(payload);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();

  const body = await readBody<{
    action?: string;
    reason?: string;
    title?: string;
    status?: string;
  }>(req);
  const session = await getSessionLoose(id);
  if (!session) return fail("Session not found.", 404);

  switch (body?.action) {
    case "end": {
      const ended = await endSession(session.id, body.reason || "nurse_ended");
      if (!ended) return fail("Session not found.", 404);
      await appendAudit({
        actorRole: nurse.role,
        actorId: nurse.userId,
        action: "care.session_ended",
        sessionId: session.id,
        patientId: session.patientId,
        detail: { reason: body.reason || "nurse_ended" },
      });
      const view = await sessionView(ended, { forNurse: true, baseUrl: publicBaseUrl(req) });
      return ok({ session: view });
    }
    case "escalation.acknowledged": {
      await updateSession(session.id, { escalated: false });
      await appendEvent(session.id, "escalation.acknowledged", "nurse", { by: nurse.displayName });
      await appendAudit({
        actorRole: nurse.role,
        actorId: nurse.userId,
        action: "care.escalation_acknowledged",
        sessionId: session.id,
        patientId: session.patientId,
      });
      const latest = (await getSessionLoose(session.id)) ?? session;
      const view = await sessionView(latest, { forNurse: true, baseUrl: publicBaseUrl(req) });
      return ok({ session: view });
    }
    case "task.create": {
      const title = (body.title || "").trim();
      if (!title) return fail("Task title is required.", 400);
      const task = await createTask({
        patientId: session.patientId,
        sessionId: session.id,
        title: title.slice(0, 200),
        createdBy: nurse.displayName,
      });
      await appendEvent(session.id, "task.created", "nurse", { taskId: task.id, title: task.title });
      await appendAudit({
        actorRole: nurse.role,
        actorId: nurse.userId,
        action: "care.task_created",
        sessionId: session.id,
        patientId: session.patientId,
        detail: { taskId: task.id },
      });
      return ok({ task });
    }
    default:
      return fail("Unknown action.", 400);
  }
}
