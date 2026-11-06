import type { NextRequest } from "next/server";
import { guardNurse, isResponse, fail, ok } from "@/lib/care/http";
import { getPatient, listReports, listSessions, listTasks, deletePatient } from "@/lib/care/repo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;
  const { id } = await ctx.params;
  const patient = await getPatient(id);
  if (!patient) return fail("Patient not found.", 404);

  const [reports, tasks, sessions] = await Promise.all([
    listReports(id),
    listTasks(id),
    listSessions(100),
  ]);

  return ok({
    patient,
    reports,
    tasks,
    sessions: sessions.filter((s) => s.patientId === id),
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;
  const { id } = await ctx.params;
  const ok_ = await deletePatient(id);
  if (!ok_) return fail("Patient not found.", 404);
  return ok({ deleted: id });
}
