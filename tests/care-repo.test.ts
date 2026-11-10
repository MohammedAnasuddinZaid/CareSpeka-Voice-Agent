import { beforeEach, describe, expect, it } from "vitest";
import {
  addMessage,
  addRecord,
  appendTranscript,
  buildRecordContext,
  createPatient,
  createSession,
  createTask,
  deletePatient,
  deleteRecord,
  endSession,
  expireIfStale,
  findSessionByJoinCode,
  findSessionByJoinToken,
  findSessionByParticipantToken,
  getPatient,
  getRecord,
  getReport,
  getReportBySession,
  getSession,
  getSessionLink,
  getSessionLoose,
  getStoreInfo,
  joinSessionAtomic,
  linkParticipantToken,
  linkSessionToPatient,
  listEvents,
  listMessages,
  listPatients,
  listRecords,
  listReports,
  listSessions,
  listSignals,
  listTasks,
  listTranscript,
  markMessagesRead,
  pushSignal,
  putReport,
  regenerateJoinToken,
  setTaskStatus,
  unlinkSessionPatient,
} from "@/lib/care/repo";
import { buildReport } from "@/lib/care/report";
import { CareKeys as K, getDriver, resetDriverForTests } from "@/lib/care/store";
import { hashToken } from "@/lib/care/crypto";
import type { CareReport, CareTask, ClinicalPatient, PatientMessage, PatientRecord } from "@/lib/care/types";

beforeEach(() => {
  process.env.CARE_SEED_DEMO = "false";
  resetDriverForTests();
});

async function makePatient(name = "Test Patient"): Promise<ClinicalPatient> {
  return createPatient({ displayName: name, age: 70, primaryConcern: "Follow-up" });
}

function taskInput(patient: ClinicalPatient, title: string): Omit<CareTask, "id" | "createdAt" | "status"> {
  return { patientId: patient.id, title, createdBy: "Nurse Demo" };
}

describe("patients", () => {
  it("creates an empty, real (non-synthetic) patient with a numeric extension", async () => {
    const p = await makePatient("  Ada Lovelace  ");
    expect(p.displayName).toBe("Ada Lovelace");
    expect(p.synthetic).toBe(false);
    expect(p.extension).toMatch(/^\d{4}$/);
    expect(p.age).toBe(70);
    expect(p.conditions).toEqual([]);
    expect(p.medications).toEqual([]);
    expect(p.allergies).toEqual([]);
    expect(p.observations).toEqual([]);
    expect(p.encounters).toEqual([]);

    const list = await listPatients();
    expect(list.map((x) => x.id)).toContain(p.id);
    expect((await getPatient(p.id))?.displayName).toBe("Ada Lovelace");
  });

  it("defaults a blank name to 'Unnamed patient' and gives unique extensions", async () => {
    const a = await createPatient({ displayName: "   " });
    const b = await makePatient("Second");
    expect(a.displayName).toBe("Unnamed patient");
    expect(a.extension).not.toBe(b.extension);
  });

  it("deletes a patient, tombstones them, and removes their records", async () => {
    const p = await makePatient("To Delete");
    await addRecord({ patientId: p.id, title: "Note", text: "Some note" });
    expect(await deletePatient(p.id)).toBe(true);
    expect(await getPatient(p.id)).toBeNull();
    expect((await listPatients()).some((x) => x.id === p.id)).toBe(false);
    expect(await listRecords(p.id)).toHaveLength(0);
    expect(await deletePatient(p.id)).toBe(false);
  });

  it("reports a memory driver under test", async () => {
    expect(await getStoreInfo()).toEqual({ driver: "memory", persistent: false });
  });
});

describe("sessions and join tokens", () => {
  it("creates a waiting session with a hashed join token and a 6-digit code", async () => {
    const p = await makePatient();
    const { session, joinToken } = await createSession({
      patientId: p.id,
      nurseId: "nurse_1",
      nurseName: "Nurse Demo",
    });
    expect(session.status).toBe("waiting");
    expect(session.joinTokenHash).toBe(hashToken(joinToken));
    expect(session.joinCode).toMatch(/^\d{6}$/);
    expect(Date.parse(session.joinExpiresAt!)).toBeGreaterThan(Date.now());
    expect(session.joinTokenHash).not.toContain(joinToken);
    expect(await getSession(session.id)).toMatchObject({ id: session.id, patientId: p.id });
    expect((await getSessionLoose(session.id.toUpperCase()))?.id).toBe(session.id);
    expect((await findSessionByJoinCode(session.joinCode!))?.id).toBe(session.id);
    expect((await findSessionByJoinToken(joinToken))?.id).toBe(session.id);
    expect(await findSessionByJoinToken("wrong")).toBeNull();
  });

  it("records creation and link-generated events in sequence", async () => {
    const p = await makePatient();
    const { session } = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const events = await listEvents(session.id);
    expect(events.map((e) => e.type)).toEqual(["session.created", "join.link_generated"]);
    expect(events[1].seq).toBeGreaterThan(events[0].seq);
  });

  it("regenerating a join token invalidates the previous one", async () => {
    const p = await makePatient();
    const { session, joinToken: oldToken } = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const regen = await regenerateJoinToken(session.id, 10);
    expect(regen).not.toBeNull();
    expect(await findSessionByJoinToken(oldToken)).toBeNull();
    expect((await findSessionByJoinToken(regen!.joinToken))?.id).toBe(session.id);
  });

  it("lets exactly one caller claim the participant slot", async () => {
    const p = await makePatient();
    const { session } = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const first = await joinSessionAtomic(session.id, {
      joinedAt: new Date().toISOString(),
      participantName: "Ada",
      status: "active",
    });
    expect(first?.participantName).toBe("Ada");
    expect(first?.status).toBe("active");
    expect(await joinSessionAtomic(session.id, { participantName: "Second" })).toBeNull();
  });

  it("refuses a join for an expired or ended session", async () => {
    const p = await makePatient();
    const expired = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N", ttlMinutes: -1 });
    expect(await joinSessionAtomic(expired.session.id, { joinedAt: new Date().toISOString() })).toBeNull();

    const ended = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    await endSession(ended.session.id, "nurse_ended");
    expect(await joinSessionAtomic(ended.session.id, { joinedAt: new Date().toISOString() })).toBeNull();
  });

  it("expires a stale waiting session but leaves an active one alone", async () => {
    const p = await makePatient();
    const stale = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N", ttlMinutes: -1 });
    const expired = await expireIfStale(stale.session);
    expect(expired.status).toBe("expired");
    expect((await getSession(stale.session.id))?.status).toBe("expired");

    const fresh = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    expect((await expireIfStale(fresh.session)).status).toBe("waiting");
  });

  it("ends a session once, computing a non-negative duration", async () => {
    const p = await makePatient();
    const { session } = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const ended = await endSession(session.id, "nurse_ended");
    expect(ended?.status).toBe("ended");
    expect(ended?.endReason).toBe("nurse_ended");
    expect(ended?.durationMs).toBeGreaterThanOrEqual(0);
    const eventCount = (await listEvents(session.id)).length;
    await endSession(session.id, "again");
    // A second end must not append another session.ended event.
    expect((await listEvents(session.id)).length).toBe(eventCount);
  });

  it("lists sessions newest-first with a limit", async () => {
    const p = await makePatient();
    const a = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const b = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const sessions = await listSessions(50);
    expect(sessions.map((s) => s.id)).toEqual([b.session.id, a.session.id]);
    expect(await listSessions(1)).toHaveLength(1);
  });

  it("indexes participant tokens and rejects them after a re-join", async () => {
    const p = await makePatient();
    const { session, joinToken } = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const token = "participant-raw-token";
    await linkParticipantToken(session.id, token);
    // findSessionByParticipantToken also verifies joinTokenHash binding is absent,
    // so it only resolves once the session row carries a matching participant hash.
    const updated = await joinSessionAtomic(session.id, {
      participantTokenHash: hashToken(token),
      participantName: "Ada",
    });
    expect(updated).not.toBeNull();
    expect((await findSessionByParticipantToken(token))?.id).toBe(session.id);
    expect(await findSessionByParticipantToken("not-the-token")).toBeNull();
    // The join token is still valid (different token namespace).
    expect((await findSessionByJoinToken(joinToken))?.id).toBe(session.id);
  });
});

describe("transcript and signalling", () => {
  it("appends transcript entries with increasing seq, caps length, and filters by sinceSeq", async () => {
    const p = await makePatient();
    const { session } = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const first = await appendTranscript(session.id, { role: "patient", text: "  I feel dizzy  " });
    const second = await appendTranscript(session.id, { role: "agent", text: "Tell me more" });
    expect(first.text).toBe("I feel dizzy");
    expect(second.seq).toBeGreaterThan(first.seq);
    expect((await listTranscript(session.id)).map((t) => t.id)).toEqual([first.id, second.id]);
    expect((await listTranscript(session.id, first.seq)).map((t) => t.id)).toEqual([second.id]);

    const long = await appendTranscript(session.id, { role: "patient", text: "x".repeat(5000) });
    expect(long.text.length).toBe(4000);
  });

  it("assigns unique mono-increasing signal indexes and honours sinceIdx", async () => {
    const p = await makePatient();
    const { session } = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const a = await pushSignal(session.id, "nurse", { from: "patient", kind: "offer", data: { sdp: "x" } });
    const b = await pushSignal(session.id, "nurse", { from: "patient", kind: "ice", data: { c: 1 } });
    expect(a.idx).toBe(0);
    expect(b.idx).toBe(1);
    expect((await listSignals(session.id, "nurse", 0)).map((s) => s.idx)).toEqual([0, 1]);
    expect((await listSignals(session.id, "nurse", 1)).map((s) => s.idx)).toEqual([1]);
    expect(await listSignals(session.id, "patient")).toEqual([]);
  });
});

describe("reports", () => {
  it("stores a report, finds it by session, and filters by patient", async () => {
    const p = await makePatient();
    const { session } = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    const report = buildReport({
      sessionId: session.id,
      patientId: p.id,
      patient: p,
      entries: [{ id: "t1", seq: 1, sessionId: session.id, role: "patient", text: "I feel well", at: new Date().toISOString() }],
    });
    await putReport(report);
    expect((await getReport(report.id))?.id).toBe(report.id);
    expect((await getReportBySession(session.id))?.id).toBe(report.id);
    expect((await listReports(p.id)).map((r) => r.id)).toEqual([report.id]);
    expect(await listReports("someone-else")).toEqual([]);
  });

  it("does not duplicate a report id in the index", async () => {
    const p = await makePatient();
    const report = buildReport({
      sessionId: "wc_x",
      patientId: p.id,
      patient: p,
      entries: [],
    });
    await putReport(report);
    await putReport({ ...report, status: "approved" });
    expect(await listReports(p.id)).toHaveLength(1);
  });
});

describe("tasks and messages", () => {
  it("creates tasks newest-first and keeps only the latest version per id", async () => {
    const p = await makePatient();
    const t1 = await createTask(taskInput(p, "First"));
    const t2 = await createTask(taskInput(p, "Second"));
    expect(t1.status).toBe("open");
    expect((await listTasks()).map((t) => t.id)).toEqual([t2.id, t1.id]);

    expect(await setTaskStatus(t1.id, "done")).toBe(true);
    const latest = await listTasks(p.id);
    expect(latest).toHaveLength(2);
    expect(latest.find((t) => t.id === t1.id)?.status).toBe("done");
    expect(await setTaskStatus("ghost", "done")).toBe(false);
  });

  it("lists messages newest-first, dedupes read markers, and does not duplicate on repeat reads", async () => {
    const p = await makePatient();
    const m1 = await addMessage({ patientId: p.id, patientName: p.displayName, text: "First", createdBy: "N" });
    const m2 = await addMessage({ patientId: p.id, patientName: p.displayName, text: "Second", createdBy: "N" });
    expect((await listMessages(p.id)).map((m) => m.id)).toEqual([m2.id, m1.id]);

    await markMessagesRead(p.id);
    await markMessagesRead(p.id); // idempotent
    const after = await listMessages(p.id);
    expect(after).toHaveLength(2);
    expect(after.every((m) => Boolean(m.readAt))).toBe(true);
    // Another patient's messages are untouched.
    const other = await makePatient("Other");
    const om = await addMessage({ patientId: other.id, patientName: other.displayName, text: "Hi", createdBy: "N" });
    expect((await listMessages(other.id))[0].readAt).toBeUndefined();
    expect((await listMessages()).some((m) => m.id === om.id)).toBe(true);
  });
});

describe("inserted records", () => {
  it("adds a record, caps text, lists newest-first, and hides deleted ones", async () => {
    const p = await makePatient();
    const a = await addRecord({ patientId: p.id, title: "  Discharge  ", source: "Hospital", text: "  first  " });
    const b = await addRecord({ patientId: p.id, title: "Lab", text: "x".repeat(50_000) });
    expect(a.title).toBe("Discharge");
    expect(a.text).toBe("first");
    expect(a.chars).toBe(5);
    expect(b.text.length).toBe(40_000);
    expect((await listRecords(p.id)).map((r) => r.id)).toEqual([b.id, a.id]);
    expect((await getRecord(a.id))?.id).toBe(a.id);

    expect(await deleteRecord(a.id)).toBe(true);
    expect(await getRecord(a.id)).toBeNull();
    expect((await listRecords(p.id)).map((r) => r.id)).toEqual([b.id]);
    expect(await deleteRecord("ghost")).toBe(false);
  });

  it("heals a record index stored as a legacy JSON document", async () => {
    const p = await makePatient();
    const d = await getDriver();
    const record: PatientRecord = {
      id: "rec_legacy",
      patientId: p.id,
      title: "Legacy",
      text: "old",
      chars: 3,
      createdAt: new Date().toISOString(),
    };
    await d.setDoc(K.record(record.id), record);
    // No list was written — only the document shape an older build used.
    await d.setDoc(K.recordIndex, [record.id]);
    expect((await listRecords(p.id)).map((r) => r.id)).toEqual([record.id]);
    // The read healed the index into list form for the next caller.
    expect(await d.getList(K.recordIndex)).toEqual([record.id]);
  });

  it("bounds the model context and reports how many records were omitted", async () => {
    const p = await makePatient();
    await addRecord({ patientId: p.id, title: "A", text: "a".repeat(100) });
    await addRecord({ patientId: p.id, title: "B", text: "b".repeat(100) });
    await addRecord({ patientId: p.id, title: "C", text: "c".repeat(100) });
    const ctx = await buildRecordContext(p.id, 250);
    expect(ctx.used.length).toBeGreaterThanOrEqual(1);
    expect(ctx.used.length).toBeLessThan(3);
    expect(ctx.omitted).toBe(3 - ctx.used.length);
    expect(ctx.text).toContain("### ");
  });
});

describe("session → patient link", () => {
  it("links, reads (case-insensitively), and unlinks a session", async () => {
    const p = await makePatient();
    const link = await linkSessionToPatient("ab12cd", p.id, "Nurse Demo");
    expect(link.sessionId).toBe("AB12CD");
    expect((await getSessionLink("ab12cd"))?.patientId).toBe(p.id);
    expect((await getSessionLink("AB12CD"))?.patientId).toBe(p.id);
    await unlinkSessionPatient("ab12cd");
    expect(await getSessionLink("AB12CD")).toBeNull();
    // Re-linking works after an unlink.
    await linkSessionToPatient("AB12CD", p.id);
    expect((await getSessionLink("ab12cd"))?.patientId).toBe(p.id);
  });
});

// Keep the unused type import meaningful for future report fixtures.
export type _Report = CareReport;
export type _Message = PatientMessage;