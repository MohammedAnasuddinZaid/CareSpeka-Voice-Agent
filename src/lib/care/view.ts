import type { CareSession, CareSessionView } from "./types";
import { getPatient, getReportBySession } from "./repo";

/**
 * Builds the client-facing view of a session. The join/participant hashes and
 * the raw joining code are never included. Patients get the same view minus the
 * nurse-only fields.
 */
export async function sessionView(
  session: CareSession,
  opts: { forNurse: boolean; joinToken?: string; baseUrl?: string }
): Promise<CareSessionView> {
  const [patient, report] = await Promise.all([getPatient(session.patientId), getReportBySession(session.id)]);

  const view: CareSessionView = {
    id: session.id,
    mode: session.mode,
    patientId: session.patientId,
    nurseName: session.nurseName,
    status: session.status,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: session.durationMs,
    joinExpiresAt: session.joinExpiresAt,
    joinedAt: session.joinedAt,
    participantName: session.participantName,
    endReason: session.endReason,
    reportId: session.reportId,
    escalated: session.escalated,
    seq: session.seq,
    patient: patient ?? undefined,
    report: report ?? null,
  };

  if (opts.forNurse) {
    view.joinCode = session.joinCode;

    if (opts.baseUrl && opts.joinToken) {
      view.joinUrl = `${opts.baseUrl}/care/join?t=${encodeURIComponent(opts.joinToken)}`;
    } else if (opts.baseUrl) {
      // Without the raw token (e.g. after a refresh) we can at least deep-link
      // the joining page so the nurse can hand over the device.
      view.joinUrl = `${opts.baseUrl}/care/join`;
    }
  }

  return view;
}
