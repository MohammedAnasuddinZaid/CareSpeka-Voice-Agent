/**
 * Typed browser client for the Web Voice Call — Demo APIs.
 *
 * Everything goes through the CareSpeak origin with cookies for the nurse and a
 * participant token for the patient. No server secret is ever handled here.
 */
import type {
  CareAuditEntry,
  CareEvent,
  CareEventType,
  CareReport,
  CareSessionView,
  CareSignal,
  CareSignalKind,
  CareTask,
  CareTranscriptEntry,
  ClinicalPatient,
  JoinPreview,
  JoinResult,
  PatientMessage,
} from "@/lib/care/types";

export class CareApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CareApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { participant?: string | null } = {}
): Promise<T> {
  const { participant, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (rest.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (participant) headers.set("x-care-participant", participant);

  let res: Response;
  try {
    res = await fetch(path, { ...rest, headers, credentials: "include" });
  } catch {
    throw new CareApiError("Network unavailable. Check your connection.", 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  const body = (data ?? {}) as Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    throw new CareApiError(String(body.error || `Request failed (${res.status})`), res.status, String(body.code || ""));
  }
  return body as T;
}

// --- auth ------------------------------------------------------------------

export interface CareUser {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "nurse";
}

export async function careLogin(username: string, password: string) {
  return request<{ user: CareUser; warning?: string }>("/api/care/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function careLogout() {
  return request<{ ok: true }>("/api/care/auth/logout", { method: "POST" });
}

export async function careMe() {
  return request<{ user: CareUser; store: { driver: string; persistent: boolean } }>("/api/care/auth/me");
}

export interface CareConfig {
  mode: string;
  modeLabel: string;
  store: { driver: string; persistent: boolean };
  webrtc: { iceServers: RTCIceServer[]; turnConfigured: boolean };
  ai: { asrModel: string; llmModel: string; ttsEngine: string };
  limits: { maxSessionMinutes: number; joinTtlMinutes: number; signalPollMs: number };
}

export async function careConfig() {
  return request<CareConfig>("/api/care/config");
}

// --- patients --------------------------------------------------------------

export interface PatientSummary {
  id: string;
  extension: string;
  displayName: string;
  age: number | null;
  sex?: string;
  room?: string | null;
  primaryConcern?: string;
  synthetic: boolean;
  activeConditions: number;
  activeMedications: number;
  allergies: number;
}

export async function careListPatients() {
  return request<{ patients: PatientSummary[] }>("/api/care/patients");
}

export async function careGetPatient(id: string) {
  return request<{
    patient: ClinicalPatient;
    reports: CareReport[];
    tasks: CareTask[];
    sessions: Array<Record<string, unknown>>;
  }>(`/api/care/patients/${encodeURIComponent(id)}`);
}

// --- sessions --------------------------------------------------------------

export interface SessionSummary {
  id: string;
  patientId: string;
  patientName: string;
  nurseName: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  escalated: boolean;
  reportId?: string;
}

export async function careListSessions() {
  return request<{ sessions: SessionSummary[] }>("/api/care/sessions");
}

export async function careCreateSession(patientId: string) {
  return request<{ session: CareSessionView; qrDataUrl: string; joinToken: string }>("/api/care/sessions", {
    method: "POST",
    body: JSON.stringify({ patientId }),
  });
}

export interface InsightsPayload {
  symptoms: Array<{ label: string; category: string; redFlag: boolean }>;
  redFlags: string[];
  concerns: string[];
  historyRefs: Array<{ text: string; provenance: string }>;
  suggestedTopics: string[];
}

export async function careGetSession(
  id: string,
  opts: { sinceEvent?: number; sinceTranscript?: number; participant?: string | null } = {}
) {
  const qs = new URLSearchParams();
  if (opts.sinceEvent) qs.set("sinceEvent", String(opts.sinceEvent));
  if (opts.sinceTranscript) qs.set("sinceTranscript", String(opts.sinceTranscript));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<{
    session: CareSessionView;
    events: CareEvent[];
    transcript: CareTranscriptEntry[];
    insights?: InsightsPayload;
    tasks?: CareTask[];
  }>(`/api/care/sessions/${encodeURIComponent(id)}${suffix}`, { participant: opts.participant });
}

export async function careSessionAction(
  id: string,
  action: string,
  extra: Record<string, unknown> = {}
) {
  return request<{ session?: CareSessionView; task?: CareTask }>(
    `/api/care/sessions/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ action, ...extra }) }
  );
}

export async function careRegenerateQr(id: string) {
  return request<{ session: CareSessionView; qrDataUrl: string; joinToken: string }>(
    `/api/care/sessions/${encodeURIComponent(id)}/qr`
  );
}

// --- joining ---------------------------------------------------------------

export async function careJoinPreview(token: string) {
  return request<JoinPreview>(`/api/care/join?t=${encodeURIComponent(token)}`);
}

export async function careJoin(input: { token?: string; code?: string; name?: string; resumeToken?: string }) {
  return request<JoinResult>("/api/care/join", { method: "POST", body: JSON.stringify(input) });
}

// --- signalling ------------------------------------------------------------

export async function careSendSignal(
  sessionId: string,
  kind: CareSignalKind,
  data: unknown,
  participant?: string | null
) {
  return request<{ signal: CareSignal }>("/api/care/signal", {
    method: "POST",
    body: JSON.stringify({ sessionId, kind, data }),
    participant,
  });
}

export async function carePollSignals(sessionId: string, since: number, participant?: string | null) {
  return request<{ signals: CareSignal[]; role: "nurse" | "patient" }>(
    `/api/care/signal?sessionId=${encodeURIComponent(sessionId)}&since=${since}`,
    { participant }
  );
}

// --- events / transcript ---------------------------------------------------

export async function carePostEvent(
  sessionId: string,
  type: CareEventType,
  detail: Record<string, unknown> = {},
  participant?: string | null
) {
  return request<{ event: CareEvent }>("/api/care/events", {
    method: "POST",
    body: JSON.stringify({ sessionId, type, detail }),
    participant,
  });
}

export async function carePostTranscript(
  sessionId: string,
  entry: { role: "nurse" | "patient" | "agent" | "system"; text: string; engine?: string; confidence?: number; provisional?: boolean },
  participant?: string | null
) {
  return request<{ entry: CareTranscriptEntry; escalated: boolean }>("/api/care/transcript", {
    method: "POST",
    body: JSON.stringify({ sessionId, ...entry }),
    participant,
  });
}

export async function careFallbackAgent(sessionId: string, mode?: "greeting" | "reply") {
  return request<{
    entry: CareTranscriptEntry;
    text: string;
    escalate: boolean;
    escalationReason?: string;
    engine: string;
    insights: InsightsPayload;
  }>("/api/care/agent", { method: "POST", body: JSON.stringify({ sessionId, mode }) });
}

// --- reports ---------------------------------------------------------------

export async function careGenerateReport(sessionId: string, regenerate = false) {
  return request<{ report: CareReport; existing?: boolean }>("/api/care/report", {
    method: "POST",
    body: JSON.stringify({ sessionId, regenerate }),
  });
}

export async function careGetReport(id: string) {
  return request<{ report: CareReport }>(`/api/care/report/${encodeURIComponent(id)}`);
}

export async function carePatchReport(
  id: string,
  body: { action?: "approve" | "edit" | "reopen"; nurseEditedSummary?: string; reviewNote?: string }
) {
  return request<{ report: CareReport }>(`/api/care/report/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// --- audit / tasks ---------------------------------------------------------

export async function careAudit(patientId?: string, limit = 200) {
  const qs = new URLSearchParams();
  if (patientId) qs.set("patientId", patientId);
  qs.set("limit", String(limit));
  return request<{ audit: CareAuditEntry[] }>(`/api/care/audit?${qs.toString()}`);
}

export async function careTasks(patientId?: string) {
  const qs = patientId ? `?patientId=${encodeURIComponent(patientId)}` : "";
  return request<{ tasks: CareTask[] }>(`/api/care/tasks${qs}`);
}

export async function careSetTask(id: string, status: "open" | "done") {
  return request<{ tasks: CareTask[] }>("/api/care/tasks", {
    method: "PATCH",
    body: JSON.stringify({ id, status }),
  });
}

// --- nurse voice assistant --------------------------------------------------

export type AssistantAction =
  | { type: "send_message"; patientId: string; patientName: string; text: string }
  | { type: "start_call"; patientId: string; patientName: string };

export interface AssistantReply {
  answer: string;
  intent: string;
  engine: string;
  patientId?: string;
  action: AssistantAction | null;
  suggestedQuestions: string[];
}

/** Ask the care assistant a question about the patients (nurse only). */
export async function careAskAssistant(question: string, patientId?: string | null) {
  return request<AssistantReply>("/api/care/assistant", {
    method: "POST",
    body: JSON.stringify({ question, patientId: patientId ?? undefined }),
  });
}

// --- patient messages -------------------------------------------------------

export async function careListMessages(patientId?: string) {
  const qs = patientId ? `?patientId=${encodeURIComponent(patientId)}` : "";
  return request<{ messages: PatientMessage[] }>(`/api/care/messages${qs}`);
}

export async function careSendMessage(patientId: string, text: string) {
  return request<{ message: PatientMessage }>("/api/care/messages", {
    method: "POST",
    body: JSON.stringify({ patientId, text }),
  });
}
