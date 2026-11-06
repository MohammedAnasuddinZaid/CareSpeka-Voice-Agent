import type { NextRequest } from "next/server";
import {
  appendAudit,
  appendEvent,
  expireIfStale,
  findSessionByJoinCode,
  findSessionByJoinToken,
  findSessionByParticipantToken,
  getPatient,
  linkParticipantToken,
  listMessages,
  updateSession,
} from "@/lib/care/repo";
import { hashToken, newToken } from "@/lib/care/crypto";
import { fail, ok, readBody } from "@/lib/care/http";
import type { JoinPreview, JoinResult } from "@/lib/care/types";

export const dynamic = "force-dynamic";

async function resolveByCode(code: string) {
  const direct = await findSessionByJoinCode(code);
  return direct;
}

/** Public preview: only non-sensitive fields, so the QR page can show who is waiting. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") || "";
  if (!token) return fail("This joining link is incomplete.", 400);

  let session = await findSessionByJoinToken(token);
  if (!session) return fail("This joining link is invalid or has expired.", 404);
  session = await expireIfStale(session);

  const patient = await getPatient(session.patientId);
  const preview: JoinPreview = {
    ok: true,
    sessionId: session.id,
    status: session.status,
    nurseName: session.nurseName,
    patientName: patient?.displayName ?? "the patient",
    expiresAt: session.joinExpiresAt,
    expired: session.status === "expired",
    alreadyJoined: Boolean(session.joinedAt),
    mode: "web-voice-demo",
    modeLabel: "Web Voice Call — Demo",
    messages: await listMessages(session.patientId),
  };
  return ok(preview);
}

interface JoinBody {
  token?: string;
  code?: string;
  name?: string;
  resumeToken?: string;
}

export async function POST(req: NextRequest) {
  const body = await readBody<JoinBody>(req);
  if (!body) return fail("Invalid request.", 400);

  // 1) Resuming with an existing participant token (e.g. after a refresh).
  if (body.resumeToken) {
    const existing = await findSessionByParticipantToken(body.resumeToken);
    if (existing && existing.status !== "ended") {
      const patient = await getPatient(existing.patientId);
      const result: JoinResult = {
        ok: true,
        sessionId: existing.id,
        participantToken: body.resumeToken,
        participantName: existing.participantName ?? "Patient",
        patientName: patient?.displayName ?? "",
        nurseName: existing.nurseName,
        status: existing.status,
      };
      return ok({ ...result });
    }
    return fail("Your previous session is no longer available. Ask the nurse for a new link.", 410);
  }

  // 2) Joining with a token (QR) or a manual code.
  let session = body.token ? await findSessionByJoinToken(body.token) : null;
  if (!session && body.code) session = await resolveByCode(body.code.trim());

  if (!session) return fail("This joining link or code is invalid.", 404);

  session = await expireIfStale(session);
  if (session.status === "expired") return fail("This joining link has expired. Ask the nurse to generate a new one.", 410);
  if (session.status === "ended") return fail("This care session has already ended.", 410);

  // 3) Single participant only. A second, different patient is rejected.
  if (session.joinedAt && !body.resumeToken) {
    return fail("Someone has already joined this session. Ask the nurse for a new link.", 409);
  }

  const participantToken = newToken();
  const name = (body.name || "").trim().slice(0, 80) || "Patient";
  const now = new Date().toISOString();

  const updated = await updateSession(session.id, {
    status: "active",
    joinedAt: session.joinedAt ?? now,
    startedAt: session.startedAt ?? now,
    participantName: name,
    participantTokenHash: hashToken(participantToken),
  });

  // Index the token so this patient can authenticate later API calls. Only the
  // hash is ever persisted; the raw token lives in the patient's browser only.
  await linkParticipantToken(session.id, participantToken);

  await appendEvent(session.id, "session.joined", "patient", { name });
  await appendEvent(session.id, "participant.connected", "patient", { });
  await appendAudit({
    actorRole: "patient",
    action: "care.patient_joined",
    sessionId: session.id,
    patientId: session.patientId,
    detail: { name },
  });

  const patient = await getPatient(session.patientId);
  const result: JoinResult = {
    ok: true,
    sessionId: session.id,
    participantToken,
    participantName: name,
    patientName: patient?.displayName ?? "",
    nurseName: updated?.nurseName ?? session.nurseName,
    status: updated?.status ?? "active",
  };
  return ok({ ...result });
}
