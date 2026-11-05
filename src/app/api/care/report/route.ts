import type { NextRequest } from "next/server";
import {
  appendAudit,
  appendEvent,
  getPatient,
  getReportBySession,
  getSession,
  getTranscriptRaw,
  listReports,
  putReport,
  updateSession,
} from "@/lib/care/repo";
import { nurseFromRequest } from "@/lib/care/auth";
import { fail, ok, readBody, unauthorized } from "@/lib/care/http";
import { buildReport } from "@/lib/care/report";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const sessionId = url.searchParams.get("sessionId");
  const patientId = url.searchParams.get("patientId");

  if (id) {
    const { getReport } = await import("@/lib/care/repo");
    const report = await getReport(id);
    return report ? ok({ report }) : fail("Report not found.", 404);
  }
  if (sessionId) {
    const report = await getReportBySession(sessionId);
    return ok({ report });
  }
  const reports = await listReports(patientId ?? undefined);
  return ok({ reports });
}

export async function POST(req: NextRequest) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();

  const body = await readBody<{ sessionId?: string; regenerate?: boolean }>(req);
  const sessionId = body?.sessionId?.trim();
  if (!sessionId) return fail("A session is required.", 400);

  const session = await getSession(sessionId);
  if (!session) return fail("Session not found.", 404);

  if (!body?.regenerate) {
    const existing = await getReportBySession(sessionId);
    if (existing) return ok({ report: existing, existing: true });
  }

  const [patient, entries] = await Promise.all([getPatient(session.patientId), getTranscriptRaw(sessionId)]);
  if (!entries.length) {
    return fail("There is no conversation to report on yet.", 409);
  }

  const durationMs =
    session.durationMs ??
    (session.startedAt ? Math.max(0, Date.now() - Date.parse(session.startedAt)) : 0);

  const report = buildReport({
    sessionId,
    patientId: session.patientId,
    patient,
    entries,
    durationMs,
  });

  await putReport(report);
  await updateSession(sessionId, { reportId: report.id });
  await appendEvent(sessionId, "report.generated", "agent", { reportId: report.id });
  await appendAudit({
    actorRole: nurse.role,
    actorId: nurse.userId,
    action: "care.report_generated",
    sessionId,
    patientId: session.patientId,
    detail: { reportId: report.id },
  });

  return ok({ report });
}
