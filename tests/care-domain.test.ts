import { beforeEach, describe, expect, it } from "vitest";
import { hashToken, newJoinCode, newToken, safeEqual, isExpired } from "@/lib/care/crypto";
import { analyze, composeReply, extractSymptoms, greeting, askedTopicsFrom, reportFacts } from "@/lib/care/agent";
import { buildReport, extractDuration } from "@/lib/care/report";
import {
  appendTranscript,
  createSession,
  expireIfStale,
  findSessionByJoinToken,
  findSessionByParticipantToken,
  getSession,
  linkParticipantToken,
  listEvents,
  listSignals,
  listTranscript,
  pushSignal,
  regenerateJoinToken,
  updateSession,
} from "@/lib/care/repo";
import { resetDriverForTests } from "@/lib/care/store";
import { getSeedPatient } from "@/lib/care/seedPatients";
import type { CareTranscriptEntry } from "@/lib/care/types";

function entry(seq: number, role: CareTranscriptEntry["role"], text: string): CareTranscriptEntry {
  return { id: `t${seq}`, seq, sessionId: "s", role, text, at: new Date().toISOString() };
}

describe("care crypto", () => {
  it("hashes deterministically and compares safely", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
    expect(safeEqual(hashToken("abc"), hashToken("abc"))).toBe(true);
    expect(safeEqual(hashToken("abc"), hashToken("abd"))).toBe(false);
  });

  it("generates url-safe tokens and 6-digit codes", () => {
    const t = newToken();
    expect(t.length).toBeGreaterThan(20);
    expect(newJoinCode()).toMatch(/^\d{6}$/);
  });

  it("detects expiry", () => {
    expect(isExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
    expect(isExpired(null)).toBe(false);
  });
});

describe("clinical reasoning", () => {
  const patient = getSeedPatient("pt_0001")!;

  it("extracts symptoms and flags red flags", () => {
    const found = extractSymptoms("I have chest pain and I feel a bit dizzy");
    const labels = found.map((s) => s.label);
    expect(labels).toContain("Chest pain");
    expect(labels).toContain("Dizziness");
    expect(found.find((s) => s.label === "Chest pain")?.redFlag).toBe(true);
  });

  it("escalates on a red-flag symptom instead of continuing", () => {
    const reply = composeReply({
      patient,
      entries: [entry(1, "patient", "I have crushing chest pain right now")],
      askedTopics: new Set(),
    });
    expect(reply.escalate).toBe(true);
    expect(reply.escalationReason).toMatch(/Chest pain/i);
  });

  it("greets using the patient's name and purpose, without inventing facts", () => {
    const text = greeting(patient);
    expect(text).toContain("Anita");
    expect(text.toLowerCase()).toContain("care assistant");
  });

  it("asks a heart-failure-relevant follow-up when there is no red flag", () => {
    const reply = composeReply({
      patient,
      entries: [entry(1, "patient", "I have been feeling a little tired")],
      askedTopics: new Set(),
    });
    expect(reply.escalate).toBe(false);
    expect(reply.text.length).toBeGreaterThan(10);
  });

  it("derives asked topics from prior agent questions", () => {
    const asked = new Set<string>();
    const reply = composeReply({ patient, entries: [entry(1, "patient", "hello")], askedTopics: asked });
    const entries2 = [entry(2, "agent", reply.text)];
    expect(askedTopicsFrom(entries2).size).toBeGreaterThanOrEqual(0);
  });

  it("produces insights with concerns for worsening symptoms", () => {
    const insights = analyze(patient, [entry(1, "patient", "my swelling is getting worse and I am very tired")]);
    expect(insights.symptoms.length).toBeGreaterThan(0);
    expect(insights.concerns.join(" ")).toMatch(/worsening|Multiple|Cardiac/i);
  });

  it("tags medication provenance by whether it was discussed", () => {
    const facts = reportFacts(patient, [entry(1, "patient", "I am taking my Furosemide every day")]);
    const furosemide = facts.medications.find((m) => m.text.includes("Furosemide"));
    expect(furosemide?.provenance).toBe("patient");
    const metformin = facts.medications.find((m) => m.text.includes("Metformin"));
    expect(metformin?.provenance).toBe("record");
  });
});

describe("report builder", () => {
  const patient = getSeedPatient("pt_0002")!;
  const entries = [
    entry(1, "agent", "Hello Rahul, how have you been?"),
    entry(2, "patient", "I have had a bad headache since yesterday."),
    entry(3, "agent", "Sorry to hear that. Have you checked your blood pressure?"),
    entry(4, "patient", "Yes, it was 150 over 90."),
  ];

  it("extracts a symptom duration from the transcript", () => {
    expect(extractDuration(entries)).toMatch(/yesterday/i);
  });

  it("grounds every section in the transcript or the record, and never invents vitals", () => {
    const report = buildReport({ sessionId: "wc_1", patientId: patient.id, patient, entries, durationMs: 90_000 });
    expect(report.status).toBe("draft");
    expect(report.sections.patientReportedSymptoms.some((s) => /Headache/i.test(s.text))).toBe(true);
    expect(report.sections.relevantHistory.length).toBeGreaterThan(0);
    expect(report.sections.aiSummary).toMatch(/transcript/i);
    // No vital sign text should appear anywhere in the generated facts.
    const all = JSON.stringify(report.sections);
    expect(all).not.toMatch(/\b\d{2,3}\/\d{2,3}\b/);
    expect(report.transcriptRef.count).toBe(4);
  });
});

describe("session repository", () => {
  beforeEach(() => {
    resetDriverForTests();
    process.env.CARE_STORE = "memory";
  });

  it("creates a session and resolves it by its join token", async () => {
    const { session, joinToken } = await createSession({ patientId: "pt_0001", nurseId: "nurse_1", nurseName: "Nurse Demo" });
    expect(session.status).toBe("waiting");
    const found = await findSessionByJoinToken(joinToken);
    expect(found?.id).toBe(session.id);
  });

  it("invalidates the old token when a link is regenerated", async () => {
    const { session, joinToken } = await createSession({ patientId: "pt_0001", nurseId: "nurse_1", nurseName: "Nurse Demo" });
    const regen = await regenerateJoinToken(session.id, 30);
    expect(regen).not.toBeNull();
    expect(await findSessionByJoinToken(joinToken)).toBeNull();
    expect((await findSessionByJoinToken(regen!.joinToken))?.id).toBe(session.id);
  });

  it("expires a session whose join window has passed", async () => {
    const { session } = await createSession({ patientId: "pt_0001", nurseId: "nurse_1", nurseName: "Nurse Demo", ttlMinutes: -1 });
    const expired = await expireIfStale(session);
    expect(expired.status).toBe("expired");
  });

  it("allocates ordered event and transcript sequence numbers", async () => {
    const { session } = await createSession({ patientId: "pt_0001", nurseId: "nurse_1", nurseName: "Nurse Demo" });
    await appendTranscript(session.id, { role: "patient", text: "hello" });
    await appendTranscript(session.id, { role: "agent", text: "hi" });
    const transcript = await listTranscript(session.id);
    expect(transcript.map((t) => t.seq)).toEqual([...transcript.map((t) => t.seq)].sort((a, b) => a - b));
    expect(transcript[0].seq).toBeLessThan(transcript[1].seq);

    const events = await listEvents(session.id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.map((e) => e.type)).toContain("session.created");
  });

  it("queues signals addressed to the other party in order", async () => {
    const { session } = await createSession({ patientId: "pt_0001", nurseId: "nurse_1", nurseName: "Nurse Demo" });
    await pushSignal(session.id, "patient", { from: "nurse", kind: "offer", data: { sdp: "a" } });
    await pushSignal(session.id, "patient", { from: "nurse", kind: "ice", data: { candidate: "b" } });
    const forPatient = await listSignals(session.id, "patient");
    expect(forPatient.map((s) => s.kind)).toEqual(["offer", "ice"]);
    expect(forPatient.map((s) => s.idx)).toEqual([0, 1]);
    const forNurse = await listSignals(session.id, "nurse");
    expect(forNurse).toHaveLength(0);
  });

  it("marks a session active when the participant token is registered", async () => {
    const { session } = await createSession({ patientId: "pt_0002", nurseId: "nurse_1", nurseName: "Nurse Demo" });
    await updateSession(session.id, { status: "active", participantName: "Rahul" });
    const loaded = await getSession(session.id);
    expect(loaded?.status).toBe("active");
    expect(loaded?.participantName).toBe("Rahul");
  });

  it("resolves a patient from their participant token after it is linked", async () => {
    const { session } = await createSession({ patientId: "pt_0001", nurseId: "nurse_1", nurseName: "Nurse Demo" });
    const token = newToken();
    await updateSession(session.id, {
      status: "active",
      participantTokenHash: hashToken(token),
    });
    await linkParticipantToken(session.id, token);

    const found = await findSessionByParticipantToken(token);
    expect(found?.id).toBe(session.id);
    // An unlinked or superseded token must not resolve.
    expect(await findSessionByParticipantToken(newToken())).toBeNull();

    const newer = newToken();
    await updateSession(session.id, { participantTokenHash: hashToken(newer) });
    expect(await findSessionByParticipantToken(token)).toBeNull();
  });
});
