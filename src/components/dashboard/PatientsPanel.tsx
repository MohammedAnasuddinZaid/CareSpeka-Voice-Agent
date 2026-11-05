"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  PhoneCall,
  PhoneOff,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Clock,
  Users,
  MessageSquare,
  BadgeCheck,
  AlertTriangle,
} from "lucide-react";
import {
  ApiError,
  addContact,
  cancelFollowUp,
  confirmVerify,
  endCall,
  getPatient,
  getPatients,
  scheduleFollowUp,
  sendMessage,
  startCall,
  verifyContact,
  type Contact,
  type Patient,
  type PatientDetail,
  type SessionUser,
} from "@/lib/platformApi";
import {
  Badge,
  Empty,
  Notice,
  Panel,
  Spinner,
  callStateTone,
  escalationStateTone,
  formatDurationMs,
  formatTime,
  messageStateTone,
  relativeTime,
  severityTone,
} from "@/components/dashboard/ui";

const ROLES = ["patient", "family", "primary_nurse", "primary_nurse_backup", "caregiver", "emergency_contact"];
const CHANNELS = ["sms", "voice", "whatsapp"];

function canWrite(user: SessionUser): boolean {
  return user.role === "admin" || user.role === "nurse";
}

export function PatientsPanel({ user, onChanged }: { user: SessionUser; onChanged: () => void | Promise<void> }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const writable = canWrite(user);

  const loadPatients = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getPatients();
      setPatients(data.patients);
      setError(null);
      setSelectedId((current) => current ?? data.patients[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load patients.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (patientId: number) => {
    try {
      const data = await getPatient(patientId);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the patient record.");
    }
  }, []);

  useEffect(() => {
    void loadPatients();
  }, [loadPatients]);

  useEffect(() => {
    if (selectedId != null) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const refreshAll = useCallback(async () => {
    await loadPatients();
    if (selectedId != null) await loadDetail(selectedId);
    await onChanged();
  }, [loadPatients, loadDetail, selectedId, onChanged]);

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <Panel
        title="Patient directory"
        subtitle="Synthetic demonstration data by default"
        actions={
          <button type="button" onClick={() => void refreshAll()} className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        }
      >
        {loading ? (
          <Spinner label="Loading patients…" />
        ) : patients.length === 0 ? (
          <Empty>No patient records are seeded.</Empty>
        ) : (
          <ul className="space-y-1.5">
            {patients.map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(patient.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                    selectedId === patient.id
                      ? "border-[#c63a22] bg-[#fdf4f0]"
                      : "border-[#ececec] hover:border-[#ddd]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-[#1f1f1f]">{patient.display_name}</span>
                    {patient.synthetic ? <Badge tone="info">synthetic</Badge> : null}
                  </div>
                  <div className="mt-0.5 text-xs text-[#9ca3af]">
                    {patient.extension}
                    {patient.room ? ` · room ${patient.room}` : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="space-y-6">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {detail ? (
          <PatientWorkspace
            detail={detail}
            writable={writable}
            onChange={refreshAll}
            onSelectPatient={setSelectedId}
          />
        ) : (
          <Panel title="Workspace" subtitle="Select a patient">
            <Spinner label="Loading record…" />
          </Panel>
        )}
      </div>
    </div>
  );
}

function PatientWorkspace({
  detail,
  writable,
  onChange,
}: {
  detail: PatientDetail;
  writable: boolean;
  onChange: () => void | Promise<void>;
  onSelectPatient: (id: number) => void;
}) {
  const patient = detail.patient;
  return (
    <div className="space-y-6">
      <Panel
        title={patient.display_name}
        subtitle={`${patient.extension}${patient.room ? ` · room ${patient.room}` : ""}${patient.primary_concern ? ` · ${patient.primary_concern}` : ""}`}
      >
        <div className="flex flex-wrap gap-2">
          {patient.synthetic ? <Badge tone="info">Synthetic record — not a real person</Badge> : <Badge tone="danger">Real patient record</Badge>}
          <Badge tone="neutral">ID {patient.id}</Badge>
          {patient.language ? <Badge tone="neutral">lang {patient.language}</Badge> : null}
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <CallAndMessage patient={patient} contacts={detail.contacts} writable={writable} onChange={onChange} />
        <ContactsAndVerification patient={patient} contacts={detail.contacts} writable={writable} onChange={onChange} />
      </div>

      <FollowUps patient={patient} jobs={detail.follow_ups} writable={writable} onChange={onChange} />

      <div className="grid gap-6 lg:grid-cols-3">
        <RecentCalls calls={detail.calls} />
        <RecentMessages messages={detail.messages} />
        <RecentEscalations escalations={detail.escalations} />
      </div>
    </div>
  );
}

function primaryContact(contacts: Contact[]): Contact | undefined {
  return contacts.find((c) => c.role === "patient" && c.active) || contacts.find((c) => c.active) || contacts[0];
}

function CallAndMessage({
  patient,
  contacts,
  writable,
  onChange,
}: {
  patient: Patient;
  contacts: Contact[];
  writable: boolean;
  onChange: () => void | Promise<void>;
}) {
  const contact = primaryContact(contacts);
  const [purpose, setPurpose] = useState("nurse_to_patient_ai");
  const [body, setBody] = useState("");
  const [channel, setChannel] = useState("sms");
  const [allowQuiet, setAllowQuiet] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "success" | "warning" | "danger" | "info"; text: string } | null>(null);

  const doCall = async () => {
    setBusy("call");
    setResult(null);
    try {
      const res = await startCall(patient.id, purpose);
      if (res.ok) {
        const simulated = res.mode === "mock";
        setResult({
          tone: simulated ? "warning" : "success",
          text: simulated
            ? "Simulated call recorded (mock provider). No real telephone call was placed."
            : `Call requested via the carrier. Status will update from provider events (current: ${res.call?.state ?? "queued"}).`,
        });
      } else {
        setResult({ tone: "danger", text: res.message || res.reason || res.detail || "The call could not be placed." });
      }
      await onChange();
    } catch (err) {
      setResult({ tone: "danger", text: err instanceof ApiError ? err.message : "Call request failed." });
    } finally {
      setBusy(null);
    }
  };

  const doSend = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy("message");
    setResult(null);
    try {
      const res = await sendMessage({
        patient_id: patient.id,
        body: body.trim(),
        channel,
        allow_quiet_hours: allowQuiet,
      });
      if (res.ok) {
        const stored = typeof res.message === "object" ? res.message : null;
        const state = stored?.state ?? "queued";
        setResult({
          tone: "info",
          text: `Message accepted by the provider — state "${state}". "Accepted" is not proof of delivery; a delivery receipt will update the state.`,
        });
        setBody("");
      } else {
        const failText =
          typeof res.message === "string" ? res.message : res.detail || res.reason || "The message was not sent.";
        setResult({ tone: "danger", text: failText });
      }
      await onChange();
    } catch (err) {
      setResult({ tone: "danger", text: err instanceof ApiError ? err.message : "Message request failed." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="Reach the patient"
      subtitle={contact ? `Using contact ${contact.display_name} (${contact.phone_masked})` : "No contact registered"}
    >
      {!contact ? (
        <Notice tone="warning">Register a verified phone number below before calling or messaging this patient.</Notice>
      ) : null}

      <div className="space-y-5">
        <div className="rounded-xl border border-[#ececec] p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
            <PhoneCall className="h-4 w-4 text-[#c63a22]" /> Nurse → patient AI call
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={!writable}>
              <option value="nurse_to_patient_ai">Nurse to patient AI</option>
              <option value="follow_up_call">Follow-up call</option>
              <option value="check_in">Check-in</option>
            </select>
            <button
              type="button"
              onClick={() => void doCall()}
              disabled={!writable || !contact || busy === "call"}
              className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
            >
              {busy === "call" ? "Requesting…" : "Start call"}
            </button>
          </div>
          <p className="mt-2 text-xs text-[#9ca3af]">
            The AI answers the patient with the local pipeline; the call status shown is taken from real provider
            events, never assumed.
          </p>
        </div>

        <form onSubmit={doSend} className="rounded-xl border border-[#ececec] p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
            <MessageSquare className="h-4 w-4 text-[#c63a22]" /> Send a message
          </div>
          <textarea
            className="input min-h-[72px] w-full resize-y"
            placeholder="e.g. Please take your evening blood-pressure tablet."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={!writable}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)} disabled={!writable}>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-[#6e6e6e]">
              <input type="checkbox" checked={allowQuiet} onChange={(e) => setAllowQuiet(e.target.checked)} disabled={!writable} />
              Override quiet hours (explicit)
            </label>
            <button type="submit" disabled={!writable || !contact || busy === "message"} className="btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-sm disabled:opacity-50">
              <Send className="h-3.5 w-3.5" /> {busy === "message" ? "Sending…" : "Send"}
            </button>
          </div>
        </form>

        {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
      </div>
    </Panel>
  );
}

function ContactsAndVerification({
  patient,
  contacts,
  writable,
  onChange,
}: {
  patient: Patient;
  contacts: Contact[];
  writable: boolean;
  onChange: () => void | Promise<void>;
}) {
  const [role, setRole] = useState("family");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "warning" | "danger" | "info"; text: string } | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await addContact({
        patient_id: patient.id,
        role,
        display_name: name.trim(),
        phone: phone.trim(),
        is_primary: isPrimary,
      });
      setResult({ tone: "success", text: `Contact saved as ${res.contact.phone_masked}. Verification is still required.` });
      setName("");
      setPhone("");
      setIsPrimary(false);
      await onChange();
    } catch (err) {
      setResult({ tone: "danger", text: err instanceof ApiError ? err.message : "Could not save the contact." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Contacts & verification" subtitle="Numbers are stored masked; a contact is not reachable until verified">
      <ul className="mb-4 space-y-2">
        {contacts.length === 0 ? (
          <Empty>No contacts yet.</Empty>
        ) : (
          contacts.map((contact) => (
            <ContactRow key={contact.id} contact={contact} writable={writable} onChange={onChange} />
          ))
        )}
      </ul>

      {writable ? (
        <form onSubmit={add} className="rounded-xl border border-[#ececec] p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
            <Plus className="h-4 w-4 text-[#c63a22]" /> Add contact
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="input" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} required />
            <input className="input" placeholder="Phone (national or +E.164)" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-[#6e6e6e]">
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> Primary contact
            </label>
          </div>
          <button type="submit" disabled={busy} className="btn-primary mt-3 px-4 py-2 text-sm disabled:opacity-50">
            {busy ? "Saving…" : "Save contact"}
          </button>
        </form>
      ) : null}
      {result ? <div className="mt-3"><Notice tone={result.tone}>{result.text}</Notice></div> : null}
    </Panel>
  );
}

function ContactRow({ contact, writable, onChange }: { contact: Contact; writable: boolean; onChange: () => void | Promise<void> }) {
  const [verifying, setVerifying] = useState(false);
  const [code, setCode] = useState("");
  const [delivery, setDelivery] = useState<{ sent: boolean; mode: string; detail: string; simulated?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await verifyContact(contact.id, "sms");
      setDelivery({ ...res.delivery, simulated: res.simulated_code });
      setVerifying(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start verification.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirmVerify(contact.id, code.trim());
      setVerifying(false);
      setCode("");
      setDelivery(null);
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-xl border border-[#ececec] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[#1f1f1f]">{contact.display_name}</span>
            <Badge tone="neutral">{contact.role}</Badge>
            {contact.is_primary ? <Badge tone="info">primary</Badge> : null}
            <Badge tone={contact.verification_status === "verified" ? "success" : contact.verification_status === "failed" ? "danger" : "warning"}>
              {contact.verification_status || "unverified"}
            </Badge>
            {!contact.active ? <Badge tone="neutral">inactive</Badge> : null}
          </div>
          <div className="mt-0.5 text-xs text-[#9ca3af]">{contact.phone_masked}</div>
        </div>
        {writable ? (
          <button type="button" onClick={() => void start()} disabled={busy} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-50">
            {verifying ? "Resend code" : "Verify number"}
          </button>
        ) : null}
      </div>

      {verifying ? (
        <div className="mt-2 rounded-lg border border-[#ececec] bg-[#fafafa] p-2">
          {delivery && !delivery.sent ? (
            <Notice tone="warning">
              <span className="text-xs">
                No real SMS was sent ({delivery.mode}). This simulated code is shown so the flow can be tested
                offline: <span className="font-mono font-semibold">{delivery.simulated}</span>
              </span>
            </Notice>
          ) : (
            <p className="mb-2 text-xs text-[#6e6e6e]">Enter the code sent to {contact.phone_masked}.</p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <input className="input" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="button" onClick={() => void confirm()} disabled={busy || !code.trim()} className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50">
              Confirm
            </button>
          </div>
        </div>
      ) : null}
      {error ? <div className="mt-2"><Notice tone="danger">{error}</Notice></div> : null}
    </li>
  );
}

function FollowUps({
  patient,
  jobs,
  writable,
  onChange,
}: {
  patient: Patient;
  jobs: PatientDetail["follow_ups"];
  writable: boolean;
  onChange: () => void | Promise<void>;
}) {
  const [delay, setDelay] = useState(60);
  const [kind, setKind] = useState("follow_up_call");
  const [body, setBody] = useState("Following up on your care plan.");
  const [channel, setChannel] = useState("sms");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "warning" | "danger" | "info"; text: string } | null>(null);

  const schedule = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await scheduleFollowUp({
        patient_id: patient.id,
        kind,
        delay_minutes: Number(delay),
        body,
        channel,
      });
      setResult({ tone: "success", text: `Follow-up scheduled for ${formatTime(res.job.run_at)}. It runs on the server even if this browser closes.` });
      await onChange();
    } catch (err) {
      setResult({ tone: "danger", text: err instanceof ApiError ? err.message : "Could not schedule the follow-up." });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (jobId: string) => {
    try {
      await cancelFollowUp(jobId);
      await onChange();
    } catch {
      /* surfaced on next refresh */
    }
  };

  return (
    <Panel title="Scheduled follow-up" subtitle="Durable server-side jobs — not browser timers">
      <form onSubmit={schedule} className="grid gap-2 sm:grid-cols-5">
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} disabled={!writable}>
          <option value="follow_up_call">AI follow-up call</option>
          <option value="follow_up_message">Follow-up message</option>
        </select>
        <input
          className="input"
          type="number"
          min={1}
          value={delay}
          onChange={(e) => setDelay(Number(e.target.value))}
          disabled={!writable}
          aria-label="Delay in minutes"
        />
        {kind === "follow_up_message" ? (
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)} disabled={!writable}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <div className="hidden sm:block" />
        )}
        <input className="input sm:col-span-2" placeholder="Message body (for messages)" value={body} onChange={(e) => setBody(e.target.value)} disabled={!writable} />
        <button type="submit" disabled={!writable || busy} className="btn-primary px-4 py-2 text-sm disabled:opacity-50 sm:col-span-5">
          {busy ? "Scheduling…" : `Schedule in ${delay} minute${delay === 1 ? "" : "s"}`}
        </button>
      </form>
      {result ? <div className="mt-3"><Notice tone={result.tone}>{result.text}</Notice></div> : null}

      <ul className="mt-4 space-y-2">
        {jobs.length === 0 ? (
          <Empty>No pending follow-ups.</Empty>
        ) : (
          jobs.map((job) => (
            <li key={job.id} className="flex items-center justify-between rounded-xl border border-[#ececec] px-3 py-2">
              <div>
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-[#6e6e6e]" />
                  <span className="text-sm font-medium text-[#1f1f1f]">{job.kind}</span>
                  <Badge tone="info">{job.state}</Badge>
                </div>
                <div className="text-xs text-[#9ca3af]">runs {formatTime(job.run_at)} · attempts {job.attempts}</div>
              </div>
              {writable ? (
                <button type="button" onClick={() => void cancel(job.id)} className="text-xs font-semibold text-[#d94a4a] hover:underline">
                  Cancel
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </Panel>
  );
}

function RecentCalls({ calls }: { calls: PatientDetail["calls"] }) {
  return (
    <Panel title="Recent calls">
      {calls.length === 0 ? (
        <Empty>No calls yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {calls.slice(0, 6).map((call) => (
            <li key={call.id} className="rounded-xl border border-[#ececec] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-[#1f1f1f]">{call.to_masked || "—"}</span>
                <Badge tone={callStateTone(call.state)}>{call.state}</Badge>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[#9ca3af]">
                <PhoneCall className="h-3 w-3" /> {call.direction} · {relativeTime(call.created_at)} · {formatDurationMs(call.duration_ms)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RecentMessages({ messages }: { messages: PatientDetail["messages"] }) {
  return (
    <Panel title="Recent messages">
      {messages.length === 0 ? (
        <Empty>No messages yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {messages.slice(0, 6).map((msg) => (
            <li key={msg.id} className="rounded-xl border border-[#ececec] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase text-[#6e6e6e]">{msg.channel}</span>
                <Badge tone={messageStateTone(msg.state)}>{msg.state}</Badge>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-[#6e6e6e]">{msg.body}</p>
              <div className="mt-0.5 text-[11px] text-[#9ca3af]">{relativeTime(msg.created_at)}</div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RecentEscalations({ escalations }: { escalations: PatientDetail["escalations"] }) {
  return (
    <Panel title="Escalations">
      {escalations.length === 0 ? (
        <Empty>No escalations.</Empty>
      ) : (
        <ul className="space-y-2">
          {escalations.slice(0, 6).map((item) => (
            <li key={item.id} className="rounded-xl border border-[#ececec] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={severityTone(item.severity)}>{item.severity}</Badge>
                <Badge tone={escalationStateTone(item.state)}>{item.state}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-[#6e6e6e]">{item.reason}</p>
              <div className="mt-0.5 text-[11px] text-[#9ca3af]">{relativeTime(item.created_at)}</div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
