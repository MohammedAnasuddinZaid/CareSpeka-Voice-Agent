import { beforeEach, describe, expect, it } from "vitest";
import { quickAnswer } from "@/lib/care/quickAnswers";
import { askPortal, linkPortalSession } from "@/lib/care/portalBrain";
import { appendTranscript, createSession, createTask, addRecord } from "@/lib/care/repo";
import { getSessionStore } from "@/lib/server/store";
import { passagesSignature, retrievePassages, buildPatientPassages } from "@/lib/care/retrieval";
import { getSeedPatient } from "@/lib/care/seedPatients";
import { resetDriverForTests } from "@/lib/care/store";
import type { CareRole, CareSession, CareTranscriptEntry, ClinicalPatient } from "@/lib/care/types";

beforeEach(() => {
  resetDriverForTests();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

const anita = () => getSeedPatient("pt_0001")!;

function mkSession(patientId: string, createdAt: string): CareSession {
  return {
    id: "wc_qk",
    mode: "web-voice-demo",
    patientId,
    nurseId: "nurse.demo",
    nurseName: "Nurse Demo",
    status: "ended",
    createdAt,
    joinTokenHash: "h",
    joinCode: "QK01",
    joinExpiresAt: createdAt,
    escalated: false,
    seq: 0,
  };
}

function entry(role: CareRole, text: string, at: string): CareTranscriptEntry {
  return { id: `tt_${text.length}`, seq: 1, sessionId: "wc_qk", role, text, at };
}

describe("quick answers — live readings", () => {
  it("reports the abnormal reading when findings exist", () => {
    const answer = quickAnswer({
      question: "what are her readings right now?",
      patient: anita(),
      metrics: { alertnessScore: 12, blinkRate: 2 },
      findings: [{ key: "low_alertness", label: "Alertness", reading: "12%", note: "" }],
    });
    expect(answer?.intent).toBe("live_readings");
    expect(answer?.scope).toBe("record");
    expect(answer?.text).toContain("12");
    expect(answer?.text.toLowerCase()).toContain("alertness");
  });

  it("says everything is inside thresholds when nothing crosses", () => {
    const answer = quickAnswer({
      question: "how is she doing right now?",
      patient: anita(),
      metrics: { alertnessScore: 90, blinkRate: 15 },
      findings: [],
    });
    expect(answer?.intent).toBe("live_readings");
    expect(answer?.text.toLowerCase()).toContain("threshold");
  });
});

describe("quick answers — closest to threshold", () => {
  it("names the reading nearest its limit and what is already out", () => {
    const answer = quickAnswer({
      question: "which reading is closest to the threshold?",
      patient: anita(),
      metrics: { alertnessScore: 20, blinkRate: 15 },
      vitals: { deviceId: "d", spo2: 95, heartRate: 80, temperature: 36.8, receivedAt: Date.now() },
    });
    expect(answer?.intent).toBe("closest_threshold");
    expect(answer?.text.toLowerCase()).toContain("alertness");
    expect(answer?.text.toLowerCase()).toContain("oxygen");
    expect(answer?.text.toLowerCase()).toContain("outside");
  });
});

describe("quick answers — trends are question-dependent", () => {
  const multi: ClinicalPatient = {
    ...anita(),
    observations: [
      { id: "o1", label: "Weight", value: 71.2, unit: "kg", at: "2026-01-01T09:00:00Z", provenance: "record" },
      { id: "o2", label: "Weight", value: 72.4, unit: "kg", at: "2026-01-04T09:00:00Z", provenance: "record" },
      { id: "o3", label: "Weight", value: 74.1, unit: "kg", at: "2026-01-07T09:00:00Z", provenance: "record" },
      { id: "o4", label: "Potassium", value: 4.1, unit: "mmol/L", at: "2026-01-01T09:00:00Z", provenance: "record" },
      { id: "o5", label: "Potassium", value: 3.6, unit: "mmol/L", at: "2026-01-07T09:00:00Z", provenance: "record" },
    ],
  };

  it("follows the named subject and computes direction and delta", () => {
    const weight = quickAnswer({ question: "how is her weight trending?", patient: multi });
    expect(weight?.intent).toBe("trend");
    expect(weight?.text).toContain("Weight");
    expect(weight?.text).toContain("74.1");
    expect(weight?.text.toLowerCase()).toContain("up");

    const potassium = quickAnswer({ question: "how is her potassium trending?", patient: multi });
    expect(potassium?.intent).toBe("trend");
    expect(potassium?.text).toContain("Potassium");
    expect(potassium?.text.toLowerCase()).toContain("down");

    // The two questions must not collapse to one canned reply.
    expect(weight?.text).not.toBe(potassium?.text);
  });
});

describe("quick answers — question dependence and fall-through", () => {
  it("returns null for questions it does not own", () => {
    expect(quickAnswer({ question: "what medications is she on?", patient: anita() })).toBeNull();
    expect(quickAnswer({ question: "quantum entanglement experiment", patient: anita() })).toBeNull();
  });

  it("uses the specific record a question asks about", () => {
    const records = [
      { id: "r1", title: "Discharge summary", source: "Hospital", createdAt: "2026-02-01T10:00:00Z" },
      { id: "r2", title: "Lab report", source: "Lab", createdAt: "2026-02-02T10:00:00Z" },
    ];
    const docs = quickAnswer({ question: "what documents are on file?", patient: anita(), records });
    expect(docs?.intent).toBe("documents");
    expect(docs?.text).toContain("Discharge summary");
    expect(docs?.text).toContain("Lab report");
    expect(docs?.citations.length).toBe(2);
  });

  it("recaps the last call from the session transcript", () => {
    const answer = quickAnswer({
      question: "recap the last call",
      patient: anita(),
      extras: {
        sessions: [mkSession("pt_0001", "2026-02-05T12:00:00Z")],
        transcripts: [
          {
            sessionId: "wc_qk",
            at: "2026-02-05T12:00:00Z",
            entries: [entry("nurse", "how are you?", "2026-02-05T12:00:00Z"), entry("patient", "a bit breathless today", "2026-02-05T12:00:30Z")],
          },
        ],
      },
    });
    expect(answer?.intent).toBe("last_call");
    expect(answer?.text).toContain("breathless");
  });

  it("lists open follow-up tasks", () => {
    const answer = quickAnswer({
      question: "any open follow-up tasks?",
      patient: anita(),
      extras: {
        tasks: [
          { id: "t1", patientId: "pt_0001", title: "Repeat potassium", status: "open", createdAt: "2026-02-01T09:00:00Z", createdBy: "Nurse Demo" },
          { id: "t2", patientId: "pt_0001", title: "Old task", status: "done", createdAt: "2026-02-01T09:00:00Z", createdBy: "Nurse Demo" },
        ],
      },
    });
    expect(answer?.intent).toBe("tasks");
    expect(answer?.text).toContain("Repeat potassium");
    expect(answer?.text).not.toContain("Old task");
  });

  it("summarises what changed since the last contact", () => {
    const answer = quickAnswer({
      question: "what changed since the last call?",
      patient: anita(),
      extras: { sessions: [mkSession("pt_0001", "2026-01-01T00:00:00Z")] },
    });
    expect(answer?.intent).toBe("changed_since_last_call");
    // Anita gained weight after that date in the seed chart.
    expect(answer?.text.toLowerCase()).toContain("weight");
  });
});

describe("retrieval index cache", () => {
  it("is stable for the same passages and changes when they change", () => {
    const passages = buildPatientPassages(anita());
    const again = buildPatientPassages(anita());
    expect(passagesSignature(passages)).toBe(passagesSignature(again));

    const first = retrievePassages("weight", passages);
    const second = retrievePassages("weight", passages);
    expect(second.passages.map((p) => p.id)).toEqual(first.passages.map((p) => p.id));

    const changed = [...passages, { id: "extra", kind: "record" as const, title: "New note", text: "weight weight weight" }];
    expect(passagesSignature(changed)).not.toBe(passagesSignature(passages));
  });
});

describe("askPortal uses the fast deterministic path", () => {
  it("answers live-reading questions from the device, not a model", async () => {
    await linkPortalSession("QKLIVE", "pt_0001");
    const store = await getSessionStore();
    await store.setMetrics("QKLIVE", "cam1", { alertnessScore: 12, blinkRate: 2 });

    const res = await askPortal("QKLIVE", "what are her live readings right now?");
    expect(res.engine).toBe("rules");
    expect(res.intent).toBe("live_readings");
    expect(res.answer.length).toBeGreaterThan(0);
  });

  it("lists inserted documents on request", async () => {
    await addRecord({ patientId: "pt_0001", title: "Discharge summary", source: "Hospital", text: "Furosemide 40mg OD." });
    await linkPortalSession("QKDOC", "pt_0001");

    const res = await askPortal("QKDOC", "what documents are on file?");
    expect(res.intent).toBe("documents");
    expect(res.answer).toContain("Discharge summary");
  });

  it("recaps the last call with the real transcript", async () => {
    const { session } = await createSession({ patientId: "pt_0001", nurseId: "nurse.demo", nurseName: "Nurse Demo" });
    await appendTranscript(session.id, { role: "patient", text: "I get breathless on the stairs" });

    const res = await askPortal(session.id, "recap the last call");
    expect(res.patientId).toBe("pt_0001");
    expect(res.intent).toBe("last_call");
    expect(res.answer).toContain("breathless");
  });

  it("surfaces open follow-up tasks", async () => {
    await createTask({ patientId: "pt_0001", title: "Repeat potassium", createdBy: "Nurse Demo" });
    await linkPortalSession("QKTASK", "pt_0001");

    const res = await askPortal("QKTASK", "any open follow-up tasks?");
    expect(res.intent).toBe("tasks");
    expect(res.answer).toContain("Repeat potassium");
  });
});
