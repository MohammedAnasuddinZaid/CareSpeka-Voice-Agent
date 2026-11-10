/**
 * Shared authorisation for session-scoped care endpoints (the nurse portal and
 * the emergency/demo call trigger). Server-only.
 *
 * Layered, weakest-to-strongest:
 *   1. a signed-in nurse cookie always works;
 *   2. a valid `pair` token from the patient's QR proves the caller scanned it.
 *
 * Note: a session id alone is NOT a capability. Pair tokens must be persisted in
 * the shared store so they survive instance recycling.
 */
import type { NextRequest } from "next/server";
import { nurseFromRequest } from "./auth";
import { verifyPairTokenPersistent } from "@/lib/server/pairing";

export interface SessionActor {
  role: string;
  userId: string;
  displayName: string;
}

export interface SessionAccess {
  allowed: boolean;
  actor?: SessionActor;
}

export async function authorizeSession(
  req: NextRequest,
  session: string,
  pair?: string | null
): Promise<SessionAccess> {
  const nurse = await nurseFromRequest(req);
  if (nurse) {
    return {
      allowed: true,
      actor: { role: nurse.role, userId: nurse.userId, displayName: nurse.displayName },
    };
  }
  if (pair && (await verifyPairTokenPersistent(session, pair))) return { allowed: true };
  return { allowed: false };
}
