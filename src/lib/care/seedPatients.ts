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
  {
    id: "pt_0007",
    extension: "1007",
    displayName: "Margaret O'Connor",
    age: 76,
    sex: "female",
    room: "Ward A / Bed 5",
    primaryConcern: "Falls and hip fracture recovery after hemiarthroplasty",
    language: "en",
    synthetic: true,
    carePlan:
      "Mobile with a frame and one assistant, check for dizziness before standing, continue apixaban, monitor wound and bowels, physiotherapy five days a week.",
    conditions: [
      { id: "c1", code: "S72.00", name: "Fractured neck of femur (left)", status: "resolved", since: "2026-10-24", note: "Left hemiarthroplasty performed, no postoperative complication" },
      { id: "c2", code: "M81.0", name: "Osteoporosis", status: "active", since: "2017-06-12" },
      { id: "c3", code: "I48.91", name: "Atrial fibrillation", status: "active", since: "2015-03-08" },
      { id: "c4", code: "F06.7", name: "Mild cognitive impairment", status: "active", since: "2024-01-19", note: "Baseline sometimes forgetful; no delirium during this admission" },
    ],
    medications: [
      { id: "m1", name: "Apixaban", dose: "5 mg", route: "oral", frequency: "twice daily", status: "active", since: "2016-04-02" },
      { id: "m2", name: "Bisoprolol", dose: "2.5 mg", route: "oral", frequency: "once daily", status: "active", since: "2015-03-10" },
      { id: "m3", name: "Calcium + Vitamin D", dose: "500 mg", route: "oral", frequency: "once daily", status: "active", since: "2017-06-15" },
      { id: "m4", name: "Paracetamol", dose: "1 g", route: "oral", frequency: "up to four times daily as needed", status: "active", since: "2026-10-24" },
      { id: "m5", name: "Lactulose", dose: "15 ml", route: "oral", frequency: "twice daily", status: "active", since: "2026-10-26", note: "Opioid-related constipation prevention" },
    ],
    allergies: [
      { id: "a1", substance: "Codeine", reaction: "Confusion and severe constipation", severity: "severe" },
    ],
    observations: [
      { id: "o1", label: "Blood pressure", value: "118/72", unit: "mmHg", at: daysAgo(1), provenance: "record" },
      { id: "o2", label: "Heart rate", value: 78, unit: "bpm", at: daysAgo(1), provenance: "record" },
      { id: "o3", label: "Haemoglobin", value: 98, unit: "g/L", at: daysAgo(2), provenance: "record" },
      { id: "o4", label: "Pain score", value: 3, unit: "/10", at: daysAgo(1), provenance: "record" },
      { id: "o5", label: "Temperature", value: 36.8, unit: "°C", at: daysAgo(1), provenance: "record" },
      { id: "o6", label: "Assisted steps", value: 18, unit: "steps", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(12), kind: "in-person", by: "Dr. Menon", summary: "Admitted after a fall at home with a left femoral neck fracture. Underwent left hemiarthroplasty on the same day." },
      { id: "e2", at: daysAgo(6), kind: "in-person", by: "Physiotherapist", summary: "Mobilising short distances with a frame and one assistant. Standing blood pressure did not drop significantly." },
      { id: "e3", at: daysAgo(2), kind: "web-voice-call", by: "CareSpeak agent", summary: "Reported feeling unsteady in the morning and needing help to the bathroom. Advised to call before standing." },
    ],
  },
  {
    id: "pt_0008",
    extension: "1008",
    displayName: "Arjun Patel",
    age: 62,
    sex: "male",
    room: "Home care",
    primaryConcern: "Chronic kidney disease stage 4 with a gout flare",
    language: "en",
    synthetic: true,
    carePlan:
      "Renal diet and fluid advice, avoid NSAIDs, review all medicines with renal dosing, weekly creatinine, potassium and blood pressure, and treat the current gout flare as prescribed.",
    conditions: [
      { id: "c1", code: "N18.4", name: "Chronic kidney disease stage 4", status: "active", since: "2019-09-14" },
      { id: "c2", code: "M10.9", name: "Gout", status: "active", since: "2012-02-20", note: "Recurrent flares in the right first metatarsophalangeal joint" },
      { id: "c3", code: "I10", name: "Essential hypertension", status: "active", since: "2008-05-30" },
      { id: "c4", code: "E11.9", name: "Type 2 diabetes mellitus", status: "active", since: "2015-08-11" },
    ],
    medications: [
      { id: "m1", name: "Allopurinol", dose: "100 mg", route: "oral", frequency: "once daily", status: "active", since: "2019-10-01", note: "Renal dose; escalate slowly with urate monitoring" },
      { id: "m2", name: "Amlodipine", dose: "5 mg", route: "oral", frequency: "once daily", status: "active", since: "2008-06-02" },
      { id: "m3", name: "Metformin", dose: "500 mg", route: "oral", frequency: "once daily with breakfast", status: "active", since: "2015-08-15", note: "Revised dose for renal function" },
      { id: "m4", name: "Sodium bicarbonate", dose: "500 mg", route: "oral", frequency: "twice daily", status: "active", since: "2024-03-08" },
      { id: "m5", name: "Colchicine", dose: "500 µg", route: "oral", frequency: "twice daily during flare", status: "active", since: "2026-11-02" },
    ],
    allergies: [
      { id: "a1", substance: "Ibuprofen", reaction: "Acute kidney injury and ankle swelling", severity: "severe" },
    ],
    observations: [
      { id: "o1", label: "Creatinine", value: 285, unit: "µmol/L", at: daysAgo(3), provenance: "record" },
      { id: "o2", label: "eGFR", value: 21, unit: "mL/min/1.73m²", at: daysAgo(3), provenance: "record" },
      { id: "o3", label: "Potassium", value: 5.4, unit: "mmol/L", at: daysAgo(3), provenance: "record" },
      { id: "o4", label: "Urate", value: 0.52, unit: "mmol/L", at: daysAgo(3), provenance: "record" },
      { id: "o5", label: "Blood pressure", value: "152/88", unit: "mmHg", at: daysAgo(1), provenance: "record" },
      { id: "o6", label: "Weight", value: 82.0, unit: "kg", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(18), kind: "in-person", by: "Dr. Iyer", summary: "Nephrology review. Discussed renal protection, a low-potassium diet and avoiding all NSAIDs." },
      { id: "e2", at: daysAgo(3), kind: "telephony", by: "Nurse Demo", summary: "Reported a painful, swollen right big toe for two days. Colchicine started; nephrology informed." },
    ],
  },
  {
    id: "pt_0009",
    extension: "1009",
    displayName: "Sofia Mendes",
    age: 34,
    sex: "female",
    room: "Home care",
    primaryConcern: "Postpartum blood-pressure review after pre-eclampsia",
    language: "en",
    synthetic: true,
    carePlan:
      "Twice-daily blood pressure, continue labetalol and postnatal enoxaparin, watch for headache, visual disturbance or epigastric pain, wound check, and breastfeeding support.",
    conditions: [
      { id: "c1", code: "O14.1", name: "Severe pre-eclampsia", status: "resolved", since: "2026-10-30", note: "Delivered by caesarean section; blood pressure remains elevated postpartum" },
      { id: "c2", code: "O90.3", name: "Postpartum hypertension", status: "active", since: "2026-10-31" },
      { id: "c3", code: "O86.0", name: "Caesarean wound infection", status: "resolved", since: "2026-11-04", note: "Superficial wound infection treated with oral antibiotics" },
    ],
    medications: [
      { id: "m1", name: "Labetalol", dose: "200 mg", route: "oral", frequency: "twice daily", status: "active", since: "2026-10-30" },
      { id: "m2", name: "Enoxaparin", dose: "40 mg", route: "subcutaneous", frequency: "once daily for six weeks after delivery", status: "active", since: "2026-10-30" },
      { id: "m3", name: "Paracetamol", dose: "1 g", route: "oral", frequency: "up to four times daily as needed", status: "active", since: "2026-10-30" },
      { id: "m4", name: "Ferrous fumarate", dose: "210 mg", route: "oral", frequency: "once daily", status: "active", since: "2026-11-01", note: "Postpartum iron supplementation" },
    ],
    allergies: [
      { id: "a1", substance: "Latex", reaction: "Contact rash and itching", severity: "mild" },
    ],
    observations: [
      { id: "o1", label: "Blood pressure", value: "146/94", unit: "mmHg", at: daysAgo(4), provenance: "record" },
      { id: "o2", label: "Blood pressure", value: "138/88", unit: "mmHg", at: daysAgo(1), provenance: "record" },
      { id: "o3", label: "Urine protein:creatinine ratio", value: 32, unit: "mg/mmol", at: daysAgo(5), provenance: "record" },
      { id: "o4", label: "Haemoglobin", value: 104, unit: "g/L", at: daysAgo(5), provenance: "record" },
      { id: "o5", label: "Weight", value: 74.0, unit: "kg", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(11), kind: "in-person", by: "Dr. Rao", summary: "Emergency caesarean section for severe pre-eclampsia at 37 weeks. Baby well, on the postnatal ward." },
      { id: "e2", at: daysAgo(6), kind: "in-person", by: "Community midwife", summary: "Wound red and tender at the right edge; swab taken and oral antibiotics started. Blood pressure still above target." },
      { id: "e3", at: daysAgo(2), kind: "web-voice-call", by: "CareSpeak agent", summary: "Reported a mild headache and tiredness but no visual change or epigastric pain. Advised to rest and repeat the blood pressure." },
    ],
  },
  {
    id: "pt_0010",
    extension: "1010",
    displayName: "Thomas Green",
    age: 57,
    sex: "male",
    room: "Ward B / Bed 4",
    primaryConcern: "Atrial fibrillation with recent transient ischaemic attack",
    language: "en",
    synthetic: true,
    carePlan:
      "Continue warfarin with a target INR of 2.0–3.0, weekly INR while unstable, monitor for bleeding, review falls risk and stroke symptoms, and attend the anticoagulation clinic.",
    conditions: [
      { id: "c1", code: "I48.91", name: "Atrial fibrillation", status: "active", since: "2023-07-18" },
      { id: "c2", code: "G45.9", name: "Transient ischaemic attack", status: "resolved", since: "2026-10-20", note: "Left arm weakness and slurred speech resolved within 40 minutes" },
      { id: "c3", code: "I10", name: "Essential hypertension", status: "active", since: "2016-11-05" },
      { id: "c4", code: "E78.5", name: "Hyperlipidaemia", status: "active", since: "2016-11-05" },
    ],
    medications: [
      { id: "m1", name: "Warfarin", dose: "4 mg", route: "oral", frequency: "once daily at 18:00, dose adjusted by INR", status: "active", since: "2026-10-20" },
      { id: "m2", name: "Bisoprolol", dose: "5 mg", route: "oral", frequency: "once daily", status: "active", since: "2023-07-20" },
      { id: "m3", name: "Atorvastatin", dose: "40 mg", route: "oral", frequency: "once at night", status: "active", since: "2016-11-10" },
      { id: "m4", name: "Ramipril", dose: "5 mg", route: "oral", frequency: "once daily", status: "active", since: "2016-11-10" },
    ],
    allergies: [
      { id: "a1", substance: "Aspirin", reaction: "Wheeze and facial flushing", severity: "moderate" },
    ],
    observations: [
      { id: "o1", label: "INR", value: 2.4, unit: "", at: daysAgo(14), provenance: "record" },
      { id: "o2", label: "INR", value: 3.1, unit: "", at: daysAgo(6), provenance: "record" },
      { id: "o3", label: "INR", value: 2.7, unit: "", at: daysAgo(1), provenance: "record" },
      { id: "o4", label: "Heart rate", value: 88, unit: "bpm", at: daysAgo(1), provenance: "record" },
      { id: "o5", label: "Blood pressure", value: "132/80", unit: "mmHg", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(20), kind: "in-person", by: "Dr. Menon", summary: "Admitted with a resolved left-arm TIA. Carotid imaging normal, warfarin started and cardiology informed." },
      { id: "e2", at: daysAgo(7), kind: "in-person", by: "Anticoagulation nurse", summary: "INR 3.1, above target. Warfarin reduced to 4 mg for three days, then rechecked. No bleeding." },
      { id: "e3", at: daysAgo(2), kind: "telephony", by: "Nurse Demo", summary: "Reported brushing his gums and a small bruise on the forearm. Advised to report any black stool or unusual bleeding." },
    ],
  },
  {
    id: "pt_0011",
    extension: "1011",
    displayName: "Fatima Al-Hassan",
    age: 48,
    sex: "female",
    room: "Home care",
    primaryConcern: "Rheumatoid arthritis on methotrexate with a new cough",
    language: "en",
    synthetic: true,
    carePlan:
      "Continue methotrexate and folic acid, monitor for infection while on immunosuppression, check temperature and chest symptoms, arrange rheumatology review and avoid live vaccines.",
    conditions: [
      { id: "c1", code: "M05.79", name: "Seropositive rheumatoid arthritis", status: "active", since: "2016-05-11" },
      { id: "c2", code: "M35.0", name: "Sjögren syndrome", status: "active", since: "2019-02-03" },
      { id: "c3", code: "M81.0", name: "Osteoporosis", status: "active", since: "2021-08-17", note: "Long-term steroid use" },
    ],
    medications: [
      { id: "m1", name: "Methotrexate", dose: "15 mg", route: "oral", frequency: "once weekly on Sunday", status: "active", since: "2016-06-01" },
      { id: "m2", name: "Folic acid", dose: "5 mg", route: "oral", frequency: "once weekly on Tuesday", status: "active", since: "2016-06-01" },
      { id: "m3", name: "Hydroxychloroquine", dose: "200 mg", route: "oral", frequency: "twice daily", status: "active", since: "2017-01-10" },
      { id: "m4", name: "Prednisolone", dose: "5 mg", route: "oral", frequency: "once daily", status: "active", since: "2022-04-02" },
      { id: "m5", name: "Alendronic acid", dose: "70 mg", route: "oral", frequency: "once weekly on Wednesday", status: "active", since: "2021-08-20" },
    ],
    allergies: [
      { id: "a1", substance: "Sulfa drugs", reaction: "Widespread rash", severity: "moderate" },
    ],
    observations: [
      { id: "o1", label: "C-reactive protein", value: 28, unit: "mg/L", at: daysAgo(4), provenance: "record" },
      { id: "o2", label: "ESR", value: 42, unit: "mm/h", at: daysAgo(4), provenance: "record" },
      { id: "o3", label: "Haemoglobin", value: 108, unit: "g/L", at: daysAgo(4), provenance: "record" },
      { id: "o4", label: "Temperature", value: 37.9, unit: "°C", at: daysAgo(1), provenance: "record" },
      { id: "o5", label: "Joint pain score", value: 5, unit: "/10", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(25), kind: "in-person", by: "Dr. Iyer", summary: "Rheumatology review. Disease activity moderate. Methotrexate continued; bloods satisfactory." },
      { id: "e2", at: daysAgo(2), kind: "telephony", by: "Nurse Demo", summary: "Reported a dry cough and low-grade fever for two days. Advised to hold methotrexate until reviewed and to seek same-day assessment if breathless." },
    ],
  },
  {
    id: "pt_0012",
    extension: "1012",
    displayName: "Noah Williams",
    age: 8,
    sex: "male",
    room: "Home care",
    primaryConcern: "Newly diagnosed type 1 diabetes after diabetic ketoacidosis",
    language: "en",
    synthetic: true,
    carePlan:
      "Parent-administered insulin with meals and at night, four-hourly glucose and ketone checks while unwell, school care plan, diabetes educator review and emergency glucagon at home and school.",
    conditions: [
      { id: "c1", code: "E10.9", name: "Type 1 diabetes mellitus", status: "active", since: "2026-10-27" },
      { id: "c2", code: "E10.10", name: "Diabetic ketoacidosis", status: "resolved", since: "2026-10-27", note: "Resolved with intravenous fluids and insulin; discharged after three days" },
    ],
    medications: [
      { id: "m1", name: "Insulin glargine", dose: "8 units", route: "subcutaneous", frequency: "once daily at bedtime", status: "active", since: "2026-10-29" },
      { id: "m2", name: "Insulin lispro", dose: "4 units", route: "subcutaneous", frequency: "with meals, adjusted by carbohydrate intake", status: "active", since: "2026-10-29" },
      { id: "m3", name: "Glucagon", dose: "0.5 mg", route: "intramuscular", frequency: "emergency use only for severe hypoglycaemia", status: "active", since: "2026-10-30" },
    ],
    allergies: [],
    observations: [
      { id: "o1", label: "Blood glucose", value: 14.2, unit: "mmol/L", at: daysAgo(2), provenance: "record" },
      { id: "o2", label: "Blood ketones", value: 0.8, unit: "mmol/L", at: daysAgo(2), provenance: "record" },
      { id: "o3", label: "Weight", value: 26.0, unit: "kg", at: daysAgo(3), provenance: "record" },
      { id: "o4", label: "HbA1c", value: 11.2, unit: "%", at: daysAgo(9), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(12), kind: "in-person", by: "Dr. Rao", summary: "Admitted in diabetic ketoacidosis. Treated with intravenous fluids and an insulin infusion, transitioned to subcutaneous insulin." },
      { id: "e2", at: daysAgo(8), kind: "in-person", by: "Diabetes educator", summary: "Parent taught glucose monitoring, insulin drawing, hypoglycaemia management and sick-day rules. School care plan started." },
      { id: "e3", at: daysAgo(2), kind: "telephony", by: "Nurse Demo", summary: "Parent reported a bedtime glucose of 14.2 mmol/L with ketones 0.8. Advised fluids, correction dose per plan and repeat ketones in two hours." },
    ],
  },
  {
    id: "pt_0013",
    extension: "1013",
    displayName: "Elena Rossi",
    age: 70,
    sex: "female",
    room: "Ward C / Bed 6",
    primaryConcern: "Stroke rehabilitation with swallowing difficulty",
    language: "en",
    synthetic: true,
    carePlan:
      "Soft diet with thickened fluids, swallow review, daily blood pressure and neurological observations, mobilise with two assistants, continue clopidogrel and statin, and screen for depression.",
    conditions: [
      { id: "c1", code: "I63.9", name: "Left middle cerebral artery infarct", status: "active", since: "2026-10-22", note: "Right-sided weakness and mild expressive aphasia" },
      { id: "c2", code: "I48.91", name: "Atrial fibrillation", status: "active", since: "2018-09-30" },
      { id: "c3", code: "R13.10", name: "Dysphagia", status: "active", since: "2026-10-22" },
      { id: "c4", code: "E78.5", name: "Hyperlipidaemia", status: "active", since: "2015-04-14" },
    ],
    medications: [
      { id: "m1", name: "Clopidogrel", dose: "75 mg", route: "oral", frequency: "once daily", status: "active", since: "2026-10-23" },
      { id: "m2", name: "Atorvastatin", dose: "80 mg", route: "oral", frequency: "once at night", status: "active", since: "2026-10-23" },
      { id: "m3", name: "Metoprolol", dose: "25 mg", route: "oral", frequency: "twice daily", status: "active", since: "2018-10-02" },
      { id: "m4", name: "Macrogol", dose: "1 sachet", route: "oral", frequency: "once daily", status: "active", since: "2026-10-26" },
    ],
    allergies: [],
    observations: [
      { id: "o1", label: "Blood pressure", value: "148/86", unit: "mmHg", at: daysAgo(1), provenance: "record" },
      { id: "o2", label: "Heart rate", value: 76, unit: "bpm", at: daysAgo(1), provenance: "record" },
      { id: "o3", label: "NIHSS", value: 4, unit: "points", at: daysAgo(3), provenance: "record" },
      { id: "o4", label: "Oxygen saturation", value: 96, unit: "%", at: daysAgo(1), provenance: "record" },
      { id: "o5", label: "Swallow screen", value: "Soft diet, thickened fluids", at: daysAgo(3), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(19), kind: "in-person", by: "Dr. Menon", summary: "Admitted with a left MCA infarct outside the thrombolysis window. Stroke-unit care, aspirin avoided due to AF; clopidogrel started after imaging." },
      { id: "e2", at: daysAgo(9), kind: "in-person", by: "Speech and language therapist", summary: "Modified barium swallow showed aspiration risk with thin fluids. Soft diet and thickened fluids recommended." },
      { id: "e3", at: daysAgo(2), kind: "in-person", by: "Physiotherapist", summary: "Transfers with two assistants and a rotunda. Right grip improving; ongoing rehab plan." },
    ],
  },
  {
    id: "pt_0014",
    extension: "1014",
    displayName: "Samuel Okafor",
    age: 65,
    sex: "male",
    room: "Ward B / Bed 6",
    primaryConcern: "Recovery from urosepsis with an indwelling catheter",
    language: "en",
    synthetic: true,
    carePlan:
      "Complete antibiotics, monitor temperature, blood pressure, urine output and confusion, maintain catheter care, check renal function and arrange urology follow-up for benign prostatic enlargement.",
    conditions: [
      { id: "c1", code: "A41.9", name: "Sepsis secondary to urinary tract infection", status: "resolved", since: "2026-11-01", note: "Improved with intravenous antibiotics and fluids" },
      { id: "c2", code: "N40.1", name: "Benign prostatic enlargement", status: "active", since: "2020-06-17" },
      { id: "c3", code: "E11.9", name: "Type 2 diabetes mellitus", status: "active", since: "2013-02-08" },
      { id: "c4", code: "N18.2", name: "Chronic kidney disease stage 2", status: "active", since: "2021-09-25" },
    ],
    medications: [
      { id: "m1", name: "Tamsulosin", dose: "400 µg", route: "oral", frequency: "once daily after food", status: "active", since: "2020-06-20" },
      { id: "m2", name: "Metformin", dose: "500 mg", route: "oral", frequency: "twice daily", status: "active", since: "2013-02-12" },
      { id: "m3", name: "Amlodipine", dose: "5 mg", route: "oral", frequency: "once daily", status: "active", since: "2018-07-04" },
      { id: "m4", name: "Cefuroxime", dose: "750 mg", route: "intravenous", frequency: "three times daily, day 4 of 7", status: "active", since: "2026-11-01" },
    ],
    allergies: [
      { id: "a1", substance: "Penicillin", reaction: "Rash and swelling of the lips", severity: "moderate" },
    ],
    observations: [
      { id: "o1", label: "Temperature", value: 36.9, unit: "°C", at: daysAgo(1), provenance: "record" },
      { id: "o2", label: "Blood pressure", value: "108/64", unit: "mmHg", at: daysAgo(1), provenance: "record" },
      { id: "o3", label: "Heart rate", value: 92, unit: "bpm", at: daysAgo(1), provenance: "record" },
      { id: "o4", label: "White cell count", value: 11.2, unit: "×10⁹/L", at: daysAgo(2), provenance: "record" },
      { id: "o5", label: "Urine output", value: 40, unit: "mL/hour", at: daysAgo(1), provenance: "record" },
      { id: "o6", label: "Blood glucose", value: 9.1, unit: "mmol/L", at: daysAgo(1), provenance: "record" },
    ],
    encounters: [
      { id: "e1", at: daysAgo(10), kind: "in-person", by: "Dr. Rao", summary: "Admitted with fever, confusion and hypotension from a urinary source. Sepsis bundle completed; catheter replaced." },
      { id: "e2", at: daysAgo(5), kind: "in-person", by: "Urology", summary: "Catheter draining well. Plan for trial without catheter after antibiotics and urology clinic review." },
      { id: "e3", at: daysAgo(2), kind: "web-voice-call", by: "CareSpeak agent", summary: "Reported feeling better, no shivering, passing urine through the catheter. Advised to keep drinking and report any confusion or fever." },
    ],
  },
];

/** Bump when the synthetic dataset changes so existing stores reconcile it. */
export const SYNTHETIC_SEED_VERSION = 3;

/**
 * Patients added after the first seed. Reconciliation only ever adds these to
 * an existing store; older synthetic patients are refreshed but never
 * resurrected if the nurse deleted them.
 */
export const SYNTHETIC_ADDITION_IDS = new Set([
  "pt_0005",
  "pt_0006",
  "pt_0007",
  "pt_0008",
  "pt_0009",
  "pt_0010",
  "pt_0011",
  "pt_0012",
  "pt_0013",
  "pt_0014",
]);

export function getSeedPatient(id: string): ClinicalPatient | undefined {
  return SYNTHETIC_PATIENTS.find((p) => p.id === id);
}
