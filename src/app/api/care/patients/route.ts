import type { NextRequest } from "next/server";
import { guardNurse, isResponse, ok } from "@/lib/care/http";
import { listPatients } from "@/lib/care/repo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;
  const patients = await listPatients();
  return ok({
    patients: patients.map((p) => ({
      id: p.id,
      extension: p.extension,
      displayName: p.displayName,
      age: p.age,
      sex: p.sex,
      room: p.room,
      primaryConcern: p.primaryConcern,
      synthetic: p.synthetic,
      activeConditions: p.conditions.filter((c) => c.status === "active").length,
      activeMedications: p.medications.filter((m) => m.status === "active").length,
      allergies: p.allergies.length,
    })),
  });
}
