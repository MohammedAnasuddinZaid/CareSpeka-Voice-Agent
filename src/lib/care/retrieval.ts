/**
 * Record retrieval for the care assistant.
 *
 * The assistant used to send the newest free-text records to the model and hope
 * the answer was in there. That fails as soon as a patient has a real chart:
 * older discharge letters, lab results, call transcripts and follow-up tasks all
 * compete for a small context window.
 *
 * This module turns the whole authorised chart into small, labelled passages and
 * ranks them with a local full-text index (MiniSearch). Ranking is deterministic
 * and offline, so it works with or without an LLM:
 *
 *   - field boosts on the passage title and source,
 *   - fuzzy matching for typos and speech-to-text slips,
 *   - a clinical synonym expansion ("bp" -> blood pressure, "sats" -> oxygen),
 *   - recency and passage-kind boosts,
 *   - a match-strength gate so an unrelated question does not pretend it found
 *     evidence.
 *
 * Nothing here invents a fact. Passages are quoted or paraphrased by callers,
 * and every passage carries the record title it came from so the UI can show
 * what was actually read.
 */
import MiniSearch from "minisearch";
import type {
  CareReport,
  CareSession,
  CareTask,
  CareTranscriptEntry,
  ClinicalPatient,
  PatientMessage,
  PatientRecord,
} from "./types";

export type PassageKind =
  | "profile"
  | "condition"
  | "medication"
  | "allergy"
  | "observation"
  | "encounter"
  | "careplan"
  | "record"
  | "transcript"
  | "report"
  | "task"
  | "message"
  | "knowledge";

export interface Passage {
  id: string;
  kind: PassageKind;
  title: string;
  text: string;
  source?: string;
  at?: string;
  /** Extra searchable words that are not part of the displayed text. */
  keywords?: string;
  /** Relative importance of this passage when scores are close. */
  weight?: number;
}

export interface RetrievedPassage extends Passage {
  score: number;
  excerpt: string;
  matchedTerms: string[];
}

export interface RetrievalOptions {
  limit?: number;
  /** Only return passages whose score clears this fraction of the best score. */
  relativeFloor?: number;
  /** Minimum number of meaningful query terms that must appear. */
  minMatched?: number;
}

export interface RetrievalResult {
  passages: RetrievedPassage[];
  /** True when the best passage covers enough of the question to quote safely. */
  strong: boolean;
  /** Query terms that were looked for after expansion. */
  terms: string[];
}

export interface PatientExtras {
  transcripts?: Array<{ sessionId: string; at?: string; entries: CareTranscriptEntry[] }>;
  reports?: CareReport[];
  tasks?: CareTask[];
  messages?: PatientMessage[];
  /** The most recent sessions for this patient, newest first. Used by the recap. */
  sessions?: CareSession[];
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could did do does doing done for from had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves " +
    "please tell show give explain about patient record records chart note notes query question answer okay ok"
  ).split(/\s+/)
);

const SYNONYMS: Record<string, string[]> = {
  bp: ["blood", "pressure"],
  hr: ["heart", "rate", "pulse"],
  spo2: ["oxygen", "saturation", "sats"],
  sats: ["oxygen", "saturation"],
  sat: ["oxygen", "saturation"],
  temp: ["temperature", "fever"],
  med: ["medication", "medicine", "drug"],
  meds: ["medication", "medicine", "drug"],
  medication: ["medicine", "drug", "dose"],
  medicines: ["medication", "drug"],
  allergy: ["allergies", "reaction", "anaphylaxis"],
  allergies: ["allergy", "reaction"],
  sugar: ["glucose", "diabetes", "blood"],
  glucose: ["sugar", "diabetes"],
  breath: ["breathless", "breathlessness", "dyspnoea", "dyspnea", "respiratory"],
  breathless: ["breathlessness", "dyspnoea", "dyspnea", "oxygen"],
  breathlessness: ["dyspnoea", "dyspnea", "oxygen", "respiratory"],
  dyspnoea: ["breathless", "breathlessness", "respiratory"],
  dyspnea: ["breathless", "breathlessness", "respiratory"],
  water: ["fluid", "diuretic", "furosemide", "swelling", "oedema", "edema"],
  swelling: ["oedema", "edema", "fluid", "ankle"],
  swollen: ["swelling", "oedema", "edema", "fluid"],
  dizzy: ["dizziness", "vertigo", "orthostatic", "falls"],
  fall: ["falls", "dizzy", "mobility"],
  pee: ["urine", "urinary", "output"],
  tummy: ["abdomen", "abdominal", "stomach"],
  poop: ["bowel", "stool", "constipation"],
  kidney: ["renal", "creatinine", "egfr"],
  renal: ["kidney", "creatinine", "egfr"],
  creatinine: ["kidney", "renal", "egfr"],
  egfr: ["kidney", "renal", "creatinine"],
  liver: ["hepatic", "bilirubin", "alt"],
  bloods: ["blood", "test", "lab", "results", "haemoglobin", "sodium", "potassium"],
  labs: ["blood", "test", "results", "laboratory"],
  haemoglobin: ["hemoglobin", "hb", "anaemia", "anemia"],
  hemoglobin: ["haemoglobin", "hb", "anaemia", "anemia"],
  hba1c: ["a1c", "glycated", "diabetes", "glucose"],
  cholesterol: ["lipid", "ldl", "hdl"],
  scan: ["imaging", "xray", "ct", "mri", "ultrasound"],
  xray: ["scan", "imaging", "x-ray"],
  wound: ["incision", "surgical", "dressing", "infection"],
  operation: ["surgery", "surgical", "procedure", "operative"],
  thin: ["anticoagulant", "warfarin", "apixaban", "rivaroxaban"],
  gasping: ["breathless", "respiratory", "oxygen"],
  unconscious: ["collapsed", "unresponsive", "alertness"],
  confused: ["confusion", "delirium", "alertness"],
  pain: ["discomfort", "ache", "sore", "score"],
  mood: ["anxiety", "depression", "mental"],
  sleep: ["insomnia", "night", "orthopnoea"],
  appetite: ["eating", "weight", "nutrition"],
  walk: ["mobility", "walking", "exercise", "falls"],
  fluid: ["water", "oedema", "edema", "intake", "output", "diuretic"],
  sepsis: ["infection", "fever", "septic"],
  uti: ["urine", "urinary", "infection"],
  af: ["atrial", "fibrillation"],
  hf: ["heart", "failure"],
  cva: ["stroke", "neurological"],
  mi: ["heart", "attack", "myocardial"],
  dvt: ["clot", "thrombosis"],
  pe: ["pulmonary", "embolism"],
  copd: ["respiratory", "lungs", "smoking"],
};

/**
 * Compact clinical spellings that a naive letter/digit split tears apart:
 * "SpO2" becomes "spo 2", "O2" becomes "o" + a dropped "2", "BP" stays an
 * opaque abbreviation. Expanding them at tokenize time applies to both the
 * indexed chart and the question, so "spo2" and "oxygen saturation" meet.
 */
const COMPACT_TERMS: Array<[RegExp, string]> = [
  [/\bspo2\b|\bsao2\b/g, " oxygen saturation "],
  [/\bpao2\b|\bo2\b|\byo2\b/g, " oxygen "],
  [/\bco2\b/g, " carbon dioxide "],
  [/\bbp\b/g, " bp blood pressure "],
  [/\bhr\b/g, " hr heart rate "],
  [/\brr\b/g, " rr respiratory rate "],
  [/\btemp\b/g, " temp temperature "],
  [/\bwt\b/g, " wt weight "],
  [/\bhba1c\b/g, " hba1c glycated haemoglobin "],
  [/\begfr\b/g, " egfr renal kidney "],
  [/\bu&e\b|\bu and e\b/g, " urea electrolytes "],
  [/\bfbc\b|\bwcc\b|\bwbc\b/g, " full blood count haemoglobin white cell "],
  [/\blfts?\b/g, " liver function test "],
  [/\bcrp\b/g, " crp inflammation "],
  [/\besr\b/g, " esr inflammation "],
  [/\binr\b/g, " inr clotting warfarin "],
  [/\bx-?ray\b/g, " xray imaging "],
  [/\bsoboe\b|\bdoe\b/g, " breathless exertion "],
];

/** Light, deliberately conservative stemming. */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith("ed")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss") && !term.endsWith("us")) {
    return term.slice(0, -1);
  }
  return term;
}

function tokenize(text: string): string[] {
  let lower = text.toLowerCase();
  for (const [pattern, replacement] of COMPACT_TERMS) lower = lower.replace(pattern, replacement);
  return lower
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * A very long question (a dictated paragraph, a pasted note) would otherwise
 * expand into dozens of OR terms, each with fuzzy and prefix matching. The cap
 * keeps a turn bounded without dropping the meaningful words: base terms come
 * first, then synonyms, and each group is ordered longest-first.
 */
const MAX_QUERY_TERMS = 16;

function expandTerms(question: string): string[] {
  const base = tokenize(question);
  const out = new Set<string>();
  const byLength = (a: string, b: string) => b.length - a.length || a.localeCompare(b);
  for (const term of [...base].sort(byLength)) out.add(term);
  for (const term of [...base].sort(byLength)) {
    for (const extra of SYNONYMS[term] ?? []) out.add(extra);
    const singular = stem(term);
    if (singular !== term) out.add(singular);
  }
  return [...out].filter((t) => t.length > 1).slice(0, MAX_QUERY_TERMS);
}

export function passageSearchText(passage: Passage): string {
  return `${passage.title} ${passage.source ?? ""} ${passage.keywords ?? ""} ${passage.text}`;
}

interface WordSets {
  raw: Set<string>;
  stemmed: Set<string>;
}

/**
 * Whole-word sets for a passage/title. Matching whole words (rather than
 * `String.includes`) matters: "rate" is not a match inside "accurate", and a
 * stray substring must not make a passage look like evidence.
 */
function wordSets(text: string): WordSets {
  const raw = new Set<string>();
  const stemmed = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    raw.add(word);
    stemmed.add(stem(word));
  }
  return { raw, stemmed };
}

function hasTerm(words: WordSets, term: string): boolean {
  return words.raw.has(term) || words.stemmed.has(stem(term));
}

function excerptFor(text: string, terms: string[], max = 320): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const lower = clean.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return `${clean.slice(0, max - 1).trimEnd()}…`;
  const start = Math.max(0, at - Math.floor(max / 3));
  const end = Math.min(clean.length, start + max);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}

function chunkText(text: string, max = 900, overlap = 120): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= max) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + max);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("; "),
        window.lastIndexOf("\n")
      );
      if (breakAt > max * 0.45) end = start + breakAt + 1;
    }
    const part = clean.slice(start, end).trim();
    if (part) chunks.push(part);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function fmt(value: number | string, unit?: string): string {
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function day(iso?: string): string {
  return iso ? iso.slice(0, 10) : "date not recorded";
}

/**
 * Builds every searchable passage for one patient. The same function is used by
 * answers and by the "what can I ask" suggestions, so the two can never drift.
 */
export function buildPatientPassages(
  patient: ClinicalPatient,
  records: PatientRecord[] = [],
  extras: PatientExtras = {}
): Passage[] {
  const out: Passage[] = [];
  const name = patient.displayName;
  const who = `${name}${patient.age != null ? `, age ${patient.age}` : ""}${patient.sex ? `, ${patient.sex}` : ""}`;
  const location = patient.room ? `Location: ${patient.room}.` : "";
  const synthetic = patient.synthetic ? "Synthetic demo data, not a real patient." : "";

  out.push({
    id: "profile",
    kind: "profile",
    title: `${name} — profile`,
    text: `${who}. ${location} Primary concern: ${patient.primaryConcern ?? "not recorded"}. Language: ${patient.language}. ${synthetic}`.trim(),
    keywords: `${name} ${patient.id} ${patient.extension} demographics age sex room ward bed`,
    weight: 1.2,
  });

  for (const c of patient.conditions) {
    out.push({
      id: `condition:${c.id}`,
      kind: "condition",
      title: `${name} — condition: ${c.name}`,
      text: `${c.name}${c.code ? ` (${c.code})` : ""}. Status: ${c.status}${c.since ? `, since ${c.since}` : ""}.${c.note ? ` Note: ${c.note}.` : ""}`,
      at: c.since,
      keywords: `condition diagnosis problem ${c.code ?? ""} active resolved history`,
      weight: 1.05,
    });
  }
  if (patient.conditions.length) {
    out.push({
      id: "conditions:summary",
      kind: "condition",
      title: `${name} — all conditions`,
      text: `Conditions: ${patient.conditions
        .map((c) => `${c.name}${c.code ? ` (${c.code})` : ""} [${c.status}]`)
        .join("; ")}.`,
      keywords: "conditions diagnoses problem list medical history background",
    });
  }

  for (const m of patient.medications) {
    out.push({
      id: `medication:${m.id}`,
      kind: "medication",
      title: `${name} — medication: ${m.name}`,
      text: `${m.name}${m.dose ? ` ${m.dose}` : ""}${m.route ? ` ${m.route}` : ""}${m.frequency ? `, ${m.frequency}` : ""}. Status: ${m.status}${m.since ? `, since ${m.since}` : ""}.${m.note ? ` Note: ${m.note}.` : ""}`,
      at: m.since,
      keywords: `medication medicine drug prescription dose tablet inhaler ${m.name}`,
      weight: 1.05,
    });
  }
  if (patient.medications.length) {
    out.push({
      id: "medications:summary",
      kind: "medication",
      title: `${name} — all medications`,
      text: `Medications: ${patient.medications
        .map(
          (m) =>
            `${m.name}${m.dose ? ` ${m.dose}` : ""}${m.frequency ? ` ${m.frequency}` : ""} [${m.status}]`
        )
        .join("; ")}.`,
      keywords: "medications medicines drugs prescription list current stopped",
    });
  }

  for (const a of patient.allergies) {
    out.push({
      id: `allergy:${a.id}`,
      kind: "allergy",
      title: `${name} — allergy: ${a.substance}`,
      text: `${a.substance} allergy. Reaction: ${a.reaction ?? "not recorded"}. Severity: ${a.severity}.`,
      keywords: `allergy allergic reaction anaphylaxis safety ${a.substance}`,
      weight: 1.1,
    });
  }
  out.push({
    id: "allergies:summary",
    kind: "allergy",
    title: `${name} — allergies`,
    text: patient.allergies.length
      ? `Allergies: ${patient.allergies
          .map((a) => `${a.substance} (${a.reaction ?? "reaction not recorded"}, ${a.severity})`)
          .join("; ")}.`
      : `${name} has no recorded allergies.`,
    keywords: "allergies allergic reaction safety",
  });

  const byLabel = new Map<string, typeof patient.observations>();
  for (const o of patient.observations) {
    const arr = byLabel.get(o.label) ?? [];
    arr.push(o);
    byLabel.set(o.label, arr);
  }
  for (const [label, series] of byLabel) {
    const sorted = [...series].sort((a, b) => a.at.localeCompare(b.at));
    out.push({
      id: `observation:${label}`,
      kind: "observation",
      title: `${name} — observations: ${label}`,
      text: `${label} readings: ${sorted
        .map((o) => `${fmt(o.value, o.unit)} on ${day(o.at)}`)
        .join("; ")}.`,
      at: sorted[sorted.length - 1]?.at,
      keywords: `observation vital sign reading measurement trend ${label} latest previous`,
      weight: 1.1,
    });
  }
  if (patient.observations.length) {
    out.push({
      id: "observations:latest",
      kind: "observation",
      title: `${name} — latest observations`,
      text: `Latest recorded observations: ${[...byLabel.entries()]
        .map(([label, series]) => {
          const latest = [...series].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
          return latest ? `${label} ${fmt(latest.value, latest.unit)} (${day(latest.at)})` : "";
        })
        .filter(Boolean)
        .join("; ")}.`,
      keywords: "latest observations vitals readings current last measured",
    });
  }

  for (const e of patient.encounters) {
    out.push({
      id: `encounter:${e.id}`,
      kind: "encounter",
      title: `${name} — ${e.kind} on ${day(e.at)}`,
      text: `${e.kind}${e.by ? ` by ${e.by}` : ""} on ${day(e.at)}: ${e.summary}`,
      at: e.at,
      keywords: `encounter visit admission discharge call contact ${e.kind}`,
      weight: 1.05,
    });
  }

  if (patient.carePlan) {
    out.push({
      id: "careplan",
      kind: "careplan",
      title: `${name} — care plan`,
      text: `Care plan: ${patient.carePlan}`,
      keywords: "care plan goals management follow-up instructions daily monitoring",
      weight: 1.08,
    });
  }

  for (const record of records) {
    const chunks = chunkText(record.text);
    chunks.forEach((chunk, index) => {
      out.push({
        id: `record:${record.id}:${index}`,
        kind: "record",
        title: `${record.title}${chunks.length > 1 ? ` — part ${index + 1}` : ""}`,
        source: record.source,
        at: record.createdAt,
        text: chunk,
        keywords: `inserted record document ${record.source ?? ""} ${record.title}`,
        weight: 1.15,
      });
    });
  }

  for (const transcript of extras.transcripts ?? []) {
    const entries = transcript.entries ?? [];
    if (!entries.length) continue;
    const chunks = chunkText(
      entries.map((e) => `${e.role === "patient" ? "Patient" : e.role === "agent" ? "Agent" : e.role}: ${e.text}`).join("\n")
    );
    chunks.forEach((chunk, index) => {
      out.push({
        id: `transcript:${transcript.sessionId}:${index}`,
        kind: "transcript",
        title: `Call transcript ${day(transcript.at ?? entries[0]?.at)}${chunks.length > 1 ? ` — part ${index + 1}` : ""}`,
        source: "Care call",
        at: transcript.at ?? entries[0]?.at,
        text: chunk,
        keywords: "call transcript conversation said last call discussed",
        weight: 1.12,
      });
    });
  }

  for (const report of extras.reports ?? []) {
    const sections = report.sections;
    const text = [
      `Status: ${report.status}. Generated ${day(report.generatedAt)}.`,
      `Reason: ${sections.reasonForInteraction}`,
      `Patient-reported symptoms: ${sections.patientReportedSymptoms.map((s) => s.text).join("; ") || "none"}`,
      `Relevant history: ${sections.relevantHistory.map((s) => s.text).join("; ") || "none"}`,
      `Medications discussed: ${sections.medicationsDiscussed.map((s) => s.text).join("; ") || "none"}`,
      `Allergies discussed: ${sections.allergiesDiscussed.map((s) => s.text).join("; ") || "none"}`,
      `Concerns for nurse: ${sections.concernsForNurse.map((s) => s.text).join("; ") || "none"}`,
      `Escalations: ${sections.escalations.join("; ") || "none"}`,
      `Suggested follow-up: ${sections.suggestedFollowUp.join("; ") || "none"}`,
      `Unresolved questions: ${sections.unresolvedQuestions.join("; ") || "none"}`,
      `Summary: ${sections.aiSummary}`,
      `Key points: ${sections.keyPoints.join("; ")}`,
    ].join("\n");
    for (const [index, chunk] of chunkText(text).entries()) {
      out.push({
        id: `report:${report.id}:${index}`,
        kind: "report",
        title: `Care report ${day(report.generatedAt)}${chunk.length && text.length > 900 ? ` — part ${index + 1}` : ""}`,
        source: "Care call report",
        at: report.generatedAt,
        text: chunk,
        keywords: "report summary call findings symptoms escalation follow-up sbar",
        weight: 1.1,
      });
    }
  }

  for (const task of extras.tasks ?? []) {
    out.push({
      id: `task:${task.id}`,
      kind: "task",
      title: `Follow-up task: ${task.title}`,
      text: `Task "${task.title}" is ${task.status}${task.due ? `, due ${day(task.due)}` : ""}. Created by ${task.createdBy}.`,
      at: task.createdAt,
      keywords: "task follow-up todo outstanding pending action",
      weight: 1.05,
    });
  }

  for (const message of extras.messages ?? []) {
    out.push({
      id: `message:${message.id}`,
      kind: "message",
      title: `Message to ${name} on ${day(message.createdAt)}`,
      text: `Sent by ${message.createdBy}: "${message.text}"`,
      at: message.createdAt,
      keywords: "message sent told patient note communication",
    });
  }

  return out;
}

function indexPassages(passages: Passage[]): MiniSearch<Passage> {
  const mini = new MiniSearch<Passage>({
    fields: ["title", "text", "keywords"],
    storeFields: ["id"],
    tokenize,
    processTerm: stem,
    searchOptions: {
      boost: { title: 2.4, keywords: 1.35, text: 1 },
      // Fuzzy matching is valuable for speech-to-text slips ("furosemid") but
      // ruinous on short terms, where one edit reaches unrelated words. Prefix
      // matching is likewise only useful once a term is long enough to narrow.
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      prefix: (term) => term.length >= 3,
      maxFuzzy: 2,
      weights: { fuzzy: 0.7, prefix: 0.85 },
      combineWith: "OR",
    },
  });
  mini.addAll(passages);
  return mini;
}

// ---------------------------------------------------------------------------
// index cache
// ---------------------------------------------------------------------------
//
// Building a MiniSearch index is the single most expensive step in a turn, and
// the same chart is rebuilt on every question (the patient row plus the newest
// records). The chart changes rarely, so an index is cached against a cheap
// content signature: build once, then answer subsequent questions in
// microseconds. The cache is small (LRU-ish, insert-order eviction) so a busy
// process cannot grow without bound.

const INDEX_CACHE = new Map<string, MiniSearch<Passage>>();
export const RETRIEVAL_CACHE_MAX = 40;

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cheap, collision-resistant-enough signature of the passage set. */
export function passagesSignature(passages: Passage[]): string {
  let acc = `${passages.length}`;
  for (const p of passages) {
    // Every field the index/search depends on must be in the signature, or a
    // chart that changed only its keywords/kind/weight would reuse a stale
    // index (e.g. two patients whose profile text matches but whose extension
    // keyword differs).
    acc += `|${fnv1a(
      `${p.id}\u0001${p.kind}\u0001${p.title}\u0001${p.text}\u0001${p.at ?? ""}\u0001${p.source ?? ""}\u0001${p.keywords ?? ""}\u0001${p.weight ?? ""}`
    ).toString(36)}`;
  }
  return `${passages.length}:${fnv1a(acc).toString(36)}`;
}

function getIndex(passages: Passage[]): MiniSearch<Passage> {
  const key = passagesSignature(passages);
  const cached = INDEX_CACHE.get(key);
  if (cached) {
    // Refresh recency: delete + re-set moves the key to the end of the Map.
    INDEX_CACHE.delete(key);
    INDEX_CACHE.set(key, cached);
    return cached;
  }
  const built = indexPassages(passages);
  INDEX_CACHE.set(key, built);
  if (INDEX_CACHE.size > RETRIEVAL_CACHE_MAX) {
    const oldest = INDEX_CACHE.keys().next().value;
    if (oldest !== undefined) INDEX_CACHE.delete(oldest);
  }
  return built;
}

/** Test hook: drop every cached index. */
export function clearRetrievalCache(): void {
  INDEX_CACHE.clear();
}

/** Test hook: number of cached indexes (always bounded by the cache ceiling). */
export function retrievalCacheSize(): number {
  return INDEX_CACHE.size;
}

/**
 * Ranks the passages against a question. `strong` is false when only a stray
 * word matched — callers should then say the record does not contain the answer
 * instead of quoting an unrelated note.
 */
export function retrievePassages(
  question: string,
  passages: Passage[],
  opts: RetrievalOptions = {}
): RetrievalResult {
  const terms = expandTerms(question);
  const limit = opts.limit ?? 6;
  const relativeFloor = opts.relativeFloor ?? 0.18;
  const minMatched = opts.minMatched ?? 1;
  if (!terms.length || !passages.length) return { passages: [], strong: false, terms };

  const mini = getIndex(passages);
  const query = terms.join(" ");
  let raw: Array<{ id: string; score: number; terms?: string[]; queryTerms?: string[] }> = [];
  try {
    raw = mini.search(query) as typeof raw;
  } catch {
    raw = [];
  }

  const byId = new Map(passages.map((p) => [p.id, p]));
  const best = raw[0]?.score ?? 0;
  // Terms long enough to be a real clinical subject (a drug, a condition, a
  // measure). A hit that puts one of these in the passage title is almost always
  // the passage the nurse wants, so it earns a small, bounded bonus.
  const focusTerms = terms.filter((t) => t.length >= 4);
  const scored: RetrievedPassage[] = [];
  for (const hit of raw) {
    const passage = byId.get(String(hit.id));
    if (!passage) continue;
    if (best > 0 && hit.score < best * relativeFloor) continue;
    const hay = wordSets(passageSearchText(passage));
    // MiniSearch reports which query terms actually matched, including fuzzy
    // and prefix matches. Without them a typo like "potasium" was found by the
    // index and then thrown away by the literal word check below.
    const fuzzyMatched = new Set((hit.queryTerms ?? []).map(stem));
    const matchedTerms = terms.filter((t) => fuzzyMatched.has(stem(t)) || hasTerm(hay, t));
    if (matchedTerms.length < minMatched) continue;
    const titleWords = wordSets(passage.title);
    const titleFocus =
      (hit.terms ?? []).some((t) => t.length >= 4 && hasTerm(titleWords, t)) ||
      focusTerms.some((t) => hasTerm(titleWords, t));
    const weight = passage.weight ?? 1;
    // A small recency boost for documents; old letters still rank if relevant.
    const at = passage.at ? Date.parse(passage.at) : NaN;
    const ageDays = Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 86_400_000) : 365;
    const recency = passage.kind === "record" || passage.kind === "transcript" ? Math.max(0, 0.12 - ageDays / 3650) : 0;
    scored.push({
      ...passage,
      score: hit.score * weight * (titleFocus ? 1.15 : 1) + recency,
      excerpt: excerptFor(passage.text, terms),
      matchedTerms,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  const topTerms = new Set(top.flatMap((p) => p.matchedTerms));
  const meaningful = terms.filter((t) => t.length > 3);
  const coverage = meaningful.length ? meaningful.filter((t) => topTerms.has(t)).length / meaningful.length : 0;
  const strong = Boolean(top.length) && (coverage >= 0.34 || top[0].matchedTerms.some((t) => t.length >= 6));

  return { passages: top, strong, terms };
}

/** Prompt-ready source block. Sources are numbered so the model can rely on them. */
export function retrievalContext(passages: RetrievedPassage[], maxChars = 9000): string {
  if (!passages.length) return "";
  const out: string[] = [];
  let used = 0;
  for (const [index, p] of passages.entries()) {
    const header = `[S${index + 1}] ${p.title}${p.source ? ` (${p.source})` : ""}${p.at ? ` — ${day(p.at)}` : ""}`;
    const body = p.text.replace(/\s+/g, " ").trim().slice(0, 1800);
    const block = `${header}\n${body}`;
    if (used + block.length > maxChars && out.length) break;
    out.push(block);
    used += block.length;
  }
  return out.join("\n\n");
}

/** Short, de-duplicated source labels for the UI. */
export function citationList(
  passages: RetrievedPassage[],
  max = 4
): Array<{ title: string; kind: PassageKind; source?: string; at?: string }> {
  const seen = new Set<string>();
  const out: Array<{ title: string; kind: PassageKind; source?: string; at?: string }> = [];
  for (const p of passages) {
    const label = p.title.replace(/\s+—\s+part\s+\d+$/, "");
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ title: label, kind: p.kind, source: p.source, at: p.at });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Deterministic answer built from the strongest passages. Used when the model is
 * unavailable, and as a safety net when a model reply fails validation.
 */
export function evidenceAnswer(passages: RetrievedPassage[], max = 2): string {
  if (!passages.length) return "";
  const chosen = passages.slice(0, max);
  const parts = chosen.map((p) => {
    const clean = p.excerpt.replace(/\s+/g, " ").trim();
    return `${clean} (${p.title}${p.source ? `, ${p.source}` : ""})`;
  });
  return `From the record: ${parts.join(" Also: ")}`;
}
