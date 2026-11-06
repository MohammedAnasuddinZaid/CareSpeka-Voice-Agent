/**
 * Repository layer for the Web Voice Call — Demo.
 *
 * All persistence goes through here so API routes stay thin and the storage
 * driver stays swappable. Server-only.
 */
import { getDriver, CareKeys as K, type DriverName } from "./store";
import { getSeedPatient, SYNTHETIC_PATIENTS } from "./seedPatients";
import { hashToken, isExpired, isoNow, newId, newJoinCode, newToken } from "./crypto";
import type {
  CareAuditEntry,
  CareEvent,
  CareEventType,
  CareReport,
  CareRole,
  CareSession,
  CareSignal,
  CareTask,
  CareTranscriptEntry,
  ClinicalPatient,
  PatientMessage,
  PatientRecord,
  SessionPatientLink,
} from "./types";
import { ensureDemoSeed } from "./seedDemo";

// ---------------------------------------------------------------------------
// store info
// ---------------------------------------------------------------------------

export async function getStoreInfo(): Promise<{ driver: DriverName; persistent: boolean }> {
  const d = await getDriver();
  return { driver: d.name, persistent: d.persistent };
}

// ---------------------------------------------------------------------------
// patients
// ---------------------------------------------------------------------------

async function ensurePatientsSeeded(): Promise<void> {
  const d = await getDriver();
  const index = (await d.getDoc(K.patientIndex)) as string[] | null;
  if (index && index.length) return;
  for (const p of SYNTHETIC_PATIENTS) await d.setDoc(K.patient(p.id), p);
  await d.setDoc(K.patientIndex, SYNTHETIC_PATIENTS.map((p) => p.id));
}

export async function listPatients(): Promise<ClinicalPatient[]> {
  await ensureDemoSeed();
  await ensurePatientsSeeded();
  const d = await getDriver();
  const index = ((await d.getDoc(K.patientIndex)) as string[] | null) ?? [];
  const out: ClinicalPatient[] = [];
  for (const id of index) {
    const p = (await d.getDoc(K.patient(id))) as ClinicalPatient | null;
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getPatient(id: string): Promise<ClinicalPatient | null> {
  await ensurePatientsSeeded();
  const d = await getDriver();
  const p = (await d.getDoc(K.patient(id))) as ClinicalPatient | null;
  return p ?? getSeedPatient(id) ?? null;
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export async function createSession(input: {
  patientId: string;
  nurseId: string;
  nurseName: string;
  ttlMinutes?: number;
}): Promise<{ session: CareSession; joinToken: string }> {
  const d = await getDriver();
  const ttl = input.ttlMinutes ?? 30;
  const joinToken = newToken();
  const session: CareSession = {
    id: newId("wc"),
    mode: "web-voice-demo",
    patientId: input.patientId,
    nurseId: input.nurseId,
    nurseName: input.nurseName,
    status: "waiting",
    createdAt: isoNow(),
    joinTokenHash: hashToken(joinToken),
    joinCode: newJoinCode(),
    joinExpiresAt: new Date(Date.now() + ttl * 60_000).toISOString(),
    escalated: false,
    seq: 0,
  };
  await d.setDoc(K.session(session.id), session);
  await d.setDoc(K.joinToken(session.joinTokenHash), session.id);
  const index = ((await d.getDoc(K.sessionIndex)) as string[] | null) ?? [];
  index.push(session.id);
  await d.setDoc(K.sessionIndex, index.slice(-500));
  await appendEventInternal(session.id, "session.created", "nurse", { patientId: session.patientId });
  await appendEventInternal(session.id, "join.link_generated", "system", { expiresAt: session.joinExpiresAt });
  return { session: (await getSession(session.id))!, joinToken };
}

export async function getSession(id: string): Promise<CareSession | null> {
  const d = await getDriver();
  return ((await d.getDoc(K.session(id))) as CareSession | null) ?? null;
}

export async function listSessions(limit = 50): Promise<CareSession[]> {
  await ensureDemoSeed();
  const d = await getDriver();
  const index = ((await d.getDoc(K.sessionIndex)) as string[] | null) ?? [];
  const out: CareSession[] = [];
  for (const id of index.slice(-limit).reverse()) {
    const s = (await d.getDoc(K.session(id))) as CareSession | null;
    if (s) out.push(s);
  }
  return out;
}

/** Find a waiting session by its human-typeable joining code. */
export async function findSessionByJoinCode(code: string): Promise<CareSession | null> {
  const d = await getDriver();
  const index = ((await d.getDoc(K.sessionIndex)) as string[] | null) ?? [];
  for (const id of [...index].reverse()) {
    const s = (await d.getDoc(K.session(id))) as CareSession | null;
    if (s && s.joinCode === code) return s;
  }
  return null;
}

export async function updateSession(id: string, patch: Partial<CareSession>): Promise<CareSession | null> {
  const current = await getSession(id);
  if (!current) return null;
  const merged = { ...current, ...patch, id: current.id };
  const d = await getDriver();
  await d.setDoc(K.session(id), merged);
  return merged;
}

export async function findSessionByJoinToken(raw: string): Promise<CareSession | null> {
  const d = await getDriver();
  const id = (await d.getDoc(K.joinToken(hashToken(raw)))) as string | null;
  if (!id) return null;
  const session = await getSession(id);
  // A regenerated link changes joinTokenHash; the old token then no longer matches.
  if (!session || session.joinTokenHash !== hashToken(raw)) return null;
  return session;
}

/** Issue a fresh join link, invalidating the previous token. */
export async function regenerateJoinToken(
  sessionId: string,
  ttlMinutes: number
): Promise<{ session: CareSession; joinToken: string } | null> {
  const d = await getDriver();
  const session = await getSession(sessionId);
  if (!session) return null;
  const joinToken = newToken();
  const joinTokenHash = hashToken(joinToken);
  const joinExpiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const updated = await updateSession(sessionId, {
    joinTokenHash,
    joinExpiresAt,
    status: session.status === "expired" ? "waiting" : session.status,
  });
  await d.setDoc(K.joinToken(joinTokenHash), sessionId);
  await appendEventInternal(sessionId, "join.link_generated", "system", { expiresAt: joinExpiresAt, regenerated: true });
  return { session: updated!, joinToken };
}

/** Index a participant token so the patient can authenticate subsequent calls. */
export async function linkParticipantToken(sessionId: string, raw: string): Promise<void> {
  const d = await getDriver();
  await d.setDoc(K.participant(hashToken(raw)), sessionId);
}

export async function findSessionByParticipantToken(raw: string): Promise<CareSession | null> {
  const d = await getDriver();
  const hash = hashToken(raw);
  const id = (await d.getDoc(K.participant(hash))) as string | null;
  if (!id) return null;
  const session = await getSession(id);
  // Verify the stored hash still matches, so a re-join invalidates any earlier token.
  if (!session || session.participantTokenHash !== hash) return null;
  return session;
}

/** Expire a session whose join window passed before anyone connected. */
export async function expireIfStale(session: CareSession): Promise<CareSession> {
  if ((session.status === "waiting" || session.status === "created") && isExpired(session.joinExpiresAt)) {
    return (await updateSession(session.id, { status: "expired" })) ?? session;
  }
  return session;
}

export async function endSession(id: string, reason: string): Promise<CareSession | null> {
  const s = await getSession(id);
  if (!s) return null;
  if (s.status === "ended") return s;
  const endedAt = isoNow();
  const started = s.startedAt ? Date.parse(s.startedAt) : Date.parse(s.createdAt);
  const durationMs = Math.max(0, Date.now() - started);
  const updated = await updateSession(id, { status: "ended", endedAt, durationMs, endReason: reason });
  await appendEventInternal(id, "session.ended", "nurse", { reason, durationMs });
  return updated;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

async function nextSeq(sessionId: string): Promise<number> {
  const s = await getSession(sessionId);
  const seq = (s?.seq ?? 0) + 1;
  if (s) await updateSession(sessionId, { seq });
  return seq;
}

async function appendEventInternal(
  sessionId: string,
  type: CareEventType,
  actor: CareRole,
  detail?: Record<string, unknown>
): Promise<CareEvent> {
  const event: CareEvent = { seq: await nextSeq(sessionId), at: isoNow(), type, actor, detail };
  const d = await getDriver();
  await d.appendList(K.events(sessionId), event, 2000);
  return event;
}

export const appendEvent = appendEventInternal;

export async function listEvents(sessionId: string, sinceSeq = 0): Promise<CareEvent[]> {
  const d = await getDriver();
  const all = (await d.getList(K.events(sessionId))) as CareEvent[];
  return all.filter((e) => e.seq > sinceSeq);
}

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------

export async function appendTranscript(
  sessionId: string,
  entry: { role: CareRole; text: string; engine?: string; confidence?: number; provisional?: boolean }
): Promise<CareTranscriptEntry> {
  const clean = entry.text.trim().slice(0, 4000);
  const stored: CareTranscriptEntry = {
    id: newId("tt"),
    seq: await nextSeq(sessionId),
    sessionId,
    role: entry.role,
    text: clean,
    at: isoNow(),
    engine: entry.engine,
    confidence: entry.confidence,
    provisional: entry.provisional,
  };
  const d = await getDriver();
  await d.appendList(K.transcript(sessionId), stored, 4000);
  await appendEventInternal(sessionId, "transcript.updated", entry.role, { seq: stored.seq });
  return stored;
}

export async function listTranscript(sessionId: string, sinceSeq = 0): Promise<CareTranscriptEntry[]> {
  const d = await getDriver();
  const all = (await d.getList(K.transcript(sessionId))) as CareTranscriptEntry[];
  return all.filter((t) => t.seq > sinceSeq);
}

export async function getTranscriptRaw(sessionId: string): Promise<CareTranscriptEntry[]> {
  const d = await getDriver();
  return (await d.getList(K.transcript(sessionId))) as CareTranscriptEntry[];
}

// ---------------------------------------------------------------------------
// signalling
// ---------------------------------------------------------------------------

export async function pushSignal(
  sessionId: string,
  to: "nurse" | "patient",
  signal: Omit<CareSignal, "idx" | "at">
): Promise<CareSignal> {
  const d = await getDriver();
  const list = (await d.getList(K.signal(sessionId, to))) as CareSignal[];
  const stored: CareSignal = { ...signal, idx: list.length, at: isoNow() };
  await d.appendList(K.signal(sessionId, to), stored, 1000);
  return stored;
}

export async function listSignals(sessionId: string, to: "nurse" | "patient", sinceIdx = 0): Promise<CareSignal[]> {
  const d = await getDriver();
  const all = (await d.getList(K.signal(sessionId, to))) as CareSignal[];
  return all.filter((s) => s.idx >= sinceIdx);
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

export async function putReport(report: CareReport): Promise<void> {
  const d = await getDriver();
  await d.setDoc(K.report(report.id), report);
  const index = ((await d.getDoc(K.reportIndex)) as string[] | null) ?? [];
  if (!index.includes(report.id)) index.push(report.id);
  await d.setDoc(K.reportIndex, index.slice(-1000));
}

export async function getReport(id: string): Promise<CareReport | null> {
  const d = await getDriver();
  return ((await d.getDoc(K.report(id))) as CareReport | null) ?? null;
}

export async function getReportBySession(sessionId: string): Promise<CareReport | null> {
  const d = await getDriver();
  const index = ((await d.getDoc(K.reportIndex)) as string[] | null) ?? [];
  for (const id of [...index].reverse()) {
    const r = (await d.getDoc(K.report(id))) as CareReport | null;
    if (r?.sessionId === sessionId) return r;
  }
  return null;
}

export async function listReports(patientId?: string): Promise<CareReport[]> {
  const d = await getDriver();
  const index = ((await d.getDoc(K.reportIndex)) as string[] | null) ?? [];
  const out: CareReport[] = [];
  for (const id of [...index].reverse()) {
    const r = (await d.getDoc(K.report(id))) as CareReport | null;
    if (!r) continue;
    if (patientId && r.patientId !== patientId) continue;
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export async function appendAudit(entry: Omit<CareAuditEntry, "id" | "at">): Promise<CareAuditEntry> {
  const stored: CareAuditEntry = { id: newId("aud"), at: isoNow(), ...entry };
  const d = await getDriver();
  await d.appendList(K.audit, stored, 5000);
  return stored;
}

export async function listAudit(limit = 200): Promise<CareAuditEntry[]> {
  const d = await getDriver();
  const all = (await d.getList(K.audit)) as CareAuditEntry[];
  return all.slice(-limit).reverse();
}

// ---------------------------------------------------------------------------
// care tasks
// ---------------------------------------------------------------------------

export async function createTask(input: Omit<CareTask, "id" | "createdAt" | "status">): Promise<CareTask> {
  const task: CareTask = { id: newId("task"), createdAt: isoNow(), status: "open", ...input };
  const d = await getDriver();
  await d.appendList(K.tasks, task, 2000);
  return task;
}

export async function listTasks(patientId?: string): Promise<CareTask[]> {
  const d = await getDriver();
  const all = (await d.getList(K.tasks)) as CareTask[];
  // Keep only the most recent version of each task id.
  const byId = new Map<string, CareTask>();
  for (const t of all) byId.set(t.id, t);
  const latest = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return patientId ? latest.filter((t) => t.patientId === patientId) : latest;
}

export async function setTaskStatus(id: string, status: "open" | "done"): Promise<void> {
  // Tasks are stored as an append-only log; a status change appends the full
  // updated record, and readers keep the most recent version per id.
  const d = await getDriver();
  const all = (await d.getList(K.tasks)) as CareTask[];
  const latest = [...all].reverse().find((t) => t.id === id);
  if (!latest) return;
  await d.appendList(K.tasks, { ...latest, status }, 2000);
}

// ---------------------------------------------------------------------------
// patient messages (nurse -> patient)
// ---------------------------------------------------------------------------

export async function addMessage(input: {
  patientId: string;
  patientName: string;
  text: string;
  createdBy: string;
}): Promise<PatientMessage> {
  const text = input.text.trim().slice(0, 2000);
  const message: PatientMessage = {
    id: newId("msg"),
    patientId: input.patientId,
    patientName: input.patientName,
    text,
    createdAt: isoNow(),
    createdBy: input.createdBy,
    channel: "web-voice-demo",
  };
  const d = await getDriver();
  await d.appendList(K.messages, message, 2000);
  return message;
}

/** Newest first. Optionally limited to one patient. */
export async function listMessages(patientId?: string): Promise<PatientMessage[]> {
  const d = await getDriver();
  const all = (await d.getList(K.messages)) as PatientMessage[];
  const filtered = patientId ? all.filter((m) => m.patientId === patientId) : all;
  return [...filtered].reverse();
}

export async function markMessagesRead(patientId: string): Promise<void> {
  // Messages are an append-only log; a read marker appends the updated record.
  const d = await getDriver();
  const all = (await d.getList(K.messages)) as PatientMessage[];
  const unread = all.filter((m) => m.patientId === patientId && !m.readAt);
  const now = isoNow();
  for (const m of unread) await d.appendList(K.messages, { ...m, readAt: now }, 2000);
}

// ---------------------------------------------------------------------------
// login sessions (nurse auth)
// ---------------------------------------------------------------------------

export interface LoginRecord {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "nurse";
  expiresAt: string;
}

export async function putLogin(hash: string, rec: LoginRecord): Promise<void> {
  const d = await getDriver();
  await d.setDoc(K.login(hash), rec);
}

export async function getLogin(hash: string): Promise<LoginRecord | null> {
  const d = await getDriver();
  const rec = (await d.getDoc(K.login(hash))) as LoginRecord | null;
  if (!rec) return null;
  if (isExpired(rec.expiresAt)) {
    await delLogin(hash);
    return null;
  }
  return rec;
}

export async function delLogin(hash: string): Promise<void> {
  const d = await getDriver();
  await d.del(K.login(hash));
}

// ---------------------------------------------------------------------------
// inserted patient records (context for the care assistant)
// ---------------------------------------------------------------------------

/** Hard cap per record so one paste cannot bloat the context or the store. */
export const RECORD_MAX_CHARS = 40_000;

export async function addRecord(input: {
  patientId: string;
  title: string;
  source?: string;
  text: string;
  createdBy?: string;
  synthetic?: boolean;
}): Promise<PatientRecord> {
  const text = input.text.trim().slice(0, RECORD_MAX_CHARS);
  const record: PatientRecord = {
    id: newId("rec"),
    patientId: input.patientId,
    title: input.title.trim().slice(0, 160) || "Untitled record",
    source: input.source?.trim().slice(0, 80) || undefined,
    text,
    chars: text.length,
    createdAt: isoNow(),
    createdBy: input.createdBy,
    synthetic: input.synthetic,
  };
  const d = await getDriver();
  await d.setDoc(K.record(record.id), record);
  await d.appendList(K.recordIndex, record.id, 1000);
  return record;
}

/** Newest first. Missing documents (deleted) are skipped. */
export async function listRecords(patientId?: string): Promise<PatientRecord[]> {
  const d = await getDriver();
  const ids = (await d.getList(K.recordIndex)) as string[];
  const out: PatientRecord[] = [];
  for (const id of ids) {
    const rec = (await d.getDoc(K.record(id))) as PatientRecord | null;
    if (!rec) continue;
    if (patientId && rec.patientId !== patientId) continue;
    out.push(rec);
  }
  return out.reverse();
}

export async function getRecord(id: string): Promise<PatientRecord | null> {
  const d = await getDriver();
  return ((await d.getDoc(K.record(id))) as PatientRecord | null) ?? null;
}

/**
 * Records are append-only for auditability, so "delete" hides the document and
 * leaves the index entry. `listRecords` already skips documents that are gone.
 */
export async function deleteRecord(id: string): Promise<boolean> {
  const rec = await getRecord(id);
  if (!rec) return false;
  const d = await getDriver();
  await d.del(K.record(id));
  return true;
}

/**
 * Concatenates the most recent records for a patient into one context block.
 *
 * Newest first, bounded by `maxChars` so a long history still fits a model
 * prompt. Each block is labelled with its title, source and date so the
 * assistant can attribute what it says.
 */
export async function buildRecordContext(
  patientId: string,
  maxChars = 24_000
): Promise<{ text: string; used: PatientRecord[]; omitted: number }> {
  const all = await listRecords(patientId);
  const used: PatientRecord[] = [];
  const parts: string[] = [];
  let total = 0;
  for (const rec of all) {
    const header = `### ${rec.title}${rec.source ? ` (${rec.source})` : ""} — ${rec.createdAt.slice(0, 10)}`;
    const block = `${header}\n${rec.text}`;
    if (total + block.length > maxChars && parts.length > 0) break;
    parts.push(block);
    used.push(rec);
    total += block.length + 2;
  }
  return {
    text: parts.join("\n\n"),
    used,
    omitted: all.length - used.length,
  };
}

// ---------------------------------------------------------------------------
// session -> patient link (set from the nurse portal after scanning the QR)
// ---------------------------------------------------------------------------

export async function linkSessionToPatient(
  sessionId: string,
  patientId: string,
  linkedBy?: string
): Promise<SessionPatientLink> {
  const link: SessionPatientLink = {
    sessionId,
    patientId,
    linkedAt: isoNow(),
    linkedBy,
  };
  const d = await getDriver();
  await d.setDoc(K.sessionLink(sessionId), link);
  return link;
}

export async function getSessionLink(sessionId: string): Promise<SessionPatientLink | null> {
  const d = await getDriver();
  return ((await d.getDoc(K.sessionLink(sessionId))) as SessionPatientLink | null) ?? null;
}
