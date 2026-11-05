/**
 * Typed client for the VoiceLink care-platform API.
 *
 * The browser talks to the local FastAPI backend with a session cookie. Every
 * request includes credentials so the dashboard works both same-origin and on
 * the local Next.js dev server (localhost:3000 -> localhost:8000).
 */

export type Role = "admin" | "nurse" | "patient" | "family";

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  patient_id: number | null;
  dev_bypass?: boolean;
}

export interface Contact {
  id: number;
  patient_id: number | null;
  role: string;
  display_name: string;
  phone_masked: string;
  preferred_channel: string;
  permissions: Record<string, unknown>;
  consent_status: string;
  verification_status: string;
  verified_at: string | null;
  is_primary: boolean;
  active: boolean;
}

export interface Patient {
  id: number;
  extension: string;
  display_name: string;
  age: number | null;
  room: string | null;
  primary_concern: string | null;
  language: string;
  synthetic: boolean;
  contacts?: Contact[];
}

export interface TelephonyCall {
  id: string;
  provider: string;
  provider_call_id: string | null;
  direction: string;
  from_masked: string | null;
  to_masked: string | null;
  patient_id: number | null;
  contact_id: number | null;
  purpose: string;
  state: string;
  provider_mode: string;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  error: string | null;
}

export interface StoredMessage {
  id: string;
  provider: string;
  provider_message_id: string | null;
  direction: string;
  channel: string;
  from_masked: string | null;
  to_masked: string | null;
  patient_id: number | null;
  body: string;
  state: string;
  provider_mode: string;
  created_at: string;
  delivered_at: string | null;
  error: string | null;
}

export interface Escalation {
  id: string;
  patient_id: number | null;
  call_id: string | null;
  severity: "routine" | "follow_up" | "urgent" | "emergency";
  category: string;
  reason: string;
  transcript_excerpt: string | null;
  state: "open" | "acknowledged" | "resolved" | "cancelled";
  requires_ack: boolean;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface EscalationAction {
  id: number;
  escalation_id: string;
  attempt: number;
  action_type: string;
  target_masked: string | null;
  state: string;
  result: string | null;
  created_at: string;
}

export interface FamilyRequest {
  id: string;
  patient_id: number;
  contact_id: number | null;
  mode: string;
  state: string;
  verification_state: string;
  requested_by: string | null;
  requested_at: string;
  expires_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  detail: string | null;
}

export interface ProviderSummary {
  provider: string;
  mode: string;
  operating_mode: string;
  configured: boolean;
  missing: string[];
  capabilities: Record<string, boolean>;
  media: { encoding: string; sample_rate: number; frame_ms: number };
  telephony_enabled: boolean;
  requested: string;
  resolved: string;
  available: Array<{
    provider: string;
    configured: boolean;
    mode: string;
    operating_mode: string;
    missing: string[];
  }>;
  webhook_base_url: string;
  public_base_url: string;
  secrets: Record<string, boolean>;
  mode_label: string;
  health?: Record<string, unknown>;
}

export interface OverviewData {
  active_calls: TelephonyCall[];
  open_escalations: Escalation[];
  unacknowledged_alerts: Escalation[];
  missed_calls: TelephonyCall[];
  pending_messages: StoredMessage[];
  escalation_actions: Record<string, EscalationAction[]>;
  counts: {
    active_calls: number;
    open_escalations: number;
    unacknowledged: number;
    missed_calls: number;
    pending_messages: number;
    scheduled_jobs: number;
  };
  telephony: ProviderSummary;
  webhook_ready: boolean;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  patient_id: number | null;
  detail: Record<string, unknown>;
}

export interface FollowUpJob {
  id: string;
  kind: string;
  patient_id: number | null;
  payload: Record<string, unknown>;
  run_at: string;
  state: string;
  attempts: number;
  last_error: string | null;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function backendBase(): string {
  const override = process.env.NEXT_PUBLIC_VOICELINK_BACKEND;
  if (override) return override.replace(/\/$/, "");
  if (typeof window === "undefined") return "http://127.0.0.1:8000";
  if (window.location.port === "3443") return window.location.origin;
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${backendBase()}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { detail: text };
    }
  }

  if (!response.ok) {
    const detail = (payload as { detail?: unknown })?.detail;
    let code = `http_${response.status}`;
    let message = `Request failed (${response.status}).`;
    if (typeof detail === "string") {
      message = detail;
    } else if (detail && typeof detail === "object") {
      const obj = detail as { code?: string; message?: string };
      code = obj.code || code;
      message = obj.message || message;
    }
    throw new ApiError(response.status, code, message);
  }
  return payload as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- auth -----------------------------------------------------------------
export async function login(username: string, password: string): Promise<SessionUser> {
  const data = await post<{ ok: boolean; user: SessionUser }>("/api/platform/auth/login", {
    username,
    password,
  });
  return data.user;
}

export async function logout(): Promise<void> {
  await post("/api/platform/auth/logout");
}

export async function me(): Promise<SessionUser | null> {
  try {
    const data = await get<{ ok: boolean; user: SessionUser }>("/api/platform/auth/me");
    return data.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

// --- overview / patients ---------------------------------------------------
export function getOverview(): Promise<OverviewData & { ok: boolean }> {
  return get("/api/platform/overview");
}

export function getPatients(): Promise<{ ok: boolean; patients: Patient[] }> {
  return get("/api/platform/patients");
}

export interface PatientDetail {
  ok: boolean;
  patient: Patient;
  contacts: Contact[];
  calls: TelephonyCall[];
  messages: StoredMessage[];
  escalations: Escalation[];
  permissions: Array<Record<string, unknown>>;
  follow_ups: FollowUpJob[];
}

export function getPatient(patientId: number): Promise<PatientDetail> {
  return get(`/api/platform/patients/${patientId}`);
}

export function addContact(input: {
  patient_id: number;
  role: string;
  display_name: string;
  phone: string;
  is_primary?: boolean;
  consent_status?: string;
  permissions?: Record<string, unknown>;
}): Promise<{ ok: boolean; contact: Contact }> {
  return post("/api/platform/contacts", input);
}

export function verifyContact(
  contactId: number,
  channel = "sms",
): Promise<{
  ok: boolean;
  challenge_id: string;
  phone_masked: string;
  expires_at: string;
  delivery: { sent: boolean; mode: string; detail: string };
  simulated_code: string | null;
}> {
  return post(`/api/platform/contacts/${contactId}/verify`, { channel });
}

export function confirmVerify(contactId: number, code: string): Promise<{ ok: boolean; verified: boolean }> {
  return post(`/api/platform/contacts/${contactId}/verify/confirm`, { code });
}

// --- calls ------------------------------------------------------------------
export function startCall(patientId: number, purpose = "nurse_to_patient_ai"): Promise<{
  ok: boolean;
  call?: TelephonyCall;
  mode?: string;
  accepted?: boolean;
  detail?: string;
  reason?: string;
  message?: string;
  duplicate?: boolean;
}> {
  return post("/api/platform/calls", { patient_id: patientId, purpose });
}

export function endCall(callId: string): Promise<{ ok: boolean; call?: TelephonyCall }> {
  return post(`/api/platform/calls/${callId}/end`);
}

export function getCalls(patientId?: number): Promise<{ ok: boolean; calls: TelephonyCall[]; telephony: ProviderSummary }> {
  const query = patientId === undefined ? "" : `?patient_id=${patientId}`;
  return get(`/api/platform/calls${query}`);
}

// --- messages ---------------------------------------------------------------
export function sendMessage(input: {
  patient_id: number;
  body: string;
  channel?: string;
  allow_quiet_hours?: boolean;
}): Promise<{
  ok: boolean;
  message?: StoredMessage | string;
  mode?: string;
  accepted?: boolean;
  detail?: string;
  reason?: string;
  duplicate?: boolean;
}> {
  return post("/api/platform/messages", input);
}

export function getMessages(patientId?: number): Promise<{ ok: boolean; messages: StoredMessage[] }> {
  const query = patientId === undefined ? "" : `?patient_id=${patientId}`;
  return get(`/api/platform/messages${query}`);
}

// --- escalations ------------------------------------------------------------
export function getEscalations(state?: string): Promise<{
  ok: boolean;
  escalations: Escalation[];
  actions: Record<string, EscalationAction[]>;
}> {
  const query = state ? `?state=${encodeURIComponent(state)}` : "";
  return get(`/api/platform/escalations${query}`);
}

export function acknowledgeEscalation(id: string, note = ""): Promise<{ ok: boolean; escalation: Escalation }> {
  return post(`/api/platform/escalations/${id}/ack`, { note });
}

export function resolveEscalation(id: string, note = ""): Promise<{ ok: boolean; escalation: Escalation }> {
  return post(`/api/platform/escalations/${id}/resolve`, { note });
}

// --- family -----------------------------------------------------------------
export function getFamilyPermissions(patientId?: number): Promise<{
  ok: boolean;
  permissions: Array<Record<string, unknown>>;
}> {
  const query = patientId === undefined ? "" : `?patient_id=${patientId}`;
  return get(`/api/platform/family/permissions${query}`);
}

export function grantFamilyPermission(input: {
  patient_id: number;
  contact_id: number;
  scope: Record<string, unknown>;
}): Promise<{ ok: boolean }> {
  return post("/api/platform/family/permissions", input);
}

export function revokeFamilyPermission(patientId: number, contactId: number): Promise<{ ok: boolean }> {
  return post(`/api/platform/family/permissions/${patientId}/${contactId}/revoke`);
}

export function getFamilyRequests(state?: string): Promise<{ ok: boolean; requests: FamilyRequest[] }> {
  const query = state ? `?state=${encodeURIComponent(state)}` : "";
  return get(`/api/platform/family/requests${query}`);
}

export function createFamilyRequest(input: {
  patient_id: number;
  contact_id: number;
  mode: string;
  detail?: string;
}): Promise<{ ok: boolean; request: FamilyRequest }> {
  return post("/api/platform/family/requests", input);
}

export function approveFamilyRequest(id: string, note = ""): Promise<{ ok: boolean; request: FamilyRequest }> {
  return post(`/api/platform/family/requests/${id}/approve`, { note });
}

export function denyFamilyRequest(id: string, note = ""): Promise<{ ok: boolean; request: FamilyRequest }> {
  return post(`/api/platform/family/requests/${id}/deny`, { note });
}

// --- follow-ups -------------------------------------------------------------
export function scheduleFollowUp(input: {
  patient_id: number;
  kind: string;
  delay_minutes: number;
  body?: string;
  channel?: string;
}): Promise<{ ok: boolean; job: FollowUpJob }> {
  return post("/api/platform/follow-ups", input);
}

export function getFollowUps(patientId?: number): Promise<{ ok: boolean; jobs: FollowUpJob[] }> {
  const query = patientId === undefined ? "" : `?patient_id=${patientId}`;
  return get(`/api/platform/follow-ups${query}`);
}

export function cancelFollowUp(jobId: string): Promise<{ ok: boolean }> {
  return post(`/api/platform/follow-ups/${jobId}/cancel`);
}

// --- provider ---------------------------------------------------------------
export function getProvider(): Promise<{
  ok: boolean;
  provider: ProviderSummary;
}> {
  return get("/api/platform/provider");
}

export function saveProviderSecrets(values: Record<string, string>): Promise<{
  ok: boolean;
  stored: string[];
  provider: ProviderSummary;
}> {
  return post("/api/platform/provider/secrets", { values });
}

export function testProvider(): Promise<{
  ok: boolean;
  health: Record<string, unknown>;
  webhook_ready: boolean;
  webhook_base_url: string;
  note: string;
}> {
  return post("/api/platform/provider/test");
}

// --- audit / reports --------------------------------------------------------
export function getAudit(limit = 100): Promise<{
  ok: boolean;
  entries: AuditEntry[];
  chain: { ok: boolean; entries?: number; broken_at?: number };
}> {
  return get(`/api/platform/audit?limit=${limit}`);
}

export function getReports(): Promise<{
  ok: boolean;
  totals: { calls: number; messages: number; escalations: number };
  calls_by_state: Record<string, number>;
  messages_by_state: Record<string, number>;
  escalations_by_severity: Record<string, number>;
  telephony: ProviderSummary;
}> {
  return get("/api/platform/reports");
}