import { describe, expect, it } from "vitest";
import { classifyQuestion, emergencyAnswer, smallTalkAnswer, unknownAnswer } from "@/lib/care/knowledge";
import { getSeedPatient } from "@/lib/care/seedPatients";

const PATIENT = getSeedPatient("pt_0001")!; // Anita Sharma — heart failure, hypertension, diabetes

describe("classifyQuestion — safety first", () => {
  it("routes a symptom described as happening now to emergency", () => {
    expect(classifyQuestion("she has chest pain right now", PATIENT).scope).toBe("emergency");
    expect(classifyQuestion("the patient is bleeding heavily", PATIENT).scope).toBe("emergency");
    expect(classifyQuestion("he just collapsed", PATIENT).scope).toBe("emergency");
    expect(classifyQuestion("she is not breathing", PATIENT).scope).toBe("emergency");
  });

  it("treats explicit educational / historical symptom questions as NOT emergency", () => {
    // These are definitional questions; a nurse asking "what is X" is not reporting X.
    for (const q of [
      "what is chest pain?",
      "what is a heart attack?",
      "what is a stroke?",
      "what is anaphylaxis?",
      "explain chest pain",
      "what are the warning signs of a heart attack?",
      "when did the chest pain start?",
    ]) {
      expect(classifyQuestion(q, PATIENT).scope, q).not.toBe("emergency");
    }
  });
});

describe("classifyQuestion — conversation vs record vs knowledge", () => {
  it("recognises greetings, thanks and sign-offs as chitchat", () => {
    expect(classifyQuestion("hi", PATIENT).scope).toBe("chitchat");
    expect(classifyQuestion("thanks!", PATIENT).scope).toBe("chitchat");
    expect(classifyQuestion("goodbye", PATIENT).scope).toBe("chitchat");
    expect(classifyQuestion("ok", PATIENT).scope).toBe("chitchat");
  });

  it("recognises identity questions as meta", () => {
    expect(classifyQuestion("who are you?", PATIENT).scope).toBe("meta");
    expect(classifyQuestion("what can you do?", PATIENT).scope).toBe("meta");
    expect(classifyQuestion("are you human?", PATIENT).scope).toBe("meta");
  });

  it("routes arithmetic to chitchat unless it names a record field", () => {
    expect(classifyQuestion("what is 2+2", PATIENT).scope).toBe("chitchat");
    expect(classifyQuestion("50% of 200", PATIENT).scope).toBe("chitchat");
  });

  it("routes record questions to record", () => {
    expect(classifyQuestion("what medications is she on", PATIENT).scope).toBe("record");
    expect(classifyQuestion("any allergies", PATIENT).scope).toBe("record");
    expect(classifyQuestion("what were the last readings", PATIENT).scope).toBe("record");
    expect(classifyQuestion("show me the tasks", PATIENT).scope).toBe("record");
  });

  it("routes a patient's named condition to mixed", () => {
    // Heart failure is in Anita's chart but this is a concept question.
    const route = classifyQuestion("what is heart failure", PATIENT);
    expect(["mixed", "general"]).toContain(route.scope);
    expect(route.patientSpecific).toBe(false);
  });

  it("routes general clinical questions to general", () => {
    expect(classifyQuestion("what is a normal respiratory rate", PATIENT).scope).toBe("general");
    expect(classifyQuestion("what are the warning signs of sepsis", PATIENT).scope).toBe("general");
  });

  it("treats an empty question as a record question (no crash)", () => {
    expect(classifyQuestion("", PATIENT).scope).toBe("record");
    expect(classifyQuestion("   ", null).scope).toBe("record");
  });

  it("defaults a bare question in an open session to that patient's record", () => {
    expect(classifyQuestion("anything I should know", PATIENT).scope).toBe("record");
    expect(classifyQuestion("anything I should know", null).scope).toBe("general");
  });
});

describe("smallTalkAnswer", () => {
  it("greets with the patient's first name", () => {
    expect(smallTalkAnswer("hello", { patient: PATIENT })).toContain("Anita");
  });

  it("answers thanks and sign-off deterministically", () => {
    expect(smallTalkAnswer("thanks", { patient: PATIENT })).toMatch(/welcome/i);
    expect(smallTalkAnswer("bye", { patient: PATIENT })).toMatch(/goodbye/i);
  });

  it("returns one of the canned jokes for a joke request", () => {
    const answer = smallTalkAnswer("tell me a joke", { patient: PATIENT })!;
    expect(answer.length).toBeGreaterThan(20);
  });

  it("does arithmetic correctly", () => {
    expect(smallTalkAnswer("what is 2+2", {})).toBe("2+2 equals 4.");
    expect(smallTalkAnswer("what is 10 - 3 * 2", {})).toBe("10-3*2 equals 4.");
    expect(smallTalkAnswer("50% of 200", {})).toContain("100");
  });

  it("does not divide by zero into a bogus answer", () => {
    expect(smallTalkAnswer("what is 5 / 0", {})).toBeNull();
  });

  it("repeats the previous answer only when one exists", () => {
    expect(smallTalkAnswer("repeat that", { lastAssistant: "Anita is stable." })).toContain(
      "Anita is stable."
    );
    expect(smallTalkAnswer("repeat that", {})).toMatch(/previous answer/i);
  });

  it("declines to place emergency calls but points to 112", () => {
    const answer = smallTalkAnswer("can you call 911", { patient: PATIENT })!;
    expect(answer).toMatch(/112/);
  });

  it("returns null for a question it cannot handle so retrieval can run", () => {
    expect(smallTalkAnswer("what is the capital of France", { patient: PATIENT })).toBeNull();
  });
});

describe("emergencyAnswer & unknownAnswer", () => {
  it("gives a suicide-specific, safety-first answer", () => {
    const answer = emergencyAnswer("he says he wants to kill himself", PATIENT);
    expect(answer).toMatch(/112/);
    expect(answer.toLowerCase()).toContain("stay with");
  });

  it("gives the generic emergency answer with the patient name otherwise", () => {
    const answer = emergencyAnswer("chest pain now", PATIENT);
    expect(answer).toContain("Anita");
    expect(answer).toMatch(/112/);
  });

  it("never guesses in unknownAnswer", () => {
    expect(unknownAnswer(PATIENT)).toContain("Anita");
    expect(unknownAnswer(null)).toMatch(/don't have a grounded answer/i);
  });
});
