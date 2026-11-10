import type { NextRequest } from "next/server";
import { appendAudit } from "@/lib/care/repo";
import { clearSessionCookie, logout, nurseFromRequest, NURSE_COOKIE } from "@/lib/care/auth";
import { ok } from "@/lib/care/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const nurse = await nurseFromRequest(req);
  const raw = req.headers.get("cookie") ?? "";
  const encoded = raw
    .split(";")
    .map((p) => p.trim().split("="))
    .find(([k]) => k === NURSE_COOKIE)?.[1];
  let token = encoded ?? null;
  if (token) {
    try {
      token = decodeURIComponent(token);
    } catch {
      // keep the raw value
    }
  }
  await logout(token);
  if (nurse) {
    await appendAudit({ actorRole: nurse.role, actorId: nurse.userId, action: "auth.logout" });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie() },
  });
}
