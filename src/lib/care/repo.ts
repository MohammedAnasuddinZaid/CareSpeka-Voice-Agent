/**
 * Repository layer for the Web Voice Call — Demo.
 *
 * All persistence goes through here so API routes stay thin and the storage
 * driver stays swappable. Server-only.
 */
import { getDriver, CareKeys as K, type DriverName } from "./store";
import { getSeedPatient, SYNTHETIC_ADDITION_IDS, SYNTHETIC_PATIENTS, SYNTHETIC_SEED_VERSION } from "./seedPatients";
import { hashToken, isExpired, isoNow, newId, newJoinCode, newToken } from "./crypto";
import type {
  CareAuditEntry,
  CareEvent,
  CareEventType,
  CareReport,
  CareRole,
  CareSession,
  CareSessionStatus,
  CareSignal,
  CareTask,
  CareTranscriptEntry,
  ClinicalPatient,
  PatientMessage,
  PatientRecord,
  SessionPatientLink,
} from "./types";
import { ensureDemoSeed, ensurePatientRecordSeed } from "./seedDemo";

// ---------------------------------------------------------------------------
// runtime validation
//
// The memory/file drivers can contain hand-edited or legacy documents, and a
// Redis value can be corrupted or written by an older build. Every value that
// crosses the driver boundary is narrowed here, so one bad record cannot crash
// a route with `undefined.filter is not a function` or a half-populated session.
// ---------------------------------------------------------------------------

const SESSION_STATUSES = new Set<CareSessionStatus>([
  "created",
  "waiting",
  "active",
  "ending",
  "ended",
  "expired",
  "error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asCareSession(value: unknown): CareSession | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.patientId !== "string" ||
    typeof value.nurseId !== "string" ||
    typeof value.nurseName !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.status !== "string" ||
    !SESSION_STATUSES.has(value.status as CareSessionStatus)
  ) {
    return null;
  }
  return value as unknown as CareSession;
}

function asClinicalPatient(value: unknown): ClinicalPatient | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.displayName !== "string") return null;
  const out: Record<string, unknown> = { ...value };
  for (const key of ["conditions", "medications", "allergies", "observations", "encounters"]) {
    if (!Array.isArray(out[key])) out[key] = [];
  }
  return out as unknown as ClinicalPatient;
}

function asSessionLink(value: unknown): SessionPatientLink | null {
  if (!isRecord(value)) return null;
  if (typeof value.sessionId !== "string" || typeof value.patientId !== "string") return null;
  return value as unknown as SessionPatientLink;
}

function isCareEvent(value: unknown): value is CareEvent {
  return isRecord(value) && typeof value.seq === "number" && typeof value.type === "string" && typeof value.at === "string";
}

function isTranscriptEntry(value: unknown): value is CareTranscriptEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.seq === "number" &&
    typeof value.role === "string" &&
    typeof value.text === "string" &&
    typeof value.at === "string"
  );
}

function isCareSignal(value: unknown): value is CareSignal {
  return isRecord(value) && typeof value.idx === "number" && typeof value.kind === "string" && typeof value.at === "string";
}

function isPatientMessage(value: unknown): value is PatientMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.patientId === "string" &&
    typeof value.text === "string" &&
    typeof value.createdAt === "string"
  );
}

function isPatientRecord(value: unknown): value is PatientRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.patientId === "string";
}

/** Session-scoped auxiliary keys (links, metrics, pairing) use uppercase ids. */
function sessionKey(id: string): string {
  return id.trim().toUpperCase();
}


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

  if ((process.env.CARE_SEED_DEMO ?? "").toLowerCase() === "false") {
    if (!(await d.getDoc(K.patientSeeded))) await d.setDoc(K.patientSeeded, true);
    return;
  }

  const seeded = await d.getDoc(K.patientSeeded);
  const index = stringArray(await d.getDoc(K.patientIndex));
  const version = Number((await d.getDoc(K.patientSeedVersion)) ?? 0) || 0;

  // First run: write the whole synthetic dataset.
  if (!seeded && !index.length) {
    for (const p of SYNTHETIC_PATIENTS) await d.setDoc(K.patient(p.id), p);
    await d.setDoc(K.patientIndex, SYNTHETIC_PATIENTS.map((p) => p.id));
    await d.setDoc(K.patientSeeded, true);
    await d.setDoc(K.patientSeedVersion, SYNTHETIC_SEED_VERSION);
  } else if (version < SYNTHETIC_SEED_VERSION) {
    // Existing store: refresh synthetic patients and add only the newly
    // introduced ones. A deleted patient has a tombstone, so it is never
    // resurrected here.
    const nextIndex = new Set(index);
    for (const p of SYNTHETIC_PATIENTS) {
      if (await d.getDoc(K.patientDeleted(p.id))) {
        nextIndex.delete(p.id);
        continue;
      }
      const existing = asClinicalPatient(await d.getDoc(K.patient(p.id)));
      if (existing) {
        if (existing.synthetic) await d.setDoc(K.patient(p.id), p);
        nextIndex.add(p.id);
      } else if (SYNTHETIC_ADDITION_IDS.has(p.id)) {
        await d.setDoc(K.patient(p.id), p);
        nextIndex.add(p.id);
      }
    }
    await d.setDoc(K.patientIndex, [...nextIndex]);
    await d.setDoc(K.patientSeedVersion, SYNTHETIC_SEED_VERSION);
    if (!seeded) await d.setDoc(K.patientSeeded, true);
  }

  await ensurePatientRecordSeed();
}

export async function listPatients(): Promise<ClinicalPatient[]> {
  await ensurePatientsSeeded();
  await ensureDemoSeed();
  const d = await getDriver();
  const index = stringArray(await d.getDoc(K.patientIndex));
  const out: ClinicalPatient[] = [];
  for (const id of index) {
    const p = asClinicalPatient(await d.getDoc(K.patient(id)));
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getPatient(id: string): Promise<ClinicalPatient | null> {
  await ensurePatientsSeeded();
  const d = await getDriver();
  const p = asClinicalPatient(await d.getDoc(K.patient(id)));
  if (p) return p;
  if (await d.getDoc(K.patientDeleted(id))) return null;
  return getSeedPatient(id) ?? null;
}

/**
 * Creates a new patient record the nurse can immediately add documents for and
 * link to a bed's session. Real (non-synthetic) and empty at birth — conditions,
 * medications, allergies and observations start blank and are added through the
 * records intake, so nothing is invented.
 */
export async function createPatient(input: {
  displayName: string;
  age?: number | null;
  sex?: string;
  room?: string;
  primaryConcern?: string;
  carePlan?: string;
  language?: string;
}): Promise<ClinicalPatient> {
  await ensurePatientsSeeded();
  const d = await getDriver();
  const id = newId("pt");

  // Reserve the index slot atomically so two nurses creating a patient at the
  // same moment cannot overwrite each other's index (lost patient) or reuse an
  // extension number.
  let extension = "1001";
  await d.mutateDoc<string[]>(K.patientIndex, (current) => {
    const index = stringArray(current);
    extension = String(1000 + index.length + 1);
    return [...index, id].slice(-2000);
  });

  const patient: ClinicalPatient = {
    id,
    extension,
    displayName: input.displayName.trim().slice(0, 120) || "Unnamed patient",
    age: input.age ?? null,
    sex: input.sex?.trim() || undefined,
    room: input.room?.trim() || undefined,
    primaryConcern: input.primaryConcern?.trim() || undefined,
    language: input.language?.trim() || "en",
    synthetic: false,
    carePlan: input.carePlan?.trim() || undefined,
    conditions: [],
    medications: [],
    allergies: [],
    observations: [],
    encounters: [],
  };
  await d.setDoc(K.patient(id), patient);
  return patient;
}

/**
 * Removes a patient and their records. Used to clear demo patients so only the
 * real patient(s) remain. Never removes the seeded demo data's seed marker, so
 * deleted patients stay deleted.
 */
export async function deletePatient(id: string): Promise<boolean> {
  await ensurePatientsSeeded();
  const d = await getDriver();
  const patient = asClinicalPatient(await d.getDoc(K.patient(id)));
  if (!patient) return false;

  // remove their records
  const recordIds = await readRecordIndex();
  const keptRecordIds: string[] = [];
  for (const rid of recordIds) {
    const rec = await d.getDoc(K.record(rid));
    if (isRecord(rec) && rec.patientId === id) {
      await d.del(K.record(rid));
      continue;
    }
    if (rec) keptRecordIds.push(rid);
  }
  await d.setList(K.recordIndex, keptRecordIds);

  await d.del(K.patient(id));
  // Tombstone so demo reconciliation can never resurrect a patient the nurse
  // deliberately removed.
  await d.setDoc(K.patientDeleted(id), { at: isoNow() });
  await d.mutateDoc<string[]>(K.patientIndex, (current) => {
    return stringArray(current).filter((x) => x !== id);
  });
  return true;
}

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
  await d.mutateDoc<string[]>(K.sessionIndex, (current) => {
    const index = stringArray(current);
    if (!index.includes(session.id)) index.push(session.id);
    return index.slice(-500);
  });
  await appendEventInternal(session.id, "session.created", "nurse", { patientId: session.patientId });
  await appendEventInternal(session.id, "join.link_generated", "system", { expiresAt: session.joinExpiresAt });
  return { session: (await getSession(session.id))!, joinToken };
}

export async function getSession(id: string): Promise<CareSession | null> {
  const d = await getDriver();
  return asCareSession(await d.getDoc(K.session(id)));
}

/**
 * Session lookup that tolerates the uppercase form used by the API routes.
 * Care session ids are lowercase (`wc_...`); most endpoints normalise the
 * caller-supplied id to uppercase, so a direct lookup would miss the row.
 */
export async function getSessionLoose(id: string): Promise<CareSession | null> {
  const direct = await getSession(id);
  if (direct) return direct;
  const lower = id.toLowerCase();
  if (lower !== id) return getSession(lower);
  return null;
}

export async function listSessions(limit = 50): Promise<CareSession[]> {
  await ensureDemoSeed();
  const d = await getDriver();
  const index = stringArray(await d.getDoc(K.sessionIndex));
  const out: CareSession[] = [];
  for (const id of index.slice(-limit).reverse()) {
    const s = asCareSession(await d.getDoc(K.session(id)));
    if (s) out.push(s);
  }
  return out;
}

/** Find a waiting session by its human-typeable joining code. */
export async function findSessionByJoinCode(code: string): Promise<CareSession | null> {
  const d = await getDriver();
  const index = stringArray(await d.getDoc(K.sessionIndex));
  for (const id of [...index].reverse()) {
    const s = asCareSession(await d.getDoc(K.session(id)));
    if (s && s.joinCode === code) return s;
  }
  return null;
}

export async function updateSession(id: string, patch: Partial<CareSession>): Promise<CareSession | null> {
  const d = await getDriver();
  // Atomic read-modify-write: concurrent updates to different fields (a join
  // setting joinedAt while the nurse ends the session, for example) must not
  // overwrite each other.
  return d.mutateDoc<CareSession>(K.session(id), (current) => {
    if (!current) return null;
    return { ...current, ...patch, id: current.id };
  });
}

/**
 * Claim the single participant slot for a session, atomically.
 *
 * Returns the updated session for exactly one caller. Everyone else gets
 * `null` (already joined / ended / expired), which the join route turns into a
 * 409/410. This closes the race where two concurrent POSTs both observed
 * `joinedAt` unset and the second silently invalidated the first token.
 */
export async function joinSessionAtomic(
  sessionId: string,
  patch: Partial<CareSession>
): Promise<CareSession | null> {
  const d = await getDriver();
  return d.mutateDoc<CareSession>(K.session(sessionId), (current) => {
    if (!current) return null;
    if (current.joinedAt) return null;
    if (current.status === "ended" || current.status === "expired") return null;
    if ((current.status === "waiting" || current.status === "created") && isExpired(current.joinExpiresAt)) {
      return null;
    }
    return { ...current, ...patch, id: current.id };
  });
}

export async function findSessionByJoinToken(raw: string): Promise<CareSession | null> {
  const d = await getDriver();
  const id = await d.getDoc(K.joinToken(hashToken(raw)));
  if (typeof id !== "string" || !id) return null;
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

/** Remove the index entry for a token that lost the join race. */
export async function unlinkParticipantToken(raw: string): Promise<void> {
  const d = await getDriver();
  await d.del(K.participant(hashToken(raw)));
}

export async function findSessionByParticipantToken(raw: string): Promise<CareSession | null> {
  const d = await getDriver();
  const hash = hashToken(raw);
  const id = await d.getDoc(K.participant(hash));
  if (typeof id !== "string" || !id) return null;
  const session = await getSession(id);
  // Verify the stored hash still matches, so a re-join invalidates any earlier token.
  if (!session || session.participantTokenHash !== hash) return null;
  return session;
}

/** Expire a session whose join window passed before anyone connected. */
export async function expireIfStale(session: CareSession): Promise<CareSession> {
  if ((session.status !== "waiting" && session.status !== "created") || !isExpired(session.joinExpiresAt)) {
    return session;
  }
  const d = await getDriver();
  // Re-check inside the atomic write: a join may have won the race between the
  // caller's read and this update, and must not be overwritten as expired.
  const updated = await d.mutateDoc<CareSession>(K.session(session.id), (current) => {
    if (!current) return null;
    if (current.status !== "waiting" && current.status !== "created") return null;
    if (!isExpired(current.joinExpiresAt)) return null;
    return { ...current, status: "expired" };
  });
  return updated ?? (await getSession(session.id)) ?? session;
}

export async function endSession(id: string, reason: string): Promise<CareSession | null> {
  const s = await getSession(id);
  if (!s) return null;
  if (s.status === "ended") return s;

  const d = await getDriver();
  const endedAt = isoNow();
  let changed = false;
  // Decide the duration inside the atomic update so a concurrent join that sets
  // startedAt cannot be lost.
  const updated = await d.mutateDoc<CareSession>(K.session(id), (current) => {
    if (!current) return null;
    if (current.status === "ended") return current;
    changed = true;
    const started = current.startedAt ? Date.parse(current.startedAt) : Date.parse(current.createdAt);
    const durationMs = Math.max(0, Date.now() - (Number.isFinite(started) ? started : Date.now()));
    return { ...current, status: "ended", endedAt, durationMs, endReason: reason };
  });
  if (!updated) return null;
  if (changed) {
    await appendEventInternal(id, "session.ended", "nurse", { reason, durationMs: updated.durationMs ?? 0 });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

async function nextSeq(sessionId: string): Promise<number> {
  const d = await getDriver();
  const key = K.sessionSeq(sessionId);
  // One-time migration: seeded/legacy sessions carry seq on the session row but
  // have no counter yet. INCR alone would restart at 1 and make existing events
  // invisible to `sinceSeq` clients. SET NX seeds exactly once across instances.
  const session = await getSession(sessionId);
  await d.setDocIfAbsent(key, Math.max(0, session?.seq ?? 0));
  return d.incr(key, 1);
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
  const all = await d.getList(K.events(sessionId));
  return all.filter(isCareEvent).filter((e) => e.seq > sinceSeq);
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
  const all = await d.getList(K.transcript(sessionId));
  return all.filter(isTranscriptEntry).filter((t) => t.seq > sinceSeq);
}

export async function getTranscriptRaw(sessionId: string): Promise<CareTranscriptEntry[]> {
  const d = await getDriver();
  const all = await d.getList(K.transcript(sessionId));
  return all.filter(isTranscriptEntry);
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
  const counterKey = K.signalSeq(sessionId, to);
  // Seed the counter from the existing list once (legacy sessions have signals
  // but no counter). Thereafter INCR guarantees unique, gap-free indexes even
  // when two peers post at the same instant.
  const current = await d.getDoc(counterKey);
  if (typeof current !== "number" || !Number.isFinite(current)) {
    const existing = await d.getList(K.signal(sessionId, to));
    await d.setDocIfAbsent(counterKey, existing.length);
  }
  const idx = (await d.incr(counterKey, 1)) - 1;
  const stored: CareSignal = { ...signal, idx, at: isoNow() };
  await d.appendList(K.signal(sessionId, to), stored, 1000);
  return stored;
}

export async function listSignals(sessionId: string, to: "nurse" | "patient", sinceIdx = 0): Promise<CareSignal[]> {
  const d = await getDriver();
  const all = await d.getList(K.signal(sessionId, to));
  return all.filter(isCareSignal).filter((s) => s.idx >= sinceIdx);
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

export async function putReport(report: CareReport): Promise<void> {
  const d = await getDriver();
  await d.setDoc(K.report(report.id), report);
  await d.mutateDoc<string[]>(K.reportIndex, (current) => {
    const index = stringArray(current);
    if (!index.includes(report.id)) index.push(report.id);
    return index.slice(-1000);
  });
}

export async function getReport(id: string): Promise<CareReport | null> {
  const d = await getDriver();
  return ((await d.getDoc(K.report(id))) as CareReport | null) ?? null;
}

export async function getReportBySession(sessionId: string): Promise<CareReport | null> {
  const d = await getDriver();
  const index = stringArray(await d.getDoc(K.reportIndex));
  for (const id of [...index].reverse()) {
    const r = (await d.getDoc(K.report(id))) as CareReport | null;
    if (r?.sessionId === sessionId) return r;
  }
  return null;
}

export async function listReports(patientId?: string): Promise<CareReport[]> {
  const d = await getDriver();
  const index = stringArray(await d.getDoc(K.reportIndex));
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
  const all = await d.getList(K.tasks);
  // Keep only the most recent version of each task id. Remember the position of
  // each task's FIRST append so a status update (which re-appends the record
  // with the same createdAt) does not jump it around the list. Ties on
  // createdAt — two tasks created in the same millisecond — break by append
  // order so the newer one is always first.
  const byId = new Map<string, { task: CareTask; index: number }>();
  let index = 0;
  for (const raw of all) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.createdAt !== "string") continue;
    const task = raw as unknown as CareTask;
    const existing = byId.get(task.id);
    if (existing) existing.task = task;
    else byId.set(task.id, { task, index: index++ });
  }
  const latest = [...byId.values()]
    .sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt) || b.index - a.index)
    .map((entry) => entry.task);
  return patientId ? latest.filter((t) => t.patientId === patientId) : latest;
}

export async function setTaskStatus(id: string, status: "open" | "done"): Promise<boolean> {
  // Tasks are stored as an append-only log; a status change appends the full
  // updated record, and readers keep the most recent version per id.
  const d = await getDriver();
  const all = await d.getList(K.tasks);
  const latest = [...all].reverse().find((t): t is CareTask => isRecord(t) && t.id === id);
  if (!latest) return false;
  await d.appendList(K.tasks, { ...latest, status }, 2000);
  return true;
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

/** Newest first. Optionally limited to one patient. Deduped by id: a read
 *  marker appends a second copy of the same message, and returning both made
 *  every read message appear twice in the UI. */
export async function listMessages(patientId?: string): Promise<PatientMessage[]> {
  const d = await getDriver();
  const all = await d.getList(K.messages);
  // Keep the most recent version per id, but remember the position of its
  // first append: a read marker updates content, it does not re-post the
  // message. Ties on createdAt (same millisecond) fall back to append order so
  // a message can never appear older than one written before it.
  const byId = new Map<string, { message: PatientMessage; index: number }>();
  let index = 0;
  for (const raw of all) {
    if (!isPatientMessage(raw)) continue;
    const existing = byId.get(raw.id);
    if (existing) existing.message = raw;
    else byId.set(raw.id, { message: raw, index: index++ });
  }
  const filtered = [...byId.values()].filter(
    (entry) => !patientId || entry.message.patientId === patientId
  );
  return filtered
    .sort(
      (a, b) =>
        b.message.createdAt.localeCompare(a.message.createdAt) || b.index - a.index
    )
    .map((entry) => entry.message);
}

export async function markMessagesRead(patientId: string): Promise<void> {
  // Messages are an append-only log; a read marker appends the updated record.
  // Work from the latest version per id so an already-read message is not
  // appended again on every poll.
  const d = await getDriver();
  const all = await d.getList(K.messages);
  const latest = new Map<string, PatientMessage>();
  for (const raw of all) {
    if (isPatientMessage(raw)) latest.set(raw.id, raw);
  }
  const now = isoNow();
  for (const m of latest.values()) {
    if (m.patientId === patientId && !m.readAt) {
      await d.appendList(K.messages, { ...m, readAt: now }, 2000);
    }
  }
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

/**
 * Read the record index, healing the legacy shape where an older build stored
 * it as a JSON document instead of a list.
 *
 * The old code only tried the document fallback inside a `catch`, but the
 * memory and file drivers return `[]` (they do not throw) for a missing list
 * key, so a doc-shaped index silently produced zero records. Check the
 * document whenever the list is empty, regardless of driver.
 */
async function readRecordIndex(): Promise<string[]> {
  const d = await getDriver();
  let listed: unknown[] = [];
  try {
    listed = await d.getList(K.recordIndex);
  } catch {
    listed = [];
  }
  const fromList = listed.filter((x): x is string => typeof x === "string");
  if (fromList.length) return fromList;

  const raw = await d.getDoc(K.recordIndex);
  if (!Array.isArray(raw)) return [];
  const healed = raw.filter((x): x is string => typeof x === "string");
  await d.setList(K.recordIndex, healed).catch(() => undefined);
  return healed;
}

/** Newest first. Missing documents (deleted) are skipped. */
export async function listRecords(patientId?: string): Promise<PatientRecord[]> {
  const ids = await readRecordIndex();
  const d = await getDriver();
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
  const key = sessionKey(sessionId);
  const link: SessionPatientLink = {
    sessionId: key,
    patientId,
    linkedAt: isoNow(),
    linkedBy,
  };
  const d = await getDriver();
  await d.setDoc(K.sessionLink(key), link);
  await d.del(K.sessionUnlinked(key));
  return link;
}

export async function getSessionLink(sessionId: string): Promise<SessionPatientLink | null> {
  const d = await getDriver();
  return asSessionLink(await d.getDoc(K.sessionLink(sessionKey(sessionId))));
}

export async function unlinkSessionPatient(sessionId: string): Promise<void> {
  const key = sessionKey(sessionId);
  const d = await getDriver();
  await d.del(K.sessionLink(key));
  await d.setDoc(K.sessionUnlinked(key), true);
}
