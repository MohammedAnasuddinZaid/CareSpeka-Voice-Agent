import type { NextRequest } from "next/server";
import {
  addMessage,
  appendAudit,
  findSessionByParticipantToken,
  getPatient,
  listMessages,
  markMessagesRead,
} from "@/lib/care/repo";
import { nurseFromRequest, participantFromRequest } from "@/lib/care/auth";
import { fail, ok, readBody } from "@/lib/care/http";

export const dynamic = "force-dynamic";

/**
 * Patient messages (nurse -> patient):
 *  - GET as a signed-in nurse: list all messages, optionally for one patient.
 *  - GET with a participant token: the patient's own messages, marked as read.
 *  - POST as a signed-in nurse: send a message to a patient.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const patientId = url.searchParams.get("patientId") || undefined;

  const nurse = await nurseFromRequest(req);
  if (nurse) {
    return ok({ messages: await listMessages(patientId) });
  }

  // Patient reading their own messages via their join token.
  const token = await participantFromRequest(req);
  if (token) {
    const session = await findSessionByParticipantToken(token);
    if (!session) return fail("Your session is no longer available.", 410);
    const messages = await listMessages(session.patientId);
    await markMessagesRead(session.patientId);
    return ok({ messages, patientName: (await getPatient(session.patientId))?.displayName ?? "" });
  }

  return fail("Sign in to continue.", 401);
}

export async function POST(req: NextRequest) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return fail("Sign in to continue.", 401);

  const body = await readBody<{ patientId?: string; text?: string }>(req);
  const patientId = body?.patientId?.trim();
  const text = (body?.text ?? "").trim();
  if (!patientId || !text) return fail("A patient and a message are required.", 400);

  const patient = await getPatient(patientId);
  if (!patient) return fail("Patient not found.", 404);

  const message = await addMessage({ patientId, patientName: patient.displayName, text, createdBy: nurse.displayName });
  await appendAudit({
    actorRole: nurse.role,
    actorId: nurse.userId,
    action: "care.message_sent",
    patientId,
    detail: { messageId: message.id, via: "console" },
  });
  return ok({ message });
}
