import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPatientPassages,
  clearRetrievalCache,
  evidenceAnswer,
  passageSearchText,
  passagesSignature,
  retrievalCacheSize,
  retrievePassages,
  RETRIEVAL_CACHE_MAX,
  type Passage,
} from "@/lib/care/retrieval";
import { classifyQuestion } from "@/lib/care/knowledge";
import { quickAnswer, type QuickAnswerInput } from "@/lib/care/quickAnswers";
import { askPortal, linkPortalSession } from "@/lib/care/portalBrain";
import { resetDriverForTests } from "@/lib/care/store";
import { getSeedPatient } from "@/lib/care/seedPatients";

const ANITA = getSeedPatient("pt_0001")!; // heart failure, furosemide, weight / BP / SpO2
const ARJUN = getSeedPatient("pt_0008")!; // renal chart with potassium

function passage(partial: Partial<Passage> & { id: string }): Passage {
  return { kind: "record", title: "", text: "", ...partial };
}

function quickInput(partial: Partial<QuickAnswerInput>): QuickAnswerInput {
  return { question: "", patient: ANITA, ...partial };
}

beforeEach(() => {
  clearRetrievalCache();
  resetDriverForTests();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

describe("retrieval — question normalisation", () => {
  it("matches SpO2 and oxygen saturation in both directions", () => {
    const passages = buildPatientPassages(ANITA);
    const byShort = retrievePassages("what is her spo2?", passages);
    expect(byShort.passages[0].text.toLowerCase()).toContain("oxygen saturation");
    expect(byShort.strong).toBe(true);

    const byLong = retrievePassages("oxygen saturation", passages);
    expect(byLong.passages[0].text.toLowerCase()).toMatch(/oxygen saturation|spo2/);
  });

  it("understands O2 and other compact clinical forms", () => {
    const passages = [
      passage({ id: "sat", title: "Oxygen saturation", text: "Oxygen saturation 94% on air." }),
      passage({ id: "hr", title: "Heart rate", text: "Heart rate 92 bpm." }),
    ];
    expect(retrievePassages("what is the o2", passages).passages[0].id).toBe("sat");
    expect(retrievePassages("what is the hr", passages).passages[0].id).toBe("hr");
  });

  it("handles empty, punctuation-only and emoji-only questions", () => {
    const passages = buildPatientPassages(ANITA);
    for (const question of ["", "   ", "?!...", "—", "🙂🙂", ".. ,,"]) {
      expect(retrievePassages(question, passages), question).toMatchObject({
        passages: [],
        strong: false,
      });
    }
  });

  it("bounds the expanded terms for a very long dictated question", () => {
    const question =
      `${"please tell me about the weather and the garden and the traffic ".repeat(12)}` +
      "what is her potassium level";
    const result = retrievePassages(question, buildPatientPassages(ARJUN));
    expect(result.terms.length).toBeLessThanOrEqual(16);
    expect(result.passages.length).toBeGreaterThan(0);
    expect(result.passages[0].text.toLowerCase()).toContain("potassium");
  });
});

describe("retrieval — accuracy guards", () => {
  it("recovers from speech-to-text slips with fuzzy matching", () => {
    const anita = buildPatientPassages(ANITA);
    expect(retrievePassages("what dose of furosemid", anita).passages[0].text.toLowerCase()).toContain(
      "furosemide"
    );
    const arjun = buildPatientPassages(ARJUN);
    expect(retrievePassages("potasium level", arjun).passages[0].text.toLowerCase()).toContain(
      "potassium"
    );
  });

  it("does not count a substring as a matched term", () => {
    const passages = [
      passage({ id: "acc", title: "Nursing note", text: "The nurse was accurate and calm." }),
    ];
    const result = retrievePassages("rate accurate", passages);
    expect(result.passages[0].matchedTerms).toContain("accurate");
    // "rate" lives inside "accu(rate)" but is not a word of the passage.
    expect(result.passages[0].matchedTerms).not.toContain("rate");
  });

  it("still refuses an unrelated question on a real chart", () => {
    const result = retrievePassages("quantum entanglement experiment", buildPatientPassages(ANITA));
    expect(result.passages).toHaveLength(0);
    expect(result.strong).toBe(false);
    expect(evidenceAnswer(result.passages)).toBe("");
  });

  it("keeps the strongest passage first and excerpts it around the match", () => {
    const long = `${"Background detail. ".repeat(80)}Potassium 5.8 mmol/L is high. ${"Afterward. ".repeat(40)}`;
    const passages = [passage({ id: "k", title: "Lab result", text: long })];
    const result = retrievePassages("potassium", passages);
    expect(result.passages[0].excerpt.toLowerCase()).toContain("potassium 5.8");
    expect(result.passages[0].excerpt.length).toBeLessThanOrEqual(330);
  });
});

describe("retrieval — cache", () => {
  it("keeps the index cache bounded and rebuilds an evicted chart", () => {
    for (let i = 0; i < RETRIEVAL_CACHE_MAX + 6; i += 1) {
      retrievePassages("alpha", [
        passage({ id: `note-${i}`, title: `Note ${i}`, text: `alpha content ${i}` }),
      ]);
    }
    expect(retrievalCacheSize()).toBe(RETRIEVAL_CACHE_MAX);

    clearRetrievalCache();
    const rebuilt = retrievePassages("alpha", [
      passage({ id: "first", title: "Note", text: "alpha content" }),
    ]);
    expect(rebuilt.passages.map((p) => p.id)).toEqual(["first"]);
    expect(retrievalCacheSize()).toBe(1);
  });

  it("invalidates the signature on any indexed field change", () => {
    const base = passage({ id: "p", title: "Profile", text: "Anita, age 68" });
    expect(passagesSignature([base])).not.toBe(
      passagesSignature([{ ...base, text: "Anita, age 69" }])
    );
    expect(passagesSignature([base])).not.toBe(
      passagesSignature([{ ...base, keywords: "zebra" }])
    );
    expect(passagesSignature([base])).not.toBe(
      passagesSignature([{ ...base, weight: 2 }])
    );
    expect(passageSearchText(base)).toContain("Anita");
  });
});

describe("routing — negation, resolution and condition scope", () => {
  it("does not escalate a symptom the nurse has ruled out", () => {
    for (const question of [
      "she has no chest pain",
      "she denies chest pain",
      "no chest pain since this morning",
      "she hasn't collapsed",
      "the chest pain has resolved",
      "chest pain is better now",
      "help me understand chest pain",
      "what causes chest pain",
      "her chest pain history",
      "when did she have chest pain",
    ]) {
      expect(classifyQuestion(question, ANITA).scope, question).not.toBe("emergency");
    }
  });

  it("still escalates a symptom described as happening now", () => {
    for (const question of [
      "she has chest pain now",
      "she is not breathing",
      "he just collapsed",
      "the patient is bleeding heavily",
      "she has chest pain, help me understand",
    ]) {
      expect(classifyQuestion(question, ANITA).scope, question).toBe("emergency");
    }
  });

  it("does not mistake a generic word in a condition name for a chart match", () => {
    // Anita has heart failure; "heart" alone must not make a heart-attack
    // education question patient-specific.
    expect(classifyQuestion("what are the warning signs of a heart attack?", ANITA).scope).toBe(
      "general"
    );
    expect(classifyQuestion("what is a normal respiratory rate", ANITA).scope).toBe("general");
  });

  it("still recognises the patient's actual condition by name", () => {
    const route = classifyQuestion("what is heart failure", ANITA);
    expect(["mixed", "general"]).toContain(route.scope);
    expect(classifyQuestion("explain type 2 diabetes", ANITA).scope).toBe("mixed");
  });

  it("routes a record + concept question to mixed", () => {
    expect(
      classifyQuestion("what is the risk of her furosemide dose in heart failure?", ANITA).scope
    ).toBe("mixed");
  });
});

describe("quick answers — the answer follows the question", () => {
  it("does not answer a medication-status question with live readings", () => {
    expect(quickAnswer(quickInput({ question: "what is the status of her medications" }))).toBeNull();
    expect(quickAnswer(quickInput({ question: "is she stable on her medication" }))).toBeNull();
  });

  it("leaves chart-observation questions for the record engine", () => {
    expect(quickAnswer(quickInput({ question: "what are her latest observations" }))).toBeNull();
    expect(quickAnswer(quickInput({ question: "show me her observations" }))).toBeNull();
  });

  it("answers the named series, not every series", () => {
    const weight = quickAnswer(quickInput({ question: "what is her latest weight" }))!;
    expect(weight.intent).toBe("trend");
    expect(weight.text).toMatch(/weight/i);
    expect(weight.text).toMatch(/up by/i);
    expect(weight.text).not.toMatch(/blood pressure/i);

    const bp = quickAnswer(quickInput({ question: "how is her bp trending" }))!;
    expect(bp.intent).toBe("trend");
    expect(bp.text).toMatch(/systolic bp|blood pressure/i);
    expect(bp.text).not.toMatch(/weight/i);
  });

  it("reports a lost signal as a signal problem, not a reading", () => {
    const answer = quickAnswer(
      quickInput({
        question: "how is she doing",
        metrics: {
          lastSeen: new Date(Date.now() - 3 * 60_000).toISOString(),
        } as QuickAnswerInput["metrics"],
        findings: [
          {
            key: "signal_stale",
            label: "Signal",
            reading: "3 min ago",
            note: "no fresh readings from the patient device",
          },
        ],
      })
    )!;
    expect(answer.intent).toBe("live_readings");
    expect(answer.text).toMatch(/no fresh device readings/i);
    expect(answer.text).toMatch(/check the patient device/i);
    expect(answer.text).not.toMatch(/start with the signal/i);
  });

  it("lists documents on file but not when the nurse asks what a note says", () => {
    const records = [
      {
        id: "r1",
        patientId: ANITA.id,
        title: "Discharge summary",
        text: "Potassium was low at discharge.",
        chars: 31,
        createdAt: new Date().toISOString(),
      },
    ];
    const list = quickAnswer(quickInput({ question: "what do I have on file?", records }))!;
    expect(list.intent).toBe("documents");
    expect(list.text).toContain("Discharge summary");

    expect(
      quickAnswer(quickInput({ question: "what did the discharge notes say about potassium", records }))
    ).toBeNull();
  });

  it("keeps the live-reading answer when nothing is out of range", () => {
    const answer = quickAnswer(
      quickInput({
        question: "what are her latest readings",
        metrics: {
          alertnessScore: 78,
          blinkRate: 14,
          eyeClosureDuration: 800,
          movementActivity: 0.18,
          lastSeen: new Date().toISOString(),
        } as QuickAnswerInput["metrics"],
        vitals: {
          deviceId: "dev-1",
          spo2: 97,
          heartRate: 74,
          temperature: 36.8,
          receivedAt: Date.now(),
        } as QuickAnswerInput["vitals"],
      })
    )!;
    expect(answer.intent).toBe("live_readings");
    expect(answer.text).toMatch(/stable|inside their thresholds|nothing outside/i);
    expect(answer.text).toContain("97");
  });
});

describe("portal — typo-safe grounded answer", () => {
  it("answers a speech-to-text slip from the chart without a model call", async () => {
    await linkPortalSession("EDGE01", "pt_0008");
    const res = await askPortal("EDGE01", "what is his potasium level");
    expect(res.patientId).toBe("pt_0008");
    expect(res.engine).toBe("rules");
    expect(res.answer).toContain("5.4");
    expect(res.citations?.length).toBeGreaterThan(0);
    expect(res.grounded).toBe(true);
  });
});