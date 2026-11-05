import type { NextRequest } from "next/server";
import { appendAudit, appendEvent, getReport, putReport } from "@/lib/care/repo";
import { nurseFromRequest } from "@/lib/care/auth";
import { fail, ok, readBody, unauthorized } from "@/lib/care/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();
  const { id } = await ctx.params;
  const report = await getReport(id);
  return report ? ok({ report }) : fail("Report not found.", 404);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();
  const { id } = await ctx.params;

  const report = await getReport(id);
  if (!report) return fail("Report not found.", 404);

  const body = await readBody<{
    action?: "approve" | "edit" | "reopen";
    nurseEditedSummary?: string;
    reviewNote?: string;
  }>(req);

  if (body?.action === "edit" || typeof body?.nurseEditedSummary === "string") {
    if (typeof body?.nurseEditedSummary === "string") {
      report.nurseEditedSummary = body.nurseEditedSummary.slice(0, 4000);
    }
    if (typeof body?.reviewNote === "string") report.reviewNote = body.reviewNote.slice(0, 1000);
    await putReport(report);
    await appendAudit({
      actorRole: nurse.role,
      actorId: nurse.userId,
      action: "care.report_edited",
      sessionId: report.sessionId,
      patientId: report.patientId,
      detail: { reportId: report.id },
    });
    return ok({ report });
  }

  if (body?.action === "approve") {
    report.status = "approved";
    report.reviewedAt = new Date().toISOString();
    report.reviewedBy = nurse.displayName;
    if (typeof body?.reviewNote === "string") report.reviewNote = body.reviewNote.slice(0, 1000);
    report.sourceFlags.reviewed = true;
    await putReport(report);
    await appendEvent(report.sessionId, "report.reviewed", "nurse", { reportId: report.id, by: nurse.displayName });
    await appendAudit({
      actorRole: nurse.role,
      actorId: nurse.userId,
      action: "care.report_reviewed",
      sessionId: report.sessionId,
      patientId: report.patientId,
      detail: { reportId: report.id },
    });
    return ok({ report });
  }

  if (body?.action === "reopen") {
    report.status = "draft";
    report.sourceFlags.reviewed = false;
    await putReport(report);
    await appendAudit({
      actorRole: nurse.role,
      actorId: nurse.userId,
      action: "care.report_reopened",
      sessionId: report.sessionId,
      patientId: report.patientId,
      detail: { reportId: report.id },
    });
    return ok({ report });
  }

  return fail("Unknown report action.", 400);
}
