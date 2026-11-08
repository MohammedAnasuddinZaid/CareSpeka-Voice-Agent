/**
 * Synthetic clinical dataset for the Web Voice Call — Demo.
 *
 * These are NOT real patients. Every record is fabricated for the hackathon and
 * flagged `synthetic: true`. The UI surfaces that flag prominently so a judge is
 * never misled into thinking this is real clinical data.
 *
 * The dataset is intentionally small but rich enough to exercise the whole
 * workflow: conditions, medications, allergies, an observation time-series and a
 * prior-encounter history.
 */
import type { ClinicalPatient } from "./types";

function daysAgo(n: number, hour = 9): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

export const SYNTHETIC_PATIENTS: ClinicalPatient[] = [
  {
    id: "pt_0001",
    extension: "1001",
    displayName: "Anita Sharma",
    age: 68,
    sex: "female",
    room: "Ward A / Bed 3",
    primaryConcern: "Post-discharge follow-up for heart failure",
    language: "en",
    synthetic: true,
    carePlan:
      "Daily weight, fluid balance, medication adherence and symptom check for 14 days after discharge.",
    conditions: [
      { id: "c1", code: "I50.9", name: "Heart failure (NYHA II)", status: "active", since: "2021-04-10" },
      { id: "c2", code: "I10", name: "Essential hypertension", status: "active", since: "2014-08-02" },
      { id: "c3", code: "E11.9", name: "Type 2 diabetes mellitus", status: "active", since: "2016-11-20" },
      { id: "c4", code: "J18.9", name: "Community-acquired pneumonia", status: "resolved", since: "2026-08-14", note: "Treated in hospital, resolved" },
    ],
    medications: [
      { id: "m1", name: "Furosemide", dose: "40 mg", route: "oral", frequency: "once daily", status: "active", since: "2021-04-12" },
      { id: "m2", name: "Ramipril", dose: "5 mg", route: "oral", frequency: "once daily", status: "active", since: "2021-04-12" },
      { id: "m3", name: "Metformin", dose: "500 mg", route: "oral", frequency: "twice daily", status: "active", since: "2016-11-25" },
      { id: "m4", name: "Atorvastatin", dose: "20 mg", route: "oral", frequency: "once at night", status: "active", since: "2019-01-05" },
    ],
    allergies: [
      { id: "a1", substance: "Penicillin", reaction: "Rash and facial swelling", severity: "moderate" },
      { id: "a2", substance: "Contrast dye", reaction: "Nausea, hives", severity: "mild" },
    ],
    observations: [
      { id: "o1", label: "Weight", value: 71.2, unit: "kg", at: daysAgo(7), provenance: "record" },
      { id: "o2", label: "Weight", value: 72.4, unit: "kg", at: daysAgo(4), provenance: "record" },
      { id: "o3", label: "Weight", value: 74.1, unit: "kg", at: daysAgo(1), provenance: "record" },
      { id: "o4", label: "Systolic BP", value: 138, unit: "mmHg", at: daysAgo(1), provenance: "record" },
      { id: "o5", label: "Heart rate", value: 92, unit: "bpm", at: daysAgo(1), provenance: "record" },
      { id: "o6", label: "Oxygen saturation", value: 94, unit: "%", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(9), kind: "in-person", by: "Dr. Rao", summary: "Discharged after heart-failure exacerbation. Advised daily weights." },
      { id: "e2", at: daysAgo(5), kind: "web-voice-call", by: "Nurse Demo", summary: "Baseline check-in. Reported mild fatigue, no breathlessness at rest." },
      { id: "e3", at: daysAgo(2), kind: "web-voice-call", by: "CareSpeak agent", summary: "Reported two-kilogram weight gain, ankle swelling and needing an extra pillow at night. Escalated to the nurse." },
    ],
  },
  {
    id: "pt_0002",
    extension: "1002",
    displayName: "Rahul Verma",
    age: 54,
    sex: "male",
    room: "Ward B / Bed 1",
    primaryConcern: "Hypertension and medication review",
    language: "en",
    synthetic: true,
    carePlan: "Weekly blood-pressure log and medication tolerance review.",
    conditions: [
      { id: "c1", code: "I10", name: "Essential hypertension", status: "active", since: "2018-02-14" },
      { id: "c2", code: "E78.5", name: "Hyperlipidaemia", status: "active", since: "2018-02-14" },
      { id: "c3", code: "G47.33", name: "Obstructive sleep apnoea", status: "history", since: "2020-06-01" },
    ],
    medications: [
      { id: "m1", name: "Amlodipine", dose: "10 mg", route: "oral", frequency: "once daily", status: "active", since: "2018-03-01" },
      { id: "m2", name: "Hydrochlorothiazide", dose: "12.5 mg", route: "oral", frequency: "once daily", status: "active", since: "2022-05-16", note: "Added for BP control" },
      { id: "m3", name: "Rosuvastatin", dose: "10 mg", route: "oral", frequency: "once at night", status: "active", since: "2018-03-01" },
    ],
    allergies: [{ id: "a1", substance: "Sulfa drugs", reaction: "Itching", severity: "mild" }],
    observations: [
      { id: "o1", label: "Systolic BP", value: 148, unit: "mmHg", at: daysAgo(10), provenance: "record" },
      { id: "o2", label: "Systolic BP", value: 142, unit: "mmHg", at: daysAgo(5), provenance: "record" },
      { id: "o3", label: "Systolic BP", value: 136, unit: "mmHg", at: daysAgo(1), provenance: "record" },
      { id: "o4", label: "Diastolic BP", value: 88, unit: "mmHg", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(30), kind: "in-person", by: "Dr. Menon", summary: "BP above target. Added hydrochlorothiazide." },
      { id: "e2", at: daysAgo(12), kind: "message", by: "Nurse Demo", summary: "Reminded to log home BP readings." },
    ],
  },
  {
    id: "pt_0003",
    extension: "1003",
    displayName: "Lakshmi Iyer",
    age: 72,
    sex: "female",
    room: "Home care",
    primaryConcern: "Diabetes follow-up and dizziness review",
    language: "en",
    synthetic: true,
    carePlan: "Monitor for hypoglycaemia; review dizziness and falls risk.",
    conditions: [
      { id: "c1", code: "E11.9", name: "Type 2 diabetes mellitus", status: "active", since: "2012-09-09" },
      { id: "c2", code: "M81.0", name: "Osteoporosis", status: "active", since: "2019-03-22" },
      { id: "c3", code: "R42", name: "Dizziness", status: "active", since: "2026-09-30", note: "Under investigation" },
    ],
    medications: [
      { id: "m1", name: "Gliclazide", dose: "80 mg", route: "oral", frequency: "once daily", status: "active", since: "2015-01-11" },
      { id: "m2", name: "Metformin", dose: "1 g", route: "oral", frequency: "twice daily", status: "active", since: "2012-09-15" },
      { id: "m3", name: "Calcium + Vitamin D", dose: "500 mg", route: "oral", frequency: "once daily", status: "active", since: "2019-03-25" },
    ],
    allergies: [],
    observations: [
      { id: "o1", label: "Fasting glucose", value: 9.4, unit: "mmol/L", at: daysAgo(6), provenance: "record" },
      { id: "o2", label: "Fasting glucose", value: 12.1, unit: "mmol/L", at: daysAgo(1), provenance: "record" },
      { id: "o3", label: "Weight", value: 58.0, unit: "kg", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(20), kind: "in-person", by: "Dr. Rao", summary: "Reported occasional dizziness on standing." },
      { id: "e2", at: daysAgo(7), kind: "telephony", by: "Nurse Demo", summary: "Near-fall in the bathroom. Advised to sit down when dizzy and to keep the phone nearby." },
    ],
  },
  {
    id: "pt_0004",
    extension: "1004",
    displayName: "Imran Khan",
    age: 45,
    sex: "male",
    room: "Home care",
    primaryConcern: "Asthma control check",
    language: "en",
    synthetic: true,
    carePlan: "Assess inhaler technique and night-time symptom frequency.",
    conditions: [
      { id: "c1", code: "J45.50", name: "Moderate persistent asthma", status: "active", since: "2005-07-01" },
      { id: "c2", code: "J30.1", name: "Allergic rhinitis", status: "active", since: "2007-05-19" },
    ],
    medications: [
      { id: "m1", name: "Budesonide/Formoterol", dose: "160/4.5 µg", route: "inhaled", frequency: "twice daily", status: "active", since: "2020-02-02" },
      { id: "m2", name: "Salbutamol", dose: "100 µg", route: "inhaled", frequency: "as needed", status: "active", since: "2005-07-01" },
      { id: "m3", name: "Cetirizine", dose: "10 mg", route: "oral", frequency: "once daily", status: "active", since: "2021-04-01" },
    ],
    allergies: [{ id: "a1", substance: "Dust mite", reaction: "Wheeze and rhinitis", severity: "moderate" }],
    observations: [
      { id: "o1", label: "Peak flow", value: 380, unit: "L/min", at: daysAgo(14), provenance: "record" },
      { id: "o2", label: "Peak flow", value: 410, unit: "L/min", at: daysAgo(2), provenance: "record" },
    ],
    encounters: [{ id: "e1", at: daysAgo(60), kind: "in-person", by: "Dr. Menon", summary: "Routine asthma review. Control adequate." }],
  },
  {
    id: "pt_0005",
    extension: "1005",
    displayName: "Meera Nair",
    age: 81,
    sex: "female",
    room: "Ward C / Bed 2",
    primaryConcern: "COPD exacerbation recovery and oxygen weaning",
    language: "en",
    synthetic: true,
    carePlan:
      "Check SpO₂ on room air twice daily, complete the steroid taper, review inhaler technique and refer to pulmonary rehabilitation.",
    conditions: [
      { id: "c1", code: "J44.1", name: "Chronic obstructive pulmonary disease (GOLD III)", status: "active", since: "2018-01-15" },
      { id: "c2", code: "I10", name: "Essential hypertension", status: "active", since: "2011-06-30" },
      { id: "c3", code: "F41.9", name: "Anxiety disorder", status: "active", since: "2020-10-12", note: "Breathlessness can trigger anxiety" },
    ],
    medications: [
      { id: "m1", name: "Tiotropium", dose: "18 µg", route: "inhaled", frequency: "once daily", status: "active", since: "2018-01-20" },
      { id: "m2", name: "Salbutamol", dose: "100 µg", route: "inhaled", frequency: "as needed", status: "active", since: "2018-01-20" },
      { id: "m3", name: "Prednisolone", dose: "30 mg", route: "oral", frequency: "once daily, tapering over 5 days", status: "active", since: "2026-10-28" },
      { id: "m4", name: "Amlodipine", dose: "5 mg", route: "oral", frequency: "once daily", status: "active", since: "2011-07-02" },
    ],
    allergies: [],
    observations: [
      { id: "o1", label: "SpO₂ on 1 L oxygen", value: 91, unit: "%", at: daysAgo(2), provenance: "record" },
      { id: "o2", label: "SpO₂ after walking (2 L oxygen)", value: 94, unit: "%", at: daysAgo(2), provenance: "record" },
      { id: "o3", label: "Respiratory rate", value: 22, unit: "/min", at: daysAgo(2), provenance: "record" },
      { id: "o4", label: "Heart rate", value: 96, unit: "bpm", at: daysAgo(2), provenance: "record" },
      { id: "o5", label: "Temperature", value: 37.2, unit: "°C", at: daysAgo(2), provenance: "record" },
      { id: "o6", label: "Weight", value: 54.0, unit: "kg", at: daysAgo(2), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(9), kind: "in-person", by: "Dr. Menon", summary: "Admitted with an infective COPD exacerbation. Treated with nebulisers and intravenous steroids." },
      { id: "e2", at: daysAgo(5), kind: "in-person", by: "Dr. Menon", summary: "Discharged on a prednisolone taper and home oxygen at 1 L/min. Follow-up in one week." },
      { id: "e3", at: daysAgo(3), kind: "web-voice-call", by: "CareSpeak agent", summary: "Reported breathlessness on walking to the bathroom and anxiety about the oxygen wean. Advised to rest and continue the taper." },
    ],
  },
  {
    id: "pt_0006",
    extension: "1006",
    displayName: "David Fernandes",
    age: 39,
    sex: "male",
    room: "Home care",
    primaryConcern: "Post-operative wound review after appendectomy",
    language: "en",
    synthetic: true,
    carePlan:
      "Check the wound daily, record temperature twice daily, use paracetamol for pain, avoid lifting over 5 kg for two weeks and report spreading redness or fever.",
    conditions: [
      { id: "c1", code: "K35.80", name: "Acute appendicitis", status: "resolved", since: "2026-10-31", note: "Laparoscopic appendectomy, uncomplicated recovery" },
      { id: "c2", code: "E66.9", name: "Obesity", status: "active", since: "2022-04-18" },
    ],
    medications: [
      { id: "m1", name: "Paracetamol", dose: "1 g", route: "oral", frequency: "up to four times daily as needed", status: "active", since: "2026-10-31" },
      { id: "m2", name: "Amoxicillin-clavulanate", dose: "625 mg", route: "oral", frequency: "three times daily, day 3 of 5", status: "active", since: "2026-11-06" },
    ],
    allergies: [],
    observations: [
      { id: "o1", label: "Temperature", value: 37.8, unit: "°C", at: daysAgo(2), provenance: "record" },
      { id: "o2", label: "Temperature", value: 37.2, unit: "°C", at: daysAgo(1), provenance: "record" },
      { id: "o3", label: "Pain score", value: 4, unit: "/10", at: daysAgo(2), provenance: "record" },
      { id: "o4", label: "Pain score", value: 2, unit: "/10", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(8), kind: "in-person", by: "Dr. Rao", summary: "Laparoscopic appendectomy. Discharged on day two with wound-care instructions." },
      { id: "e2", at: daysAgo(6), kind: "telephony", by: "Nurse Demo", summary: "Telephone follow-up. Pain controlled with paracetamol; no fever at that time." },
      { id: "e3", at: daysAgo(2), kind: "in-person", by: "Community nurse", summary: "Wound review: mild erythema at the inferior port site, no discharge. Started oral antibiotics and arranged review." },
    ],
  },
];

/** Bump when the synthetic dataset changes so existing stores reconcile it. */
export const SYNTHETIC_SEED_VERSION = 2;

/**
 * Patients added after the first seed. Reconciliation only ever adds these to
 * an existing store; older synthetic patients are refreshed but never
 * resurrected if the nurse deleted them.
 */
export const SYNTHETIC_ADDITION_IDS = new Set(["pt_0005", "pt_0006"]);

export function getSeedPatient(id: string): ClinicalPatient | undefined {
  return SYNTHETIC_PATIENTS.find((p) => p.id === id);
}
