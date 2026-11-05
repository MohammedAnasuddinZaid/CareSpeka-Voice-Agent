"use client";

/**
 * VoiceLink care dashboard shell.
 *
 * Signs in against the local backend with a session cookie, then exposes the
 * six working areas a nurse or administrator uses.  Every value shown is drawn
 * from the backend response; nothing here is hard-coded status.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  Users,
  AlertTriangle,
  ShieldCheck,
  FileText,
  RefreshCw,
  Phone,
  Lock,
  User as UserIcon,
} from "lucide-react";
import {
  ApiError,
  getOverview,
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  type OverviewData,
  type SessionUser,
} from "@/lib/platformApi";
import { ModeBanner, Notice, Spinner } from "@/components/dashboard/ui";
import { OverviewPanel } from "@/components/dashboard/OverviewPanel";
import { PatientsPanel } from "@/components/dashboard/PatientsPanel";
import { EscalationsPanel } from "@/components/dashboard/EscalationsPanel";
import { FamilyPanel } from "@/components/dashboard/FamilyPanel";
import { ProviderPanel } from "@/components/dashboard/ProviderPanel";
import { AuditPanel } from "@/components/dashboard/AuditPanel";

type TabId = "overview" | "patients" | "escalations" | "family" | "provider" | "audit";

const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "patients", label: "Patients", icon: Users },
  { id: "escalations", label: "Escalations", icon: AlertTriangle },
  { id: "family", label: "Family access", icon: Users },
  { id: "provider", label: "Provider", icon: ShieldCheck },
  { id: "audit", label: "Audit & reports", icon: FileText },
];

export default function DashboardShell() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [tab, setTab] = useState<TabId>("overview");
  const [overview, setOverview] = useState<(OverviewData & { ok: boolean }) | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshOverview = useCallback(async () => {
    try {
      const data = await getOverview();
      setOverview(data);
      setOverviewError(null);
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : "Could not load overview.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await apiMe();
        if (!cancelled) setUser(current);
      } catch {
        if (!cancelled) setUser(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    void refreshOverview();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshOverview();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [user, refreshOverview]);

  const handleLogout = useCallback(async () => {
    setBusy(true);
    try {
      await apiLogout();
    } catch {
      /* signing out locally is still correct even if the request fails */
    }
    setUser(null);
    setOverview(null);
    setBusy(false);
  }, []);

  if (user === undefined) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Connecting to the VoiceLink backend…" />
      </div>
    );
  }

  if (!user) {
    return <LoginCard onSignedIn={setUser} />;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#c63a22] text-white">
              <Phone className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold text-[#1f1f1f]">VoiceLink care dashboard</h1>
              <p className="text-xs text-[#6e6e6e]">
                Patient · AI · nurse · family communication and escalation
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-xl border border-[#ececec] bg-white px-3 py-2 text-sm">
            <UserIcon className="h-4 w-4 text-[#6e6e6e]" />
            <span className="font-medium text-[#1f1f1f]">{user.display_name}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              {user.role}
            </span>
          </span>
          <button
            type="button"
            onClick={handleLogout}
            disabled={busy}
            className="btn-secondary px-3 py-2 text-sm disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mb-6">
        <ModeBanner telephony={overview?.telephony} webhookReady={overview?.webhook_ready} />
        {overviewError ? (
          <div className="mt-2">
            <Notice tone="warning">{overviewError}</Notice>
          </div>
        ) : null}
      </div>

      <nav className="mb-6 flex flex-wrap gap-1 border-b border-[#ececec] pb-px">
        {TABS.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`inline-flex items-center gap-2 rounded-t-lg px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-b-2 border-[#c63a22] text-[#c63a22]"
                  : "border-b-2 border-transparent text-[#6e6e6e] hover:text-[#1f1f1f]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </nav>

      {tab === "overview" ? (
        <OverviewPanel overview={overview} onRefresh={refreshOverview} onNavigate={setTab} />
      ) : null}
      {tab === "patients" ? <PatientsPanel user={user} onChanged={refreshOverview} /> : null}
      {tab === "escalations" ? <EscalationsPanel user={user} onChanged={refreshOverview} /> : null}
      {tab === "family" ? <FamilyPanel user={user} /> : null}
      {tab === "provider" ? <ProviderPanel user={user} onChanged={refreshOverview} /> : null}
      {tab === "audit" ? <AuditPanel /> : null}
    </div>
  );
}

function LoginCard({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await apiLogin(username.trim(), password);
      onSignedIn(session);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Could not reach the backend. Is the VoiceLink server running?");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
      <div className="w-full rounded-2xl border border-[#ececec] bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#c63a22] text-white">
            <Lock className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-bold text-[#1f1f1f]">VoiceLink dashboard</h1>
            <p className="text-xs text-[#6e6e6e]">Staff sign-in required</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-[#6e6e6e]" htmlFor="vl-username">
              Username
            </label>
            <input
              id="vl-username"
              className="input w-full"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-[#6e6e6e]" htmlFor="vl-password">
              Password
            </label>
            <input
              id="vl-password"
              type="password"
              className="input w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <button type="submit" disabled={busy} className="btn-primary w-full px-4 py-2.5 disabled:opacity-50">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="mt-4">
          <Notice tone="neutral">
            <span className="text-xs">
              Local setup: the first administrator password is generated into{" "}
              <span className="font-mono">backend/runtime/admin_credentials.txt</span>. The demo nurse account is{" "}
              <span className="font-mono">nurse.demo</span> / <span className="font-mono">nurse.demo</span>. Change both
              before real use.
            </span>
          </Notice>
        </div>
      </div>
    </div>
  );
}
