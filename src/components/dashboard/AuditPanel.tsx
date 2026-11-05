"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";
import { getAudit, getReports, type AuditEntry } from "@/lib/platformApi";
import { Badge, Empty, Notice, Panel, Spinner, formatTime } from "@/components/dashboard/ui";

type Reports = Awaited<ReturnType<typeof getReports>>;

export function AuditPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [chain, setChain] = useState<{ ok: boolean; entries?: number } | null>(null);
  const [reports, setReports] = useState<Reports | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [audit, reportData] = await Promise.all([getAudit(200), getReports()]);
      setEntries(audit.entries);
      setChain(audit.chain);
      setReports(reportData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load audit data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Panel title="Audit & reports">
        <Spinner label="Loading audit trail…" />
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Panel
        title="Audit trail"
        subtitle="Tamper-evident hash chain over security-relevant actions"
        actions={
          <button type="button" onClick={() => void load()} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        }
      >
        {chain ? (
          <div className="mb-3">
            {chain.ok ? (
              <Notice tone="success">
                <span className="inline-flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" /> Chain intact{typeof chain.entries === "number" ? ` over ${chain.entries} entries` : ""}.
                </span>
              </Notice>
            ) : (
              <Notice tone="danger">
                <span className="inline-flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4" /> The audit chain failed verification. Investigate immediately.
                </span>
              </Notice>
            )}
          </div>
        ) : null}

        {entries.length === 0 ? (
          <Empty>No audit entries recorded yet.</Empty>
        ) : (
          <div className="max-h-[420px] overflow-auto rounded-xl border border-[#ececec]">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-[#fafafa] text-[#6e6e6e]">
                <tr>
                  <th className="px-3 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">Actor</th>
                  <th className="px-3 py-2 font-semibold">Action</th>
                  <th className="px-3 py-2 font-semibold">Entity</th>
                  <th className="px-3 py-2 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-t border-[#f0f0f0]">
                    <td className="whitespace-nowrap px-3 py-1.5 text-[#9ca3af]">{formatTime(entry.at)}</td>
                    <td className="px-3 py-1.5">
                      <span className="text-[#1f1f1f]">{entry.actor_id || "—"}</span>
                      {entry.actor_role ? <span className="ml-1 text-[#9ca3af]">({entry.actor_role})</span> : null}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[#c63a22]">{entry.action}</td>
                    <td className="px-3 py-1.5 text-[#6e6e6e]">
                      {entry.entity_type || "—"}
                      {entry.entity_id ? ` #${entry.entity_id}` : ""}
                    </td>
                    <td className="px-3 py-1.5 text-[#9ca3af]">
                      {entry.detail && Object.keys(entry.detail).length ? JSON.stringify(entry.detail) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Reports" subtitle="Counts derived from stored records — no estimated figures">
        {reports ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Metric label="Calls" value={reports.totals.calls} />
              <Metric label="Messages" value={reports.totals.messages} />
              <Metric label="Escalations" value={reports.totals.escalations} />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Breakdown title="Calls by state" data={reports.calls_by_state} />
              <Breakdown title="Messages by state" data={reports.messages_by_state} />
              <Breakdown title="Escalations by severity" data={reports.escalations_by_severity} />
            </div>
          </div>
        ) : (
          <Empty>No report data.</Empty>
        )}
      </Panel>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[#ececec] p-3 text-center">
      <div className="text-2xl font-bold tabular-nums text-[#1f1f1f]">{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">{label}</div>
    </div>
  );
}

function Breakdown({ title, data }: { title: string; data: Record<string, number> }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-xl border border-[#ececec] p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#6e6e6e]">
        <BarChart3 className="h-3.5 w-3.5" /> {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-[#9ca3af]">No data.</div>
      ) : (
        <ul className="space-y-1">
          {rows.map(([key, count]) => (
            <li key={key} className="flex items-center justify-between text-xs">
              <span className="text-[#6e6e6e]">{key}</span>
              <Badge tone="neutral">{count}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
