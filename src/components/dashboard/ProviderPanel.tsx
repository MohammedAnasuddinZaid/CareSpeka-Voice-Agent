"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck, Wifi } from "lucide-react";
import {
  ApiError,
  getProvider,
  saveProviderSecrets,
  testProvider,
  type ProviderSummary,
  type SessionUser,
} from "@/lib/platformApi";
import { Badge, Empty, Notice, Panel, Spinner } from "@/components/dashboard/ui";

const SECRET_GROUPS: { title: string; names: { key: string; label: string }[] }[] = [
  {
    title: "Exotel (primary)",
    names: [
      { key: "EXOTEL_API_KEY", label: "API key" },
      { key: "EXOTEL_API_TOKEN", label: "API token" },
      { key: "EXOTEL_ACCOUNT_SID", label: "Account SID" },
      { key: "EXOTEL_CALLER_ID", label: "ExoPhone / caller ID" },
      { key: "EXOTEL_WEBHOOK_SECRET", label: "Webhook shared secret" },
      { key: "EXOTEL_SUBDOMAIN", label: "Subdomain (api.in.exotel / api.exotel)" },
      { key: "EXOTEL_DLT_ENTITY_ID", label: "DLT entity id (SMS)" },
      { key: "EXOTEL_DLT_TEMPLATE_ID", label: "DLT template id (SMS)" },
    ],
  },
  {
    title: "Twilio (secondary)",
    names: [
      { key: "TWILIO_ACCOUNT_SID", label: "Account SID" },
      { key: "TWILIO_AUTH_TOKEN", label: "Auth token" },
      { key: "TWILIO_PHONE_NUMBER", label: "Voice number" },
      { key: "TWILIO_MESSAGING_NUMBER", label: "Messaging number" },
      { key: "TWILIO_WEBHOOK_BASE_URL", label: "Webhook base URL override" },
    ],
  },
  {
    title: "Deployment",
    names: [
      { key: "PUBLIC_BASE_URL", label: "Public base URL (https)" },
      { key: "TELEPHONY_WEBHOOK_BASE_URL", label: "Webhook base URL (https)" },
    ],
  },
];

export function ProviderPanel({ user, onChanged }: { user: SessionUser; onChanged: () => void | Promise<void> }) {
  const [provider, setProvider] = useState<ProviderSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const isAdmin = user.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getProvider();
      setProvider(data.provider);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load provider settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runTest = async () => {
    setTestResult(null);
    try {
      const result = await testProvider();
      setTestResult(
        result.webhook_ready
          ? "Callback address is public HTTPS. That still does not prove reachability — place a real call to a number you control."
          : "No public HTTPS callback is configured yet, so a carrier cannot deliver callbacks to this server.",
      );
    } catch (err) {
      setTestResult(err instanceof ApiError ? err.message : "Provider test failed.");
    }
  };

  if (loading) {
    return (
      <Panel title="Provider settings">
        <Spinner label="Loading provider state…" />
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Panel
        title="Telephony provider"
        subtitle="What is configured, and what is only simulated"
        actions={
          <button type="button" onClick={() => void load()} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        }
      >
        {provider ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Operating mode" value={<Badge tone={provider.operating_mode === "live" ? "success" : provider.operating_mode === "mock" ? "warning" : provider.operating_mode === "configured-unverified" ? "info" : "danger"}>{provider.mode_label}</Badge>} />
              <Field label="Resolved provider" value={<span className="font-mono text-sm">{provider.resolved}</span>} />
              <Field label="Requested" value={<span className="font-mono text-sm">{provider.requested || "auto"}</span>} />
              <Field label="Calls enabled" value={provider.telephony_enabled ? <Badge tone="success">yes</Badge> : <Badge tone="danger">no</Badge>} />
            </div>

            <div className="rounded-xl border border-[#ececec] p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
                <Wifi className="h-4 w-4 text-[#c63a22]" /> Callbacks
              </div>
              <div className="space-y-1 text-xs text-[#6e6e6e]">
                <div>
                  Webhook base URL:{" "}
                  <span className="font-mono">{provider.webhook_base_url || "not set"}</span>{" "}
                  {provider.webhook_base_url?.startsWith("https://") ? (
                    <Badge tone="success">public HTTPS</Badge>
                  ) : (
                    <Badge tone="danger">not public HTTPS</Badge>
                  )}
                </div>
                <div className="text-[11px] text-[#9ca3af]">
                  A carrier must reach this server over the public internet to deliver status events and the media
                  stream. Use a reverse proxy, deployment or an authenticated tunnel; never expose the local port
                  directly.
                </div>
              </div>
              <button type="button" onClick={() => void runTest()} className="btn-secondary mt-2 px-3 py-1.5 text-xs">
                Run configuration check
              </button>
              {testResult ? <div className="mt-2"><Notice tone="info">{testResult}</Notice></div> : null}
            </div>

            <div className="rounded-xl border border-[#ececec] p-3">
              <div className="mb-2 text-sm font-semibold text-[#1f1f1f]">Adapters</div>
              <ul className="space-y-2">
                {provider.available?.map((item) => (
                  <li key={item.provider} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-[#1f1f1f]">{item.provider}</span>
                    {item.configured ? <Badge tone="success">configured</Badge> : <Badge tone="neutral">not configured</Badge>}
                    <Badge tone={item.operating_mode === "mock" ? "warning" : item.operating_mode === "disabled" ? "neutral" : "info"}>
                      {item.operating_mode}
                    </Badge>
                    {item.missing?.length ? <span className="text-[#9ca3af]">missing: {item.missing.join(", ")}</span> : null}
                  </li>
                ))}
              </ul>
              {provider.media ? (
                <div className="mt-2 text-[11px] text-[#9ca3af]">
                  Media stream: {provider.media.encoding} @ {provider.media.sample_rate} Hz, {provider.media.frame_ms} ms frames
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <Empty>No provider information.</Empty>
        )}
      </Panel>

      <SecretsPanel provider={provider} isAdmin={isAdmin} onSaved={async () => {
        await load();
        await onChanged();
      }} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#ececec] p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">{label}</div>
      <div className="mt-1">{value}</div>
    </div>
  );
}

function SecretsPanel({
  provider,
  isAdmin,
  onSaved,
}: {
  provider: ProviderSummary | null;
  isAdmin: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);

  const status = provider?.secrets || {};

  const submit = async () => {
    const payload = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""));
    if (Object.keys(payload).length === 0) {
      setError("Enter at least one value to store.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await saveProviderSecrets(payload);
      setSaved(res.stored);
      setValues({});
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not store the credentials.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Credentials"
      subtitle="Stored locally in a git-ignored file or environment. Values are never shown again after saving."
    >
      {!isAdmin ? (
        <Notice tone="warning">Only an administrator can change provider credentials. You can view which are set.</Notice>
      ) : null}

      <div className="space-y-4">
        {SECRET_GROUPS.map((group) => (
          <div key={group.title} className="rounded-xl border border-[#ececec] p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
              <ShieldCheck className="h-4 w-4 text-[#c63a22]" /> {group.title}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.names.map((item) => (
                <div key={item.key}>
                  <label className="mb-1 flex items-center gap-2 text-xs text-[#6e6e6e]">
                    <span>{item.label}</span>
                    {status[item.key] ? <Badge tone="success">set</Badge> : <Badge tone="neutral">unset</Badge>}
                  </label>
                  <input
                    type="password"
                    className="input w-full"
                    placeholder={status[item.key] ? "•••••• (leave blank to keep)" : "not set"}
                    value={values[item.key] || ""}
                    onChange={(e) => setValues((prev) => ({ ...prev, [item.key]: e.target.value }))}
                    disabled={!isAdmin}
                    autoComplete="off"
                  />
                  <div className="mt-0.5 font-mono text-[10px] text-[#c4c4c4]">{item.key}</div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {error ? <Notice tone="danger">{error}</Notice> : null}
        {saved ? (
          <Notice tone="success">
            Stored: {saved.length ? saved.join(", ") : "nothing"} · {provider?.mode_label}
          </Notice>
        ) : null}

        {isAdmin ? (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void submit()} disabled={busy} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
              {busy ? "Saving…" : "Save credentials"}
            </button>
            <span className="inline-flex items-center gap-1 text-[11px] text-[#9ca3af]">
              <AlertTriangle className="h-3 w-3" /> Never paste production credentials into shared screenshots or chat.
            </span>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
