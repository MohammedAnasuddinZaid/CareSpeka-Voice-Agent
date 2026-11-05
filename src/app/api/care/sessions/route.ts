import type { NextRequest } from "next/server";
import { appendAudit, createSession, getPatient, listSessions } from "@/lib/care/repo";
import { publicBaseUrl, guardNurse, isResponse, fail, ok, readBody } from "@/lib/care/http";
import { makeQrDataUrl } from "@/lib/care/qr";
import { sessionView } from "@/lib/care/view";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;
  const sessions = await listSessions(60);
  const patients = await Promise.all([...new Set(sessions.map((s) => s.patientId))].map((id) => getPatient(id)));
  const nameById = new Map(patients.filter(Boolean).map((p) => [p!.id, p!.displayName]));
  return ok({
    sessions: sessions.map((s) => ({
      id: s.id,
      patientId: s.patientId,
      patientName: nameById.get(s.patientId) ?? s.patientId,
      nurseName: s.nurseName,
      status: s.status,
      createdAt: s.createdAt,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      escalated: s.escalated,
      reportId: s.reportId,
    })),
  });
}

export async function POST(req: NextRequest) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;
  const body = await readBody<{ patientId?: string }>(req);
  const patientId = body?.patientId?.trim();
  if (!patientId) return fail("A patient must be selected.", 400);

  const patient = await getPatient(patientId);
  if (!patient) return fail("Patient not found.", 404);

  const ttl = Number(process.env.CARE_JOIN_TTL_MINUTES || "30");
  const { session, joinToken } = await createSession({
    patientId,
    nurseId: nurse.userId,
    nurseName: nurse.displayName,
    ttlMinutes: ttl,
  });

  const baseUrl = publicBaseUrl(req);
  const view = await sessionView(session, { forNurse: true, joinToken, baseUrl });
  const qrDataUrl = await makeQrDataUrl(view.joinUrl!);

  await appendAudit({
    actorRole: nurse.role,
    actorId: nurse.userId,
    action: "care.session_created",
    sessionId: session.id,
    patientId,
    detail: { joinExpiresAt: session.joinExpiresAt },
  });

  return ok({ session: view, qrDataUrl, joinToken });
}
