import type { NextRequest } from "next/server";
import { appendAudit, getSession, regenerateJoinToken } from "@/lib/care/repo";
import { nurseFromRequest } from "@/lib/care/auth";
import { publicBaseUrl, fail, ok, unauthorized } from "@/lib/care/http";
import { makeQrDataUrl } from "@/lib/care/qr";
import { sessionView } from "@/lib/care/view";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();

  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) return fail("Session not found.", 404);
  if (session.status === "ended") return fail("This session has already ended.", 409);

  const ttl = Number(process.env.CARE_JOIN_TTL_MINUTES || "30");
  const regenerated = await regenerateJoinToken(id, ttl);
  if (!regenerated) return fail("Could not generate a join link.", 500);

  const baseUrl = publicBaseUrl(req);
  const view = await sessionView(regenerated.session, { forNurse: true, joinToken: regenerated.joinToken, baseUrl });
  const qrDataUrl = await makeQrDataUrl(view.joinUrl!);

  await appendAudit({
    actorRole: nurse.role,
    actorId: nurse.userId,
    action: "care.join_link_regenerated",
    sessionId: id,
    patientId: session.patientId,
  });

  return ok({ session: view, qrDataUrl, joinToken: regenerated.joinToken });
}
