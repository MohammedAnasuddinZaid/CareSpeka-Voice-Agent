import type { NextRequest } from "next/server";
import { nurseFromRequest } from "@/lib/care/auth";
import { ok, unauthorized } from "@/lib/care/http";
import { getStoreInfo } from "@/lib/care/repo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();
  const store = await getStoreInfo();
  return ok({
    user: {
      userId: nurse.userId,
      username: nurse.username,
      displayName: nurse.displayName,
      role: nurse.role,
    },
    store,
  });
}
