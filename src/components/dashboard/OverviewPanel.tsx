"use client";

import { AlertTriangle, PhoneCall, RefreshCw, MessageSquare, Clock } from "lucide-react";
import type { OverviewData } from "@/lib/platformApi";
import {
  Badge,
  Empty,
  Panel,
  Spinner,
  StatCard,
  callStateTone,
  formatDurationMs,
  messageStateTone,
  relativeTime,
  severityTone,
} from "@/components/dashboard/ui";

export function OverviewPanel({
  overview,
  onRefresh,
  onNavigate,
}: {
  overview: (OverviewData & { ok: boolean }) | null;
  onRefresh: () => void | Promise<void>;
  onNavigate: (tab: "patients" | "escalations" | "family" | "provider" | "audit") => void;
}) {
  if (!overview) {
    return (
      <Panel title="Live operations" subtitle="Current calls, alerts and messages">
        <Spinner label="Loading live state…" />
      </Panel>
    );
  }

  const counts = overview.counts;
  const unack = overview.unacknowledged_alerts || [];

  return (
    <div className="space-y-6">
      {unack.length > 0 ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-red-800">
                {unack.length} escalation{unack.length === 1 ? "" : "s"} need acknowledgement
              </div>
              <ul className="mt-2 space-y-1 text-sm text-red-800">
                {unack.slice(0, 4).map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={severityTone(item.severity)}>{item.severity}</Badge>
                    <span className="font-medium">{item.reason || item.category}</span>
                    <span className="text-xs opacity-80">{relativeTime(item.created_at)}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => onNavigate("escalations")}
                className="mt-3 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
              >
                Open escalation center
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[#6e6e6e]">Live operations</h2>
        <button type="button" onClick={() => void onRefresh()} className="btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-xs">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Active calls" value={counts.active_calls} tone="info" />
        <StatCard label="Open escalations" value={counts.open_escalations} tone={counts.open_escalations ? "danger" : "neutral"} />
        <StatCard label="Unacknowledged" value={counts.unacknowledged} tone={counts.unacknowledged ? "danger" : "neutral"} />
        <StatCard label="Missed calls" value={counts.missed_calls} tone={counts.missed_calls ? "warning" : "neutral"} />
        <StatCard label="Pending messages" value={counts.pending_messages} tone="info" />
        <StatCard label="Scheduled jobs" value={counts.scheduled_jobs} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Active calls" subtitle="Ringing, answered or connected right now">
          {overview.active_calls.length === 0 ? (
            <Empty>No calls in progress.</Empty>
          ) : (
            <ul className="space-y-2">
              {overview.active_calls.map((call) => (
                <li key={call.id} className="flex items-center justify-between rounded-xl border border-[#ececec] px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <PhoneCall className="h-4 w-4 text-[#c63a22]" />
                      <span className="text-sm font-medium text-[#1f1f1f]">
                        {call.to_masked || "unknown number"}
                      </span>
                      <Badge tone={callStateTone(call.state)}>{call.state}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-[#9ca3af]">
                      {call.purpose} · {call.direction} · {relativeTime(call.created_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onNavigate("patients")}
                    className="text-xs font-semibold text-[#c63a22] hover:underline"
                  >
                    Workspace
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Escalations" subtitle="Open alerts, newest first">
          {overview.open_escalations.length === 0 ? (
            <Empty>No open escalations.</Empty>
          ) : (
            <ul className="space-y-2">
              {overview.open_escalations.slice(0, 8).map((item) => (
                <li key={item.id} className="rounded-xl border border-[#ececec] px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={severityTone(item.severity)}>{item.severity}</Badge>
                    <span className="text-sm font-medium text-[#1f1f1f]">{item.category}</span>
                    {item.requires_ack ? <Badge tone="warning">needs ack</Badge> : null}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-[#6e6e6e]">{item.reason}</p>
                  <div className="mt-1 text-[11px] text-[#9ca3af]">{relativeTime(item.created_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Missed / failed calls" subtitle="No answer, busy, failed or timed out">
          {overview.missed_calls.length === 0 ? (
            <Empty>No missed or failed calls.</Empty>
          ) : (
            <ul className="space-y-2">
              {overview.missed_calls.map((call) => (
                <li key={call.id} className="flex items-center justify-between rounded-xl border border-[#ececec] px-3 py-2">
                  <div>
                    <span className="text-sm font-medium text-[#1f1f1f]">{call.to_masked || "unknown number"}</span>
                    <div className="text-xs text-[#9ca3af]">
                      {call.purpose} · {relativeTime(call.created_at)}
                    </div>
                  </div>
                  <Badge tone={callStateTone(call.state)}>{call.state}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Pending messages" subtitle="Created, queued or accepted — not yet confirmed delivered">
          {overview.pending_messages.length === 0 ? (
            <Empty>No messages awaiting a delivery result.</Empty>
          ) : (
            <ul className="space-y-2">
              {overview.pending_messages.map((msg) => (
                <li key={msg.id} className="rounded-xl border border-[#ececec] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-[#c63a22]" />
                    <span className="text-sm font-medium text-[#1f1f1f]">{msg.to_masked || "unknown number"}</span>
                    <Badge tone={messageStateTone(msg.state)}>{msg.state}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-[#6e6e6e]">{msg.body}</p>
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-[#9ca3af]">
                    <Clock className="h-3 w-3" /> {relativeTime(msg.created_at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
