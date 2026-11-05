"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Siren } from "lucide-react";
import {
  ApiError,
  acknowledgeEscalation,
  getEscalations,
  resolveEscalation,
  type Escalation,
  type EscalationAction,
  type SessionUser,
} from "@/lib/platformApi";
import {
  Badge,
  Empty,
  Notice,
  Panel,
  Spinner,
  escalationStateTone,
  formatTime,
  relativeTime,
  severityTone,
} from "@/components/dashboard/ui";

const FILTERS: { id: string; label: string }[] = [
  { id: "", label: "All" },
  { id: "open", label: "Open" },
  { id: "acknowledged", label: "Acknowledged" },
  { id: "resolved", label: "Resolved" },
];

export function EscalationsPanel({ user, onChanged }: { user: SessionUser; onChanged: () => void | Promise<void> }) {
  const [state, setState] = useState("open");
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [actions, setActions] = useState<Record<string, EscalationAction[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const writable = user.role === "admin" || user.role === "nurse";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getEscalations(state || undefined);
      setEscalations(data.escalations);
      setActions(data.actions || {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load escalations.");
    } finally {
      setLoading(false);
    }
  }, [state]);

  useEffect(() => {
    void load();
  }, [load]);

  const after = useCallback(async () => {
    await load();
    await onChanged();
  }, [load, onChanged]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((filter) => (
            <button
              key={filter.id || "all"}
              type="button"
              onClick={() => setState(filter.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                state === filter.id ? "bg-[#c63a22] text-white" : "bg-white text-[#6e6e6e] border border-[#ececec] hover:text-[#1f1f1f]"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void load()} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Notice tone="neutral">
        <span className="text-xs">
          Escalations are created by deterministic rules plus a bounded language check with confirmation. An emergency
          always overrides quiet hours and rate limits. The AI is an assistant — not a nurse and not an ambulance
          service.
        </span>
      </Notice>

      {loading ? (
        <Panel title="Escalation center">
          <Spinner label="Loading escalations…" />
        </Panel>
      ) : escalations.length === 0 ? (
        <Panel title="Escalation center">
          <Empty>No escalations match this filter.</Empty>
        </Panel>
      ) : (
        <div className="space-y-3">
          {escalations.map((item) => (
            <EscalationCard
              key={item.id}
              escalation={item}
              actions={actions[item.id] || []}
              writable={writable}
              onChange={after}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EscalationCard({
  escalation,
  actions,
  writable,
  onChange,
}: {
  escalation: Escalation;
  actions: EscalationAction[];
  writable: boolean;
  onChange: () => void | Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urgent = escalation.severity === "emergency" || escalation.severity === "urgent";

  const act = async (kind: "ack" | "resolve") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "ack") {
        await acknowledgeEscalation(escalation.id, note);
      } else {
        await resolveEscalation(escalation.id, note);
      }
      setNote("");
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`rounded-2xl border bg-white p-4 shadow-sm ${urgent ? "border-red-200" : "border-[#ececec]"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {escalation.severity === "emergency" ? <Siren className="h-4 w-4 text-red-600" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
            <Badge tone={severityTone(escalation.severity)}>{escalation.severity}</Badge>
            <Badge tone={escalationStateTone(escalation.state)}>{escalation.state}</Badge>
            {escalation.requires_ack ? <Badge tone="warning">needs acknowledgement</Badge> : null}
            <span className="text-sm font-semibold text-[#1f1f1f]">{escalation.category}</span>
          </div>
          <p className="mt-1 text-sm text-[#4b5563]">{escalation.reason}</p>
          {escalation.transcript_excerpt ? (
            <blockquote className="mt-2 border-l-2 border-[#ececec] pl-3 text-xs italic text-[#6e6e6e]">
              “{escalation.transcript_excerpt}”
            </blockquote>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#9ca3af]">
            <span>created {formatTime(escalation.created_at)}</span>
            {escalation.acknowledged_by ? <span>acked by {escalation.acknowledged_by} {relativeTime(escalation.acknowledged_at)}</span> : null}
            {escalation.resolved_by ? <span>resolved by {escalation.resolved_by} {relativeTime(escalation.resolved_at)}</span> : null}
          </div>
        </div>

        {writable && (escalation.state === "open" || escalation.state === "acknowledged") ? (
          <div className="flex flex-col items-stretch gap-2">
            <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex gap-2">
              {escalation.state === "open" ? (
                <button
                  type="button"
                  onClick={() => void act("ack")}
                  disabled={busy !== null}
                  className="btn-secondary inline-flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> {busy === "ack" ? "Acknowledging…" : "Acknowledge"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void act("resolve")}
                disabled={busy !== null}
                className="btn-primary inline-flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> {busy === "resolve" ? "Resolving…" : "Resolve"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {error ? <div className="mt-2"><Notice tone="danger">{error}</Notice></div> : null}

      {actions.length > 0 ? (
        <div className="mt-3 border-t border-[#f0f0f0] pt-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">Action trail</div>
          <ul className="space-y-1">
            {actions.slice(0, 8).map((action) => (
              <li key={action.id} className="flex flex-wrap items-center gap-2 text-xs text-[#6e6e6e]">
                <Badge tone={action.state === "done" ? "success" : action.state === "failed" ? "danger" : "info"}>
                  {action.action_type}
                </Badge>
                <span>{action.target_masked || ""}</span>
                {action.result ? <span className="text-[#9ca3af]">{action.result}</span> : null}
                <span className="text-[10px] text-[#c4c4c4]">{relativeTime(action.created_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
