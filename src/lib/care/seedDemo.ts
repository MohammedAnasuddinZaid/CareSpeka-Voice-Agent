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
} from "./types";

let inFlight: Promise<void> | null = null;

export function ensureDemoSeed(): Promise<void> {
  // Never let demo seeding break a real request.
  if (!inFlight) inFlight = run().catch(() => undefined);
  return inFlight;
}

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