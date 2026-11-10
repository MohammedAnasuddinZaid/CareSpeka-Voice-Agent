import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  assistantSystemPrompt,
  buildContextText,
  suggestedQuestions,
  type AssistantContext,
  type PatientContext,
} from "@/lib/care/assistant";
import { buildReport } from "@/lib/care/report";
import { getSeedPatient } from "@/lib/care/seedPatients";
import type { CareSession, CareTask, CareTranscriptEntry, PatientMessage } from "@/lib/care/types";

const ANITA = getSeedPatient("pt_0001")!;
const RAHUL = getSeedPatient("pt_0002")!;

const SESSION: CareSession = {
  id: "wc_anita",
  mode: "web-voice-demo",
  patientId: ANITA.id,
  nurseId: "nurse_1",
  nurseName: "Nurse Demo",
  status: "ended",
  createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  endedAt: new Date(Date.now() - 2 * 86400000 + 600000).toISOString(),
  joinTokenHash: "hash",
  joinCode: "123456",
  joinExpiresAt: new Date().toISOString(),
  escalated: true,
  seq: 4,
};

const TRANSCRIPT: CareTranscriptEntry[] = [
  { id: "t1", seq: 1, sessionId: SESSION.id, role: "agent", text: "How are you?", at: SESSION.createdAt },
  { id: "t2", seq: 2, sessionId: SESSION.id, role: "patient", text: "My ankles are swollen and I gained two kilos", at: SESSION.createdAt },
];

function patientContext(overrides: Partial<PatientContext> = {}): PatientContext {
  return {
    patient: ANITA,
    lastSession: SESSION,
    lastTranscript: TRANSCRIPT,
    lastReport: null,
    openTasks: [],
    messages: [],
    ...overrides,
  };
}

function twoPatientContext(custom?: (anita: PatientContext) => PatientContext): AssistantContext {
  const anita = custom ? custom(patientContext()) : patientContext();
  return {
    focused: anita,
    patients: [anita, { patient: RAHUL, lastTranscript: [], openTasks: [], messages: [] }],
  };
}

const REPORT = buildReport({
  sessionId: SESSION.id,
  patientId: ANITA.id,
  patient: ANITA,
  entries: TRANSCRIPT,
  durationMs: 600000,
});

describe("answerQuestion — dictation", () => {
  it("parses 'send a message to <name> saying ...' into an action", () => {
    const result = answerQuestion("send a message to Anita Sharma saying please weigh yourself tomorrow", twoPatientContext());
    expect(result.intent).toBe("send_message");
    expect(result.patientId).toBe(ANITA.id);
    expect(result.action).toEqual({
      type: "send_message",
      patientId: ANITA.id,
      patientName: ANITA.displayName,
      text: "please weigh yourself tomorrow",
    });
    expect(result.answer).toContain("Anita Sharma");
  });

  it("parses 'tell <name> that ...' and 'message <name>: ...'", () => {
    expect(answerQuestion("tell Rahul that take your tablets", twoPatientContext()).action).toMatchObject({
      patientId: RAHUL.id,
      text: "take your tablets",
    });
    expect(answerQuestion("message Anita: drink some water", twoPatientContext()).action).toMatchObject({
      patientId: ANITA.id,
      text: "drink some water",
    });
  });

  it("does not mistake 'tell me about ...' for dictation", () => {
    const result = answerQuestion("tell me about Anita", twoPatientContext());
    expect(result.intent).not.toBe("send_message");
    expect(result.intent).toBe("overview");
  });

  it("asks for clarification when the recipient is unknown", () => {
    const result = answerQuestion("send a message to Nobody At All saying hello", twoPatientContext());
    expect(result.intent).toBe("send_message_unresolved");
    expect(result.action).toBeUndefined();
    expect(result.answer).toMatch(/could not tell which patient/i);
  });

  it("asks what to say when the message body is empty", () => {
    const result = answerQuestion("send a message to Anita saying", twoPatientContext());
    expect(result.intent).toBe("send_message_unresolved");
    expect(result.answer).toMatch(/what would you like me to say/i);
  });
});

describe("answerQuestion — cross-patient", () => {
  it("lists patients who were escalated", () => {
    const ctx = twoPatientContext((a) => ({ ...a, lastReport: REPORT }));
    const result = answerQuestion("which patients were escalated?", ctx);
    expect(result.intent).toBe("cross_patient");
    expect(result.answer).toContain("Anita Sharma");
    expect(result.answer).not.toContain("Rahul Verma —");
  });

  it("lists open follow-up work", () => {
    const task: CareTask = {
      id: "task1",
      patientId: RAHUL.id,
      title: "Repeat blood pressure",
      status: "open",
      createdAt: new Date().toISOString(),
      createdBy: "Nurse Demo",
    };
    const ctx = twoPatientContext();
    ctx.patients = ctx.patients.map((c) =>
      c.patient.id === RAHUL.id ? { ...c, openTasks: [task] } : c
    );
    const result = answerQuestion("who needs follow-up today?", ctx);
    expect(result.intent).toBe("cross_patient");
    expect(result.answer).toContain("Rahul Verma");
    expect(result.answer).toContain("Repeat blood pressure");
  });

  it("asks which patient when there is no focus and no name", () => {
    const result = answerQuestion("what medications are they on?", { patients: [patientContext()] });
    // "they" is a subject pronoun, but no focused patient is set and the name is absent.
    expect(result.intent).toBe("need_patient");
    expect(result.answer).toContain("Anita Sharma");
  });
});

describe("answerQuestion — per-patient intents", () => {
  it("answers medications with only active drugs", () => {
    const p = {
      ...ANITA,
      medications: [...ANITA.medications, { id: "m9", name: "OldDrug", status: "stopped" as const }],
    };
    const result = answerQuestion("what medications is she on?", { focused: patientContext({ patient: p }), patients: [] });
    expect(result.intent).toBe("medications");
    expect(result.answer).toContain("Furosemide 40 mg once daily");
    expect(result.answer).not.toContain("OldDrug");
  });

  it("says when no active medications are recorded", () => {
    const p = { ...ANITA, medications: ANITA.medications.map((m) => ({ ...m, status: "stopped" as const })) };
    const result = answerQuestion("any meds?", { focused: patientContext({ patient: p }), patients: [] });
    expect(result.answer).toMatch(/no active medications/i);
  });

  it("answers allergies and distinguishes none", () => {
    const withAllergy = answerQuestion("any allergies?", { focused: patientContext(), patients: [] });
    expect(withAllergy.intent).toBe("allergies");
    expect(withAllergy.answer).toContain("Penicillin");
    expect(withAllergy.answer).toContain("Contrast dye");

    const none = answerQuestion("any allergies?", {
      focused: patientContext({ patient: { ...ANITA, allergies: [] } }),
      patients: [],
    });
    expect(none.answer).toMatch(/no recorded allergies/i);
  });

  it("answers conditions and separates active from history", () => {
    const result = answerQuestion("what conditions does she have?", { focused: patientContext(), patients: [] });
    expect(result.intent).toBe("conditions");
    expect(result.answer).toContain("Heart failure");
    expect(result.answer).toContain("History also includes");
    expect(result.answer).toContain("Community-acquired pneumonia");
  });

  it("answers observations with the latest value and trend", () => {
    const result = answerQuestion("what are her latest observations?", { focused: patientContext(), patients: [] });
    expect(result.intent).toBe("observations");
    expect(result.answer).toContain("Weight 74.1 kg");
    expect(result.answer).toContain("up from 72.4 kg");
    expect(result.answer).toContain("Systolic BP 138 mmHg");
  });

  it("recaps the last call with patient statements and escalation", () => {
    const result = answerQuestion("what did she say in the last call?", {
      focused: patientContext({ lastReport: REPORT }),
      patients: [],
    });
    expect(result.intent).toBe("last_session");
    expect(result.answer).toContain("swollen");
    expect(result.answer).toMatch(/escalated/i);
    expect(result.answer).toMatch(/draft|approved/i);
  });

  it("handles a patient with no call history", () => {
    const result = answerQuestion("what did she say in the last call?", {
      focused: patientContext({ lastSession: null, lastTranscript: [] }),
      patients: [],
    });
    expect(result.answer).toMatch(/no recorded call/i);
  });

  it("lists open tasks and says when there are none", () => {
    const task: CareTask = {
      id: "task2",
      patientId: ANITA.id,
      title: "Call back about weight",
      status: "open",
      createdAt: new Date().toISOString(),
      createdBy: "Nurse Demo",
    };
    expect(
      answerQuestion("any follow-up tasks?", { focused: patientContext({ openTasks: [task] }), patients: [] }).answer
    ).toContain("Call back about weight");
    expect(
      answerQuestion("any follow-up tasks?", { focused: patientContext(), patients: [] }).answer
    ).toMatch(/no open follow-up tasks/i);
  });

  it("returns the care plan or says it is missing", () => {
    expect(answerQuestion("what is her care plan?", { focused: patientContext(), patients: [] }).answer).toContain(
      ANITA.carePlan!
    );
    expect(
      answerQuestion("what is her care plan?", {
        focused: patientContext({ patient: { ...ANITA, carePlan: undefined } }),
        patients: [],
      }).answer
    ).toMatch(/no care plan recorded/i);
  });

  it("reports the most recent message and the total", () => {
    const messages: PatientMessage[] = [
      { id: "m2", patientId: ANITA.id, patientName: ANITA.displayName, text: "Newest", createdAt: new Date().toISOString(), createdBy: "N", channel: "web-voice-demo" },
      { id: "m1", patientId: ANITA.id, patientName: ANITA.displayName, text: "Older", createdAt: new Date(Date.now() - 3600000).toISOString(), createdBy: "N", channel: "web-voice-demo" },
    ];
    const result = answerQuestion("what message did we send?", { focused: patientContext({ messages }), patients: [] });
    expect(result.intent).toBe("messages");
    expect(result.answer).toContain("Newest");
    expect(result.answer).toContain("2 messages");
  });

  it("answers escalation status honestly in both directions", () => {
    const escalated = answerQuestion("is she escalated?", { focused: patientContext(), patients: [] });
    expect(escalated.intent).toBe("escalations");
    expect(escalated.answer).toMatch(/last session was escalated/i);

    const calm = answerQuestion("is she escalated?", {
      focused: patientContext({ lastSession: { ...SESSION, escalated: false }, lastReport: null }),
      patients: [],
    });
    expect(calm.answer).toMatch(/no escalation recorded/i);
  });

  it("produces an overview for a generic question", () => {
    const result = answerQuestion("give me everything", { focused: patientContext(), patients: [] });
    expect(result.intent).toBe("overview");
    expect(result.answer).toContain("Anita Sharma");
    expect(result.answer).toContain("Reason for care");
    expect(result.answer).toContain("Care plan");
  });

  it("targets a named patient over the focused one", () => {
    const ctx = twoPatientContext();
    const result = answerQuestion("what medications is Rahul on?", ctx);
    expect(result.patientId).toBe(RAHUL.id);
    expect(result.answer).toContain("Amlodipine");
    expect(result.answer).not.toContain("Furosemide");
  });

  it("offers to start a call with the focused patient", () => {
    const result = answerQuestion("start a call with her", { focused: patientContext(), patients: [] });
    expect(result.intent).toBe("start_call");
    expect(result.action).toEqual({ type: "start_call", patientId: ANITA.id, patientName: ANITA.displayName });
  });

  it("handles an empty question and no patients", () => {
    expect(answerQuestion("  ", { patients: [] }).intent).toBe("empty");
    const noPatients = answerQuestion("what medications?", { patients: [] });
    expect(noPatients.intent).toBe("need_patient");
  });
});

describe("context + prompt helpers", () => {
  it("suggests questions using the patient's first name", () => {
    const suggestions = suggestedQuestions({ focused: patientContext(), patients: [] });
    expect(suggestions[0]).toContain("Anita");
    expect(suggestions.some((s) => /medications/i.test(s))).toBe(true);
    expect(suggestedQuestions({ patients: [] })).toEqual([
      "Who needs follow-up today?",
      "Which patients were escalated?",
    ]);
  });

  it("builds a complete grounding text", () => {
    const task: CareTask = {
      id: "t",
      patientId: ANITA.id,
      title: "Weigh daily",
      status: "open",
      createdAt: new Date().toISOString(),
      createdBy: "N",
    };
    const text = buildContextText({ patients: [patientContext({ openTasks: [task], lastReport: REPORT })] });
    expect(text).toContain("PATIENT: Anita Sharma");
    expect(text).toContain("Furosemide");
    expect(text).toContain("Penicillin");
    expect(text).toContain("Weigh daily");
    expect(text).toContain("Last transcript:");
  });

  it("publishes safety rules in the system prompt", () => {
    const prompt = assistantSystemPrompt();
    expect(prompt).toMatch(/never diagnose/i);
    expect(prompt).toMatch(/only from the patient context/i);
    expect(prompt).toMatch(/say so plainly/i);
  });
});