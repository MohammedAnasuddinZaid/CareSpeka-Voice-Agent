import type { NextRequest } from "next/server";
import { appendAudit, createPatient, listPatients } from "@/lib/care/repo";
import { fail, guardNurse, isResponse, ok, readBody } from "@/lib/care/http";

export const dynamic = "force-dynamic";

/**
 * Patients for the care portal.
 *
 *  GET  — list every patient (demo seed + any the nurse created).
 *  POST — create a new patient so records and a bed session can be attached.
 *
 * Nurse-only: patient identities are clinical data.
 */

interface PatientBody {
  displayName?: string;
  age?: number | string | null;
  sex?: string;
  room?: string;
  primaryConcern?: string;
  carePlan?: string;
}

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

export async function POST(req: NextRequest) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;

  const body = await readBody<PatientBody>(req);
  const displayName = (body?.displayName ?? "").trim();
  if (!displayName) return fail("Enter the patient's name.", 400);

  let age: number | null = null;
  if (body?.age !== undefined && body?.age !== null && String(body.age).trim() !== "") {
    const n = Number(body.age);
    if (!Number.isFinite(n) || n < 0 || n > 130) return fail("Enter an age between 0 and 130, or leave it blank.", 400);
    age = Math.round(n);
  }

  const patient = await createPatient({
    displayName,
    age,
    sex: body?.sex,
    room: body?.room,
    primaryConcern: body?.primaryConcern,
    carePlan: body?.carePlan,
  });

  await appendAudit({
    actorRole: nurse.role,
    actorId: nurse.userId,
    action: "care.patient_created",
    patientId: patient.id,
    detail: { displayName: patient.displayName },
  });

  return ok({
    patient: {
      id: patient.id,
      extension: patient.extension,
      displayName: patient.displayName,
      age: patient.age,
      sex: patient.sex,
      room: patient.room,
      primaryConcern: patient.primaryConcern,
      synthetic: patient.synthetic,
      activeConditions: 0,
      activeMedications: 0,
      allergies: 0,
    },
  });
}
