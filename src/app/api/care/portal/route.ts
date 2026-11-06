import type { NextRequest } from "next/server";
import {
  alertPortal,
  askPortal,
  buildPortalContext,
  linkPortalSession,
  portalBriefing,
} from "@/lib/care/portalBrain";
import { appendAudit, getPatient } from "@/lib/care/repo";
import { fail, ok, readBody } from "@/lib/care/http";
import { nurseFromRequest } from "@/lib/care/auth";
import { hasRegistration, verifyPairToken } from "@/lib/server/pairing";

export const dynamic = "force-dynamic";

/**
 * The nurse-portal assistant, scoped to one CareSpeak session (the QR the nurse
 * scanned). Nothing here trusts a client-supplied patient id for *reading* —
 * the patient comes from the session link stored server-side.
 *
 * Access control is layered:
 *   1. a signed-in nurse cookie always works;
 *   2. a valid `pair` token from the QR works (proves the caller scanned it);
 *   3. if no pair token was ever registered for the session — e.g. the
 *      serverless in-memory registry was recycled — the session id itself is
 *      the capability, exactly like /api/sync and /api/stream.
 */

const SESSION_RE = /^[A-Z0-9_-]{3,32}$/i;

interface PortalBody {
  session?: string;
  pair?: string;
  action?: string;
  patientId?: string;
  question?: string;
  force?: boolean;
}

interface Access {
  allowed: boolean;
  actor?: { role: string; userId: string; displayName: string };
}

async function authorize(req: NextRequest, session: string, pair?: string | null): Promise<Access> {
  const nurse = await nurseFromRequest(req);
  if (nurse) {
    return { allowed: true, actor: { role: nurse.role, userId: nurse.userId, displayName: nurse.displayName } };
  }
  if (pair && verifyPairToken(session, pair)) return { allowed: true };
  if (!hasRegistration(session)) return { allowed: true };
  return { allowed: false };
}

function normalizeSession(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return SESSION_RE.test(s) ? s : null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const session = normalizeSession(url.searchParams.get("session"));
  if (!session) return fail("A valid session id is required.", 400);

  const access = await authorize(req, session, url.searchParams.get("pair"));
  if (!access.allowed) return fail("Scan the patient's QR code, or sign in, to use the assistant.", 401);

  return ok({ context: await buildPortalContext(session) });
}

export async function POST(req: NextRequest) {
  const body = await readBody<PortalBody>(req);
  const session = normalizeSession(body?.session);
  if (!session) return fail("A valid session id is required.", 400);

  const access = await authorize(req, session, body?.pair);
  if (!access.allowed) return fail("Scan the patient's QR code, or sign in, to use the assistant.", 401);

  const action = (body?.action ?? "context").trim();

  switch (action) {
    case "context":
      return ok({ context: await buildPortalContext(session) });

    case "brief": {
      const brief = await portalBriefing(session);
      return ok({ brief });
    }

    case "ask": {
      const question = (body?.question ?? "").trim().slice(0, 1000);
      const result = await askPortal(session, question);
      return ok({ result });
    }

    case "alert": {
      const result = await alertPortal(session, { force: Boolean(body?.force) });
      return ok({ alert: result });
    }

    case "link": {
      const patientId = body?.patientId?.trim();
      if (!patientId) return fail("Choose a patient to link.", 400);

      const patient = await getPatient(patientId);
      if (!patient) return fail("Patient not found.", 404);

      const link = await linkPortalSession(session, patientId, access.actor?.displayName);
      if (!link) return fail("Patient not found.", 404);

      await appendAudit({
        actorRole: access.actor?.role ?? "nurse",
        actorId: access.actor?.userId,
        action: "care.session_linked",
        sessionId: session,
        patientId,
        detail: { via: "nurse-portal" },
      });

      return ok({ link, context: await buildPortalContext(session) });
    }

    default:
      return fail(`Unknown action: ${action}`, 400);
  }
}