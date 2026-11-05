/**
 * Clinical care reasoning for the Web Voice Call — Demo.
 *
 * This is a deterministic, rule-based care-coordination engine. It is used for
 * three things:
 *   1. Insight extraction (symptoms, concerns, red flags, history references).
 *   2. The guaranteed server-side fallback for the next AI utterance when the
 *      nurse's browser LLM is not loaded — so the demo always works.
 *   3. Drafting report facts with correct provenance.
 *
 * It NEVER diagnoses, prescribes, or invents vitals. It asks cautious follow-up
 * questions and escalates red-flag symptoms to the nurse. The browser LLM reuses
 * the same guardrails through its system prompt.
 */
import type { CareReportFact, CareTranscriptEntry, ClinicalPatient } from "./types";

export interface DetectedSymptom {
  label: string;
  category: string;
  redFlag: boolean;
  provenance: "patient";
}

interface SymptomDef {
  label: string;
  category: string;
  keywords: string[];
  redFlag?: boolean;
}

const SYMPTOMS: SymptomDef[] = [
  { label: "Chest pain", category: "cardiac", keywords: ["chest pain", "chest tightness", "pressure in my chest", "pain in my chest"], redFlag: true },
  { label: "Breathlessness at rest", category: "respiratory", keywords: ["can't breathe", "cannot breathe", "short of breath at rest", "breathless at rest", "gasping"], redFlag: true },
  { label: "Breathlessness on exertion", category: "respiratory", keywords: ["short of breath", "breathless", "out of breath", "breathlessness"] },
  { label: "Fainting / loss of consciousness", category: "neurological", keywords: ["fainted", "passed out", "blacked out", "loss of consciousness"], redFlag: true },
  { label: "Severe bleeding", category: "haemorrhage", keywords: ["heavy bleeding", "bleeding a lot", "blood loss", "won't stop bleeding"], redFlag: true },
  { label: "New confusion", category: "neurological", keywords: ["confused", "disoriented", "don't know where i am", "confusion"], redFlag: true },
  { label: "Suicidal thoughts", category: "mental-health", keywords: ["kill myself", "end my life", "suicidal", "don't want to live"], redFlag: true },
  { label: "Dizziness", category: "neurological", keywords: ["dizzy", "dizziness", "light-headed", "lightheaded", "vertigo"] },
  { label: "Headache", category: "neurological", keywords: ["headache", "head ache", "head is pounding"] },
  { label: "Fatigue", category: "general", keywords: ["tired", "fatigue", "exhausted", "no energy", "worn out"] },
  { label: "Fever", category: "infection", keywords: ["fever", "temperature", "chills", "shivering", "hot and cold"] },
  { label: "Cough", category: "respiratory", keywords: ["cough", "coughing", "bringing up phlegm", "sputum"] },
  { label: "Wheezing", category: "respiratory", keywords: ["wheez", "whistling in my chest"] },
  { label: "Palpitations", category: "cardiac", keywords: ["palpitations", "heart racing", "heart is pounding", "flutter"] },
  { label: "Swelling of legs or ankles", category: "cardiac", keywords: ["swollen", "swelling", "puffy ankles", "fluid", "oedema", "edema"] },
  { label: "Nausea / vomiting", category: "gastrointestinal", keywords: ["nausea", "nauseous", "vomit", "throwing up", "sick to my stomach"] },
  { label: "Abdominal pain", category: "gastrointestinal", keywords: ["stomach pain", "abdominal pain", "tummy", "belly pain"] },
  { label: "Weight gain (rapid)", category: "cardiac", keywords: ["gained weight", "weight has gone up", "put on weight"] },
  { label: "Weight loss", category: "general", keywords: ["lost weight", "weight loss", "losing weight"] },
  { label: "Reduced appetite", category: "general", keywords: ["no appetite", "not eating", "loss of appetite", "don't feel like eating"] },
  { label: "Poor sleep / night waking", category: "respiratory", keywords: ["can't sleep", "waking up at night", "wake up at night", "poor sleep", "insomnia"] },
  { label: "Low blood sugar symptoms", category: "metabolic", keywords: ["shaky", "sweating and hungry", "hypo", "low sugar", "blood sugar dropped"] },
  { label: "High blood sugar symptoms", category: "metabolic", keywords: ["very thirsty", "thirsty all the time", "passing a lot of urine", "peeing a lot"] },
  { label: "Pain", category: "general", keywords: ["pain", "aching", "sore", "hurts"] },
  { label: "Falls", category: "general", keywords: ["fell", "fall", "tripped"], redFlag: true },
];

const WORSENING = ["worse", "worse than", "getting worse", "more than usual", "can't cope", "cannot cope", "unable to", "suddenly"];

export function extractSymptoms(text: string): DetectedSymptom[] {
  const t = text.toLowerCase();
  const out: DetectedSymptom[] = [];
  const seen = new Set<string>();
  for (const def of SYMPTOMS) {
    if (seen.has(def.label)) continue;
    if (def.keywords.some((k) => t.includes(k))) {
      seen.add(def.label);
      out.push({ label: def.label, category: def.category, redFlag: Boolean(def.redFlag), provenance: "patient" });
    }
  }
  return out;
}

export function isWorsening(text: string): boolean {
  const t = text.toLowerCase();
  return WORSENING.some((w) => t.includes(w));
}

export interface Insights {
  symptoms: DetectedSymptom[];
  redFlags: string[];
  concerns: string[];
  historyRefs: { text: string; provenance: "record" }[];
  suggestedTopics: string[];
}

export function analyze(patient: ClinicalPatient | null, entries: CareTranscriptEntry[]): Insights {
  const patientText = entries
    .filter((e) => e.role === "patient")
    .map((e) => e.text)
    .join(" \n ");
  const symptoms = extractSymptoms(patientText);
  const redFlags = symptoms.filter((s) => s.redFlag).map((s) => s.label);

  const concerns: string[] = [];
  if (redFlags.length) concerns.push(`Red-flag symptom reported: ${redFlags.join(", ")}`);
  if (isWorsening(patientText)) concerns.push("Patient describes symptoms as worsening or beyond usual.");
  if (symptoms.length >= 3) concerns.push("Multiple symptoms reported in one interaction.");
  if (patient?.conditions.some((c) => c.name.toLowerCase().includes("heart failure")) && symptoms.some((s) => s.category === "cardiac" || s.label.includes("Weight gain"))) {
    concerns.push("Cardiac symptom in a patient with known heart failure — review fluid status.");
  }
  if (patient?.conditions.some((c) => c.name.toLowerCase().includes("diabetes")) && symptoms.some((s) => s.category === "metabolic")) {
    concerns.push("Glycaemic symptom reported in a patient with diabetes — review glucose control.");
  }

  const historyRefs: { text: string; provenance: "record" }[] = [];
  if (patient) {
    for (const c of patient.conditions.filter((c) => c.status === "active")) {
      if (patientText.toLowerCase().includes(c.name.split(" ")[0].toLowerCase())) {
        historyRefs.push({ text: `${c.name}${c.code ? ` (${c.code})` : ""}`, provenance: "record" });
      }
    }
    for (const a of patient.allergies) {
      if (patientText.toLowerCase().includes(a.substance.toLowerCase())) {
        historyRefs.push({ text: `Allergy: ${a.substance}`, provenance: "record" });
      }
    }
  }

  const suggestedTopics = buildQuestionPlan(patient).map((q) => q.text);

  return { symptoms, redFlags, concerns, historyRefs, suggestedTopics };
}

// ---------------------------------------------------------------------------
// follow-up question planning
// ---------------------------------------------------------------------------

interface Question {
  topic: string;
  text: string;
  tags: string[];
}

function buildQuestionPlan(patient: ClinicalPatient | null): Question[] {
  const plan: Question[] = [];
  const names = (patient?.conditions ?? []).map((c) => c.name.toLowerCase());

  if (names.some((n) => n.includes("heart failure"))) {
    plan.push(
      { topic: "weight", text: "Have you noticed any weight gain since your last check-in, or any swelling in your legs or ankles?", tags: ["weight gain (rapid)", "swelling of legs or ankles"] },
      { topic: "orthopnoea", text: "Do you find yourself needing extra pillows to sleep, or waking up short of breath at night?", tags: ["poor sleep / night waking", "breathlessness at rest"] },
      { topic: "medication-heart", text: "Have you been able to take your water tablet and your heart medicine every day?", tags: [] }
    );
  }
  if (names.some((n) => n.includes("diabetes"))) {
    plan.push(
      { topic: "glucose", text: "Have you been checking your blood sugar, and have you had any readings that were too high or too low?", tags: ["low blood sugar symptoms", "high blood sugar symptoms"] },
      { topic: "feet", text: "Any new numbness, tingling or sores on your feet?", tags: [] }
    );
  }
  if (names.some((n) => n.includes("hypertension"))) {
    plan.push({ topic: "bp", text: "Have you had any headaches, nosebleeds or visual changes that could relate to your blood pressure?", tags: ["headache"] });
  }
  if (names.some((n) => n.includes("asthma"))) {
    plan.push(
      { topic: "inhaler", text: "How often have you needed your blue reliever inhaler in the past week?", tags: ["wheezing", "cough"] },
      { topic: "night", text: "Has your asthma been waking you at night or limiting your usual activity?", tags: ["poor sleep / night waking"] }
    );
  }
  if (names.some((n) => n.includes("dizziness"))) {
    plan.push({ topic: "falls", text: "Have the dizzy spells caused any near-falls or falls, and do they happen when you stand up?", tags: ["dizziness", "falls"] });
  }

  plan.push(
    { topic: "appetite", text: "How has your appetite and fluid intake been over the last few days?", tags: ["reduced appetite"] },
    { topic: "general", text: "Is there anything else that has been worrying you that we have not talked about yet?", tags: [] }
  );
  return plan;
}

function nextUnaskedQuestion(patient: ClinicalPatient | null, askedTopics: Set<string>, symptoms: DetectedSymptom[]): Question | null {
  const plan = buildQuestionPlan(patient);
  const reported = new Set(symptoms.map((s) => s.label));
  // Prefer a question whose topic tags are already suggested by symptoms.
  const bySymptom = plan.find((q) => !askedTopics.has(q.topic) && q.tags.some((t) => reported.has(t)));
  if (bySymptom) return bySymptom;
  return plan.find((q) => !askedTopics.has(q.topic)) ?? null;
}

// ---------------------------------------------------------------------------
// reply composition
// ---------------------------------------------------------------------------

function acknowledgement(symptoms: DetectedSymptom[]): string {
  if (!symptoms.length) return "Thank you for telling me that.";
  const s = symptoms[symptoms.length - 1];
  switch (s.category) {
    case "cardiac":
      return "Thank you for telling me about that — I want to understand your heart symptoms carefully.";
    case "respiratory":
      return "I appreciate you sharing that. Let me ask a little more about your breathing.";
    case "neurological":
      return "Thank you for letting me know. I want to understand that symptom more clearly.";
    case "metabolic":
      return "Thanks for telling me. Let me ask a couple of questions about your sugars.";
    case "gastrointestinal":
      return "Sorry to hear that. Let me ask a little more about that.";
    default:
      return "Thank you for sharing that with me.";
  }
}

export interface AgentReply {
  text: string;
  escalate: boolean;
  escalationReason?: string;
  topic?: string;
  engine: "rule-based-care-engine";
}

export function greeting(patient: ClinicalPatient | null): string {
  const who = patient?.displayName ? patient.displayName.split(" ")[0] : "there";
  const purpose = patient?.primaryConcern ? ` I'm calling about your ${patient.primaryConcern.toLowerCase()}.` : "";
  return `Hello ${who}, this is your CareSpeak care assistant.${purpose} I'm here to check in on how you are doing. Could you tell me how you have been feeling since our last contact?`;
}

export function composeReply(args: {
  patient: ClinicalPatient | null;
  entries: CareTranscriptEntry[];
  askedTopics: Set<string>;
}): AgentReply {
  const { patient, entries, askedTopics } = args;
  const lastPatient = [...entries].reverse().find((e) => e.role === "patient")?.text ?? "";
  const symptoms = extractSymptoms(lastPatient);
  const redFlags = symptoms.filter((s) => s.redFlag);

  if (redFlags.length) {
    const label = redFlags.map((r) => r.label.toLowerCase()).join(" and ");
    return {
      text: `I'm concerned about the ${label} you have described. This is something that needs prompt attention from your care team, so I am alerting the nurse now. Please stay where you are and — if your symptoms worsen or you feel very unwell — call your local emergency number immediately.`,
      escalate: true,
      escalationReason: `Patient reported: ${redFlags.map((r) => r.label).join(", ")}`,
      engine: "rule-based-care-engine",
    };
  }

  const ack = acknowledgement(symptoms);
  const question = nextUnaskedQuestion(patient, askedTopics, symptoms);
  if (!question) {
    return {
      text: `${ack} I think we have covered the main points for today. If anything new comes up, please do contact your care team. Thank you for talking with me.`,
      escalate: false,
      engine: "rule-based-care-engine",
    };
  }
  return {
    text: `${ack} ${question.text}`,
    escalate: false,
    topic: question.topic,
    engine: "rule-based-care-engine",
  };
}

/** Topics the agent has already covered, derived from its own prior questions. */
export function askedTopicsFrom(entries: CareTranscriptEntry[]): Set<string> {
  const asked = new Set<string>();
  const plan = buildQuestionPlan(null);
  const text = entries.filter((e) => e.role === "agent").map((e) => e.text.toLowerCase()).join("\n");
  for (const q of plan) {
    const firstWords = q.text.toLowerCase().split(/\s+/).slice(0, 5).join(" ");
    if (firstWords && text.includes(firstWords)) asked.add(q.topic);
  }
  return asked;
}

// ---------------------------------------------------------------------------
// report fact extraction
// ---------------------------------------------------------------------------

export function reportFacts(patient: ClinicalPatient | null, entries: CareTranscriptEntry[]): {
  symptoms: CareReportFact[];
  history: CareReportFact[];
  medications: CareReportFact[];
  allergies: CareReportFact[];
  concerns: CareReportFact[];
  escalations: string[];
} {
  const insights = analyze(patient, entries);
  const patientText = entries.filter((e) => e.role === "patient").map((e) => e.text.toLowerCase()).join(" \n ");

  const symptoms: CareReportFact[] = insights.symptoms.map((s) => ({
    text: `${s.label}${s.redFlag ? " (red flag)" : ""}`,
    provenance: "patient",
  }));

  const history: CareReportFact[] = (patient?.conditions ?? [])
    .filter((c) => c.status === "active")
    .map((c) => ({ text: `${c.name}${c.code ? ` (${c.code})` : ""}`, provenance: "record" }));

  const medications: CareReportFact[] = (patient?.medications ?? [])
    .filter((m) => m.status === "active")
    .map((m) => ({
      text: `${m.name}${m.dose ? ` ${m.dose}` : ""}${m.frequency ? `, ${m.frequency}` : ""}${patientText.includes(m.name.toLowerCase()) ? " — discussed in session" : ""}`,
      provenance: patientText.includes(m.name.toLowerCase()) ? "patient" : "record",
    }));

  const allergies: CareReportFact[] = (patient?.allergies ?? []).map((a) => ({
    text: `${a.substance}${a.reaction ? ` — ${a.reaction}` : ""} (${a.severity})`,
    provenance: "record",
  }));

  const concerns: CareReportFact[] = insights.concerns.map((c) => ({ text: c, provenance: "ai" }));

  const escalations = insights.redFlags.length ? [`Red-flag symptom reported: ${insights.redFlags.join(", ")}`] : [];

  return { symptoms, history, medications, allergies, concerns, escalations };
}
