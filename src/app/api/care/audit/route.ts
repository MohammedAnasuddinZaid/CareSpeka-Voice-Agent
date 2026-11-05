import type { NextRequest } from "next/server";
import { listAudit } from "@/lib/care/repo";
import { nurseFromRequest } from "@/lib/care/auth";
import { ok, unauthorized } from "@/lib/care/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || "200");
  const patientId = url.searchParams.get("patientId") || undefined;
  const entries = await listAudit(Number.isFinite(limit) ? Math.min(limit, 1000) : 200);
  return ok({ audit: patientId ? entries.filter((e) => e.patientId === patientId) : entries });
}
