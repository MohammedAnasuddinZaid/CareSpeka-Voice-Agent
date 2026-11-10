import { beforeEach, describe, expect, it } from "vitest";
import { buildAssistantContext } from "@/lib/care/assistantContext";
import { sessionView } from "@/lib/care/view";
import { makeQrDataUrl } from "@/lib/care/qr";
import {
  addMessage,
  appendTranscript,
  createPatient,
  createSession,
  createTask,
  getSession,
  joinSessionAtomic,
  listSessions,
  putReport,
  setTaskStatus,
} from "@/lib/care/repo";
import { CareKeys as K, getDriver, resetDriverForTests } from "@/lib/care/store";
import { getSeedPatient } from "@/lib/care/seedPatients";
import type { CareReport } from "@/lib/care/types";

beforeEach(() => {
  process.env.CARE_SEED_DEMO = "false";
  resetDriverForTests();
  delete (globalThis as unknown as { __carespeakStoreP?: unknown }).__carespeakStoreP;
});

async function patient(name = "Asha Rao") {
  return createPatient({ displayName: name, age: 71, primaryConcern: "Breathlessness" });
}

function reportFor(input: { sessionId: string; patientId: string; id?: string }): CareReport {
  return {
    id: input.id ?? "rpt_test",
    sessionId: input.sessionId,
    patientId: input.patientId,
    status: "draft",
    generatedAt: new Date().toISOString(),
    sections: {
      reasonForInteraction: "Breathlessness",
      patientReportedSymptoms: [{ text: "Short of breath", provenance: "patient" as never }],
      symptomDuration: "2 days",
      relevantHistory: [],
      medicationsDiscussed: [],
      allergiesDiscussed: [],
      keyPoints: ["Review inhaler"],
      aiSummary: "Summary",
      concernsForNurse: [],
      escalations: [],
      suggestedFollowUp: [],
      unresolvedQuestions: [],
    },
    transcriptRef: { count: 0, firstSeq: 0, lastSeq: 0 },
    transcript: [],
    sourceFlags: {
      recordDerived: false,
      patientReported: true,
      aiGenerated: true,
      reviewed: false,
    } as never,
  } as CareReport;
}

describe("buildAssistantContext", () => {
  it("returns an empty hospital with no focused patient", async () => {
    const ctx = await buildAssistantContext();
    expect(ctx).toEqual({ patients: [], focused: null });
  });

  it("builds one context per patient with last session, transcript, report, open tasks and messages", async () => {
    const p = await patient();
    const { session } = await createSession({ patientId: p.id, nurseId: "nurse_1", nurseName: "Nurse Demo" });
    await appendTranscript(session.id, { role: "patient", text: "I cannot breathe well." });
    const report = reportFor({ sessionId: session.id, patientId: p.id });
    await putReport(report);
    const open = await createTask({ patientId: p.id, title: "Check inhaler", createdBy: "Nurse Demo" });
    const done = await createTask({ patientId: p.id, title: "Weigh patient", createdBy: "Nurse Demo" });
    await setTaskStatus(done.id, "done");
    await addMessage({ patientId: p.id, patientName: p.displayName, text: "Nurse on the way", createdBy: "Nurse Demo" });

    const ctx = await buildAssistantContext();
    expect(ctx.patients).toHaveLength(1);
    const patientCtx = ctx.patients[0];
    expect(patientCtx.patient.id).toBe(p.id);
    expect(patientCtx.lastSession?.id).toBe(session.id);
    expect(patientCtx.lastTranscript.map((t) => t.text)).toEqual(["I cannot breathe well."]);
    expect(patientCtx.lastReport?.id).toBe(report.id);
    expect(patientCtx.openTasks.map((t) => t.id)).toEqual([open.id]);
    expect(patientCtx.messages.map((m) => m.text)).toEqual(["Nurse on the way"]);
    expect(ctx.focused).toBeNull();
  });

  it("uses the newest session per patient", async () => {
    const p = await patient();
    const first = await createSession({ patientId: p.id, nurseId: "nurse_1", nurseName: "Nurse Demo" });
    // Force a strictly newer timestamp so the choice cannot depend on tie-breaking.
    const driver = await getDriver();
    const firstSession = (await getSession(first.session.id))!;
    await driver.setDoc(K.session(first.session.id), {
      ...firstSession,
      createdAt: new Date(Date.parse(firstSession.createdAt) - 60_000).toISOString(),
    });
    const second = await createSession({ patientId: p.id, nurseId: "nurse_1", nurseName: "Nurse Demo" });
    await appendTranscript(second.session.id, { role: "nurse", text: "Newer session note." });

    const ctx = await buildAssistantContext();
    expect(ctx.patients[0].lastSession?.id).toBe(second.session.id);
    expect(ctx.patients[0].lastTranscript.map((t) => t.text)).toEqual(["Newer session note."]);
  });

  it("scopes tasks and messages to their patient", async () => {
    const a = await patient("Patient A");
    const b = await patient("Patient B");
    await createTask({ patientId: a.id, title: "A task", createdBy: "n" });
    await createTask({ patientId: b.id, title: "B task", createdBy: "n" });
    await addMessage({ patientId: a.id, patientName: a.displayName, text: "For A", createdBy: "n" });
    await addMessage({ patientId: b.id, patientName: b.displayName, text: "For B", createdBy: "n" });

    const ctx = await buildAssistantContext();
    const byId = new Map(ctx.patients.map((c) => [c.patient.id, c]));
    expect(byId.get(a.id)!.openTasks.map((t) => t.title)).toEqual(["A task"]);
    expect(byId.get(b.id)!.openTasks.map((t) => t.title)).toEqual(["B task"]);
    expect(byId.get(a.id)!.messages.map((m) => m.text)).toEqual(["For A"]);
    expect(byId.get(b.id)!.messages.map((m) => m.text)).toEqual(["For B"]);
  });

  it("focuses a patient already in the list", async () => {
    const p = await patient();
    const ctx = await buildAssistantContext(p.id);
    expect(ctx.focused?.patient.id).toBe(p.id);
    expect(ctx.focused).toBe(ctx.patients[0]);
  });

  it("builds a best-effort context for a patient outside the index", async () => {
    // Seeding is off, so this seed patient is not in listPatients() but
    // getPatient() still resolves it.
    const seed = getSeedPatient("pt_0001")!;
    const ctx = await buildAssistantContext(seed.id);
    expect(ctx.patients).toHaveLength(0);
    expect(ctx.focused).not.toBeNull();
    expect(ctx.focused!.patient.id).toBe(seed.id);
    expect(ctx.focused!.lastSession).toBeNull();
    expect(ctx.focused!.lastTranscript).toEqual([]);
    expect(ctx.focused!.lastReport).toBeNull();
    expect(ctx.focused!.openTasks).toEqual([]);
    expect(ctx.focused!.messages).toEqual([]);
  });

  it("returns a null focus for an unknown or empty focus id", async () => {
    expect((await buildAssistantContext("pt_missing")).focused).toBeNull();
    expect((await buildAssistantContext(null)).focused).toBeNull();
  });

  it("falls back to a report found by session when reportId is dangling", async () => {
    const p = await patient();
    const { session } = await createSession({ patientId: p.id, nurseId: "n", nurseName: "N" });
    await putReport(reportFor({ sessionId: session.id, patientId: p.id, id: "rpt_by_session" }));

    const driver = await getDriver();
    await driver.setDoc(K.session(session.id), { ...session, reportId: "rpt_missing" });

    const ctx = await buildAssistantContext();
    expect(ctx.patients[0].lastReport?.id).toBe("rpt_by_session");
  });
});

describe("sessionView", () => {
  async function fixture() {
    const p = await patient();
    const { session, joinToken } = await createSession({
      patientId: p.id,
      nurseId: "nurse_1",
      nurseName: "Nurse Demo",
    });
    const driver = await getDriver();
    await driver.setDoc(K.session(session.id), {
      ...session,
      participantTokenHash: "participant-secret-hash",
    });
    const stored = (await getSession(session.id))!;
    return { patient: p, session: stored, joinToken };
  }

  it("hides nurse-only fields from a patient", async () => {
    const { session } = await fixture();
    const view = await sessionView(session, { forNurse: false, joinToken: "raw", baseUrl: "https://care.test" });

    expect(view).not.toHaveProperty("joinCode");
    expect(view).not.toHaveProperty("joinUrl");
    expect(view).not.toHaveProperty("joinTokenHash");
    expect(view).not.toHaveProperty("participantTokenHash");
    expect(view).not.toHaveProperty("nurseId");
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(session.joinTokenHash);
    expect(serialised).not.toContain("participant-secret-hash");
  });

  it("exposes the join code and a tokenised join URL to the nurse", async () => {
    const { session, joinToken } = await fixture();
    const view = await sessionView(session, {
      forNurse: true,
      joinToken,
      baseUrl: "https://care.test",
    });

    expect(view.joinCode).toBe(session.joinCode);
    expect(view.joinUrl).toBe(`https://care.test/care/join?t=${encodeURIComponent(joinToken)}`);
    expect(JSON.stringify(view)).not.toContain(session.joinTokenHash);
  });

  it("encodes a token that needs escaping", async () => {
    const { session } = await fixture();
    const view = await sessionView(session, {
      forNurse: true,
      joinToken: "a b/c&d",
      baseUrl: "https://care.test",
    });
    expect(view.joinUrl).toBe("https://care.test/care/join?t=a%20b%2Fc%26d");
  });

  it("degrades to a plain join deep-link without the raw token", async () => {
    const { session } = await fixture();
    const view = await sessionView(session, { forNurse: true, baseUrl: "https://care.test" });
    expect(view.joinUrl).toBe("https://care.test/care/join");
  });

  it("emits no join URL without a base URL", async () => {
    const { session, joinToken } = await fixture();
    const view = await sessionView(session, { forNurse: true, joinToken });
    expect(view.joinUrl).toBeUndefined();
    expect(view.joinCode).toBe(session.joinCode);
  });

  it("includes the patient and report for both audiences", async () => {
    const { session, patient: p } = await fixture();
    const report = reportFor({ sessionId: session.id, patientId: p.id, id: "rpt_view" });
    await putReport(report);

    const nurse = await sessionView(session, { forNurse: true });
    const patientView = await sessionView(session, { forNurse: false });
    expect(nurse.patient?.id).toBe(p.id);
    expect(patientView.patient?.id).toBe(p.id);
    expect(nurse.report?.id).toBe("rpt_view");
    expect(patientView.report?.id).toBe("rpt_view");
  });

  it("leaves patient undefined and report null when neither exists", async () => {
    const { session } = await fixture();
    const orphan = { ...session, patientId: "pt_missing" };
    const view = await sessionView(orphan, { forNurse: false });
    expect(view.patient).toBeUndefined();
    expect(view.report).toBeNull();
  });

  it("does not leak a participant token into the view", async () => {
    const { session } = await fixture();
    await joinSessionAtomic(session.id, {
      joinedAt: new Date().toISOString(),
      participantName: "Asha",
      status: "active",
    });
    const joined = (await getSession(session.id))!;
    const view = await sessionView(joined, { forNurse: true, baseUrl: "https://care.test" });
    expect(view.participantName).toBe("Asha");
    expect(view).not.toHaveProperty("participantTokenHash");
  });
});

describe("makeQrDataUrl", () => {
  it("renders a PNG data URL", async () => {
    const url = await makeQrDataUrl("https://care.test/care/join?t=abc");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url.length).toBeGreaterThan(200);
  });

  it("encodes different inputs differently and deterministically", async () => {
    const a = await makeQrDataUrl("https://care.test/one");
    const b = await makeQrDataUrl("https://care.test/two");
    const aAgain = await makeQrDataUrl("https://care.test/one");
    expect(a).not.toBe(b);
    expect(aAgain).toBe(a);
  });
});

// Keeps the helper referenced in case future cases need it without a lint error.
void listSessions;