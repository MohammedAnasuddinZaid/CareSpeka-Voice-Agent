import { describe, expect, it } from "vitest";
import { CARE_KNOWLEDGE, CARE_KNOWLEDGE_BY_ID } from "@/lib/care/careKnowledge";
import { retrievePassages } from "@/lib/care/retrieval";

function topIds(question: string, limit = 3): string[] {
  return retrievePassages(question, CARE_KNOWLEDGE, { limit }).passages.map((p) => p.id);
}

describe("knowledge base shape", () => {
  it("holds a useful shelf of general-care topics", () => {
    expect(CARE_KNOWLEDGE.length).toBeGreaterThanOrEqual(20);
    expect(CARE_KNOWLEDGE_BY_ID.size).toBe(CARE_KNOWLEDGE.length);
  });

  it("uses unique, prefixed ids indexed by the lookup map", () => {
    const ids = CARE_KNOWLEDGE.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const passage of CARE_KNOWLEDGE) {
      expect(passage.id).toMatch(/^kb_[a-z0-9_]+$/);
      expect(CARE_KNOWLEDGE_BY_ID.get(passage.id)).toBe(passage);
    }
  });

  it("marks every passage as non-patient knowledge", () => {
    for (const passage of CARE_KNOWLEDGE) {
      expect(passage.kind).toBe("knowledge");
      // No source/at means it can never be mistaken for a dated record.
      expect(passage.source).toBeUndefined();
      expect(passage.at).toBeUndefined();
    }
  });

  it("has a descriptive title and a substantive paragraph", () => {
    for (const passage of CARE_KNOWLEDGE) {
      expect(passage.title.length).toBeGreaterThan(8);
      expect(passage.text.length).toBeGreaterThan(120);
      expect(passage.text).not.toContain("\n");
      // Titles are either general-guidance pages or the product explainer.
      expect(passage.title.startsWith("General guidance") || passage.title === "About CareSpeak").toBe(
        true
      );
    }
  });

  it("carries searchable keywords that are already normalised", () => {
    for (const passage of CARE_KNOWLEDGE) {
      const keywords = passage.keywords ?? "";
      expect(keywords.length).toBeGreaterThan(0);
      expect(keywords).toBe(keywords.toLowerCase());
      expect(keywords).toBe(keywords.trim());
      expect(keywords.startsWith(",")).toBe(false);
      expect(keywords.endsWith(",")).toBe(false);
      expect(keywords.split(/\s+/).length).toBeGreaterThanOrEqual(4);
    }
  });

  it("contains no phone numbers or recording identifiers", () => {
    const all = CARE_KNOWLEDGE.map((p) => `${p.title} ${p.text} ${p.keywords}`).join("\n");
    expect(all).not.toMatch(/\+\d[\d\s-]{7,}/);
    expect(all).not.toMatch(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/);
  });
});

describe("clinical safety content", () => {
  const text = (id: string) => CARE_KNOWLEDGE_BY_ID.get(id)!.text;

  it("spells out the stroke FAST screen", () => {
    const stroke = text("kb_stroke");
    expect(stroke).toContain("Face");
    expect(stroke).toContain("Arm");
    expect(stroke).toContain("Speech");
    expect(stroke).toContain("Time");
  });

  it("lists the sepsis red flags and calls it time-critical", () => {
    const sepsis = text("kb_sepsis").toLowerCase();
    for (const flag of ["confusion", "breathing", "blood pressure", "temperature", "urine"]) {
      expect(sepsis).toContain(flag);
    }
    expect(sepsis).toContain("time-critical");
  });

  it("never gives anything by mouth to an unconscious hypoglycaemic patient", () => {
    const diabetes = text("kb_diabetes").toLowerCase();
    expect(diabetes).toContain("unconscious");
    expect(diabetes).toContain("do not give anything by mouth");
  });

  it("warns that COPD patients may need a prescribed oxygen target", () => {
    const copd = text("kb_copd").toLowerCase();
    expect(copd).toContain("carbon dioxide");
    expect(copd).toContain("prescribed target");
  });

  it("treats new central chest pain as an emergency", () => {
    const chest = text("kb_chest_pain").toLowerCase();
    expect(chest).toContain("emergency");
    expect(chest).toContain("aspirin");
    expect(chest).toContain("allergy");
  });

  it("keeps emergency numbers by region", () => {
    const numbers = text("kb_emergency_numbers");
    expect(numbers).toContain("112");
    expect(numbers).toContain("999");
    expect(numbers).toContain("911");
  });

  it("defines orthopnoea and its escalation", () => {
    const sleep = text("kb_sleep").toLowerCase();
    expect(sleep).toContain("orthopnoea");
    expect(sleep).toContain("pillows");
    expect(sleep).toContain("escalated");
  });
});

describe("retrieval against the knowledge base", () => {
  it("answers a definition question with the defining page", () => {
    expect(topIds("what is orthopnoea?")).toContain("kb_sleep");
  });

  it("finds sepsis warning signs", () => {
    expect(topIds("what are the warning signs of sepsis?")).toContain("kb_sepsis");
  });

  it("finds the stroke screen", () => {
    expect(topIds("stroke FAST symptoms")).toContain("kb_stroke");
  });

  it("finds the adult vital-sign reference", () => {
    expect(topIds("normal adult heart rate and oxygen saturation range")).toContain("kb_vitals");
  });

  it("finds the SBAR handoff structure", () => {
    expect(topIds("how do I give an SBAR handoff?")).toContain("kb_sbar");
  });

  it("finds the emergency number for India", () => {
    expect(topIds("emergency number in India")).toContain("kb_emergency_numbers");
  });

  it("finds antibiotic side-effect advice", () => {
    expect(topIds("diarrhoea and rash after antibiotics")).toContain("kb_antibiotics");
  });

  it("finds falls prevention for a dizzy patient", () => {
    expect(topIds("patient is dizzy when standing, falls risk")).toContain("kb_falls");
  });

  it("finds hydration advice", () => {
    expect(topIds("signs of dehydration and fluid balance")).toContain("kb_dehydration");
  });

  it("returns several ranked passages and a strong match", () => {
    const result = retrievePassages("breathlessness oxygen saturation", CARE_KNOWLEDGE, { limit: 4 });
    expect(result.passages.length).toBeGreaterThan(1);
    expect(result.strong).toBe(true);
    // Scores are ordered strongest first.
    const scores = result.passages.map((p) => p.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    for (const passage of result.passages) {
      expect(passage.excerpt.length).toBeGreaterThan(0);
      expect(passage.matchedTerms.length).toBeGreaterThan(0);
    }
  });

  it("does not rank an unrelated topic for a nonsense question", () => {
    const result = retrievePassages("zzzz qqqq", CARE_KNOWLEDGE);
    expect(result.passages).toEqual([]);
    expect(result.strong).toBe(false);
  });
});