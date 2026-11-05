import type { NextRequest } from "next/server";
import { listTasks, setTaskStatus } from "@/lib/care/repo";
import { nurseFromRequest } from "@/lib/care/auth";
import { fail, ok, readBody, unauthorized } from "@/lib/care/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();
  const url = new URL(req.url);
  const patientId = url.searchParams.get("patientId") || undefined;
  return ok({ tasks: await listTasks(patientId) });
}

export async function PATCH(req: NextRequest) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();
  const body = await readBody<{ id?: string; status?: "open" | "done" }>(req);
  if (!body?.id || (body.status !== "open" && body.status !== "done")) {
    return fail("A task id and status are required.", 400);
  }
  await setTaskStatus(body.id, body.status);
  return ok({ tasks: await listTasks() });
}
