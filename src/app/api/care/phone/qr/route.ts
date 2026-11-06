import type { NextRequest } from "next/server";
import { fail, ok, publicBaseUrl } from "@/lib/care/http";
import { makeQrDataUrl } from "@/lib/care/qr";
import { authorizeSession } from "@/lib/care/sessionAccess";

export const dynamic = "force-dynamic";

const SESSION_RE = /^[A-Z0-9_-]{3,32}$/i;

/**
 * Returns a QR code and absolute link for the free browser call
 * (`/care/phone`). The same capability rules as /api/care/portal apply: a nurse
 * cookie, the QR pair token, or an unregistered demo session.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const session = (url.searchParams.get("session") ?? "").trim().toUpperCase();
  if (!SESSION_RE.test(session)) return fail("A valid session id is required.", 400);

  const pair = url.searchParams.get("pair");
  const access = await authorizeSession(req, session, pair);
  if (!access.allowed) {
    return fail("Scan the patient's QR code, or sign in, to open the browser call.", 401);
  }

  const target = new URL("/care/phone", publicBaseUrl(req));
  target.searchParams.set("session", session);
  if (pair) target.searchParams.set("pair", pair);
  const link = target.toString();

  return ok({ url: link, qrDataUrl: await makeQrDataUrl(link) });
}
