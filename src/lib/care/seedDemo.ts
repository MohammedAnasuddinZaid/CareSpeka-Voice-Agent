/**
 * Demo content for the Web Voice Call — Demo.
 *
 * A freshly deployed site would otherwise look empty, which is a poor demo. This
 * module seeds a small amount of realistic, clearly-synthetic history the first
 * time the store is used: two completed sessions (one escalated, one reviewed),
 * grounded reports, a follow-up task and messages for patients.
 *
 * It is idempotent (guarded by a store flag), skipped in tests, and can be turned
 * off entirely with CARE_SEED_DEMO=false. It never invents clinical facts: the
 * reports are built by the same `buildReport` used at runtime, from the seeded
 * transcripts and the synthetic records.
 */
import { getDriver, CareKeys as K } from "./store";
import { SYNTHETIC_PATIENTS } from "./seedPatients";
import { hashToken, isoNow, newId, newToken } from "./crypto";
import { buildReport } from "./report";
import type {
  CareEvent,
  CareEventType,
  CareReport,
  CareSession,
  CareTask,
  CareTranscriptEntry,
  PatientMessage,
  PatientRecord,
} from "./types";

let inFlight: Promise<void> | null = null;
let recordsInFlight: Promise<void> | null = null;

export function ensureDemoSeed(): Promise<void> {
  // Never let demo seeding break a real request.
  if (!inFlight) inFlight = run().catch(() => undefined);
  return inFlight;
}

/**
 * Seeds the synthetic *clinical records* that give the history-aware assistant
 * something substantial to read. Kept separate from the session seed so an
 * existing deployment can receive the newer dataset without duplicating demo
 * sessions.
 *
 * Idempotent: each record has a stable id, and the guard is only written after
 * the pass completes. Patients the nurse deleted are skipped (including their
 * records), so demo content is never resurrected.
 */
export function ensurePatientRecordSeed(): Promise<void> {
  if (!recordsInFlight) recordsInFlight = seedRecords().catch(() => undefined);
  return recordsInFlight;
}

async function seedRecords(): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  if ((process.env.CARE_SEED_DEMO ?? "").toLowerCase() === "false") return;

  const d = await getDriver();
  if (await d.getDoc(K.recordsSeed)) return;

  const existingPatients = new Set<string>();
  for (const p of SYNTHETIC_PATIENTS) {
    if (await d.getDoc(K.patientDeleted(p.id))) continue;
    if (await d.getDoc(K.patient(p.id))) existingPatients.add(p.id);
  }

  // Patient seeding has not run yet. Retry on the next call rather than
  // writing an empty guard that would skip the records forever.
  if (!existingPatients.size) {
    if (await d.getDoc(K.patientSeeded)) {
      await d.setDoc(K.recordsSeed, {
        at: isoNow(),
        version: 1,
        seeded: 0,
        note: "no synthetic patients remain",
      });
    }
    return;
  }

  let indexed: string[] = [];
  try {
    indexed = ((await d.getList(K.recordIndex)) as unknown[]).filter(
      (x): x is string => typeof x === "string"
    );
  } catch {
    const raw = await d.getDoc(K.recordIndex);
    if (Array.isArray(raw)) indexed = raw.filter((x): x is string => typeof x === "string");
  }
  const indexSet = new Set(indexed);

  let seeded = 0;
  for (const seed of DEMO_RECORDS) {
    if (!existingPatients.has(seed.patientId)) continue;
    if (await d.getDoc(K.record(seed.id))) continue;

    const text = seed.text.trim();
    const record: PatientRecord = {
      id: seed.id,
      patientId: seed.patientId,
      title: seed.title,
      source: seed.source,
      text,
      chars: text.length,
      createdAt: daysAgo(seed.daysAgo, seed.hour ?? 9, 0),
      createdBy: "Demo seed",
      synthetic: true,
    };
    await d.setDoc(K.record(record.id), record);
    if (!indexSet.has(record.id)) {
      await d.appendList(K.recordIndex, record.id, 1000);
      indexSet.add(record.id);
    }
    seeded += 1;
  }

  await d.setDoc(K.recordsSeed, { at: isoNow(), version: 1, seeded });
  if (seeded > 0) {
    await d.appendList(
      K.audit,
      {
        id: newId("aud"),
        at: isoNow(),
        actorRole: "system",
        action: "care.demo_records_seeded",
        detail: { records: seeded, patients: existingPatients.size },
      },
      5000
    );
  }
}

interface DemoRecordSeed {
  id: string;
  patientId: string;
  title: string;
  source: string;
  daysAgo: number;
  hour?: number;
  text: string;
}

/** Stable synthetic documents — deliberately verbose so deep questions work. */
export const DEMO_RECORDS: DemoRecordSeed[] = [
  {
    id: "rec_seed_pt_0001_discharge",
    patientId: "pt_0001",
    title: "Discharge summary — heart failure",
    source: "Hospital discharge",
    daysAgo: 9,
    text: `Admitted with acute decompensated heart failure. Weight on admission 76.8 kg, 74.9 kg at discharge after intravenous diuresis.
Medication on discharge: furosemide 40 mg oral once daily (new), ramipril 5 mg once daily continued, metformin 500 mg twice daily and atorvastatin 20 mg at night unchanged.
Plan: fluid restriction 1.5 L per day, daily morning weight, low-salt diet, repeat electrolytes and renal function in one week.
Safety advice given: seek review for weight gain of more than 2 kg in three days, new orthopnoea, resting breathlessness or worsening ankle swelling.
Allergy: penicillin — rash and facial swelling. Contrast dye — nausea and hives.
Follow-up: community nursing check-in and GP review within seven days.`,
  },
  {
    id: "rec_seed_pt_0001_weights",
    patientId: "pt_0001",
    title: "Home monitoring log — week 1",
    source: "Patient-reported",
    daysAgo: 2,
    text: `Morning weights: 71.2 kg on day 1, 72.4 kg on day 4, 74.1 kg on day 7.
Ankle swelling noticed from day 5. Needed two pillows to sleep on day 6. No chest pain and no fever.
Furosemide was missed on day 3 because the prescription ran out; restarted on day 4 after the pharmacy supplied it.
Appetite reduced. Patient reports feeling more tired than usual and becoming breathless walking to the kitchen.`,
  },
  {
    id: "rec_seed_pt_0001_gp",
    patientId: "pt_0001",
    title: "GP telephone note",
    source: "Primary care",
    daysAgo: 1,
    hour: 16,
    text: `GP spoke to the patient after the nurse flagged a two-kilogram weight gain and new orthopnoea.
Plan: same-day clinical review, check electrolytes and renal function, and consider increasing diuretic dose only after examination.
Patient advised to continue daily weights and to call the care line if breathlessness worsens at rest.`,
  },
  {
    id: "rec_seed_pt_0002_bp_review",
    patientId: "pt_0002",
    title: "Hypertension review — medication titration",
    source: "Clinic letter",
    daysAgo: 30,
    text: `Home blood-pressure average over two weeks was 148/92 mmHg despite amlodipine 10 mg daily.
Hydrochlorothiazide 12.5 mg daily added. Check urea and electrolytes in two weeks. Continue rosuvastatin 10 mg at night.
Recorded allergy: sulfa antibiotics cause itching. Hydrochlorothiazide has been tolerated; no rash reported.
Advice: reduce salt intake, continue home readings twice daily, and send the log before the next review.`,
  },
  {
    id: "rec_seed_pt_0002_bp_log",
    patientId: "pt_0002",
    title: "Home blood-pressure log",
    source: "Patient-reported",
    daysAgo: 5,
    text: `Morning readings: 142/88, 146/90, 138/86, 136/84, 140/86 mmHg.
Evening readings: 138/84, 134/82, 136/80 mmHg.
No dizziness, no headaches, no chest pain. Medication adherence reported as good.
Patient has been walking 30 minutes most days and has reduced added salt.`,
  },
  {
    id: "rec_seed_pt_0003_diabetes",
    patientId: "pt_0003",
    title: "Diabetes clinic letter",
    source: "Clinic letter",
    daysAgo: 20,
    text: `HbA1c 8.9% (above the agreed target). Fasting glucose has been between 9 and 12 mmol/L at home.
Current treatment: gliclazide 80 mg daily and metformin 1 g twice daily. Calcium and vitamin D continued for osteoporosis.
Reports dizziness on standing, with a documented orthostatic drop of 20/10 mmHg. Advised to rise slowly, maintain hydration and check a capillary glucose during episodes.
Review medication timing and consider whether gliclazide is contributing to the dizziness.`,
  },
  {
    id: "rec_seed_pt_0003_falls",
    patientId: "pt_0003",
    title: "Falls risk assessment",
    source: "Community nursing",
    daysAgo: 7,
    text: `Falls risk assessed as high after a near-fall in the bathroom.
Findings: dizziness on standing, osteoporosis, poor night lighting and no grab rail beside the shower.
Actions: occupational therapy referral, grab rail installation, review footwear, keep the phone within reach, check capillary glucose during dizzy episodes, and ask the GP to review medication timing.
Patient lives alone and has a daughter who calls twice daily.`,
  },
  {
    id: "rec_seed_pt_0004_asthma",
    patientId: "pt_0004",
    title: "Asthma annual review",
    source: "Clinic letter",
    daysAgo: 60,
    text: `Asthma control test score 20. Peak flow 380–410 L/min against a personal best of 450 L/min.
Night-time symptoms about once a week. Reliever used around twice a week. Inhaler technique checked and good.
Continue budesonide/formoterol 160/4.5 µg twice daily and salbutamol as needed. Cetirizine continued for allergic rhinitis.
Action plan updated. Advise a review if reliever use increases, night symptoms occur more than twice a week, or peak flow falls below 320 L/min.`,
  },
  {
    id: "rec_seed_pt_0004_pharmacy",
    patientId: "pt_0004",
    title: "Pharmacy medication review",
    source: "Pharmacy",
    daysAgo: 14,
    text: `Medication adherence reported as good. No oral steroid courses in the last twelve months.
Salbutamol use approximately twice a week. Budesonide/formoterol continued. Cetirizine taken daily during the pollen season.
Discussed dust-mite measures and avoiding known triggers. Patient knows to seek urgent help for reliever use that does not settle symptoms.`,
  },
  {
    id: "rec_seed_pt_0005_discharge",
    patientId: "pt_0005",
    title: "Discharge summary — COPD exacerbation",
    source: "Hospital discharge",
    daysAgo: 5,
    text: `Admitted with an infective COPD exacerbation. Treated with nebulised bronchodilators, intravenous hydrocortisone and a five-day antibiotic course.
Discharged on prednisolone 30 mg daily with a five-day taper, tiotropium 18 µg daily, salbutamol 100 µg as needed and amlodipine 5 mg daily.
Home oxygen at 1 L/min via nasal cannula, with the target saturation range documented by the respiratory team as 88–92%.
Plan: complete the steroid taper, check saturation on room air twice daily, and refer to pulmonary rehabilitation.
Safety advice: call the care line for worsening breathlessness at rest, new confusion, fever or saturation below the documented range.`,
  },
  {
    id: "rec_seed_pt_0005_resp",
    patientId: "pt_0005",
    title: "Respiratory therapy note",
    source: "Respiratory therapist",
    daysAgo: 2,
    text: `Saturation 91% on 1 L/min at rest and 94% on 2 L/min after walking 30 metres. Respiratory rate 22, heart rate 96, temperature 37.2 °C.
Used pursed-lip breathing and rested twice during the walk. Describes anxiety about reducing the oxygen.
Inhaler technique reviewed. Continue the prednisolone taper. Refer to pulmonary rehabilitation when the course is complete.
No ankle swelling. Weight 54.0 kg, stable.`,
  },
  {
    id: "rec_seed_pt_0005_home",
    patientId: "pt_0005",
    title: "Community nursing home visit",
    source: "Community nursing",
    daysAgo: 1,
    hour: 15,
    text: `Home visit completed. Saturation 92% on 1 L/min at rest. Respiratory rate 20. Temperature 37.1 °C.
Appetite poor but drinking adequately. Sleeping in a recliner because lying flat feels uncomfortable.
No ankle swelling. Weight 54.0 kg. Prednisolone taper on track. Patient asked for written instructions about the oxygen wean.`,
  },
  {
    id: "rec_seed_pt_0006_operative",
    patientId: "pt_0006",
    title: "Operative note — laparoscopic appendectomy",
    source: "Hospital discharge",
    daysAgo: 8,
    text: `Laparoscopic appendectomy for acute appendicitis. Appendix was inflamed but not perforated. Procedure uncomplicated.
Discharged on day two with paracetamol 1 g up to four times daily as needed and written wound-care instructions.
Advice: keep the wounds dry for 48 hours, avoid lifting more than 5 kg for two weeks, and seek review for fever, spreading redness or purulent discharge.
No known drug allergies.`,
  },
  {
    id: "rec_seed_pt_0006_wound",
    patientId: "pt_0006",
    title: "Community nurse wound review",
    source: "Community nursing",
    daysAgo: 2,
    text: `Wound edges approximated. A one-centimetre area of mild erythema at the inferior port site, with no discharge and no induration.
Temperature 37.8 °C. Pain 4/10 on movement. Started amoxicillin-clavulanate 625 mg three times daily for five days.
Erythema marked with a pen and photographed for comparison. Review arranged in two days. Advised to seek urgent review if redness spreads, fever rises or pain worsens.`,
  },
  {
    id: "rec_seed_pt_0006_phone",
    patientId: "pt_0006",
    title: "Telephone follow-up — day 3 of antibiotics",
    source: "Telephone note",
    daysAgo: 1,
    hour: 11,
    text: `Temperature 37.2 °C, pain 2/10 at rest and 4/10 on movement. Erythema not spreading. No vomiting and appetite improving.
Taking amoxicillin-clavulanate as prescribed. Reports mild loose stools but is drinking well.
Continue the antibiotic course, keep the wound clean and dry, and attend the arranged wound review.`,
  },
];

async function run(): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  if ((process.env.CARE_SEED_DEMO ?? "").toLowerCase() === "false") return;

  const d = await getDriver();
  if (await d.getDoc(K.seed)) return;
  await d.setDoc(K.seed, { at: isoNow(), version: 1, status: "in-progress" });
  try {
    await seedContent(d);
    await d.setDoc(K.seed, { at: isoNow(), version: 1, status: "complete" });
  } catch (err) {
    // Allow a retry on the next request rather than leaving the guard behind.
    await d.del(K.seed).catch(() => undefined);
    throw err;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedContent(d: any): Promise<void> {
  const nurse = { nurseId: "nurse_1", nurseName: process.env.CARE_NURSE_NAME || "Nurse Demo" };

  // --- one reviewed, escalated heart-failure check-in ----------------------
  const anita = SYNTHETIC_PATIENTS[0];
  const anitaStart = daysAgo(2, 10, 15);
  const anitaEntries: Array<Omit<CareTranscriptEntry, "id" | "sessionId" | "seq" | "at">> = [
    { role: "agent", text: "Hello Anita, this is your CareSpeak care assistant. How have you been feeling since our last check-in?" },
    { role: "patient", text: "I've been more tired this week and my ankles look a bit puffy." },
    { role: "agent", text: "Thank you for telling me. Have you noticed any weight gain, or do you need extra pillows to sleep at night?" },
    { role: "patient", text: "I gained about two kilos and I need an extra pillow at night." },
    { role: "agent", text: "I'm flagging that for your nurse today — fluid build-up can matter with heart failure. Please keep your feet up and weigh yourself each morning." },
  ];
  const anitaReport = await seedSession({
    patientId: anita.id,
    participantName: anita.displayName,
    nurse,
    startIso: anitaStart,
    durationMs: 9 * 60_000,
    escalated: true,
    escalation: "Patient reported rapid weight gain and ankle swelling with orthopnoea.",
    entries: anitaEntries,
    review: { by: nurse.nurseName, note: "Reviewed; GP informed about likely fluid overload." },
  });

  // --- one open (unreviewed) dizzy / near-fall check-in --------------------
  const lakshmi = SYNTHETIC_PATIENTS[2];
  const lakshmiStart = daysAgo(1, 9, 40);
  const lakshmiEntries: Array<Omit<CareTranscriptEntry, "id" | "sessionId" | "seq" | "at">> = [
    { role: "agent", text: "Hello Lakshmi, this is your CareSpeak care assistant. How have you been since we last spoke?" },
    { role: "patient", text: "I felt dizzy when I stood up this morning and I nearly fell in the bathroom." },
    { role: "agent", text: "I'm concerned about the dizziness and the near-fall. I am alerting your nurse now. If you feel unwell again, please sit down and call for help." },
  ];
  await seedSession({
    patientId: lakshmi.id,
    participantName: lakshmi.displayName,
    nurse,
    startIso: lakshmiStart,
    durationMs: 5 * 60_000,
    escalated: true,
    escalation: "Patient reported dizziness on standing and a near-fall.",
    entries: lakshmiEntries,
    review: null,
  });

  // --- follow-up work + messages -------------------------------------------
  const tasks: CareTask[] = [
    {
      id: newId("task"),
      patientId: anita.id,
      title: "Call Anita back about weight gain and ankle swelling",
      status: "open",
      createdAt: isoNow(),
      createdBy: nurse.nurseName,
    },
    {
      id: newId("task"),
      patientId: lakshmi.id,
      title: "Review dizziness and falls risk with the clinical team",
      status: "open",
      createdAt: isoNow(),
      createdBy: nurse.nurseName,
    },
  ];
  for (const t of tasks) await d.appendList(K.tasks, t, 2000);

  const messages: PatientMessage[] = [
    {
      id: newId("msg"),
      patientId: anita.id,
      patientName: anita.displayName,
      text: "Please weigh yourself every morning this week and note any ankle swelling. Your nurse will call you back today.",
      createdAt: isoNow(),
      createdBy: nurse.nurseName,
      channel: "web-voice-demo",
    },
    {
      id: newId("msg"),
      patientId: SYNTHETIC_PATIENTS[3].id,
      patientName: SYNTHETIC_PATIENTS[3].displayName,
      text: "Remember to use your reliever inhaler as prescribed and keep your peak-flow readings for our next call.",
      createdAt: isoNow(),
      createdBy: nurse.nurseName,
      channel: "web-voice-demo",
    },
  ];
  for (const m of messages) await d.appendList(K.messages, m, 2000);

  await d.appendList(
    K.audit,
    {
      id: newId("aud"),
      at: isoNow(),
      actorRole: "system",
      action: "care.demo_seeded",
      detail: { sessions: 2, reports: anitaReport ? 2 : 1, tasks: tasks.length, messages: messages.length },
    },
    5000
  );
}

// ---------------------------------------------------------------------------

async function seedSession(args: {
  patientId: string;
  participantName: string;
  nurse: { nurseId: string; nurseName: string };
  startIso: string;
  durationMs: number;
  escalated: boolean;
  escalation?: string;
  entries: Array<Omit<CareTranscriptEntry, "id" | "sessionId" | "seq" | "at">>;
  review: { by: string; note: string } | null;
}): Promise<CareReport | null> {
  const d = await getDriver();
  const start = Date.parse(args.startIso);
  const end = start + args.durationMs;

  const session: CareSession = {
    id: newId("wc"),
    mode: "web-voice-demo",
    patientId: args.patientId,
    nurseId: args.nurse.nurseId,
    nurseName: args.nurse.nurseName,
    status: "ended",
    createdAt: new Date(start).toISOString(),
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    durationMs: args.durationMs,
    joinTokenHash: hashToken(newToken()),
    joinCode: String(100000 + Math.floor(Math.random() * 900000)),
    joinExpiresAt: new Date(start + 30 * 60_000).toISOString(),
    joinedAt: new Date(start + 60_000).toISOString(),
    participantName: args.participantName,
    endReason: "nurse_ended",
    escalated: args.escalated,
    seq: 0,
  };

  let seq = 0;
  const transcript: CareTranscriptEntry[] = args.entries.map((e, i) => ({
    ...e,
    id: newId("tt"),
    sessionId: session.id,
    seq: ++seq,
    at: new Date(start + 60_000 + i * 45_000).toISOString(),
    engine: e.role === "agent" ? "rule-based-care-engine" : "patient device (Web Speech)",
  }));

  const events: CareEvent[] = [];
  const pushEvent = (type: CareEventType, actor: CareEvent["actor"], at: number, detail?: Record<string, unknown>) => {
    events.push({ seq: ++seq, at: new Date(at).toISOString(), type, actor, detail });
  };
  pushEvent("session.created", "nurse", start, { patientId: args.patientId, seeded: true });
  pushEvent("session.joined", "patient", start + 60_000, { name: args.participantName });
  if (args.escalated) pushEvent("escalation.created", "system", end - 90_000, { reason: args.escalation, seeded: true });
  pushEvent("session.ended", "nurse", end, { reason: "nurse_ended" });

  const patient = SYNTHETIC_PATIENTS.find((p) => p.id === args.patientId) ?? null;
  const report = buildReport({
    sessionId: session.id,
    patientId: args.patientId,
    patient,
    entries: transcript,
    durationMs: args.durationMs,
  });

  if (args.review) {
    report.status = "approved";
    report.reviewedAt = new Date(end + 20 * 60_000).toISOString();
    report.reviewedBy = args.review.by;
    report.reviewNote = args.review.note;
    report.sourceFlags.reviewed = true;
    pushEvent("report.generated", "agent", end + 60_000, { reportId: report.id, seeded: true });
    pushEvent("report.reviewed", "nurse", end + 20 * 60_000, { reportId: report.id, by: args.review.by });
  } else {
    pushEvent("report.generated", "agent", end + 60_000, { reportId: report.id, seeded: true });
  }

  session.reportId = report.id;
  session.seq = seq;

  await d.setDoc(K.session(session.id), session);
  const index = ((await d.getDoc(K.sessionIndex)) as string[] | null) ?? [];
  if (!index.includes(session.id)) index.push(session.id);
  await d.setDoc(K.sessionIndex, index.slice(-500));

  for (const e of events) await d.appendList(K.events(session.id), e, 2000);
  for (const t of transcript) await d.appendList(K.transcript(session.id), t, 4000);

  await d.setDoc(K.report(report.id), report);
  const reportIndex = ((await d.getDoc(K.reportIndex)) as string[] | null) ?? [];
  if (!reportIndex.includes(report.id)) reportIndex.push(report.id);
  await d.setDoc(K.reportIndex, reportIndex.slice(-1000));

  return report;
}

function daysAgo(n: number, hour: number, minute: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}