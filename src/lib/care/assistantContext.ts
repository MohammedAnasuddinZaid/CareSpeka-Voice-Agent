/**
 * Builds the nurse assistant's context from the authorised patient record.
 *
 * Server-only. This is the bridge between the raw repository and the pure,
 * testable `answerQuestion` engine in `assistant.ts`. It reads real stored data
 * (patients, sessions, transcripts, reports, tasks and messages) and never
 * fabricates anything.
 */
import {
  getPatient,
  getReport,
  getReportBySession,
  getTranscriptRaw,
  listMessages,
  listPatients,
  listSessions,
  listTasks,
} from "./repo";
import type { AssistantContext, PatientContext } from "./assistant";
import type { CareReport, CareSession } from "./types";

export async function buildAssistantContext(focusedPatientId?: string | null): Promise<AssistantContext> {
  const [patients, sessions, allTasks, allMessages] = await Promise.all([
    listPatients(),
    listSessions(200),
    listTasks(),
    listMessages(),
  ]);

  // Newest session per patient.
  const lastByPatient = new Map<string, CareSession>();
  for (const s of sessions) {
    const current = lastByPatient.get(s.patientId);
    if (!current || s.createdAt > current.createdAt) lastByPatient.set(s.patientId, s);
  }

  const contexts: PatientContext[] = [];
  for (const patient of patients) {
    const lastSession = lastByPatient.get(patient.id) ?? null;
    const [lastTranscript, lastReport] = lastSession
      ? await Promise.all([getTranscriptRaw(lastSession.id), loadReport(lastSession)])
      : [[], null];

    contexts.push({
      patient,
      lastSession,
      lastTranscript,
      lastReport,
      openTasks: allTasks.filter((t) => t.patientId === patient.id && t.status === "open"),
      messages: allMessages.filter((m) => m.patientId === patient.id),
    });
  }

  let focused: PatientContext | null = null;
  if (focusedPatientId) {
    focused = contexts.find((c) => c.patient.id === focusedPatientId) ?? null;
    if (!focused) {
      // A patient id that is not in the list (e.g. just deleted) still gets a
      // best-effort record so the assistant can answer.
      const patient = await getPatient(focusedPatientId);
      if (patient) {
        focused = { patient, lastSession: null, lastTranscript: [], lastReport: null, openTasks: [], messages: [] };
      }
    }
  }

  return { patients: contexts, focused };
}

async function loadReport(session: CareSession): Promise<CareReport | null> {
  if (session.reportId) {
    const byId = await getReport(session.reportId);
    if (byId) return byId;
  }
  return getReportBySession(session.id);
}
