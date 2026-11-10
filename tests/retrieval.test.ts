import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPatientPassages,
  citationList,
  clearRetrievalCache,
  evidenceAnswer,
  passageSearchText,
  passagesSignature,
  retrievalContext,
  retrievePassages,
  type Passage,
  type PatientExtras,
} from "@/lib/care/retrieval";
import { getSeedPatient } from "@/lib/care/seedPatients";
import type { CareReport, PatientRecord } from "@/lib/care/types";

const PATIENT = getSeedPatient("pt_0001")!; // Anita Sharma

function passage(partial: Partial<Passage> & { id: string }): Passage {
  return { kind: "record", title: "", text: "", ...partial };
}

beforeEach(clearRetrievalCache);

describe("buildPatientPassages — coverage", () => {
  it("labels the core chart sections", () => {
    const passages = buildPatientPassages(PATIENT);
    const ids = passages.map((p) => p.id);
    expect(ids).toContain("profile");
    expect(ids).toContain("allergies:summary");
    expect(passages.some((p) => p.kind === "condition")).toBe(true);
    expect(passages.some((p) => p.kind === "medication")).toBe(true);
    expect(passages.some((p) => p.kind === "observation")).toBe(true);
    // Every passage is searchable and carries an id/title.
    for (const p of passages) {
      expect(p.id).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(passageSearchText(p).toLowerCase()).toContain(p.title.toLowerCase().split(" ")[0]);
    }
  });

  it("states no allergies explicitly when the chart has none", () => {
    const noAllergy = { ...PATIENT, allergies: [] };
    const allergies = buildPatientPassages(noAllergy).find((p) => p.id === "allergies:summary");
    expect(allergies?.text).toMatch(/no recorded allergies/i);
  });

  it("includes inserted records and splits long documents into ordered parts", () => {
    const longText = `${"Clinical note about heart failure. ".repeat(80)}`;
    const record: PatientRecord = {
      id: "rec1",
      patientId: PATIENT.id,
      title: "Discharge summary",
      source: "Hospital",
      text: longText,
      chars: longText.length,
      createdAt: new Date().toISOString(),
    };
    const parts = buildPatientPassages(PATIENT, [record]).filter((p) => p.kind === "record");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].id).toMatch(/^record:rec1:/);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(900);
  });

  it("includes transcripts, reports, tasks and messages from extras", () => {
    const extras: PatientExtras = {
      transcripts: [
        {
          sessionId: "wc_1",
          at: new Date().toISOString(),
          entries: [
            { id: "t1", seq: 1, sessionId: "wc_1", role: "patient", text: "My ankle is swollen", at: new Date().toISOString() },
          ],
        },
      ],
      reports: [],
      tasks: [
        {
          id: "task1",
          patientId: PATIENT.id,
          title: "Weigh patient",
          status: "open",
          createdAt: new Date().toISOString(),
          createdBy: "Nurse Demo",
        },
      ],
      messages: [
        {
          id: "msg1",
          patientId: PATIENT.id,
          patientName: PATIENT.displayName,
          text: "Take your water tablet",
          createdAt: new Date().toISOString(),
          createdBy: "Nurse Demo",
          channel: "web-voice-demo",
        },
      ],
    };
    const kinds = new Set(buildPatientPassages(PATIENT, [], extras).map((p) => p.kind));
    expect(kinds.has("transcript")).toBe(true);
    expect(kinds.has("task")).toBe(true);
    expect(kinds.has("message")).toBe(true);
  });
});

describe("retrievePassages — ranking and guards", () => {
  it("finds the medication a question names", () => {
    const passages = buildPatientPassages(PATIENT);
    const result = retrievePassages("what dose of furosemide is she on", passages);
    expect(result.passages.length).toBeGreaterThan(0);
    expect(result.passages[0].title.toLowerCase()).toContain("furosemide");
    expect(result.strong).toBe(true);
  });

  it("expands clinical synonyms (bp -> blood pressure)", () => {
    const passages = [
      passage({ id: "bp", title: "Blood pressure", text: "Blood pressure 138/86 mmHg yesterday." }),
      passage({ id: "hr", title: "Heart rate", text: "Heart rate 72 bpm." }),
    ];
    const result = retrievePassages("what was her bp", passages);
    expect(result.terms).toContain("blood");
    expect(result.terms).toContain("pressure");
    expect(result.passages[0].id).toBe("bp");
  });

  it("does not claim a strong match for an unrelated question", () => {
    const passages = buildPatientPassages(PATIENT);
    const result = retrievePassages("what is the boiling point of mercury", passages);
    expect(result.strong).toBe(false);
  });

  it("returns nothing for an empty question or empty passage set", () => {
    expect(retrievePassages("", buildPatientPassages(PATIENT))).toMatchObject({ passages: [], strong: false });
    expect(retrievePassages("allergies", [])).toMatchObject({ passages: [], strong: false });
  });

  it("respects the limit and relative floor", () => {
    const passages = Array.from({ length: 12 }, (_, i) =>
      passage({ id: `p${i}`, title: `Heart failure note ${i}`, text: `Heart failure guidance ${i}` })
    );
    const limited = retrievePassages("heart failure", passages, { limit: 3 });
    expect(limited.passages).toHaveLength(3);
    const strict = retrievePassages("heart failure", passages, { relativeFloor: 0.99 });
    // All twelve tie on score, so they all clear the floor and the default
    // limit of 6 caps the result.
    expect(strict.passages).toHaveLength(6);
  });

  it("requires minMatched terms when asked", () => {
    const passages = [passage({ id: "p", title: "Potassium", text: "Potassium 3.1 mmol/L is low." })];
    expect(retrievePassages("potassium magnesium", passages, { minMatched: 2 }).passages).toHaveLength(0);
    expect(retrievePassages("potassium magnesium", passages, { minMatched: 1 }).passages).toHaveLength(1);
  });

  it("carries a matched-term excerpt and the source title", () => {
    const passages = buildPatientPassages(PATIENT);
    const result = retrievePassages("penicillin allergy", passages);
    const hit = result.passages.find((p) => /penicillin/i.test(p.title + p.text));
    expect(hit).toBeTruthy();
    expect(hit!.matchedTerms.length).toBeGreaterThan(0);
    expect(hit!.excerpt.length).toBeGreaterThan(0);
  });
});

describe("index cache", () => {
  it("produces the same signature for identical passages and a different one on change", () => {
    const a = buildPatientPassages(PATIENT);
    const b = buildPatientPassages(PATIENT);
    expect(passagesSignature(a)).toBe(passagesSignature(b));
    expect(passagesSignature(a)).not.toBe(passagesSignature(buildPatientPassages({ ...PATIENT, displayName: "Someone Else" })));
  });

  it("invalidates when only the keywords change (stale-index regression)", () => {
    const base = { id: "p", title: "Profile", text: "Anita, age 68", kind: "profile" as const };
    const withZebra = [passage({ ...base, keywords: "zebra 1001" })];
    const withUnicorn = [passage({ ...base, keywords: "unicorn 1002" })];
    expect(passagesSignature(withZebra)).not.toBe(passagesSignature(withUnicorn));

    // Warm the cache on the first set, then search the second. The second
    // passage must still be found by its own keyword.
    expect(retrievePassages("zebra", withZebra).passages).toHaveLength(1);
    expect(retrievePassages("unicorn", withUnicorn).passages).toHaveLength(1);
  });

  it("returns consistent results across repeated calls", () => {
    const passages = buildPatientPassages(PATIENT);
    const first = retrievePassages("heart failure medications", passages);
    const second = retrievePassages("heart failure medications", passages);
    expect(second.passages.map((p) => p.id)).toEqual(first.passages.map((p) => p.id));
  });
});

describe("prompt + UI formatting", () => {
  it("numbers sources and truncates the prompt block", () => {
    const passages = buildPatientPassages(PATIENT);
    const result = retrievePassages("medications", passages);
    const context = retrievalContext(result.passages);
    expect(context).toMatch(/^\[S1\] /);
    const tiny = retrievalContext(result.passages, 10);
    // The first block is always emitted so a caller never gets an empty prompt.
    expect(tiny).toMatch(/^\[S1\] /);
    expect(tiny).not.toContain("[S2]");
  });

  it("returns an empty context when there are no passages", () => {
    expect(retrievalContext([])).toBe("");
  });

  it("de-duplicates citation labels and strips part numbers", () => {
    const passages = [
      { ...passage({ id: "a", title: "Note — part 1" }), score: 1, excerpt: "", matchedTerms: [] },
      { ...passage({ id: "b", title: "Note — part 2" }), score: 1, excerpt: "", matchedTerms: [] },
      { ...passage({ id: "c", title: "Other" }), score: 1, excerpt: "", matchedTerms: [] },
    ] as never;
    const citations = citationList(passages);
    expect(citations.map((c) => c.title)).toEqual(["Note", "Other"]);
  });

  it("builds an evidence answer with provenance and handles none", () => {
    const passages = [
      { ...passage({ id: "a", title: "Blood pressure", text: "BP 138/86" }), score: 2, excerpt: "BP 138/86", matchedTerms: ["bp"] },
      { ...passage({ id: "b", title: "Heart rate", text: "HR 72" }), score: 1, excerpt: "HR 72", matchedTerms: ["hr"] },
    ] as never;
    const answer = evidenceAnswer(passages, 1);
    expect(answer).toContain("From the record:");
    expect(answer).toContain("BP 138/86");
    expect(answer).toContain("Blood pressure");
    expect(evidenceAnswer([], 2)).toBe("");
  });
});