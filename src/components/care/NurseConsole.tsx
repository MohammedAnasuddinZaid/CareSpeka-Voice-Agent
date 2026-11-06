"use client";

/**
 * The simplified nurse console shown before a call starts.
 *
 * Three things, in the order a nurse needs them:
 *   1. the voice assistant (ask anything / dictate a message),
 *   2. the patient list (pick a patient, start a voice call),
 *   3. messages to the selected patient, and recent sessions.
 *
 * Everything is driven by real state handed in by `CareDashboard`.
 */
import { useCallback, useMemo, useState } from "react";
import { MessageSquare, PhoneCall, Send, UserRound } from "lucide-react";
import { Badge, Empty, Notice, Panel, formatTime, relativeTime } from "@/components/dashboard/ui";
import { careSendMessage, type PatientSummary } from "@/lib/careClient";
import type { CareAuditEntry, PatientMessage } from "@/lib/care/types";
import { sessionTone, AuditTimeline } from "@/components/care/panels";
import NurseAssistant from "@/components/care/NurseAssistant";

export default function NurseConsole({
  patients,
  sessions,
  audit,
  messages,
  busy,
  onStart,
  onRefreshMessages,
}: {
  patients: PatientSummary[];
  sessions: Array<Record<string, unknown>>;
  audit: CareAuditEntry[];
  messages: PatientMessage[];
  busy: boolean;
  onStart: (patientId: string) => void;
  onRefreshMessages: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => patients.find((p) => p.id === selectedId) ?? patients[0] ?? null, [patients, selectedId]);
  const patientMessages = useMemo(
    () => (selected ? messages.filter((m) => m.patientId === selected.id) : []),
    [messages, selected]
  );

  return (
    <div className="space-y-4">
      <NurseAssistant
        patientId={selected?.id ?? null}
        patientName={selected?.displayName ?? null}
        onStartCall={onStart}
        onMessageSent={onRefreshMessages}
      />

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <PatientsPanel patients={patients} selectedId={selected?.id ?? null} busy={busy} onSelect={setSelectedId} onStart={onStart} />

        <div className="space-y-4">
          <MessagesPanel patient={selected} messages={patientMessages} onSend={onRefreshMessages} />
          <Panel title="Recent calls" subtitle="Your past Web Voice Call sessions">
            {sessions.length === 0 ? (
              <Empty>No sessions yet.</Empty>
            ) : (
              <ul className="space-y-2 text-sm">
                {sessions.slice(0, 6).map((s) => (
                  <li key={String(s.id)} className="flex items-center gap-2">
                    <Badge tone={sessionTone(String(s.status))}>{String(s.status)}</Badge>
                    <span className="text-[#4b4b4b]">{String(s.patientName)}</span>
                    {s.escalated ? <Badge tone="danger">escalated</Badge> : null}
                    <span className="ml-auto text-xs text-[#9ca3af]">{relativeTime(String(s.createdAt))}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <details className="rounded-2xl border border-[#ececec] bg-white p-5 shadow-sm">
        <summary className="cursor-pointer text-base font-bold text-[#1f1f1f]">Audit trail</summary>
        <p className="mt-0.5 text-xs text-[#6e6e6e]">Tamper-evident record of every key action.</p>
        <div className="mt-3">
          <AuditTimeline entries={audit} />
        </div>
      </details>
    </div>
  );
}

function PatientsPanel({
  patients,
  selectedId,
  busy,
  onSelect,
  onStart,
}: {
  patients: PatientSummary[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
}) {
  return (
    <Panel
      title="Patients"
      subtitle="Pick a patient, then start a browser voice call and share the QR code."
    >
      {patients.length === 0 ? (
        <Empty>No patients available.</Empty>
      ) : (
        <ul className="divide-y divide-[#f1f1f1]">
          {patients.map((p) => {
            const active = selectedId === p.id;
            return (
              <li key={p.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onSelect(p.id);
                  }}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl px-2 py-3 transition ${active ? "bg-[#fdf2ef]" : "hover:bg-[#fafafa]"}`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f1f5f9] text-[#475569]">
                    <UserRound className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-[#1f1f1f]">{p.displayName}</span>
                    <span className="block truncate text-xs text-[#6e6e6e]">
                      {p.age ? `${p.age} yrs · ` : ""}
                      {p.primaryConcern || "No primary concern recorded"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {p.allergies ? <Badge tone="danger">{p.allergies} allerg.</Badge> : null}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStart(p.id);
                      }}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded-lg bg-[#c63a22] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#a92f1b] disabled:opacity-50"
                    >
                      <PhoneCall className="h-3.5 w-3.5" /> Call
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function MessagesPanel({
  patient,
  messages,
  onSend,
}: {
  patient: PatientSummary | null;
  messages: PatientMessage[];
  onSend: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async () => {
    const body = text.trim();
    if (!patient || !body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await careSendMessage(patient.id, body);
      setText("");
      onSend();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the message.");
    } finally {
      setBusy(false);
    }
  }, [busy, onSend, patient, text]);

  return (
    <Panel
      title="Messages"
      subtitle={patient ? `Sent to ${patient.displayName}` : "Select a patient to send a message"}
    >
      {error ? (
        <div className="mb-3">
          <Notice tone="warning">{error}</Notice>
        </div>
      ) : null}
      {messages.length === 0 ? (
        <Empty>No messages yet. They appear on the patient's joining page.</Empty>
      ) : (
        <ul className="mb-3 max-h-[220px] space-y-2 overflow-y-auto pr-1">
          {messages.map((m) => (
            <li key={m.id} className="rounded-xl border border-[#ececec] bg-[#fafafa] p-3 text-sm">
              <div className="flex items-center gap-2 text-[11px] text-[#9ca3af]">
                <MessageSquare className="h-3 w-3" />
                {formatTime(m.createdAt)}
                {m.readAt ? <Badge tone="success">read</Badge> : <Badge tone="neutral">unread</Badge>}
              </div>
              <div className="mt-1 text-[#1f1f1f]">{m.text}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          disabled={!patient || busy}
          placeholder={patient ? "Type a message for the patient…" : "Select a patient first"}
          className="flex-1 resize-none rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm disabled:bg-[#f7f7f7]"
        />
        <button
          onClick={() => void send()}
          disabled={!patient || !text.trim() || busy}
          className="inline-flex items-center gap-1 rounded-lg bg-[#c63a22] px-3 py-2 text-sm font-semibold text-white hover:bg-[#a92f1b] disabled:opacity-40"
        >
          <Send className="h-4 w-4" /> Send
        </button>
      </div>
    </Panel>
  );
}
