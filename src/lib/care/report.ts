/**
 * Post-session report builder for the Web Voice Call — Demo.
 *
 * Pure function: it turns a session transcript plus the authorised patient
 * record into a structured, reviewable draft. It never invents diagnoses,
 * vitals, medications or history, and every fact is tagged with its provenance
 * (record / patient / ai). Clinical edits require explicit nurse review.
 */
import { reportFacts } from "./agent";
import { newId } from "./crypto";
import type { CareReport, CareTranscriptEntry, ClinicalPatient } from "./types";

export function extractDuration(entries: CareTranscriptEntry[]): string {
  const text = entries.filter((e) => e.role === "patient").map((e) => e.text.toLowerCase()).join(" ");
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/(?:since|for)\s+(yesterday|last night|today)/, (m) => `Since ${m[1]}`],
    [/(\d+)\s*(day|days)/, (m) => `${m[1]} day${m[1] === "1" ? "" : "s"}`],
    [/(\d+)\s*(week|weeks)/, (m) => `${m[1]} week${m[1] === "1" ? "" : "s"}`],
    [/(\d+)\s*(hour|hours)/, (m) => `${m[1]} hour${m[1] === "1" ? "" : "s"}`],
    [/(\d+)\s*(month|months)/, (m) => `${m[1]} month${m[1] === "1" ? "" : "s"}`],
    [/a couple of days/, () => "A couple of days"],
    [/a few days/, () => "A few days"],
  ];
  for (const [re, fmt] of patterns) {
    const m = text.match(re);
    if (m) return fmt(m);
  }
  return "Not stated by the patient during this session.";
}

function keyPoints(entries: CareTranscriptEntry[], limit = 6): string[] {
  const points: string[] = [];
  for (const e of entries) {
    if (e.role !== "patient") continue;
    const t = e.text.trim();
    if (t.length < 12) continue;
    points.push(t.length > 160 ? `${t.slice(0, 157)}…` : t);
    if (points.length >= limit) break;
  }
  return points;
}

function unresolved(entries: CareTranscriptEntry[], patient: ClinicalPatient | null): string[] {
  const asked = entries.filter((e) => e.role === "agent").map((e) => e.text);
  const answeredText = entries.filter((e) => e.role === "patient").map((e) => e.text.toLowerCase()).join(" ");
  const open: string[] = [];
  // Questions that remain unanswered when the session ended.
  for (const q of asked.slice(-2)) {
    const questionPart = q.split("?").slice(-2)[0];
    if (questionPart && !answeredText.includes(questionPart.slice(0, 12).toLowerCase())) {
      open.push(q.length > 140 ? `${q.slice(0, 137)}…` : q);
    }
  }
  return open.slice(0, 3);
}

function suggestedFollowUp(concerns: string[], patient: ClinicalPatient | null): string[] {
  const out: string[] = [];
  for (const c of concerns) {
    if (c.startsWith("Red-flag")) out.push("Arrange urgent nurse review of reported red-flag symptoms.");
    else if (c.includes("heart failure")) out.push("Review fluid status, daily weight trend and diuretic adherence with the clinical team.");
    else if (c.includes("diabetes") || c.includes("Glycaemic")) out.push("Review blood-glucose readings and hypoglycaemia symptoms with the clinical team.");
    else if (c.includes("worsening")) out.push("Schedule an earlier follow-up call given reported worsening.");
    else out.push("Nurse to review the reported concern at the next contact.");
  }
  if (!out.length) {
    out.push("Continue the existing care plan and routine follow-up.");
  }
  if (patient?.carePlan) out.push(`Care plan in force: ${patient.carePlan}`);
  return [...new Set(out)];
}

export function buildReport(args: {
  sessionId: string;
  patientId: string;
  patient: ClinicalPatient | null;
  entries: CareTranscriptEntry[];
  durationMs?: number;
}): CareReport {
  const { sessionId, patientId, patient, entries } = args;
  const facts = reportFacts(patient, entries);
  const duration = args.durationMs ?? 0;

  const reason =
    patient?.primaryConcern ??
    (entries.find((e) => e.role === "patient")?.text ?? "Patient-initiated care check-in.");

  const symptomList = facts.symptoms.map((s) => s.text);
  const aiSummaryParts: string[] = [];
  aiSummaryParts.push(
    `This Web Voice Call — Demo was conducted between the patient and the CareSpeak care assistant${
      patient ? ` regarding ${patient.displayName}` : ""
    }${duration ? ` and lasted approximately ${Math.round(duration / 1000)} seconds` : ""}.`
  );
  if (symptomList.length) {
    aiSummaryParts.push(`The patient reported: ${symptomList.join(", ")}.`);
  } else {
    aiSummaryParts.push("The patient did not report specific new symptoms during the session.");
  }
  if (facts.concerns.length) {
    aiSummaryParts.push(`Points requiring review: ${facts.concerns.map((c) => c.text).join(" ")}`);
  }
  aiSummaryParts.push(
    "This summary is generated from the session transcript and the patient's authorised record only. It contains no new clinical findings and no diagnosis."
  );

  const report: CareReport = {
    id: newId("rep"),
    sessionId,
    patientId,
    status: "draft",
    generatedAt: new Date().toISOString(),
    sections: {
      reasonForInteraction: reason,
      patientReportedSymptoms: facts.symptoms,
      symptomDuration: extractDuration(entries),
      relevantHistory: facts.history,
      medicationsDiscussed: facts.medications,
      allergiesDiscussed: facts.allergies,
      keyPoints: keyPoints(entries),
      aiSummary: aiSummaryParts.join(" "),
      concernsForNurse: facts.concerns,
      escalations: facts.escalations,
      suggestedFollowUp: suggestedFollowUp(
        facts.concerns.map((c) => c.text),
        patient
      ),
      unresolvedQuestions: unresolved(entries, patient),
    },
    transcriptRef: {
      count: entries.length,
      firstSeq: entries.length ? entries[0].seq : 0,
      lastSeq: entries.length ? entries[entries.length - 1].seq : 0,
    },
    transcript: entries,
    sourceFlags: {
      recordDerived: facts.history.length > 0 || facts.medications.length > 0 || facts.allergies.length > 0,
      patientReported: facts.symptoms.length > 0,
      aiGenerated: true,
      reviewed: false,
    },
  };
  return report;
}
