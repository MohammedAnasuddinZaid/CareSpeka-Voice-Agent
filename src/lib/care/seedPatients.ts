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
];

export function getSeedPatient(id: string): ClinicalPatient | undefined {
  return SYNTHETIC_PATIENTS.find((p) => p.id === id);
}
