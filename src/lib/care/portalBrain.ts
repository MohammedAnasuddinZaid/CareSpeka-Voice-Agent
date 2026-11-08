/**
 * The nurse-portal brain.
 *
 * Server-only. Turns live device signals + the patient's clinical record + the
 * records the nurse inserted into (a) a spoken alert when something crosses a
 * threshold and (b) answers to free-text questions.
 *
 * Two engines, in order:
 *   1. `answerQuestion` — deterministic, grounded in the structured record.
 *      Used for the intents it knows (medications, allergies, observations...).
 *   2. Gemini — used for everything else, with the same grounding rules. Every
 *      answer is cached in Redis by content hash, so repeated questions and
 *      repeated alert states cost nothing.
 *
 * If neither can answer, the reply says so. Nothing here invents a vital sign,
 * a medication or a diagnosis.
 */
import { createHash } from "node:crypto";
import type { DeviceVitals, PatientMetrics } from "@/types";
import { getSessionStore } from "@/lib/server/store";
import { newestMetrics, newestVitals } from "@/lib/liveMetrics";
import { CareKeys as K, getDriver } from "./store";
import {
  addMessage,
  appendAudit,
  buildRecordContext,
  getPatient,
  getSessionLoose,
  getSessionLink,
  linkSessionToPatient,
  listPatients,
  listRecords,
  unlinkSessionPatient,
} from "./repo";
import {
  answerQuestion,
  type AssistantAction,
  type AssistantContext,
  type PatientContext,
} from "./assistant";
import { geminiConfigured, geminiGenerate, geminiModelLabel } from "./gemini";
import type { ClinicalPatient, PatientRecord, SessionPatientLink } from "./types";

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

export type Severity = "critical" | "warning" | "watch" | "ok";

const RANK: Record<Severity, number> = { ok: 0, watch: 1, warning: 2, critical: 3 };

export interface SignalFinding {
  /** Stable id — used for dedupe and cache keys. */
  key: string;
  severity: Severity;
  label: string;
  reading: string;
  note: string;
}

export function severityRank(s: Severity): number {
  return RANK[s];
}

export function worstSeverity(findings: SignalFinding[]): Severity {
  return findings.reduce<Severity>((worst, f) => (RANK[f.severity] > RANK[worst] ? f.severity : worst), "ok");
}

/**
 * Applies CareSpeak's published thresholds (see ESCALATION_RULES) plus a few
 * conservative wearable checks. Pure and testable. Never diagnoses — it only
 * reports readings and whether they sit outside a stated threshold.
 */
export function analyzeSignals(
  metrics: PatientMetrics | null | undefined,
  vitals?: DeviceVitals | null
): SignalFinding[] {
  const out: SignalFinding[] = [];

  const alertness = metrics?.alertnessScore;
  if (alertness != null && Number.isFinite(alertness) && alertness < 25) {
    out.push({
      key: "low_alertness",
      severity: alertness < 15 ? "critical" : "warning",
      label: "Alertness",
      reading: `${Math.round(alertness)}%`,
      note: "below CareSpeak's 25% alertness floor",
    });
  }

  const blink = metrics?.blinkRate;
  if (blink != null && Number.isFinite(blink) && blink < 5) {
    out.push({
      key: "low_blink",
      severity: blink < 2 ? "warning" : "watch",
      label: "Blink rate",
      reading: `${blink.toFixed(1)}/min`,
      note: "below the 5/min watch level",
    });
  }

  const closureMs = metrics?.eyeClosureDuration;
  if (closureMs != null && Number.isFinite(closureMs) && closureMs > 3000) {
    out.push({
      key: "eye_closure",
      severity: closureMs > 10_000 ? "critical" : "warning",
      label: "Eye closure",
      reading: `${(closureMs / 1000).toFixed(1)}s`,
      note: closureMs > 10_000 ? "over 10 seconds" : "over 3 seconds",
    });
  }

  const movement = metrics?.movementActivity;
  if (movement != null && Number.isFinite(movement) && movement < 0.05) {
    out.push({
      key: "low_movement",
      severity: "watch",
      label: "Movement",
      reading: `${Math.round(movement * 100)}%`,
      note: "very little movement detected",
    });
  }

  // The freshest signal from either the camera metrics or the wearable. A
  // camera-only stream and a wearable-only stream both count as "the device".
  const seenAt: number[] = [];
  if (metrics?.lastSeen) {
    const t = Date.parse(metrics.lastSeen);
    if (Number.isFinite(t)) seenAt.push(t);
  }
  if (vitals?.receivedAt != null) {
    const t = Number(vitals.receivedAt);
    if (Number.isFinite(t)) seenAt.push(t);
  }
  if (seenAt.length) {
    const ageMs = Date.now() - Math.max(...seenAt);
    if (Number.isFinite(ageMs) && ageMs > 60_000) {
      const reading =
        ageMs < 3_600_000
          ? `${Math.max(1, Math.round(ageMs / 60_000))} min ago`
          : `${(ageMs / 3_600_000).toFixed(1)} h ago`;
      out.push({
        key: "signal_stale",
        severity: ageMs > 5 * 60_000 ? "critical" : "warning",
        label: "Signal",
        reading,
        note: "no fresh readings from the patient device",
      });
    }
  }

  if (vitals?.sosActive) {
    out.push({
      key: "sos",
      severity: "critical",
      label: "Wearable SOS",
      reading: "active",
      note: "the patient pressed SOS",
    });
  }
  const spo2 = vitals?.spo2;
  if (spo2 != null && Number.isFinite(spo2) && spo2 < 94) {
    out.push({
      key: "spo2",
      severity: spo2 < 90 ? "critical" : "warning",
      label: "SpO₂",
      reading: `${Math.round(spo2)}%`,
      note: spo2 < 90 ? "below 90%" : "below 94%",
    });
  }
  const hr = vitals?.heartRate;
  if (hr != null && Number.isFinite(hr) && (hr > 130 || hr < 45)) {
    out.push({
      key: "heart_rate",
      severity: hr > 150 || hr < 40 ? "critical" : "warning",
      label: "Heart rate",
      reading: `${Math.round(hr)} bpm`,
      note: hr > 130 ? "above 130 bpm" : "below 45 bpm",
    });
  }
  const temp = vitals?.temperature;
  if (temp != null && Number.isFinite(temp) && temp >= 38) {
    out.push({
      key: "temperature",
      severity: temp >= 39 ? "critical" : "warning",
      label: "Temperature",
      reading: `${temp.toFixed(1)} °C`,
      note: "at or above 38 °C",
    });
  }

  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

/** Coarse bucket so tiny sensor jitter still hits the answer cache. */
export function metricsBucket(m: PatientMetrics | null | undefined): string {
  if (!m) return "none";
  const r = (n: number | undefined, step: number) =>
    n == null || !Number.isFinite(n) ? "-" : String(Math.round(n / step) * step);
  return [
    r(m.alertnessScore, 5),
    r(m.blinkRate, 2),
    r((m.eyeClosureDuration ?? 0) / 1000, 2),
    r(m.movementActivity, 0.05),
  ].join("/");
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedAnswer {
  text: string;
  model: string;
  at: string;
}

function cacheKey(parts: Array<string | number | null | undefined>): string {
  return createHash("sha256").update(parts.map((p) => String(p ?? "")).join("\u0000")).digest("hex").slice(0, 40);
}

async function cacheGet(key: string): Promise<CachedAnswer | null> {
  try {
    const d = await getDriver();
    const hit = (await d.getDoc(K.aiCache(key))) as CachedAnswer | null;
    if (!hit) return null;
    if (Date.now() - Date.parse(hit.at) > CACHE_TTL_MS) return null;
    return hit;
  } catch {
    return null;
  }
}

async function cachePut(key: string, text: string, model: string): Promise<void> {
  try {
    const d = await getDriver();
    const value: CachedAnswer = { text, model, at: new Date().toISOString() };
    await d.setDoc(K.aiCache(key), value);
    await d.appendList(K.aiCacheIndex, key, 500);
  } catch {
    // Cache is an optimisation; never fail a request over it.
  }
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

const ANSWER_SYSTEM = `You are CareSpeak's nurse-portal assistant, speaking to a registered nurse who is monitoring a patient remotely.
Rules you must follow:
- Use ONLY the PATIENT, INSERTED RECORDS and LIVE SIGNALS sections below. Never invent a value, medication, diagnosis, allergy or history.
- If the answer is not in the supplied material, say plainly that it is not in the record and name what to check in person.
- You may report readings and whether they are outside the stated thresholds. Do not diagnose or prescribe.
- Respect the requested ANSWER LENGTH. Otherwise prefer short, spoken answers of 2-4 sentences (about 70 words).
- If a reading is critical, say what to check first.
- Never claim to be a clinician or to have examined the patient.`;

const ALERT_SYSTEM = `You write ONE spoken sentence for a nurse's phone, based only on the LIVE SIGNALS and patient record supplied.
Rules:
- Name the patient, state the LIVE SIGNAL readings that crossed their thresholds, and what to check first.
- Use the LIVE SIGNALS readings. Do not quote older observations unless a live reading is missing.
- Never invent a value, diagnosis or medication change.
- Maximum 45 words. Sound calm and direct. Say "Alert" at most once.`;

interface PatientFacts {
  recordText: string;
  omitted: number;
}

function relTime(iso?: string | null): string {
  if (!iso) return "at an unknown time";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "recently";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function listText(items: string[]): string {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The clinical facts, in prompt-ready form. `deep` keeps more of the
 * time-series and the encounter history; the normal form stays compact.
 */
function clinicalLines(patient: ClinicalPatient, deep: boolean): string[] {
  const activeConditions = patient.conditions.filter((c) => c.status === "active");
  const historicalConditions = patient.conditions.filter((c) => c.status !== "active");
  const activeMeds = patient.medications.filter((m) => m.status === "active");
  const stoppedMeds = patient.medications.filter((m) => m.status !== "active");
  const allergies = patient.allergies.map(
    (a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ""}${a.severity ? `, ${a.severity}` : ""}`
  );

  const byLabel = new Map<string, typeof patient.observations>();
  for (const o of patient.observations) {
    const arr = byLabel.get(o.label) ?? [];
    arr.push(o);
    byLabel.set(o.label, arr);
  }
  const obs: string[] = [];
  for (const [label, series] of byLabel) {
    const sorted = [...series].sort((a, b) => a.at.localeCompare(b.at));
    const shown = deep ? sorted.slice(-3) : sorted.slice(-1);
    obs.push(
      `${label} ${shown
        .map((o) => `${o.value}${o.unit ? ` ${o.unit}` : ""} (${o.at.slice(0, 10)})`)
        .join(" → ")}`
    );
  }

  const encounters = [...patient.encounters]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, deep ? 6 : 4)
    .map((e) => `${e.at.slice(0, 10)} ${e.kind}${e.by ? ` by ${e.by}` : ""}: ${e.summary}`);

  return [
    activeConditions.length
      ? `Active conditions: ${activeConditions
          .map((c) => `${c.name}${c.code ? ` (${c.code})` : ""}${c.since ? ` since ${c.since}` : ""}`)
          .join("; ")}`
      : "Active conditions: none recorded",
    historicalConditions.length
      ? `Past conditions: ${historicalConditions
          .map((c) => `${c.name} [${c.status}]${c.note ? ` — ${c.note}` : ""}`)
          .join("; ")}`
      : "",
    activeMeds.length
      ? `Active medications: ${activeMeds
          .map(
            (m) =>
              `${m.name}${m.dose ? ` ${m.dose}` : ""}${m.route ? ` ${m.route}` : ""}${m.frequency ? ` ${m.frequency}` : ""}`
          )
          .join("; ")}`
      : "Active medications: none recorded",
    stoppedMeds.length
      ? `Stopped medications: ${stoppedMeds
          .map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ""}${m.note ? ` — ${m.note}` : ""}`)
          .join("; ")}`
      : "",
    allergies.length ? `Allergies: ${allergies.join("; ")}` : "Allergies: none recorded",
    obs.length ? `Observations: ${obs.join("; ")}` : "Observations: none recorded",
    encounters.length ? `Encounters: ${encounters.join(" | ")}` : "",
    patient.carePlan ? `Care plan: ${patient.carePlan}` : "",
  ].filter(Boolean);
}

function structured(patient: ClinicalPatient): string {
  return [
    `Name: ${patient.displayName}${patient.age != null ? `, ${patient.age}` : ""}${patient.sex ? ` ${patient.sex}` : ""}`,
    patient.room ? `Location: ${patient.room}` : "",
    patient.primaryConcern ? `Primary concern: ${patient.primaryConcern}` : "",
    `Language: ${patient.language}`,
    ...clinicalLines(patient, false),
    patient.synthetic ? "Note: this is synthetic demo data, not a real patient." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A deterministic, record-grounded history answer. Used for deep history
 * questions when no model is available, and as the fallback when a model call
 * fails. It never adds facts the record does not contain.
 */
function historySummary(patient: ClinicalPatient, records: PatientRecord[], deep: boolean): string {
  const who = `${patient.displayName} is ${patient.age != null ? `${patient.age} years old` : "of unknown age"}${
    patient.sex ? `, ${patient.sex}` : ""
  }${patient.room ? `, in ${patient.room}` : ""}.`;
  const parts: string[] = [who];
  if (patient.primaryConcern) parts.push(`Reason for care: ${patient.primaryConcern}.`);
  parts.push(...clinicalLines(patient, true).map((line) => (line.endsWith(".") ? line : `${line}.`)));
  if (records.length) {
    parts.push(
      `Inserted records: ${records
        .slice(0, deep ? 6 : 3)
        .map((r) => `"${r.title}"${r.source ? ` (${r.source})` : ""}, ${r.createdAt.slice(0, 10)}`)
        .join("; ")}.`
    );
    if (deep) {
      for (const rec of records.slice(0, 3)) {
        const excerpt = rec.text.replace(/\s+/g, " ").trim().slice(0, 420);
        if (excerpt) parts.push(`${rec.title}: ${excerpt}`);
      }
    }
  }
  if (patient.synthetic) parts.push("This is synthetic demo data, not a real patient.");
  return parts.join(" ");
}

function signalBlock(findings: SignalFinding[], metrics: PatientMetrics | null | undefined): string {
  const lines: string[] = [];
  lines.push(`Alertness: ${metrics?.alertnessScore != null ? `${Math.round(metrics.alertnessScore)}%` : "no reading"}`);
  lines.push(`Blink rate: ${metrics?.blinkRate != null ? `${metrics.blinkRate.toFixed(1)}/min` : "no reading"}`);
  lines.push(
    `Eye closure: ${metrics?.eyeClosureDuration != null ? `${(metrics.eyeClosureDuration / 1000).toFixed(1)}s` : "no reading"}`
  );
  lines.push(
    `Movement: ${metrics?.movementActivity != null ? `${Math.round(metrics.movementActivity * 100)}%` : "no reading"}`
  );
  lines.push(`Last device reading: ${metrics?.lastSeen ? relTime(metrics.lastSeen) : "no reading yet"}`);
  if (findings.length) {
    lines.push(`Thresholds crossed: ${findings.map((f) => `${f.label} ${f.reading} (${f.note})`).join("; ")}`);
  } else {
    lines.push("Thresholds crossed: none");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

export interface PortalContext {
  sessionId: string;
  link: SessionPatientLink | null;
  patientId: string | null;
  patient: ClinicalPatient | null;
  records: Array<Pick<PatientRecord, "id" | "title" | "source" | "chars" | "createdAt">>;
  recordChars: number;
  metrics: PatientMetrics | null;
  vitals: DeviceVitals | null;
  findings: SignalFinding[];
  worst: Severity;
  engine: { gemini: boolean; model: string };
  patients: Array<{ id: string; displayName: string; room?: string; synthetic?: boolean }>;
  suggestedQuestions: string[];
}

function suggestionsFor(patient: ClinicalPatient | null, findings: SignalFinding[]): string[] {
  const name = patient?.displayName.split(" ")[0] ?? "the patient";
  const out: string[] = [];
  if (findings.length) out.push("Is this urgent? What should I check first?");
  if (patient) {
    out.push(`Give me ${name}'s full history`);
    out.push(`What medications is ${name} on?`);
    out.push(`Any allergies or safety concerns for ${name}?`);
    out.push("What changed since the last observation?");
    out.push("Summarise the inserted records");
    out.push("Draft an SBAR handoff");
  } else {
    out.push("What are the live readings?");
    out.push("Is anything urgent right now?");
    out.push("What should I check first?");
  }
  return [...new Set(out)].slice(0, 6);
}

export async function buildPortalContext(sessionId: string): Promise<PortalContext> {
  const store = await getSessionStore();
  const d = await getDriver();
  const [storedLink, session, metricsMap, vitalsMap, patients, unlinked] = await Promise.all([
    getSessionLink(sessionId).catch(() => null),
    getSessionLoose(sessionId).catch(() => null),
    store.getMetrics(sessionId).catch(() => ({})),
    store.getVitals(sessionId).catch(() => ({})),
    listPatients().catch(() => [] as ClinicalPatient[]),
    d.getDoc(K.sessionUnlinked(sessionId)).catch(() => null),
  ]);

  // A session is created for a specific patient. Use that patient until the
  // nurse explicitly re-links the session in the portal, so the assistant can
  // brief the caller immediately after the QR is scanned.
  let link: SessionPatientLink | null = storedLink;
  if (!unlinked && !link && session?.patientId) {
    link = {
      sessionId,
      patientId: session.patientId,
      linkedAt: session.createdAt,
      linkedBy: session.nurseName,
    };
  }
  // auto-link only to real (non-synthetic) patients; demo patients stay optional
  if (!unlinked && !link && !session) {
    const realPatients = patients.filter((p) => !p.synthetic);
    if (realPatients.length === 1) {
      link = {
        sessionId,
        patientId: realPatients[0].id,
        linkedAt: new Date().toISOString(),
        linkedBy: "auto",
      };
      void linkSessionToPatient(sessionId, realPatients[0].id, "auto").catch(() => undefined);
    }
  }

  const metrics = newestMetrics(metricsMap);
  const vitals = newestVitals(vitalsMap);
  const findings = analyzeSignals(metrics, vitals);
  const patient = link ? await getPatient(link.patientId) : null;
  const records = link ? await listRecords(link.patientId) : [];

  return {
    sessionId,
    link,
    patientId: link?.patientId ?? null,
    patient,
    records: records.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      chars: r.chars,
      createdAt: r.createdAt,
    })),
    recordChars: records.reduce((n, r) => n + r.chars, 0),
    metrics,
    vitals,
    findings,
    worst: worstSeverity(findings),
    engine: { gemini: geminiConfigured(), model: geminiModelLabel() },
    patients: patients.map((p) => ({ id: p.id, displayName: p.displayName, room: p.room, synthetic: p.synthetic })),
    suggestedQuestions: suggestionsFor(patient, findings),
  };
}

export async function linkPortalSession(
  sessionId: string,
  patientId: string,
  linkedBy?: string
): Promise<SessionPatientLink | null> {
  const patient = await getPatient(patientId);
  if (!patient) return null;
  return linkSessionToPatient(sessionId, patientId, linkedBy);
}

export async function unlinkPortalSession(sessionId: string): Promise<void> {
  await unlinkSessionPatient(sessionId);
}

// ---------------------------------------------------------------------------
// SBAR handoff
// ---------------------------------------------------------------------------

export type PortalDetail = "brief" | "standard" | "deep";

export interface PortalChatTurn {
  role: "nurse" | "assistant";
  text: string;
}

export interface PortalSbar {
  sessionId: string;
  patientId: string;
  patientName: string;
  generatedAt: string;
  synthetic: boolean;
  situation: string;
  background: string;
  assessment: string;
  recommendation: string;
  text: string;
}

function sbarRecommendations(ctx: PortalContext): string[] {
  const has = (key: string) => ctx.findings.some((f) => f.key === key);
  const out: string[] = [];
  if (has("sos")) out.push("Acknowledge the wearable SOS immediately and confirm the patient is safe.");
  if (has("signal_stale"))
    out.push("Check that the patient device is powered, connected and streaming, then verify the patient by phone or in person.");
  if (has("low_alertness") || has("eye_closure"))
    out.push(
      "Reassess alertness and airway safety, check for hypoxia, sedation or another reversible cause, and escalate to the clinical team if it does not improve."
    );
  if (has("low_blink"))
    out.push("Repeat the blink reading while the patient is awake and facing the camera, and confirm the finding with the clinical team.");
  if (has("low_movement"))
    out.push("Check whether the patient is resting, uncomfortable or unable to move, then review positioning and comfort.");
  if (has("spo2")) out.push("Repeat the oxygen saturation with a well-positioned probe and follow the local oxygen-escalation protocol.");
  if (has("heart_rate"))
    out.push("Repeat the heart rate, check for pain, fever or dehydration, and escalate if it stays outside the threshold.");
  if (has("temperature")) out.push("Confirm the temperature with a second measurement and screen for infection.");
  if (!out.length)
    out.push("Continue routine monitoring, repeat readings as scheduled and review the care plan at the next contact.");
  return out;
}

/**
 * Deterministic SBAR handoff built only from the stored record and live signal
 * state. No model call, no invented diagnosis: Assessment is a threshold
 * summary and Recommendation is a conservative checklist.
 */
export function buildSbar(ctx: PortalContext, records: PatientRecord[] = []): PortalSbar | null {
  const patient = ctx.patient;
  if (!patient) return null;

  const who = `${patient.displayName}${patient.age != null ? `, ${patient.age}` : ""}${
    patient.sex ? ` ${patient.sex}` : ""
  }${patient.room ? `, ${patient.room}` : ""}`;
  const findingsText = ctx.findings.length
    ? `Live alerts: ${ctx.findings.map((f) => `${f.label} ${f.reading} (${f.note})`).join("; ")}.`
    : "No live threshold breaches.";
  const lastSeen = ctx.metrics?.lastSeen
    ? `The last device reading was ${relTime(ctx.metrics.lastSeen)}.`
    : "No device reading has arrived yet.";
  const situation = [
    `Situation: ${who}.`,
    patient.primaryConcern ? `Primary concern: ${patient.primaryConcern}.` : "No primary concern recorded.",
    `CareSpeak session ${ctx.sessionId}.`,
    findingsText,
    lastSeen,
  ].join(" ");

  const activeConditions = patient.conditions
    .filter((c) => c.status === "active")
    .map((c) => `${c.name}${c.code ? ` (${c.code})` : ""}`);
  const pastConditions = patient.conditions
    .filter((c) => c.status !== "active")
    .map((c) => `${c.name} [${c.status}]`);
  const activeMeds = patient.medications
    .filter((m) => m.status === "active")
    .map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ""}${m.frequency ? ` ${m.frequency}` : ""}`);
  const allergies = patient.allergies.map((a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ""}`);
  const recentEncounters = [...patient.encounters]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 3)
    .map((e) => `${e.at.slice(0, 10)} ${e.kind}: ${e.summary}`);
  const recordTitles = records
    .slice(0, 6)
    .map((r) => `"${r.title}"${r.source ? ` (${r.source})` : ""}, ${r.createdAt.slice(0, 10)}`);

  const background = [
    `Background: ${activeConditions.length ? `Active conditions: ${activeConditions.join("; ")}.` : "No active conditions recorded."}`,
    pastConditions.length ? `Past history: ${pastConditions.join("; ")}.` : "",
    activeMeds.length ? `Medications: ${activeMeds.join("; ")}.` : "No active medications recorded.",
    allergies.length ? `Allergies: ${allergies.join("; ")}.` : "No recorded allergies.",
    patient.carePlan ? `Care plan: ${patient.carePlan}.` : "",
    recentEncounters.length ? `Recent contact: ${recentEncounters.join(" | ")}.` : "",
    recordTitles.length ? `Inserted records: ${recordTitles.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const byLabel = new Map<string, typeof patient.observations>();
  for (const o of patient.observations) {
    const arr = byLabel.get(o.label) ?? [];
    arr.push(o);
    byLabel.set(o.label, arr);
  }
  const trends: string[] = [];
  for (const [label, series] of byLabel) {
    const sorted = [...series].sort((a, b) => a.at.localeCompare(b.at));
    const latest = sorted[sorted.length - 1];
    const previous = sorted[sorted.length - 2];
    if (
      latest &&
      previous &&
      typeof latest.value === "number" &&
      typeof previous.value === "number" &&
      latest.value !== previous.value
    ) {
      trends.push(`${label} ${previous.value} → ${latest.value}${latest.unit ? ` ${latest.unit}` : ""}`);
    } else if (latest) {
      trends.push(`${label} ${latest.value}${latest.unit ? ` ${latest.unit}` : ""}`);
    }
  }
  const liveReadings: string[] = [];
  if (ctx.metrics?.alertnessScore != null) liveReadings.push(`alertness ${Math.round(ctx.metrics.alertnessScore)}%`);
  if (ctx.metrics?.blinkRate != null) liveReadings.push(`blink rate ${ctx.metrics.blinkRate.toFixed(1)}/min`);
  if (ctx.metrics?.eyeClosureDuration != null)
    liveReadings.push(`eye closure ${(ctx.metrics.eyeClosureDuration / 1000).toFixed(1)} s`);
  if (ctx.metrics?.movementActivity != null)
    liveReadings.push(`movement ${Math.round(ctx.metrics.movementActivity * 100)}%`);
  if (ctx.vitals?.spo2 != null) liveReadings.push(`SpO₂ ${Math.round(ctx.vitals.spo2)}%`);
  if (ctx.vitals?.heartRate != null) liveReadings.push(`heart rate ${Math.round(ctx.vitals.heartRate)} bpm`);
  if (ctx.vitals?.temperature != null) liveReadings.push(`temperature ${ctx.vitals.temperature.toFixed(1)} °C`);

  const assessment = [
    `Assessment: ${liveReadings.length ? `Live readings are ${liveReadings.join(", ")}.` : "No live readings are available."}`,
    findingsText,
    trends.length ? `Recorded trends: ${trends.slice(0, 6).join("; ")}.` : "",
    "This is a threshold summary, not a diagnosis.",
  ]
    .filter(Boolean)
    .join(" ");

  const recommendation = `Recommendation: ${sbarRecommendations(ctx).join(" ")}`;

  const text = [
    `SBAR handoff — ${patient.displayName}${patient.synthetic ? " (synthetic demo data)" : ""}`,
    situation,
    background,
    assessment,
    recommendation,
  ].join("\n\n");

  return {
    sessionId: ctx.sessionId,
    patientId: patient.id,
    patientName: patient.displayName,
    generatedAt: new Date().toISOString(),
    synthetic: patient.synthetic,
    situation,
    background,
    assessment,
    recommendation,
    text,
  };
}

export async function sbarPortal(sessionId: string): Promise<PortalSbar | null> {
  const ctx = await buildPortalContext(sessionId);
  if (!ctx.patient) return null;
  const records = await listRecords(ctx.patient.id);
  return buildSbar(ctx, records);
}

// ---------------------------------------------------------------------------
// answering
// ---------------------------------------------------------------------------

export type Engine = "gemini" | "rules";

/** An action the portal/voice agent can carry out on the nurse's behalf. */
export type PortalAction = AssistantAction;

export interface PortalAnswer {
  answer: string;
  engine: Engine;
  model: string;
  cached: boolean;
  intent?: string;
  /** Present when the request was a dictation ("send a message to ..."). */
  action?: PortalAction | null;
  /** Suggested next questions, grounded in the current patient and readings. */
  followUps?: string[];
}

/**
 * Parses a dictation for the one patient linked to this session.
 *
 * The portal is always scoped to a single patient, so the recipient can be the
 * name, the first name, "the patient", or omitted entirely. Returns null when
 * the text is not a dictation ("tell me about ..." stays a question).
 */
export function parsePortalDictation(
  question: string,
  patient: ClinicalPatient
): { text: string } | null {
  const m = question.match(
    /^\s*(?:please\s+)?(?:can you\s+)?(?:send|message|text|tell|dictate)\b([\s\S]*)$/i
  );
  if (!m) return null;

  let rest = m[1].trim();
  // "tell me / tell us ..." is a question, never a dictation.
  if (/^(?:me|us)\b/i.test(rest)) return null;

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [patient.displayName, patient.displayName.split(" ")[0]]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  rest = rest.replace(/^\s*(?:a\s+)?(?:message|note|text)\s+to\s+/i, ""); // "a message to X"
  rest = rest.replace(/^\s*(?:to|the patient|them|him|her|patient)\b/i, ""); // recipient
  for (const name of names) {
    rest = rest.replace(new RegExp(`^\\s*${esc(name)}\\b`, "i"), "");
  }
  rest = rest.replace(/^\s*(?:a\s+)?(?:message|note|text)\b/i, ""); // "a message"
  rest = rest.replace(/^\s*(?:saying|that|to say|to|says|tell them|:|-|,)\s*/i, ""); // connector
  rest = rest.replace(/^["']|["']$/g, "").trim();

  if (!rest) return null;
  return { text: rest.slice(0, 2000) };
}

/**
 * Executes a portal action for real. Currently the only action is sending a
 * message to the patient; it is persisted (so it shows on the patient screen)
 * and audited, exactly like a message the nurse sends from the console.
 */
export async function executePortalAction(
  action: PortalAction,
  actor?: { role?: string; userId?: string; displayName?: string } | null
): Promise<{ messageId: string } | null> {
  if (action.type !== "send_message") return null;
  const patient = await getPatient(action.patientId);
  const message = await addMessage({
    patientId: action.patientId,
    patientName: patient?.displayName || action.patientName || "Patient",
    text: action.text,
    createdBy: actor?.displayName || "CareSpeak voice agent",
  });
  await appendAudit({
    actorRole: actor?.role ?? "system",
    actorId: actor?.userId,
    action: "care.message_sent",
    patientId: action.patientId,
    detail: { messageId: message.id, via: "voice-assistant", chars: action.text.length },
  });
  return { messageId: message.id };
}

function assistantContextFor(patient: ClinicalPatient): AssistantContext {
  const ctx: PatientContext = {
    patient,
    lastSession: null,
    lastTranscript: [],
    lastReport: null,
    openTasks: [],
    messages: [],
  };
  return { patients: [ctx], focused: ctx };
}

/** Structured intents the deterministic engine answers exactly and for free.
 *
 *  Note: `overview` is deliberately NOT here. `answerQuestion` returns
 *  `overview` as its catch-all for any question it does not recognise, so
 *  treating it as a structured intent made every free-form question bypass
 *  Gemini. Overview/history questions instead go to Gemini (which also sees the
 *  inserted free-text records), with the deterministic overview as the fallback.
 */
const STRUCTURED_INTENTS = new Set([
  "medications",
  "allergies",
  "observations",
  "conditions",
  "care_plan",
]);

function rulesAnswer(question: string, patient: ClinicalPatient): { text: string; intent: string } | null {
  const result = answerQuestion(question, assistantContextFor(patient));
  if (!STRUCTURED_INTENTS.has(result.intent)) return null;
  return { text: result.answer, intent: result.intent };
}

/** Very small keyword search over the inserted free-text records. */
function searchRecords(question: string, records: PatientRecord[]): PatientRecord[] {
  const stop = new Set(
    "the a an and or of to in on for with what which who when where how is are was were do does did has have had patient record records show tell about please any".split(
      " "
    )
  );
  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  if (!terms.length) return [];
  return records.filter((r) => {
    const hay = `${r.title} ${r.source ?? ""} ${r.text}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

export async function askPortal(
  sessionId: string,
  rawQuestion: string,
  opts: { voice?: boolean; detail?: PortalDetail; history?: Array<{ role?: string; text?: string }> } = {}
): Promise<PortalAnswer & { patientId: string | null }> {
  const detail: PortalDetail =
    opts.detail === "brief" || opts.detail === "deep" ? opts.detail : "standard";
  const history: PortalChatTurn[] = (opts.history ?? [])
    .filter((t): t is { role?: string; text?: string } => Boolean(t) && typeof t.text === "string")
    .map((t) => ({
      role: (t.role === "assistant" ? "assistant" : "nurse") as "assistant" | "nurse",
      text: String(t.text).trim().slice(0, 600),
    }))
    .filter((t) => t.text.length > 0)
    .slice(-8);

  const question = rawQuestion.trim().slice(0, 1000);
  const ctx = await buildPortalContext(sessionId);
  const followUps = suggestionsFor(ctx.patient, ctx.findings).slice(0, 3);

  const finish = (
    answer: string,
    engine: Engine,
    model: string,
    cached: boolean,
    intent?: string,
    action?: PortalAction | null
  ): PortalAnswer & { patientId: string | null } => ({
    answer,
    engine,
    model,
    cached,
    intent,
    action: action ?? null,
    followUps,
    patientId: ctx.patient?.id ?? null,
  });

  if (!ctx.patient) {
    const liveParts: string[] = [];
    if (ctx.metrics?.alertnessScore != null) liveParts.push(`alertness ${Math.round(ctx.metrics.alertnessScore)}%`);
    if (ctx.metrics?.blinkRate != null) liveParts.push(`blink rate ${ctx.metrics.blinkRate.toFixed(1)} per minute`);
    if (ctx.metrics?.eyeClosureDuration != null) liveParts.push(`eye closure ${(ctx.metrics.eyeClosureDuration / 1000).toFixed(1)} seconds`);
    if (ctx.metrics?.movementActivity != null) liveParts.push(`movement ${Math.round(ctx.metrics.movementActivity * 100)}%`);
    const live = liveParts.length
      ? `Live readings: ${liveParts.join(", ")}.`
      : "No live readings are arriving from this session yet.";
    const liveStatus = ctx.findings.length
      ? `${live} Outside the thresholds: ${ctx.findings.map((f) => `${f.label} ${f.reading}`).join(", ")}.`
      : liveParts.length
        ? `${live} All monitored readings are inside their thresholds.`
        : live;
    if (!question) {
      return finish(liveStatus, "rules", "rules", false);
    }
    const q = question.toLowerCase();
    if (/blink|alertness|closure|movement|reading|vital|status|how is|how are/.test(q)) {
      return finish(liveStatus, "rules", "rules", false);
    }
    return finish(
      `No patient is linked to this session yet, so I can only report the live readings: ${live} Link a patient in the nurse portal (or on this page) to use their history and records.`,
      "rules",
      "rules",
      false
    );
  }

  if (!question) {
    return finish(
      ctx.findings.length
        ? `Watching ${ctx.patient.displayName}. ${ctx.findings.map((f) => `${f.label} ${f.reading}`).join(", ")}.`
        : `Watching ${ctx.patient.displayName}. All monitored readings are inside their thresholds right now.`,
      "rules",
      "rules",
      false
    );
  }

  const patient = ctx.patient;

  // Dictation has a side effect (a real message), so it is handled before the
  // answer cache and is never cached. The route/voice webhook executes it.
  const dictation = parsePortalDictation(question, patient);
  if (dictation) {
    return {
      answer: `I'll send that to ${patient.displayName}: "${dictation.text}". It will appear on their screen.`,
      engine: "rules",
      model: "rules",
      cached: false,
      intent: "send_message",
      action: {
        type: "send_message",
        patientId: patient.id,
        patientName: patient.displayName,
        text: dictation.text,
      },
      followUps,
      patientId: patient.id,
    };
  }

  const records = await listRecords(patient.id);

  const historyQ = isHistoryQuestion(question);

  const key = cacheKey([
    "answer",
    patient.id,
    detail,
    question.toLowerCase(),
    history.length ? historySignature(history) : "",
    records.map((r) => `${r.id}:${r.chars}`).join(","),
    metricsBucket(ctx.metrics),
    ctx.findings.map((f) => f.key).join(","),
  ]);

  const cached = await cacheGet(key);
  if (cached) {
    return {
      answer: cached.text,
      engine: "gemini",
      model: cached.model,
      cached: true,
      followUps,
      patientId: patient.id,
    };
  }

  // 1. Exact structured answers first — free and never wrong. History
  //    questions skip this so they can use the richer history summary.
  const exact = historyQ ? null : rulesAnswer(question, patient);
  if (exact) {
    await cachePut(key, exact.text, "rules");
    return {
      answer: exact.text,
      engine: "rules",
      model: "rules",
      cached: false,
      intent: exact.intent,
      followUps,
      patientId: patient.id,
    };
  }

  // 2. Gemini for everything else, grounded on the same material. Conversation
  //    history is included so follow-up questions ("and her allergies?") work.
  if (geminiConfigured()) {
    const recordBlock = await buildRecordContext(patient.id);
    const matched = searchRecords(question, records);
    const matchedText = matched
      .slice(0, 3)
      .map((r) => `### ${r.title}${r.source ? ` (${r.source})` : ""}\n${r.text.slice(0, 4000)}`)
      .join("\n\n");

    const conversationBlock =
      history.length > 0
        ? `CONVERSATION SO FAR\n${history
            .map((t) => `${t.role === "assistant" ? "Assistant" : "Nurse"}: ${t.text}`)
            .join("\n")}`
        : "";

    const depthLine =
      detail === "brief"
        ? "ANSWER LENGTH\nTwo sentences maximum. Lead with the direct answer."
        : detail === "deep"
          ? "ANSWER LENGTH\nBe thorough: 5-8 sentences. Use the relevant history, the most recent observations, inserted records and current live signals. Say which record you relied on. End with what the nurse should check or do next."
          : opts.voice
            ? "ANSWER LENGTH\n2-3 short sentences for speech."
            : "ANSWER LENGTH\n3-5 sentences.";

    const prompt = [
      `PATIENT\n${structured(patient)}`,
      `INSERTED RECORDS${recordBlock.omitted ? ` (${recordBlock.omitted} older record(s) omitted for length)` : ""}\n${
        recordBlock.text || "none inserted yet"
      }`,
      matchedText ? `MOST RELEVANT RECORD EXCERPTS\n${matchedText}` : "",
      `LIVE SIGNALS\n${signalBlock(ctx.findings, ctx.metrics)}`,
      conversationBlock,
      depthLine,
      opts.voice && detail !== "deep" ? "MODE\nYou are speaking this answer aloud on the phone. Keep it concise." : "",
      `QUESTION\n${question}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await geminiGenerate({
      system: ANSWER_SYSTEM,
      prompt,
      maxTokens: detail === "deep" ? 800 : opts.voice ? 260 : detail === "brief" ? 180 : 420,
      temperature: 0.2,
    });
    if (result) {
      await cachePut(key, result.text, result.model);
      return {
        answer: result.text,
        engine: "gemini",
        model: result.model,
        cached: false,
        intent: historyQ ? "history" : undefined,
        followUps,
        patientId: patient.id,
      };
    }
  }

  // 3. Honest local fallback. History questions get the full record-grounded
  //    summary; otherwise report what the record and signals actually say.
  if (historyQ) {
    const answer = historySummary(patient, records, detail === "deep");
    await cachePut(key, answer, "rules");
    return {
      answer,
      engine: "rules",
      model: "rules",
      cached: false,
      intent: "history",
      followUps,
      patientId: patient.id,
    };
  }

  const parts: string[] = [];
  if (ctx.findings.length) {
    parts.push(
      `Live readings outside thresholds: ${ctx.findings
        .map((f) => `${f.label} ${f.reading} (${f.note})`)
        .join("; ")}.`
    );
  } else {
    parts.push("All monitored readings are inside their thresholds right now.");
  }
  const hits = searchRecords(question, records);
  if (hits.length) {
    parts.push(
      `The inserted records that mention this are: ${hits
        .slice(0, 2)
        .map((r) => `"${r.title}" (${r.createdAt.slice(0, 10)})`)
        .join(" and ")}.`
    );
  } else {
    parts.push("I could not match that to an inserted document.");
    const overview = answerQuestion(question, assistantContextFor(patient));
    if (overview.intent === "overview" && overview.answer) parts.push(overview.answer);
  }
  parts.push("Check the chart in person, or add the missing document on the Patient records page.");
  const answer = parts.join(" ");
  await cachePut(key, answer, "rules");
  return {
    answer,
    engine: "rules",
    model: "rules",
    cached: false,
    followUps,
    patientId: patient.id,
  };
}

function isHistoryQuestion(question: string): boolean {
  return /\b(history|background|summar(?:y|ise|ize)|overview|everything|profile|past|previous|records?)\b/i.test(question) &&
    !/last\s+(call|session|conversation)\b/i.test(question);
}

function historySignature(history: PortalChatTurn[]): string {
  return createHash("sha256")
    .update(history.map((t) => `${t.role}:${t.text}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// spoken alerts + briefing
// ---------------------------------------------------------------------------

export interface PortalAlert {
  line: string;
  severity: Severity;
  engine: Engine;
  model: string;
  cached: boolean;
  findings: SignalFinding[];
}

/** Best-effort conversion of a "Signal" reading back into seconds. */
function staleSeconds(reading: string): number | null {
  const h = reading.match(/([\d.]+)\s*h/);
  if (h) {
    const n = Number(h[1]);
    return Number.isFinite(n) ? Math.round(n * 3600) : null;
  }
  const m = reading.match(/([\d.]+)\s*min/);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? Math.round(n * 60) : null;
  }
  const s = reading.match(/([\d.]+)\s*s/);
  if (s) {
    const n = Number(s[1]);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

/** Deterministic one-liner used when Gemini is unavailable. */
export function rulesAlertLine(patient: ClinicalPatient | null, findings: SignalFinding[]): string {
  if (!findings.length) return "";
  const who = patient ? patient.displayName : "The patient";
  const worst = findings[0];
  if (worst.key === "signal_stale") {
    const seconds = staleSeconds(worst.reading);
    const duration =
      seconds != null && seconds > 0
        ? seconds >= 120
          ? `${Math.round(seconds / 60)} minutes`
          : `${seconds} seconds`
        : worst.reading;
    return `No fresh device readings for ${duration}. Please check the patient's device and the patient now.`;
  }
  const rest = findings.slice(1, 3).map((f) => `${f.label.toLowerCase()} ${f.reading}`);
  const tail = rest.length ? `, with ${rest.join(" and ")}` : "";
  return `${who}: ${worst.label.toLowerCase()} is ${worst.reading}, ${worst.note}${tail}. Please assess ${patient ? patient.displayName.split(" ")[0] : "them"} now.`;
}

/**
 * Returns a spoken alert for the current signal state, or an empty line when
 * every reading is inside its threshold. Cached per signal state.
 */
export async function alertPortal(
  sessionId: string,
  opts: { force?: boolean } = {}
): Promise<PortalAlert> {
  const ctx = await buildPortalContext(sessionId);
  if (!ctx.findings.length) {
    return { line: "", severity: "ok", engine: "rules", model: "rules", cached: false, findings: [] };
  }

  const key = cacheKey([
    "alert",
    ctx.patientId,
    ctx.findings
      .map((f) => {
        if (f.key === "signal_stale") {
          const seconds = staleSeconds(f.reading);
          const minutes = seconds != null && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0;
          return `${f.key}:${minutes}m`;
        }
        return `${f.key}:${f.reading}`;
      })
      .join("|"),
    metricsBucket(ctx.metrics),
  ]);

  if (!opts.force) {
    const hit = await cacheGet(key);
    if (hit) {
      return { line: hit.text, severity: ctx.worst, engine: "gemini", model: hit.model, cached: true, findings: ctx.findings };
    }
  }

  if (geminiConfigured() && ctx.patient) {
    const prompt = [
      `PATIENT\n${structured(ctx.patient)}`,
      `LIVE SIGNALS\n${signalBlock(ctx.findings, ctx.metrics)}`,
      `TASK\nWrite one spoken sentence for the nurse about ${ctx.patient.displayName}.`,
    ].join("\n\n");
    const result = await geminiGenerate({ system: ALERT_SYSTEM, prompt, maxTokens: 140, temperature: 0.2 });
    if (result) {
      await cachePut(key, result.text, result.model);
      return { line: result.text, severity: ctx.worst, engine: "gemini", model: result.model, cached: false, findings: ctx.findings };
    }
  }

  const line = rulesAlertLine(ctx.patient, ctx.findings);
  await cachePut(key, line, "rules");
  return { line, severity: ctx.worst, engine: "rules", model: "rules", cached: false, findings: ctx.findings };
}

/** The line spoken when the portal opens, before the nurse asks anything. */
export async function portalBriefing(sessionId: string): Promise<{ line: string; engine: Engine; model: string }> {
  const ctx = await buildPortalContext(sessionId);
  if (!ctx.patient) {
    const liveParts: string[] = [];
    if (ctx.metrics?.alertnessScore != null) liveParts.push(`alertness ${Math.round(ctx.metrics.alertnessScore)}%`);
    if (ctx.metrics?.blinkRate != null) liveParts.push(`blink rate ${ctx.metrics.blinkRate.toFixed(1)} per minute`);
    if (ctx.metrics?.eyeClosureDuration != null) liveParts.push(`eye closure ${(ctx.metrics.eyeClosureDuration / 1000).toFixed(1)} seconds`);
    if (ctx.metrics?.movementActivity != null) liveParts.push(`movement ${Math.round(ctx.metrics.movementActivity * 100)}%`);
    const live = liveParts.length
      ? `Live readings right now: ${liveParts.join(", ")}.`
      : "No live readings yet from this session. Make sure the patient device is streaming.";
    if (ctx.findings.length) {
      return {
        line: `${live} ${rulesAlertLine(null, ctx.findings)}`,
        engine: "rules",
        model: "rules",
      };
    }
    if (!liveParts.length) {
      return { line: live, engine: "rules", model: "rules" };
    }
    return {
      line: `${live} All monitored readings are inside their thresholds. Link a patient in the portal to add their history.`,
      engine: "rules",
      model: "rules",
    };
  }

  const base = ctx.findings.length
    ? rulesAlertLine(ctx.patient, ctx.findings)
    : `Monitoring ${ctx.patient.displayName}. ${ctx.patient.primaryConcern ?? "No primary concern recorded."} All monitored readings are inside their thresholds.`;

  if (!geminiConfigured()) return { line: base, engine: "rules", model: "rules" };

  const key = cacheKey(["brief", ctx.patientId, metricsBucket(ctx.metrics), ctx.findings.map((f) => f.key).join(",")]);
  const hit = await cacheGet(key);
  if (hit) return { line: hit.text, engine: "gemini", model: hit.model };

  const prompt = [
    `PATIENT\n${structured(ctx.patient)}`,
    `LIVE SIGNALS\n${signalBlock(ctx.findings, ctx.metrics)}`,
    `TASK\nGive the nurse a two-sentence orientation: who this is, their main concern, and whether anything needs attention right now.`,
  ].join("\n\n");
  const result = await geminiGenerate({ system: ANSWER_SYSTEM, prompt, maxTokens: 200, temperature: 0.2 });
  if (result) {
    await cachePut(key, result.text, result.model);
    return { line: result.text, engine: "gemini", model: result.model };
  }
  return { line: base, engine: "rules", model: "rules" };
}

/**
 * The full situation the agent speaks the moment the phone is answered: who the
 * patient is, why they are being monitored, and every live reading that has left
 * its threshold. Deterministic — the call never waits on a model to start.
 */
export function voiceOpening(ctx: PortalContext): string {
  if (!ctx.patient) {
    return "CareSpeak agent here. No patient is linked to this session yet. Link a patient in the nurse portal, then ask me about their history and live readings.";
  }
  const p = ctx.patient;
  const parts = [`CareSpeak alert line. This is about ${p.displayName}${p.room ? `, ${p.room}` : ""}.`];
  if (p.primaryConcern) parts.push(`Reason for care: ${p.primaryConcern}.`);
  if (ctx.findings.length) {
    parts.push(
      `Live readings that need attention: ${ctx.findings
        .map((f) => `${f.label} ${f.reading}, ${f.note}`)
        .join("; ")}.`
    );
  } else {
    parts.push("All monitored readings are currently inside their thresholds.");
  }
  parts.push(
    "You can ask me about the patient's history, medications, allergies or records, or tell me a message to send them."
  );
  return parts.join(" ");
}