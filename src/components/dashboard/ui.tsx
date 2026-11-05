"use client";

/**
 * Small presentational primitives shared by the VoiceLink dashboard panels.
 * Everything here is deliberately dumb: it renders state, it never invents it.
 */
import { ReactNode } from "react";
import { RefreshCw, AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ProviderSummary } from "@/lib/platformApi";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-600 border-slate-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  danger: "bg-red-50 text-red-700 border-red-200",
  info: "bg-sky-50 text-sky-700 border-sky-200",
};

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#ececec] bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[#1f1f1f]">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-[#6e6e6e]">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
}) {
  const accent: Record<Tone, string> = {
    neutral: "text-[#1f1f1f]",
    success: "text-emerald-600",
    warning: "text-amber-600",
    danger: "text-red-600",
    info: "text-sky-600",
  };
  return (
    <div className="rounded-2xl border border-[#ececec] bg-white p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#6e6e6e]">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${accent[tone]}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-[#9ca3af]">{hint}</div> : null}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const map: Record<Tone, { cls: string; icon: ReactNode }> = {
    neutral: { cls: "border-slate-200 bg-slate-50 text-slate-700", icon: <Info className="h-4 w-4 shrink-0" /> },
    success: { cls: "border-emerald-200 bg-emerald-50 text-emerald-800", icon: <CheckCircle2 className="h-4 w-4 shrink-0" /> },
    warning: { cls: "border-amber-200 bg-amber-50 text-amber-800", icon: <AlertTriangle className="h-4 w-4 shrink-0" /> },
    danger: { cls: "border-red-200 bg-red-50 text-red-800", icon: <XCircle className="h-4 w-4 shrink-0" /> },
    info: { cls: "border-sky-200 bg-sky-50 text-sky-800", icon: <Info className="h-4 w-4 shrink-0" /> },
  };
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${map[tone].cls}`}>
      {map[tone].icon}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[#6e6e6e]">
      <RefreshCw className="h-4 w-4 animate-spin" />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-[#e5e5e5] px-4 py-6 text-center text-sm text-[#9ca3af]">{children}</div>;
}

/** The honest telephony mode banner, rendered from real provider state. */
export function ModeBanner({ telephony, webhookReady }: { telephony?: ProviderSummary | null; webhookReady?: boolean }) {
  if (!telephony) {
    return <Notice tone="neutral">Telephony status is not available yet.</Notice>;
  }
  const mode = telephony.operating_mode;
  const tone: Tone =
    mode === "live" ? "success" : mode === "configured-unverified" ? "info" : mode === "mock" ? "warning" : "danger";
  return (
    <div className="space-y-1">
      <Notice tone={tone}>
        <span className="font-semibold">{telephony.mode_label}</span>
        <span className="text-xs opacity-80">
          {" "}
          · provider: <span className="font-mono">{telephony.resolved}</span>
          {telephony.requested ? <> · requested: <span className="font-mono">{telephony.requested}</span></> : null}
        </span>
        {mode === "mock" ? (
          <div className="mt-1 text-xs">
            No real telephone call or SMS is placed. Respond with real results only after configuring a carrier and a
            public HTTPS callback.
          </div>
        ) : null}
        {mode === "configured-unverified" ? (
          <div className="mt-1 text-xs">
            Credentials are present, but this is not proof that a real call works. Place a call to a number you control
            to verify end to end.
          </div>
        ) : null}
      </Notice>
      {webhookReady === false && mode !== "mock" ? (
        <Notice tone="danger">
          No public HTTPS callback is configured, so a carrier cannot reach this server. Set{" "}
          <span className="font-mono">PUBLIC_BASE_URL</span> / <span className="font-mono">TELEPHONY_WEBHOOK_BASE_URL</span>{" "}
          to a public HTTPS endpoint.
        </Notice>
      ) : null}
    </div>
  );
}

// --- formatting helpers -----------------------------------------------------
export function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatDurationMs(ms?: number | null): string {
  if (!ms || ms <= 0) return "—";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function severityTone(severity?: string): Tone {
  switch ((severity || "").toLowerCase()) {
    case "emergency":
      return "danger";
    case "urgent":
      return "warning";
    case "follow_up":
    case "follow-up":
      return "info";
    case "routine":
      return "success";
    default:
      return "neutral";
  }
}

export function callStateTone(state?: string): Tone {
  switch ((state || "").toLowerCase()) {
    case "connected":
    case "answered":
    case "completed":
      return "success";
    case "queued":
    case "dialing":
    case "ringing":
    case "created":
      return "info";
    case "failed":
    case "busy":
    case "no_answer":
    case "rejected":
    case "cancelled":
    case "provider_timeout":
      return "danger";
    default:
      return "neutral";
  }
}

export function messageStateTone(state?: string): Tone {
  switch ((state || "").toLowerCase()) {
    case "delivered":
      return "success";
    case "sent":
    case "queued":
    case "created":
      return "info";
    case "failed":
    case "undelivered":
      return "danger";
    default:
      return "neutral";
  }
}

export function escalationStateTone(state?: string): Tone {
  switch ((state || "").toLowerCase()) {
    case "open":
      return "danger";
    case "acknowledged":
      return "warning";
    case "resolved":
      return "success";
    default:
      return "neutral";
  }
}
