"use client";

/**
 * Presentational panels for the Web Voice Call — Demo. Every panel renders the
 * real session state it is handed; nothing is animated or faked.
 */
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Activity,
  HeartPulse,
  Pill,
  ShieldAlert,
  ClipboardList,
  CheckCircle2,
  Cpu,
  Radio,
  Copy,
  RefreshCw,
  QrCode,
  ExternalLink,
  Plus,
} from "lucide-react";
import { Badge, Empty, Notice, Panel, Spinner, Tone, formatTime, relativeTime } from "@/components/dashboard/ui";
import type {
  CareAuditEntry,
  CareEvent,
  CareReport,
  CareReportFact,
  CareSessionView,
  CareTask,
  CareTranscriptEntry,
  ClinicalPatient,
} from "@/lib/care/types";
import type { AiStatus } from "@/lib/care/browserAI";
import type { InsightsPayload } from "@/lib/careClient";
import type { RtcStatus } from "@/hooks/useCareRtc";

export function sessionTone(status?: string): Tone {
  switch ((status || "").toLowerCase()) {
    case "active":
      return "success";
    case "waiting":
    case "created":
      return "info";
    case "ended":
      return "neutral";
    case "expired":
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

export function rtcTone(status: RtcStatus, pcState: string): Tone {
  if (pcState === "connected") return "success";
  if (status === "failed") return "danger";
  if (status === "reconnecting") return "warning";
  if (status === "negotiating") return "info";
  return "neutral";
}

// --- connection / live header ----------------------------------------------

export function ConnectionPanel({
  session,
  status,
  pcState,
  iceState,
  elapsedMs,
  aiStatus,
  onReconnect,
  error,
}: {
  session: CareSessionView | null;
  status: RtcStatus;
  pcState: string;
  iceState: string;
  elapsedMs: number;
  aiStatus: AiStatus;
  onReconnect: () => void;
  error: string | null;
}) {
  return (
    <Panel
      title="Live connection"
      subtitle="Native WebRTC peer-to-peer audio (no media server)"
      actions={
        <button
          onClick={onReconnect}
          className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] px-2.5 py-1 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7]"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Reconnect
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Session" value={session?.status ?? "—"} tone={sessionTone(session?.status)} />
        <Stat label="Peer" value={pcState} tone={rtcTone(status, pcState)} />
        <Stat label="ICE" value={iceState} tone={iceState === "connected" || iceState === "completed" ? "success" : "info"} />
        <Stat label="Duration" value={formatClock(elapsedMs)} tone="neutral" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#6e6e6e]">
        <Badge tone={session?.participantName ? "success" : "warning"}>
          <Radio className="h-3 w-3" /> {session?.participantName ? `Patient: ${session.participantName}` : "Waiting for patient"}
        </Badge>
        <Badge tone="neutral">ASR: {aiStageLabel(aiStatus.asr)}</Badge>
        <Badge tone="neutral">LLM: {aiStageLabel(aiStatus.llm)}</Badge>
        <Badge tone="neutral">TTS: {aiStageLabel(aiStatus.tts)}</Badge>
        <Badge tone={aiStatus.webgpu ? "success" : "info"}>{aiStatus.webgpu ? "WebGPU available" : "WASM / CPU"}</Badge>
      </div>
      {error ? (
        <div className="mt-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
    </Panel>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  const accent: Record<Tone, string> = {
    neutral: "text-[#1f1f1f]",
    success: "text-emerald-600",
    warning: "text-amber-600",
    danger: "text-red-600",
    info: "text-sky-600",
  };
  return (
    <div className="rounded-xl border border-[#ececec] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">{label}</div>
      <div className={`mt-0.5 text-sm font-bold capitalize ${accent[tone]}`}>{value.replace(/_/g, " ")}</div>
    </div>
  );
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function aiStageLabel(stage: AiStatus["asr"]): string {
  return stage === "ready" ? "on-device" : stage === "loading" ? "loading…" : stage === "error" ? "failed" : stage === "unsupported" ? "unavailable" : "off";
}

// --- QR / joining ----------------------------------------------------------

export function QrCard({
  qrDataUrl,
  joinUrl,
  joinCode,
  expiresAt,
  onCopyLink,
  onCopyCode,
  onRegenerate,
  onOpen,
}: {
  qrDataUrl: string | null;
  joinUrl?: string;
  joinCode?: string;
  expiresAt?: string;
  onCopyLink: () => void;
  onCopyCode: () => void;
  onRegenerate: () => void;
  onOpen: () => void;
}) {
  return (
    <Panel
      title="Patient joining"
      subtitle="Scan, or enter the joining code"
      actions={
        <button
          onClick={onRegenerate}
          className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] px-2.5 py-1 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7]"
        >
          <QrCode className="h-3.5 w-3.5" /> New QR
        </button>
      }
    >
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        <div className="flex h-[180px] w-[180px] shrink-0 items-center justify-center rounded-xl border border-[#ececec] bg-white p-2">
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrDataUrl} alt="Session QR code" className="h-full w-full" />
          ) : (
            <Spinner label="Generating…" />
          )}
        </div>
        <div className="w-full space-y-2">
          <div className="rounded-xl border border-[#ececec] bg-[#fafafa] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">Joining code</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-2xl font-bold tracking-widest text-[#1f1f1f]">{joinCode ?? "——————"}</span>
              <button onClick={onCopyCode} className="rounded-lg border border-[#e5e5e5] p-1.5 hover:bg-white" title="Copy code">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {expiresAt ? (
            <div className="text-xs text-[#6e6e6e]">Link expires {formatTime(expiresAt)} · {relativeTime(expiresAt)}</div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onCopyLink}
              className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] px-2.5 py-1 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7]"
            >
              <Copy className="h-3.5 w-3.5" /> Copy link
            </button>
            <button
              onClick={onOpen}
              className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] px-2.5 py-1 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7]"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Preview patient page
            </button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

// --- transcript ------------------------------------------------------------

export function TranscriptPanel({
  entries,
  live,
}: {
  entries: CareTranscriptEntry[];
  live: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length]);

  return (
    <Panel
      title="Live transcript"
      subtitle="Patient speech and AI responses, in the order they happened"
      actions={live ? <Badge tone="danger">● LIVE</Badge> : <Badge tone="neutral">saved</Badge>}
    >
      {entries.length === 0 ? (
        <Empty>No speech yet. The transcript fills as you and the patient talk.</Empty>
      ) : (
        <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
          {entries.map((e) => (
            <div key={e.id} className={`flex ${e.role === "agent" ? "justify-start" : e.role === "patient" ? "justify-end" : "justify-center"}`}>
              {e.role === "system" ? (
                <div className="text-[11px] text-[#9ca3af]">{e.text}</div>
              ) : (
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                    e.role === "agent"
                      ? "bg-[#f1f5f9] text-[#1f1f1f]"
                      : e.role === "nurse"
                        ? "bg-amber-50 text-amber-900"
                        : "bg-[#c63a22] text-white"
                  }`}
                >
                  <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">
                    {e.role === "agent" ? "AI care assistant" : e.role === "nurse" ? "Nurse" : "Patient"} · {formatTime(e.at)}
                  </div>
                  {e.text}
                  {e.engine ? <div className="mt-1 text-[10px] opacity-60">{e.engine}</div> : null}
                </div>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </Panel>
  );
}

// --- insights --------------------------------------------------------------

export function InsightsPanel({ insights, escalated }: { insights: InsightsPayload | null; escalated: boolean }) {
  const symptoms = insights?.symptoms ?? [];
  return (
    <Panel
      title="AI insights"
      subtitle="Extracted from this conversation only — not a diagnosis"
      actions={escalated ? <Badge tone="danger">Escalation</Badge> : <Badge tone="neutral">monitoring</Badge>}
    >
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">Symptoms mentioned</div>
          {symptoms.length ? (
            <div className="flex flex-wrap gap-1.5">
              {symptoms.map((s) => (
                <Badge key={s.label} tone={s.redFlag ? "danger" : "info"}>
                  {s.redFlag ? <AlertTriangle className="h-3 w-3" /> : null} {s.label}
                </Badge>
              ))}
            </div>
          ) : (
            <div className="text-xs text-[#9ca3af]">None detected yet.</div>
          )}
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">Concerns for nurse</div>
          {insights?.concerns.length ? (
            <ul className="space-y-1 text-sm text-[#4b4b4b]">
              {insights.concerns.map((c, i) => (
                <li key={i} className="flex gap-2">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" /> {c}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-[#9ca3af]">No concerns flagged.</div>
          )}
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">Suggested follow-up topics</div>
          {insights?.suggestedTopics.length ? (
            <ul className="space-y-1 text-xs text-[#6e6e6e]">
              {insights.suggestedTopics.slice(0, 5).map((t, i) => (
                <li key={i}>• {t}</li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-[#9ca3af]">—</div>
          )}
        </div>
      </div>
    </Panel>
  );
}

// --- clinical profile ------------------------------------------------------

export function ClinicalProfilePanel({ patient }: { patient: ClinicalPatient | null }) {
  if (!patient) return null;
  const active = patient.conditions.filter((c) => c.status === "active");
  const meds = patient.medications.filter((m) => m.status === "active");
  const latest = patient.observations.slice(-4).reverse();
  return (
    <Panel
      title="Patient record"
      subtitle={patient.synthetic ? "Synthetic data for demonstration — not a real patient" : "Authorised clinical record"}
      actions={<Badge tone="neutral">{patient.extension}</Badge>}
    >
      <div className="mb-3">
        <div className="text-lg font-bold text-[#1f1f1f]">{patient.displayName}</div>
        <div className="text-xs text-[#6e6e6e]">
          {patient.age ? `${patient.age} yrs` : "age unknown"} · {patient.sex ?? "—"} · {patient.room ?? "—"}
        </div>
        {patient.primaryConcern ? (
          <div className="mt-1 text-sm text-[#4b4b4b]">
            <span className="font-semibold">Reason:</span> {patient.primaryConcern}
          </div>
        ) : null}
      </div>

      {patient.allergies.length ? (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-red-600">
            <ShieldAlert className="h-3.5 w-3.5" /> Allergies
          </div>
          <div className="flex flex-wrap gap-1.5">
            {patient.allergies.map((a) => (
              <Badge key={a.id} tone="danger">
                {a.substance} — {a.severity}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            <HeartPulse className="h-3.5 w-3.5" /> Conditions
          </div>
          <ul className="space-y-1 text-sm text-[#4b4b4b]">
            {active.map((c) => (
              <li key={c.id}>
                {c.name} {c.code ? <span className="text-xs text-[#9ca3af]">({c.code})</span> : null}
              </li>
            ))}
            {active.length === 0 ? <li className="text-xs text-[#9ca3af]">None recorded</li> : null}
          </ul>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            <Pill className="h-3.5 w-3.5" /> Medications
          </div>
          <ul className="space-y-1 text-sm text-[#4b4b4b]">
            {meds.map((m) => (
              <li key={m.id}>
                {m.name} {m.dose ? <span className="text-xs text-[#9ca3af]">{m.dose} · {m.frequency}</span> : null}
              </li>
            ))}
            {meds.length === 0 ? <li className="text-xs text-[#9ca3af]">None recorded</li> : null}
          </ul>
        </div>
      </div>

      {latest.length ? (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            <Activity className="h-3.5 w-3.5" /> Recent observations
          </div>
          <div className="flex flex-wrap gap-2">
            {latest.map((o) => (
              <div key={o.id} className="rounded-lg border border-[#ececec] px-2 py-1 text-xs">
                <span className="font-semibold text-[#1f1f1f]">{o.value}{o.unit ? ` ${o.unit}` : ""}</span>
                <span className="ml-1 text-[#9ca3af]">{o.label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {patient.encounters.length ? (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            <ClipboardList className="h-3.5 w-3.5" /> Previous interactions
          </div>
          <ul className="space-y-1 text-xs text-[#6e6e6e]">
            {patient.encounters.slice(-3).reverse().map((e) => (
              <li key={e.id}>
                <span className="font-semibold text-[#4b4b4b]">{e.kind.replace(/-/g, " ")}</span> · {formatTime(e.at)} — {e.summary}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

// --- report ----------------------------------------------------------------

function FactList({ title, facts, tone }: { title: string; facts: CareReportFact[]; tone: Tone }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">{title}</div>
      {facts.length ? (
        <ul className="space-y-1 text-sm text-[#4b4b4b]">
          {facts.map((f, i) => (
            <li key={i} className="flex items-start gap-2">
              <Badge tone={tone}>{f.provenance === "record" ? "record" : f.provenance === "patient" ? "patient" : "AI"}</Badge>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs text-[#9ca3af]">None.</div>
      )}
    </div>
  );
}

export function ReportPanel({
  report,
  editable,
  onEdit,
  onApprove,
  onReopen,
  onAddTask,
}: {
  report: CareReport | null;
  editable: boolean;
  onEdit: (summary: string, note: string) => void;
  onApprove: (note: string) => void;
  onReopen: () => void;
  onAddTask: (title: string) => void;
}) {
  const [draft, setDraft] = useDraft(report?.nurseEditedSummary ?? "");
  const [note, setNote] = useDraft(report?.reviewNote ?? "");
  const [task, setTask] = useDraft("");

  if (!report) {
    return (
      <Panel title="Clinical report" subtitle="Generated after the session ends">
        <Empty>No report yet. End the session to generate a draft from the transcript.</Empty>
      </Panel>
    );
  }

  const approved = report.status === "approved";

  return (
    <Panel
      title="Clinical report"
      subtitle={`Draft generated ${relativeTime(report.generatedAt)} from ${report.transcriptRef.count} transcript lines`}
      actions={approved ? <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> Approved</Badge> : <Badge tone="warning">Draft — needs review</Badge>}
    >
      <div className="space-y-4">
        <Notice tone="info">
          This report is generated only from the session transcript and the patient's authorised record. Provenance is
          tagged on every fact: <span className="font-semibold">record</span>, <span className="font-semibold">patient</span> or{" "}
          <span className="font-semibold">AI</span>. No diagnosis or prescription is added.
        </Notice>

        <section>
          <div className="text-sm font-bold text-[#1f1f1f]">AI summary</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-[#4b4b4b]">{report.nurseEditedSummary || report.sections.aiSummary}</p>
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <section>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">Reason for interaction</div>
            <div className="text-sm text-[#4b4b4b]">{report.sections.reasonForInteraction}</div>
          </section>
          <section>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">Symptom duration</div>
            <div className="text-sm text-[#4b4b4b]">{report.sections.symptomDuration}</div>
          </section>
        </div>

        <FactList title="Patient-reported symptoms" facts={report.sections.patientReportedSymptoms} tone="warning" />
        <FactList title="Relevant medical history" facts={report.sections.relevantHistory} tone="neutral" />
        <FactList title="Medications" facts={report.sections.medicationsDiscussed} tone="neutral" />
        <FactList title="Allergies" facts={report.sections.allergiesDiscussed} tone="neutral" />
        <FactList title="Concerns requiring nurse attention" facts={report.sections.concernsForNurse} tone="danger" />

        <section>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">Escalations</div>
          {report.sections.escalations.length ? (
            <ul className="list-disc pl-5 text-sm text-red-700">
              {report.sections.escalations.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-[#9ca3af]">None.</div>
          )}
        </section>

        <section>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">Suggested follow-up</div>
          <ul className="list-disc pl-5 text-sm text-[#4b4b4b]">
            {report.sections.suggestedFollowUp.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>

        {report.sections.unresolvedQuestions.length ? (
          <section>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">Unresolved questions</div>
            <ul className="list-disc pl-5 text-sm text-[#6e6e6e]">
              {report.sections.unresolvedQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {editable ? (
          <div className="space-y-2 rounded-xl border border-[#ececec] bg-[#fafafa] p-3">
            <div className="text-sm font-bold text-[#1f1f1f]">Nurse review</div>
            <label className="block text-xs font-semibold text-[#6e6e6e]">
              Edited summary (optional)
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-[#e5e5e5] bg-white px-2 py-1.5 text-sm"
                placeholder="Leave blank to keep the generated summary."
              />
            </label>
            <label className="block text-xs font-semibold text-[#6e6e6e]">
              Review note
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#e5e5e5] bg-white px-2 py-1.5 text-sm"
                placeholder="e.g. reviewed against triage protocol"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onEdit(draft, note)}
                className="rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-xs font-semibold text-[#4b4b4b] hover:bg-white"
              >
                Save edits
              </button>
              <button
                onClick={() => onApprove(note)}
                className="rounded-lg bg-[#c63a22] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#a92f1b]"
              >
                Approve report
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            <span>
              Reviewed by <span className="font-semibold">{report.reviewedBy}</span> {relativeTime(report.reviewedAt)}
              {report.reviewNote ? <> — “{report.reviewNote}”</> : null}
            </span>
            <button onClick={onReopen} className="rounded-lg border border-emerald-300 px-2.5 py-1 text-xs font-semibold hover:bg-white">
              Reopen
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <label className="flex-1 text-xs font-semibold text-[#6e6e6e]">
            Create follow-up task
            <input
              value={task}
              onChange={(e) => setTask(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[#e5e5e5] px-2 py-1.5 text-sm"
              placeholder="e.g. Call back in 48 hours"
            />
          </label>
          <button
            onClick={() => {
              if (task.trim()) {
                onAddTask(task.trim());
                setTask("");
              }
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7]"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
      </div>
    </Panel>
  );
}

function useDraft(initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  return [value, setValue];
}

// --- events / audit --------------------------------------------------------

export function EventFeed({ events }: { events: CareEvent[] }) {
  const recent = [...events].reverse().slice(0, 40);
  return (
    <Panel title="Session events" subtitle="Everything that actually happened">
      {recent.length === 0 ? (
        <Empty>No events yet.</Empty>
      ) : (
        <ul className="max-h-[240px] space-y-1.5 overflow-y-auto text-xs">
          {recent.map((e) => (
            <li key={e.seq} className="flex items-start gap-2">
              <span className="mt-0.5 font-mono text-[10px] text-[#9ca3af]">#{e.seq}</span>
              <span className="text-[#4b4b4b]">{eventLabel(e.type)}</span>
              <span className="ml-auto whitespace-nowrap text-[10px] text-[#9ca3af]">{formatTime(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function AuditTimeline({ entries }: { entries: CareAuditEntry[] }) {
  return (
    <Panel title="Audit trail" subtitle="Tamper-evident record of every key action">
      {entries.length === 0 ? (
        <Empty>No audit entries yet.</Empty>
      ) : (
        <ul className="max-h-[260px] space-y-1.5 overflow-y-auto text-xs">
          {entries.map((a) => (
            <li key={a.id} className="flex items-start gap-2">
              <span className="rounded bg-[#f1f5f9] px-1.5 py-0.5 font-mono text-[10px] text-[#475569]">{a.action}</span>
              <span className="text-[#6e6e6e]">
                {a.actorRole}
                {a.patientId ? ` · ${a.patientId}` : ""}
              </span>
              <span className="ml-auto whitespace-nowrap text-[10px] text-[#9ca3af]">{formatTime(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function TaskList({ tasks }: { tasks: CareTask[] }) {
  return (
    <Panel title="Care tasks" subtitle="Follow-up work created from this session">
      {tasks.length === 0 ? (
        <Empty>No follow-up tasks yet.</Empty>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <Badge tone={t.status === "done" ? "success" : "warning"}>{t.status}</Badge>
              <span className="text-[#4b4b4b]">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- AI engine control -----------------------------------------------------

export function AiEnginePanel({
  aiStatus,
  onLoadAsr,
  onLoadLlm,
  patientSpeechOnDevice,
  onToggleOnDevice,
  usingFallback,
}: {
  aiStatus: AiStatus;
  onLoadAsr: () => void;
  onLoadLlm: () => void;
  patientSpeechOnDevice: boolean;
  onToggleOnDevice: (v: boolean) => void;
  usingFallback: boolean;
}) {
  return (
    <Panel
      title="AI engine"
      subtitle="Runs in this browser. Models are opt-in and downloaded on demand."
      actions={<Badge tone={aiStatus.webgpu ? "success" : "info"}>{aiStatus.webgpu ? "WebGPU" : "WASM/CPU"}</Badge>}
    >
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-2 rounded-xl border border-[#ececec] p-3">
          <div>
            <div className="font-semibold text-[#1f1f1f]">Speech recognition (Whisper, on-device)</div>
            <div className="text-xs text-[#6e6e6e]">Transcribes the patient's audio in this browser. ~40 MB.</div>
          </div>
          {aiStatus.asr === "ready" ? (
            <Badge tone="success">ready</Badge>
          ) : (
            <button
              onClick={onLoadAsr}
              disabled={aiStatus.asr === "loading"}
              className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7] disabled:opacity-50"
            >
              <Cpu className="h-3.5 w-3.5" /> {aiStatus.asr === "loading" ? "Loading…" : "Load"}
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 rounded-xl border border-[#ececec] p-3">
          <div>
            <div className="font-semibold text-[#1f1f1f]">Reasoning (WebLLM, on-device)</div>
            <div className="text-xs text-[#6e6e6e]">Small instruct model in the browser. Needs WebGPU. ~0.8–1 GB.</div>
          </div>
          {aiStatus.llm === "ready" ? (
            <Badge tone="success">ready</Badge>
          ) : (
            <button
              onClick={onLoadLlm}
              disabled={aiStatus.llm === "loading"}
              className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7] disabled:opacity-50"
            >
              <Cpu className="h-3.5 w-3.5" /> {aiStatus.llm === "loading" ? "Loading…" : "Load"}
            </button>
          )}
        </div>

        {aiStatus.detail ? <div className="text-xs text-[#6e6e6e]">{aiStatus.detail}</div> : null}

        <label className="flex items-center gap-2 text-xs text-[#4b4b4b]">
          <input type="checkbox" checked={patientSpeechOnDevice} onChange={(e) => onToggleOnDevice(e.target.checked)} />
          Patient's own device sends speech text (use when Whisper is off)
        </label>

        {usingFallback ? (
          <Notice tone="warning">
            The on-device LLM is off, so replies use the built-in rule-based care engine. It is clinically cautious and
            asks scripted follow-up questions — it is not a language model.
          </Notice>
        ) : null}
      </div>
    </Panel>
  );
}

// --- labels ----------------------------------------------------------------

export function eventLabel(type: string): string {
  const map: Record<string, string> = {
    "session.created": "Session created",
    "join.link_generated": "Joining link generated",
    "session.joined": "Patient joined",
    "participant.connected": "Participant connected",
    "participant.disconnected": "Participant disconnected",
    "agent.connected": "AI agent connected",
    "agent.disconnected": "AI agent disconnected",
    "mic.granted": "Microphone granted",
    "mic.denied": "Microphone denied",
    "speech.started": "Patient started speaking",
    "speech.ended": "Patient stopped speaking",
    "transcript.updated": "Transcript updated",
    "agent.response.started": "AI started responding",
    "agent.response.completed": "AI finished responding",
    "escalation.created": "Escalation created",
    "escalation.acknowledged": "Escalation acknowledged",
    "session.resumed": "Session resumed",
    "session.ended": "Session ended",
    "report.generated": "Report generated",
    "report.reviewed": "Report reviewed",
    "task.created": "Follow-up task created",
    "signal.beacon": "Connection beacon",
    error: "Error",
  };
  return map[type] ?? type;
}

