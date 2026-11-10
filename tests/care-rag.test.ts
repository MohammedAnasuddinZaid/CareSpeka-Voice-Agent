import { beforeEach, describe, expect, it } from "vitest";
import { buildPatientPassages, retrievePassages, evidenceAnswer } from "@/lib/care/retrieval";
import { classifyQuestion, smallTalkAnswer } from "@/lib/care/knowledge";
import { askPortal, linkPortalSession } from "@/lib/care/portalBrain";
import { getSeedPatient, SYNTHETIC_PATIENTS } from "@/lib/care/seedPatients";
import { DEMO_RECORDS } from "@/lib/care/seedDemo";
import { resetDriverForTests } from "@/lib/care/store";

beforeEach(() => {
  resetDriverForTests();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

describe("demo dataset", () => {
  it("gives every synthetic patient a deep chart and seeded documents", () => {
    expect(SYNTHETIC_PATIENTS.length).toBeGreaterThanOrEqual(14);
    const patientIds = new Set(SYNTHETIC_PATIENTS.map((p) => p.id));
    for (const p of SYNTHETIC_PATIENTS) {
      expect(p.conditions.length, p.id).toBeGreaterThan(0);
      expect(p.medications.length, p.id).toBeGreaterThan(0);
      expect(p.observations.length, p.id).toBeGreaterThan(0);
      expect(p.encounters.length, p.id).toBeGreaterThan(0);
      expect(
        DEMO_RECORDS.filter((r) => r.patientId === p.id).length,
        `${p.id} seeded records`
      ).toBeGreaterThan(0);
    }
    expect(new Set(DEMO_RECORDS.map((r) => r.id)).size).toBe(DEMO_RECORDS.length);
    expect(DEMO_RECORDS.every((r) => patientIds.has(r.patientId))).toBe(true);
  });
});

describe("question routing", () => {
  const anita = getSeedPatient("pt_0001")!;

  it("separates record questions, general knowledge and conversation", () => {
    expect(classifyQuestion("What medications is she on?", anita).scope).toBe("record");
    expect(classifyQuestion("What are the warning signs of sepsis?", anita).scope).toBe("general");
    expect(classifyQuestion("hello there", anita).scope).toBe("chitchat");
    expect(classifyQuestion("who are you?", anita).scope).toBe("meta");
    expect(classifyQuestion("she has chest pain right now", anita).scope).toBe("emergency");
  });

  it("keeps educational questions out of the emergency path", () => {
    expect(classifyQuestion("what are the warning signs of a heart attack?", anita).scope).not.toBe("emergency");
  });

  it("does not re-triage a documented symptom as a live emergency", () => {
    expect(classifyQuestion("when did the chest pain start?", anita).scope).not.toBe("emergency");
    expect(classifyQuestion("history of a stroke?", anita).scope).not.toBe("emergency");
    // The same symptom described as happening now still escalates.
    expect(classifyQuestion("she has chest pain now", anita).scope).toBe("emergency");
  });

  it("answers small talk without a model", () => {
    expect(smallTalkAnswer("hello", { patient: anita })).toContain("Anita");
    expect(smallTalkAnswer("tell me a joke", { patient: anita })).toMatch(/[.!?]/);
    expect(smallTalkAnswer("what is 12 * 7?", { patient: anita })).toContain("84");
  });
});

describe("record retrieval", () => {
  const arjun = getSeedPatient("pt_0008")!;

  it("finds the passage that answers a clinical question", () => {
    const passages = buildPatientPassages(arjun);
    const result = retrievePassages("what is the potassium level?", passages);
    expect(result.passages.length).toBeGreaterThan(0);
    expect(result.passages[0].text.toLowerCase()).toContain("potassium");
    expect(result.strong).toBe(true);
    expect(evidenceAnswer(result.passages)).toContain("From the record");
  });

  it("does not pretend an unrelated question is in the chart", () => {
    const passages = buildPatientPassages(arjun);
    const result = retrievePassages("quantum entanglement experiment", passages);
    expect(result.strong).toBe(false);
    expect(result.passages).toHaveLength(0);
  });
});

describe("portal answers", () => {
  it("answers a general clinical question with labelled guidance", async () => {
    await linkPortalSession("RAG01", "pt_0001");
    const res = await askPortal("RAG01", "What are the warning signs of sepsis?");
    expect(res.scope).toBe("general");
    expect(res.grounded).toBe(false);
    expect(res.answer.toLowerCase()).toContain("sepsis");
    expect(res.citations?.some((c) => c.kind === "knowledge")).toBe(true);
  });

  it("treats a red-flag symptom as an emergency", async () => {
    await linkPortalSession("RAG02", "pt_0001");
    const res = await askPortal("RAG02", "She has chest pain right now");
    expect(res.scope).toBe("emergency");
    expect(res.answer).toContain("112");
  });

  it("answers a greeting warmly and names the patient", async () => {
    await linkPortalSession("RAG03", "pt_0001");
    const res = await askPortal("RAG03", "hello");
    expect(res.scope).toBe("chitchat");
    expect(res.intent).toBe("conversation");
    expect(res.answer).toContain("Anita");
  });

  it("uses conversation, not the chart, for jokes and arithmetic", async () => {
    await linkPortalSession("RAG05", "pt_0001");
    const joke = await askPortal("RAG05", "tell me a joke");
    expect(joke.scope).toBe("chitchat");
    expect(joke.intent).toBe("conversation");
    expect(joke.answer.length).toBeGreaterThan(20);

    const math = await askPortal("RAG05", "what is 12 * 7?");
    expect(math.scope).toBe("chitchat");
    expect(math.answer).toContain("84");
  });

  it("grounds a chart question in the retrieved record", async () => {
    await linkPortalSession("RAG04", "pt_0007");
    const res = await askPortal("RAG04", "When did Margaret have her hip operation?");
    expect(res.patientId).toBe("pt_0007");
    expect(res.answer).toContain("Margaret");
    expect(res.citations?.length).toBeGreaterThan(0);
  });
});
