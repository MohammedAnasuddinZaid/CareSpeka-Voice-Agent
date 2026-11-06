import type { NextRequest } from "next/server";
import {
  addRecord,
  appendAudit,
  deleteRecord,
  getPatient,
  listRecords,
  RECORD_MAX_CHARS,
} from "@/lib/care/repo";
import { guardNurse, isResponse, ok, fail, readBody } from "@/lib/care/http";

export const dynamic = "force-dynamic";

/**
 * Patient records the nurse inserts so the portal assistant has history.
 *
 *  GET    ?patientId=X        — list records (newest first), summaries only
 *  POST   { patientId, title, source?, text } — add one record
 *  DELETE ?id=X               — remove one record
 *
 * Nurse-only: these documents are clinical history, so they never leak to an
 * unauthenticated caller the way the session-scoped sync channel can.
 */

interface RecordBody {
  patientId?: string;
  title?: string;
  source?: string;
  text?: string;
}

export async function GET(req: NextRequest) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;

  const patientId = new URL(req.url).searchParams.get("patientId")?.trim() || undefined;
  const records = await listRecords(patientId);
  return ok({
    records: records.map((r) => ({
      id: r.id,
      patientId: r.patientId,
      title: r.title,
      source: r.source,
      chars: r.chars,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      synthetic: r.synthetic,
    })),
  });
}

export async function POST(req: NextRequest) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;

  const body = await readBody<RecordBody>(req);
  const patientId = body?.patientId?.trim();
  const title = (body?.title ?? "").trim();
  const text = (body?.text ?? "").trim();

  if (!patientId) return fail("Choose a patient first.", 400);
  if (!title) return fail("Give the record a title, for example “Discharge summary”.", 400);
  if (!text) return fail("Paste the record text or upload a file.", 400);
  if (text.length > RECORD_MAX_CHARS) {
    return fail(`That record is ${text.length.toLocaleString()} characters. The limit is ${RECORD_MAX_CHARS.toLocaleString()}.`, 413);
  }

  const patient = await getPatient(patientId);
  if (!patient) return fail("Patient not found.", 404);

  const record = await addRecord({
    patientId,
    title,
    source: body?.source,
    text,
    createdBy: nurse.displayName,
  });

  await appendAudit({
    actorRole: nurse.role,
    actorId: nurse.userId,
    action: "care.record_added",
    patientId,
    detail: { recordId: record.id, title: record.title, chars: record.chars },
  });

  return ok({
    record: {
      id: record.id,
      patientId: record.patientId,
      title: record.title,
      source: record.source,
      chars: record.chars,
      createdAt: record.createdAt,
      createdBy: record.createdBy,
    },
  });
}

export async function DELETE(req: NextRequest) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;

  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id) return fail("A record id is required.", 400);

  const records = await listRecords();
  const target = records.find((r) => r.id === id);
  if (!target) return fail("Record not found.", 404);

  const removed = await deleteRecord(id);
  if (!removed) return fail("Record not found.", 404);

  await appendAudit({
    actorRole: nurse.role,
    actorId: nurse.userId,
    action: "care.record_removed",
    patientId: target.patientId,
    detail: { recordId: id, title: target.title },
  });

  return ok({ deleted: true, id });
}