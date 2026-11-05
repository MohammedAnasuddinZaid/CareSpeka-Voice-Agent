/**
 * Web Voice Call — Demo: domain types.
 *
 * This module is the browser-to-browser care-call feature that runs entirely on
 * Vercel (Next.js route handlers) with native WebRTC media and AI inference
 * hosted in the nurse's browser. It is additive: nothing here changes or removes
 * the existing CareSpeak gesture/eye features or the VoiceLink telephony stack.
 *
 * Every value in these types is either stored server-side or derived from stored
 * data. Nothing is fabricated at render time.
 */

export const CARE_MODE = "web-voice-demo" as const;
export const CARE_MODE_LABEL = "Web Voice Call — Demo" as const;

export type CareRole = "nurse" | "patient" | "agent" | "system";

export type Provenance = "record" | "patient" | "ai";

// --- clinical record (synthetic for the hackathon) -------------------------

export interface ClinicalCondition {
  id: string;
  code?: string;
  name: string;
  status: "active" | "resolved" | "history";
  since?: string;
  note?: string;
}

export interface ClinicalMedication {
  id: string;
  name: string;
  dose?: string;
  route?: string;
  frequency?: string;
  status: "active" | "stopped";
  since?: string;
  note?: string;
}

export interface ClinicalAllergy {
  id: string;
  substance: string;
  reaction?: string;
  severity: "mild" | "moderate" | "severe" | "unknown";
}

export interface ClinicalObservation {
  id: string;
  label: string;
  value: number | string;
  unit?: string;
  at: string;
  provenance: Provenance;
}

export interface EncounterSummary {
  id: string;
  at: string;
  kind: "web-voice-call" | "in-person" | "telephony" | "message";
  summary: string;
  by?: string;
}

export interface ClinicalPatient {
  id: string;
  extension: string;
  displayName: string;
  age: number | null;
  sex?: string;
  room?: string;
  primaryConcern?: string;
  language: string;
  synthetic: boolean;
  carePlan?: string;
  conditions: ClinicalCondition[];
  medications: ClinicalMedication[];
  allergies: ClinicalAllergy[];
  observations: ClinicalObservation[];
  encounters: EncounterSummary[];
}

// --- session lifecycle -----------------------------------------------------

export type CareSessionStatus =
  | "created"
  | "waiting"
  | "active"
  | "ending"
  | "ended"
  | "expired"
  | "error";

export interface CareSession {
  id: string;
  mode: typeof CARE_MODE;
  patientId: string;
  nurseId: string;
  nurseName: string;
  status: CareSessionStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Only the hash of the join token is ever stored server-side. */
  joinTokenHash: string;
  /** Human-typeable fallback code (not a secret on its own; still authorised). */
  joinCode: string;
  joinExpiresAt: string;
  joinedAt?: string;
  participantName?: string;
  participantTokenHash?: string;
  endReason?: string;
  reportId?: string;
  escalated: boolean;
  /** Last event sequence number allocated for this session. */
  seq: number;
}

export type CareEventType =
  | "session.created"
  | "join.link_generated"
  | "session.joined"
  | "participant.connected"
  | "participant.disconnected"
  | "agent.connected"
  | "agent.disconnected"
  | "mic.granted"
  | "mic.denied"
  | "speech.started"
  | "speech.ended"
  | "transcript.updated"
  | "agent.response.started"
  | "agent.response.completed"
  | "escalation.created"
  | "escalation.acknowledged"
  | "session.resumed"
  | "session.ended"
  | "report.generated"
  | "report.reviewed"
  | "task.created"
  | "signal.beacon"
  | "error";

export interface CareEvent {
  seq: number;
  at: string;
  type: CareEventType;
  actor: CareRole;
  detail?: Record<string, unknown>;
}

export interface CareTranscriptEntry {
  id: string;
  seq: number;
  sessionId: string;
  role: CareRole;
  text: string;
  at: string;
  /** Honest label of the component that produced the text. */
  engine?: string;
  confidence?: number;
  provisional?: boolean;
}

// --- signalling (HTTP polling) ---------------------------------------------

export type CareSignalKind = "offer" | "answer" | "ice" | "ready" | "bye" | "beacon";

export interface CareSignal {
  idx: number;
  at: string;
  from: "nurse" | "patient";
  kind: CareSignalKind;
  data: unknown;
}

// --- report ----------------------------------------------------------------

export interface CareReportFact {
  text: string;
  provenance: Provenance;
}

export interface CareReport {
  id: string;
  sessionId: string;
  patientId: string;
  status: "draft" | "approved";
  generatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  nurseEditedSummary?: string;
  sections: {
    reasonForInteraction: string;
    patientReportedSymptoms: CareReportFact[];
    symptomDuration: string;
    relevantHistory: CareReportFact[];
    medicationsDiscussed: CareReportFact[];
    allergiesDiscussed: CareReportFact[];
    keyPoints: string[];
    aiSummary: string;
    concernsForNurse: CareReportFact[];
    escalations: string[];
    suggestedFollowUp: string[];
    unresolvedQuestions: string[];
  };
  transcriptRef: { count: number; firstSeq: number; lastSeq: number };
  transcript: CareTranscriptEntry[];
  sourceFlags: {
    recordDerived: boolean;
    patientReported: boolean;
    aiGenerated: boolean;
    reviewed: boolean;
  };
}

// --- audit -----------------------------------------------------------------

export interface CareAuditEntry {
  id: string;
  at: string;
  actorRole: string;
  actorId?: string;
  action: string;
  sessionId?: string;
  patientId?: string;
  detail?: Record<string, unknown>;
}

// --- care tasks ------------------------------------------------------------

export interface CareTask {
  id: string;
  patientId: string;
  sessionId?: string;
  title: string;
  status: "open" | "done";
  createdAt: string;
  createdBy: string;
  due?: string;
}

// --- public views (never leak server secrets) ------------------------------

export type CareSessionView = Omit<
  CareSession,
  "joinTokenHash" | "participantTokenHash" | "joinCode" | "nurseId"
> & {
  joinCode?: string;
  joinUrl?: string;
  patient?: ClinicalPatient;
  report?: CareReport | null;
};

export interface JoinPreview {
  ok: true;
  sessionId: string;
  status: CareSessionStatus;
  nurseName: string;
  patientName: string;
  expiresAt: string;
  expired: boolean;
  alreadyJoined: boolean;
  mode: typeof CARE_MODE;
  modeLabel: typeof CARE_MODE_LABEL;
}

export interface JoinResult {
  ok: true;
  sessionId: string;
  participantToken: string;
  participantName: string;
  patientName: string;
  nurseName: string;
  status: CareSessionStatus;
}
