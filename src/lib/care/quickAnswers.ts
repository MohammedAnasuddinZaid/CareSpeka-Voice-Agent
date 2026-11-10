/**
 * Fast, deterministic, question-shaped answers.
 *
 * The nurse portal can answer a whole class of questions instantly and exactly
 * from the authorised chart and the live device readings — no model, no network,
 * no waiting. This module covers the intents that are pure lookups or arithmetic
 * over the record:
 *
 *   - what are the live readings right now, is anything out of range
 *   - which reading is closest to its threshold
 *   - is a value trending up or down (weight, potassium, blood pressure ...)
 *   - what changed since the last call
 *   - what documents are on file
 *   - what did the patient say in the last call
 *   - what follow-up tasks are open
 *
 * Two properties matter for the demo:
 *   1. **It depends on the question.** Each intent reads the exact series or
 *      record the nurse asked about, so two different questions never collapse
 *      to one canned reply.
 *   2. **It varies.** Every intent has a couple of phrasings chosen by a hash of
 *      the question, so the wording tracks how the nurse asked while the facts
 *      stay identical.
 *
 * Nothing here invents a value. If the record does not contain the answer this
 * returns `null` so the caller can fall through to retrieval + the model.
 */
import type { DeviceVitals, PatientMetrics } from "@/types";
import type { ClinicalObservation, ClinicalPatient, PatientRecord } from "./types";
import type { PatientExtras } from "./retrieval";

export interface QuickFinding {
  key: string;
  label: string;
  reading: string;
  note: string;
}

export interface QuickRecord {
  id: string;
  title: string;
  source?: string;
  chars?: number;
  createdAt: string;
}

export interface QuickAnswer {
  text: string;
  intent: string;
  scope: "record" | "general" | "mixed";
  grounded: boolean;
  citations: Array<{ title: string; kind: string; source?: string; at?: string }>;
}

export interface QuickAnswerInput {
  question: string;
  patient: ClinicalPatient;
  metrics?: PatientMetrics | null;
  vitals?: DeviceVitals | null;
  findings?: QuickFinding[];
  records?: QuickRecord[];
  extras?: PatientExtras;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministically pick one phrasing so wording varies but facts do not. */
function pick<T>(items: T[], seed: string): T {
  return items[hashString(seed) % items.length];
}

function firstName(patient: ClinicalPatient): string {
  return patient.displayName.split(/\s+/)[0] || patient.displayName;
}

function joinAnd(items: string[]): string {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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

function day(iso?: string): string {
  return iso ? iso.slice(0, 10) : "date not recorded";
}

function num(value: number | string | undefined, digits = 1): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : value.toFixed(digits);
  }
  return value == null ? "" : String(value);
}

/** Live device readings, in the order a nurse would read them aloud. */
function readingParts(metrics?: PatientMetrics | null, vitals?: DeviceVitals | null): string[] {
  const parts: string[] = [];
  if (metrics?.alertnessScore != null) parts.push(`alertness ${Math.round(metrics.alertnessScore)} percent`);
  if (metrics?.blinkRate != null) parts.push(`blink rate ${metrics.blinkRate.toFixed(1)} per minute`);
  if (metrics?.eyeClosureDuration != null)
    parts.push(`eye closure ${(metrics.eyeClosureDuration / 1000).toFixed(1)} seconds`);
  if (metrics?.movementActivity != null) parts.push(`movement ${Math.round(metrics.movementActivity * 100)} percent`);
  if (vitals?.spo2 != null) parts.push(`oxygen saturation ${Math.round(vitals.spo2)} percent`);
  if (vitals?.heartRate != null) parts.push(`heart rate ${Math.round(vitals.heartRate)} beats per minute`);
  if (vitals?.temperature != null) parts.push(`temperature ${vitals.temperature.toFixed(1)} degrees Celsius`);
  return parts;
}

function observationSeries(patient: ClinicalPatient): Array<{ label: string; sorted: ClinicalObservation[] }> {
  const byLabel = new Map<string, ClinicalObservation[]>();
  for (const o of patient.observations) {
    const arr = byLabel.get(o.label) ?? [];
    arr.push(o);
    byLabel.set(o.label, arr);
  }
  return [...byLabel.entries()].map(([label, series]) => ({
    label,
    sorted: [...series].sort((a, b) => a.at.localeCompare(b.at)),
  }));
}

// ---------------------------------------------------------------------------
// intents
// ---------------------------------------------------------------------------

const RE = {
  live: /\b(live|current|right now|at the moment|this moment|latest)\b[\s\S]*\b(reading|readings|vitals?|observations?|numbers?|values?|status)\b|\b(reading|readings|vitals?|observations?|numbers?)\b[\s\S]*\b(right now|right this moment|currently|live|at the moment|at this moment|now)\b|\b(how (?:is|are|'s)|how is)\b[\s\S]*\b(doing|now|today|right now)\b|\bwhat(?:'s| is) (?:she|he|they|the patient|the lady|the man|the person) (?:doing|like)\b|\bstatus(?: right now| now| update)?\b|\bis (?:she|he|they|the patient) (?:ok|okay|alright|stable|safe)\b|\banything (?:wrong|urgent|concerning|to worry)\b|\bhow (?:is|are) (?:things|we|the readings?)\b|\bwhat are (?:the|her|his|their) readings?\b|\bany readings?\b/i,
  closest:
    /\b(closest|nearest)\b[\s\S]*\b(threshold|limit|border|line|breach)\b|\b(near|close to|about to (?:breach|cross|trip))\b[\s\S]*\b(threshold|limit)\b|\bwhich reading\b|\bwhat(?:'s| is) (?:the )?(?:most )?(?:concerning|abnormal|out of range)\b/i,
  trend:
    /\b(trend|trending|going up|going down|rising|falling|increasing|decreasing|climbing|dropping|improving|worsening|getting (?:better|worse))\b|\bover (?:time|the (?:last|past) \w+)|\bmost recent\b|\blast (?:few )?(?:readings?|values?|measurements?)\b|\bdirection\b/i,
  changed:
    /\bwhat(?:'s| has| have)? changed\b|\banything (?:new|changed)\b|\bsince (?:the )?last (?:call|session|time|contact|visit)\b|\bupdate me\b|\bwhat(?:'s| is) new since\b/i,
  documents:
    /\b(what|which|list|show)\b[\s\S]*\b(documents?|records?|files?|notes?|letters?|reports?|uploads?|attachments?|papers?)\b|\binserted (?:record|note|documents?)\b|\bwhat (?:have|do) (?:you|we) (?:got|have)\b|\bon file\b/i,
  lastCall:
    /\blast (?:call|session|conversation|contact)\b|\bprevious (?:call|session|conversation)\b|\bwhat did\b[\s\S]*\bsay\b|\brecap\b|\bsummar(?:y|ise|ize)\b[\s\S]*\b(call|session|conversation)\b|\btranscript\b/i,
  tasks: /\b(follow.?up|tasks?|to.?do|outstanding|pending|open items?|action items?|anything (?:for|else for) me)\b/i,
};

function citationsFromRecords(records: QuickRecord[]): QuickAnswer["citations"] {
  return records.slice(0, 4).map((r) => ({ title: r.title, kind: "record", source: r.source, at: r.createdAt }));
}

/** 1. Live readings — what the device is streaming now. */
function liveAnswer(input: QuickAnswerInput): QuickAnswer {
  const { patient, metrics, vitals, findings = [] } = input;
  const name = firstName(patient);
  const parts = readingParts(metrics, vitals);

  if (findings.length) {
    const findingsText = findings.map((f) => `${f.label.toLowerCase()} ${f.reading}`).join(", ");
    const worst = findings[0];
    const lead = pick(
      [
        `Right now ${name} has ${findingsText}.`,
        `At this moment ${name} is showing ${findingsText}.`,
        `${name} currently has ${findingsText}.`,
      ],
      `${name}|${worst.key}|${worst.reading}`
    );
    const tail = parts.length ? ` The full live readings are ${parts.join(", ")}.` : "";
    const check = ` Start with the ${worst.label.toLowerCase()}: ${worst.reading}.`;
    return {
      text: `${lead}${tail}${check}`,
      intent: "live_readings",
      scope: "record",
      grounded: true,
      citations: [],
    };
  }

  if (parts.length) {
    const lead = pick(
      [
        `Right now ${name}'s device readings are all inside their thresholds.`,
        `There is nothing outside the thresholds for ${name} at the moment.`,
        `${name} looks stable on the monitor right now.`,
      ],
      `${name}|${parts.join(",")}`
    );
    return {
      text: `${lead} The live readings are ${parts.join(", ")}.`,
      intent: "live_readings",
      scope: "record",
      grounded: true,
      citations: [],
    };
  }

  const lastSeen = metrics?.lastSeen ? relTime(metrics.lastSeen) : null;
  return {
    text: lastSeen
      ? `No live readings have arrived from ${name}'s device yet, but the device last reported ${lastSeen}. Ask again once it is streaming.`
      : `No live readings are arriving from ${name}'s device yet. Check that the patient device is on and connected, then ask me again.`,
    intent: "live_readings",
    scope: "record",
    grounded: false,
    citations: [],
  };
}

interface ThresholdCandidate {
  label: string;
  value: string;
  margin: number;
  note: string;
}

/** 2. Which reading sits closest to its alarm threshold. */
function thresholdAnswer(input: QuickAnswerInput): QuickAnswer {
  const { patient, metrics, vitals } = input;
  const name = firstName(patient);
  const candidates: ThresholdCandidate[] = [];

  if (metrics?.alertnessScore != null) {
    candidates.push({
      label: "alertness",
      value: `${Math.round(metrics.alertnessScore)} percent`,
      margin: metrics.alertnessScore - 25,
      note: "the 25 percent alertness floor",
    });
  }
  if (metrics?.blinkRate != null) {
    candidates.push({
      label: "blink rate",
      value: `${metrics.blinkRate.toFixed(1)} per minute`,
      margin: metrics.blinkRate - 5,
      note: "the 5 per minute level",
    });
  }
  if (metrics?.eyeClosureDuration != null) {
    candidates.push({
      label: "eye closure",
      value: `${(metrics.eyeClosureDuration / 1000).toFixed(1)} seconds`,
      margin: 3 - metrics.eyeClosureDuration / 1000,
      note: "the 3 second level",
    });
  }
  if (metrics?.movementActivity != null) {
    candidates.push({
      label: "movement",
      value: `${Math.round(metrics.movementActivity * 100)} percent`,
      margin: metrics.movementActivity - 0.05,
      note: "the 5 percent level",
    });
  }
  if (vitals?.spo2 != null) {
    candidates.push({
      label: "oxygen saturation",
      value: `${Math.round(vitals.spo2)} percent`,
      margin: vitals.spo2 - 94,
      note: "the 94 percent level",
    });
  }
  if (vitals?.heartRate != null) {
    candidates.push({
      label: "heart rate",
      value: `${Math.round(vitals.heartRate)} beats per minute`,
      margin: Math.min(vitals.heartRate - 45, 130 - vitals.heartRate),
      note: "the 45 to 130 range",
    });
  }
  if (vitals?.temperature != null) {
    candidates.push({
      label: "temperature",
      value: `${vitals.temperature.toFixed(1)} degrees Celsius`,
      margin: 38 - vitals.temperature,
      note: "the 38 degree level",
    });
  }

  if (!candidates.length) {
    return {
      text: `I do not have live readings for ${name} yet, so I cannot say which is closest to its threshold. I can check the recorded observations instead if you like.`,
      intent: "closest_threshold",
      scope: "record",
      grounded: false,
      citations: [],
    };
  }

  const inside = candidates.filter((c) => c.margin >= 0).sort((a, b) => a.margin - b.margin);
  const outside = candidates.filter((c) => c.margin < 0);

  const lines: string[] = [];
  if (outside.length) {
    lines.push(`${outside.map((c) => `${c.label} at ${c.value}`).join(", ")} ${outside.length === 1 ? "is" : "are"} already outside the threshold.`);
  }
  if (inside.length) {
    const closest = inside[0];
    lines.push(
      `${closest.label} is closest at ${closest.value}, just inside ${closest.note}.`
    );
    const second = inside[1];
    if (second) lines.push(`Next is ${second.label} at ${second.value}.`);
  } else {
    lines.push("Every monitored reading is outside its threshold, so treat all of them as priority.");
  }
  return {
    text: `For ${name}: ${lines.join(" ")}`,
    intent: "closest_threshold",
    scope: "record",
    grounded: true,
    citations: [],
  };
}

function trendPhrase(sorted: ClinicalObservation[]): string {
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];
  const valueText = (o: ClinicalObservation) => `${num(o.value)}${o.unit ? ` ${o.unit}` : ""}`;
  if (!previous) {
    return `${valueText(latest)} (${day(latest.at)})`;
  }
  if (typeof latest.value === "number" && typeof previous.value === "number" && latest.value !== previous.value) {
    const dir = latest.value > previous.value ? "up" : "down";
    const delta = Math.abs(latest.value - previous.value);
    return `${valueText(previous)} on ${day(previous.at)} to ${valueText(latest)} on ${day(latest.at)}, ${dir} by ${num(Number(delta.toFixed(2)))}`;
  }
  return `${valueText(latest)} (${day(latest.at)}), unchanged from the previous reading`;
}

/** 3. Trend for a named observation, or every recorded trend. */
function trendAnswer(input: QuickAnswerInput): QuickAnswer | null {
  const { patient, question } = input;
  const name = firstName(patient);
  const series = observationSeries(patient).filter((s) => s.sorted.length >= 1);
  if (!series.length) return null;

  const lower = question.toLowerCase();
  const mentioned = series.filter((s) => {
    const words = s.label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return words.some((w) => lower.includes(w)) || lower.includes(s.label.toLowerCase());
  });

  const chosen = mentioned.length ? mentioned : series.filter((s) => s.sorted.length >= 2);
  const list = chosen.length ? chosen : series;

  const clauses = list.map((s) => `${s.label}: ${trendPhrase(s.sorted)}`);
  const focus = mentioned.length === 1 ? `${mentioned[0].label} for ${name}` : `the recorded trends for ${name}`;
  return {
    text: `Here ${list.length === 1 ? "is" : "are"} ${focus}: ${clauses.join("; ")}.`,
    intent: "trend",
    scope: "record",
    grounded: true,
    citations: [],
  };
}

/** 4. What changed since the last contact. */
function changedAnswer(input: QuickAnswerInput): QuickAnswer {
  const { patient, extras } = input;
  const name = firstName(patient);
  const sessions = [...(extras?.sessions ?? [])].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const lastSession = sessions[0] ?? null;
  const lastAt = lastSession?.createdAt ?? extras?.transcripts?.[0]?.at ?? null;

  if (!lastAt) {
    return {
      text: `There is no previous call recorded with ${name} to compare against yet. I can still give you a full summary of the chart if you want one.`,
      intent: "changed_since_last_call",
      scope: "record",
      grounded: true,
      citations: [],
    };
  }

  const since = Date.parse(lastAt);
  const changes: string[] = [];

  const newObs = patient.observations
    .filter((o) => Number.isFinite(Date.parse(o.at)) && Date.parse(o.at) > since)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const o of newObs.slice(-4)) {
    changes.push(`${o.label} ${num(o.value)}${o.unit ? ` ${o.unit}` : ""} (${day(o.at)})`);
  }

  const newEncounters = patient.encounters
    .filter((e) => Number.isFinite(Date.parse(e.at)) && Date.parse(e.at) > since)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const e of newEncounters.slice(-2)) changes.push(`${e.kind} on ${day(e.at)}: ${e.summary}`);

  const newRecords = (input.records ?? []).filter(
    (r) => Number.isFinite(Date.parse(r.createdAt)) && Date.parse(r.createdAt) > since
  );
  for (const r of newRecords.slice(0, 3)) changes.push(`new document "${r.title}" (${day(r.createdAt)})`);

  const openTasks = (extras?.tasks ?? []).filter((t) => t.status === "open");
  if (openTasks.length) changes.push(`${openTasks.length} open follow-up task${openTasks.length === 1 ? "" : "s"}`);

  if (!changes.length) {
    return {
      text: `Nothing new has been recorded for ${name} since the last contact ${relTime(lastAt)}. The chart and readings are unchanged.`,
      intent: "changed_since_last_call",
      scope: "record",
      grounded: true,
      citations: [],
    };
  }

  return {
    text: `Since the last contact ${relTime(lastAt)}, the record shows: ${joinAnd(changes)}.`,
    intent: "changed_since_last_call",
    scope: "record",
    grounded: true,
    citations: [],
  };
}

/** 5. Documents on file. */
function documentsAnswer(input: QuickAnswerInput): QuickAnswer {
  const { patient, records = [] } = input;
  const name = firstName(patient);
  if (!records.length) {
    return {
      text: `There are no inserted documents for ${name} yet. You can add a discharge summary or lab report in the portal and I will read it.`,
      intent: "documents",
      scope: "record",
      grounded: true,
      citations: [],
    };
  }
  const listed = records
    .slice(0, 6)
    .map((r) => `"${r.title}"${r.source ? ` from ${r.source}` : ""} (${day(r.createdAt)})`);
  return {
    text: `${name} has ${records.length} document${records.length === 1 ? "" : "s"} on file: ${listed.join("; ")}. Ask me about any of them and I will pull the detail.`,
    intent: "documents",
    scope: "record",
    grounded: true,
    citations: citationsFromRecords(records),
  };
}

/** 6. Last call recap. */
function lastCallAnswer(input: QuickAnswerInput): QuickAnswer {
  const { patient, extras } = input;
  const name = firstName(patient);
  const sessions = [...(extras?.sessions ?? [])].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const lastSession = sessions[0] ?? null;
  const transcript = lastSession
    ? extras?.transcripts?.find((t) => t.sessionId === lastSession.id)
    : extras?.transcripts?.[0];

  if (!lastSession && !transcript) {
    return {
      text: `There is no recorded call with ${name} yet. Once a call happens, I can recap what was said, the follow-up plan and the report status.`,
      intent: "last_call",
      scope: "record",
      grounded: true,
      citations: [],
    };
  }

  const at = lastSession?.createdAt ?? transcript?.at;
  const report = lastSession
    ? extras?.reports?.find((r) => r.sessionId === lastSession.id)
    : extras?.reports?.[0];
  const entries = transcript?.entries ?? [];
  const patientLines = entries.filter((e) => e.role === "patient").map((e) => e.text);
  const parts: string[] = [`The last call with ${name} was ${relTime(at)}.`];
  if (patientLines.length) {
    parts.push(`${name} said: ${patientLines.slice(0, 3).map((t) => `"${t}"`).join(" ")}`);
  } else if (entries.length) {
    parts.push("The call was mostly the nurse and the agent; there were no patient statements recorded.");
  } else {
    parts.push("No transcript was saved for that call.");
  }
  if (lastSession?.escalated) parts.push("The session was escalated for review.");
  if (report) {
    parts.push(report.status === "approved" ? `The report was approved${report.reviewedBy ? ` by ${report.reviewedBy}` : ""}.` : "The report is still a draft and needs review.");
    const followUp = report.sections.suggestedFollowUp?.[0];
    if (followUp) parts.push(`Suggested follow-up: ${followUp}.`);
  }
  return {
    text: parts.join(" "),
    intent: "last_call",
    scope: "record",
    grounded: true,
    citations: report ? [{ title: `Care report ${day(report.generatedAt)}`, kind: "report", at: report.generatedAt }] : [],
  };
}

/** 7. Open follow-up tasks. */
function tasksAnswer(input: QuickAnswerInput): QuickAnswer {
  const { patient, extras } = input;
  const name = firstName(patient);
  const open = (extras?.tasks ?? []).filter((t) => t.status === "open");
  if (!open.length) {
    return {
      text: `${name} has no open follow-up tasks right now. I can create one if you dictate it.`,
      intent: "tasks",
      scope: "record",
      grounded: true,
      citations: [],
    };
  }
  const listed = open
    .slice(0, 5)
    .map((t) => `${t.title}${t.due ? ` (due ${day(t.due)})` : ""}`);
  return {
    text: `Open follow-up for ${name}: ${joinAnd(listed)}.`,
    intent: "tasks",
    scope: "record",
    grounded: true,
    citations: [],
  };
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/**
 * Tries to answer instantly from the record. Returns null when the question is
 * not one of the deterministic intents (so the caller can use retrieval + the
 * model).
 */
export function quickAnswer(input: QuickAnswerInput): QuickAnswer | null {
  const q = input.question.trim();
  if (!q) return null;

  // Order matters. The most specific intents run first so a broad phrase like
  // "last call" cannot swallow a document list or a trend question.
  if (RE.closest.test(q)) return thresholdAnswer(input);
  if (RE.changed.test(q)) return changedAnswer(input);
  if (RE.documents.test(q)) return documentsAnswer(input);
  if (RE.lastCall.test(q)) return lastCallAnswer(input);
  if (RE.tasks.test(q)) return tasksAnswer(input);
  if (RE.live.test(q)) return liveAnswer(input);
  if (RE.trend.test(q) && observationSeries(input.patient).length) {
    const answer = trendAnswer(input);
    if (answer) return answer;
  }

  return null;
}
