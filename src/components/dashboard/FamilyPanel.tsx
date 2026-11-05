"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldCheck, Users, XCircle } from "lucide-react";
import {
  ApiError,
  approveFamilyRequest,
  createFamilyRequest,
  denyFamilyRequest,
  getFamilyPermissions,
  getFamilyRequests,
  getPatient,
  getPatients,
  grantFamilyPermission,
  revokeFamilyPermission,
  type Contact,
  type FamilyRequest,
  type Patient,
  type SessionUser,
} from "@/lib/platformApi";
import { Badge, Empty, Notice, Panel, Spinner, formatTime } from "@/components/dashboard/ui";

type PermissionRow = {
  id?: number;
  patient_id?: number;
  contact_id?: number;
  scope?: Record<string, unknown>;
  granted_by?: string;
  revoked?: boolean;
  created_at?: string;
};

export function FamilyPanel({ user }: { user: SessionUser }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [requests, setRequests] = useState<FamilyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const writable = user.role === "admin" || user.role === "nurse";

  const loadPatients = useCallback(async () => {
    try {
      const data = await getPatients();
      setPatients(data.patients);
      setSelectedId((current) => current ?? data.patients[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load patients.");
    }
  }, []);

  const loadForPatient = useCallback(async (patientId: number) => {
    setLoading(true);
    try {
      const [detail, perms, reqs] = await Promise.all([
        getPatient(patientId),
        getFamilyPermissions(patientId),
        getFamilyRequests(),
      ]);
      setContacts(detail.contacts);
      setPermissions((perms.permissions || []) as PermissionRow[]);
      setRequests(reqs.requests.filter((r) => r.patient_id === patientId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load family access.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPatients();
  }, [loadPatients]);

  useEffect(() => {
    if (selectedId != null) void loadForPatient(selectedId);
  }, [selectedId, loadForPatient]);

  const reload = useCallback(async () => {
    if (selectedId != null) await loadForPatient(selectedId);
  }, [selectedId, loadForPatient]);

  const familyContacts = contacts.filter((c) => c.role !== "patient");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs font-semibold text-[#6e6e6e]" htmlFor="family-patient">
          Patient
        </label>
        <select
          id="family-patient"
          className="input"
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(Number(e.target.value))}
        >
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name} ({p.extension})
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void reload()} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Notice tone="neutral">
        <span className="text-xs">
          Mode 1 lets an approved family member talk with the AI within the granted scope. Mode 2 covers a request for a
          direct call, which needs staff approval and verification. Access can be revoked at any time.
        </span>
      </Notice>

      {loading ? (
        <Panel title="Family access">
          <Spinner label="Loading permissions…" />
        </Panel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <PermissionsPanel
            patientId={selectedId}
            contacts={familyContacts}
            permissions={permissions}
            writable={writable}
            onChange={reload}
          />
          <RequestsPanel
            patientId={selectedId}
            contacts={familyContacts}
            requests={requests}
            writable={writable}
            onChange={reload}
          />
        </div>
      )}
    </div>
  );
}

function PermissionsPanel({
  patientId,
  contacts,
  permissions,
  writable,
  onChange,
}: {
  patientId: number | null;
  contacts: Contact[];
  permissions: PermissionRow[];
  writable: boolean;
  onChange: () => void | Promise<void>;
}) {
  const [contactId, setContactId] = useState<number | "">("");
  const [mode1, setMode1] = useState(true);
  const [mode2, setMode2] = useState(false);
  const [shareNotes, setShareNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grant = async () => {
    if (patientId == null || contactId === "") return;
    setBusy(true);
    setError(null);
    try {
      await grantFamilyPermission({
        patient_id: patientId,
        contact_id: Number(contactId),
        scope: { mode1, mode2, share_notes: shareNotes },
      });
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not grant access.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: PermissionRow) => {
    if (patientId == null || !row.contact_id) return;
    try {
      await revokeFamilyPermission(patientId, row.contact_id);
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke access.");
    }
  };

  const nameFor = (id?: number) => contacts.find((c) => c.id === id)?.display_name || `contact ${id}`;

  return (
    <Panel title="Permissions" subtitle="Who may interact with the AI on this patient's behalf">
      <ul className="mb-4 space-y-2">
        {permissions.length === 0 ? (
          <Empty>No family permissions granted.</Empty>
        ) : (
          permissions.map((row, index) => (
            <li key={row.id ?? index} className="flex items-center justify-between rounded-xl border border-[#ececec] px-3 py-2">
              <div>
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-[#6e6e6e]" />
                  <span className="text-sm font-medium text-[#1f1f1f]">{nameFor(row.contact_id)}</span>
                  {row.revoked ? <Badge tone="neutral">revoked</Badge> : <Badge tone="success">active</Badge>}
                </div>
                <div className="mt-0.5 text-[11px] text-[#9ca3af]">
                  {String((row.scope as { mode1?: boolean })?.mode1 ? "Mode 1 " : "")}
                  {String((row.scope as { mode2?: boolean })?.mode2 ? "Mode 2 " : "")}
                  {String((row.scope as { share_notes?: boolean })?.share_notes ? "· shares notes" : "")}
                  {row.granted_by ? ` · granted by ${row.granted_by}` : ""}
                </div>
              </div>
              {writable && !row.revoked ? (
                <button type="button" onClick={() => void revoke(row)} className="text-xs font-semibold text-[#d94a4a] hover:underline">
                  Revoke
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>

      {writable ? (
        <div className="rounded-xl border border-[#ececec] p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
            <ShieldCheck className="h-4 w-4 text-[#c63a22]" /> Grant access
          </div>
          <select className="input mb-2 w-full" value={contactId} onChange={(e) => setContactId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Select a family contact…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name} ({c.role})
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-3 text-xs text-[#6e6e6e]">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={mode1} onChange={(e) => setMode1(e.target.checked)} /> Mode 1 (family ↔ AI)
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={mode2} onChange={(e) => setMode2(e.target.checked)} /> Mode 2 (direct call request)
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={shareNotes} onChange={(e) => setShareNotes(e.target.checked)} /> Share care notes
            </label>
          </div>
          <button type="button" onClick={() => void grant()} disabled={busy || contactId === ""} className="btn-primary mt-3 px-4 py-2 text-sm disabled:opacity-50">
            {busy ? "Granting…" : "Grant access"}
          </button>
        </div>
      ) : null}
      {error ? <div className="mt-3"><Notice tone="danger">{error}</Notice></div> : null}
    </Panel>
  );
}

function RequestsPanel({
  patientId,
  contacts,
  requests,
  writable,
  onChange,
}: {
  patientId: number | null;
  contacts: Contact[];
  requests: FamilyRequest[];
  writable: boolean;
  onChange: () => void | Promise<void>;
}) {
  const [contactId, setContactId] = useState<number | "">("");
  const [mode, setMode] = useState("family_ai");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (patientId == null || contactId === "") return;
    setBusy(true);
    setError(null);
    try {
      await createFamilyRequest({ patient_id: patientId, contact_id: Number(contactId), mode });
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the request.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (request: FamilyRequest, approve: boolean) => {
    setError(null);
    try {
      if (approve) await approveFamilyRequest(request.id);
      else await denyFamilyRequest(request.id);
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the decision.");
    }
  };

  const nameFor = (id?: number | null) => contacts.find((c) => c.id === id)?.display_name || `contact ${id ?? "?"}`;

  return (
    <Panel title="Access requests" subtitle="Approval-gated requests, with expiry">
      {writable ? (
        <div className="mb-4 rounded-xl border border-[#ececec] p-3">
          <div className="mb-2 text-sm font-semibold text-[#1f1f1f]">Log a request</div>
          <div className="flex flex-wrap gap-2">
            <select className="input" value={contactId} onChange={(e) => setContactId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Select a family contact…</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ))}
            </select>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="family_ai">Mode 1 — family ↔ AI</option>
              <option value="direct_call">Mode 2 — direct call</option>
            </select>
            <button type="button" onClick={() => void create()} disabled={busy || contactId === ""} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
              {busy ? "Creating…" : "Create request"}
            </button>
          </div>
        </div>
      ) : null}

      <ul className="space-y-2">
        {requests.length === 0 ? (
          <Empty>No family requests for this patient.</Empty>
        ) : (
          requests.map((request) => (
            <li key={request.id} className="rounded-xl border border-[#ececec] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-[#1f1f1f]">{nameFor(request.contact_id)}</span>
                <Badge tone={request.mode === "direct_call" ? "warning" : "info"}>{request.mode}</Badge>
                <Badge
                  tone={
                    request.state === "approved"
                      ? "success"
                      : request.state === "denied"
                      ? "danger"
                      : request.state === "expired"
                      ? "neutral"
                      : "warning"
                  }
                >
                  {request.state}
                </Badge>
                <span className="text-[11px] text-[#9ca3af]">
                  {request.expires_at ? `expires ${formatTime(request.expires_at)}` : ""}
                </span>
              </div>
              {request.detail ? <p className="mt-1 text-xs text-[#6e6e6e]">{request.detail}</p> : null}
              {writable && request.state === "pending" ? (
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => void decide(request, true)} className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                  </button>
                  <button type="button" onClick={() => void decide(request, false)} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
                    <XCircle className="h-3.5 w-3.5" /> Deny
                  </button>
                </div>
              ) : null}
            </li>
          ))
        )}
      </ul>
      {error ? <div className="mt-3"><Notice tone="danger">{error}</Notice></div> : null}
    </Panel>
  );
}
