import type { NextRequest } from "next/server";
import { appendAudit } from "@/lib/care/repo";
import { clearSessionCookie, logout, NURSE_COOKIE } from "@/lib/care/auth";
import { ok } from "@/lib/care/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const raw = req.headers.get("cookie") ?? "";
  const token = raw
    .split(";")
    .map((p) => p.trim().split("="))
    .find(([k]) => k === NURSE_COOKIE)?.[1];
  await logout(token ? decodeURIComponent(token) : null);
  await appendAudit({ actorRole: "nurse", action: "auth.logout" });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie() },
  });
}
