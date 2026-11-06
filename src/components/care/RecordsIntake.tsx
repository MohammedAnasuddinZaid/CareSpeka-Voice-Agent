"use client";

/**
 * Patient records intake.
 *
 * The nurse links a patient and adds the documents the portal assistant should
 * know about — discharge summaries, lab reports, transfer notes. Everything is
 * free text and read verbatim; nothing here is interpreted as a diagnosis.
 *
 * Works on a phone (single column, large tap targets) and on a laptop.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  LogOut,
  ShieldCheck,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import {
  CareApiError,
  careAddRecord,
  careDeleteRecord,
  careListPatients,
  careListRecords,
  careLogin,
  careLogout,
  careMe,
  type CareRecordSummary,
  type CareUser,
  type PatientSummary,
} from "@/lib/careClient";

const MAX_CHARS = 40_000;
const ACCEPT = ".txt,.md,.markdown,.csv,.json,.log,.text";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function RecordsIntake() {
  const [authState, setAuthState] = useState<"checking" | "anon" | "ready">("checking");
  const [user, setUser] = useState<CareUser | null>(null);

  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [patientId, setPatientId] = useState<string>("");
  const [records, setRecords] = useState<CareRecordSummary[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);

  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);

  // --- auth ---------------------------------------------------------------
  useEffect(() => {
    let active = true;
    void careMe()
      .then((res) => {
        if (!active) return;
        setUser(res.user);
        setAuthState("ready");
      })
      .catch(() => {
        if (active) setAuthState("anon");
      });
    return () => {
      active = false;
    };
  }, []);

  // --- patients -----------------------------------------------------------
  useEffect(() => {
    if (authState !== "ready") return;
    let active = true;
    void careListPatients()
      .then((res) => {
        if (!active) return;
        setPatients(res.patients);
        const fromUrl =
          typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("patientId") : null;
        const preferred =
          (fromUrl && res.patients.some((p) => p.id === fromUrl) ? fromUrl : null) ??
          res.patients[0]?.id ??
          "";
        setPatientId((current) => current || preferred);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load patients.");
      });
    return () => {
      active = false;
    };
  }, [authState]);

  const loadRecords = useCallback(async (id: string) => {
    if (!id) {
      setRecords([]);
      return;
    }
    setLoadingRecords(true);
    try {
      const res = await careListRecords(id);
      setRecords(res.records);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load records.");
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  useEffect(() => {
    void loadRecords(patientId);
  }, [patientId, loadRecords]);

  const selectedPatient = useMemo(() => patients.find((p) => p.id === patientId) ?? null, [patients, patientId]);

  const totalChars = useMemo(() => records.reduce((n, r) => n + r.chars, 0), [records]);

  // --- actions ------------------------------------------------------------
  const flash = (message: string) => {
    setNotice(message);
    setError(null);
    window.setTimeout(() => setNotice((n) => (n === message ? null : n)), 4000);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > MAX_CHARS * 4) {
      setError(`“${file.name}” is ${(file.size / 1024 / 1024).toFixed(1)} MB. Please paste the relevant section instead.`);
      return;
    }
    try {
      const content = await file.text();
      setText(content);
      if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
      if (!source.trim()) setSource("Uploaded file");
    } catch {
      setError("That file could not be read. Try pasting its contents instead.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!patientId) {
      setError("Choose a patient first.");
      return;
    }
    if (!title.trim()) {
      setError("Give the record a title, for example “Discharge summary”.");
      return;
    }
    if (!text.trim()) {
      setError("Paste the record text or upload a file.");
      return;
    }
    if (text.length > MAX_CHARS) {
      setError(`That is ${text.length.toLocaleString()} characters; the limit is ${MAX_CHARS.toLocaleString()}.`);
      return;
    }

    setBusy(true);
    try {
      await careAddRecord({ patientId, title: title.trim(), source: source.trim() || undefined, text });
      setTitle("");
      setSource("");
      setText("");
      await loadRecords(patientId);
      flash("Record added. The portal assistant can use it immediately.");
    } catch (err) {
      setError(err instanceof CareApiError ? err.message : "Could not save the record.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (record: CareRecordSummary) => {
    if (!window.confirm(`Delete “${record.title}”? The assistant will stop using it.`)) return;
    setDeletingId(record.id);
    setError(null);
    try {
      await careDeleteRecord(record.id);
      setRecords((prev) => prev.filter((r) => r.id !== record.id));
      flash("Record deleted.");
    } catch (err) {
      setError(err instanceof CareApiError ? err.message : "Could not delete the record.");
    } finally {
      setDeletingId(null);
    }
  };

  const signOut = async () => {
    try {
      await careLogout();
    } catch {
      /* ignore */
    }
    setUser(null);
    setAuthState("anon");
  };

  // --- render -------------------------------------------------------------
  if (authState === "checking") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-[#6e6e6e]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking your session…
      </div>
    );
  }

  if (authState === "anon") {
    return <LoginCard onSignedIn={(u) => { setUser(u); setAuthState("ready"); }} />;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-24 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-[#c63a22]" />
            <h1 className="text-xl font-bold text-[#1f1f1f] sm:text-2xl">Patient records</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-[#6e6e6e]">
            Add the history the portal assistant should know — discharge summaries, lab reports, transfer notes.
            It reads them as context when the nurse scans the patient&apos;s QR code.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <span className="hidden items-center gap-1.5 rounded-full border border-[#ececec] bg-white px-3 py-1.5 text-xs font-medium text-[#4b4b4b] sm:inline-flex">
              <User className="h-3.5 w-3.5" /> {user.displayName}
            </span>
          ) : null}
          <button
            onClick={signOut}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[#ececec] bg-white px-3 py-1.5 text-xs font-semibold text-[#6e6e6e] hover:text-[#1f1f1f]"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </header>

      {notice ? (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        {/* form */}
        <form onSubmit={submit} className="rounded-2xl border border-[#ececec] bg-white p-5 shadow-sm">
          <div className="mb-4">
            <label className="block text-xs font-semibold uppercase tracking-wide text-[#6e6e6e]" htmlFor="patient">
              Patient
            </label>
            <select
              id="patient"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-[#e5e5e5] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#c63a22]"
            >
              {patients.length === 0 ? <option value="">No patients available</option> : null}
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                  {p.room ? ` — ${p.room}` : ""}
                  {p.synthetic ? " (demo)" : ""}
                </option>
              ))}
            </select>
            {selectedPatient ? (
              <p className="mt-1.5 text-xs text-[#9ca3af]">
                {selectedPatient.age != null ? `${selectedPatient.age}y` : "Age not recorded"}
                {selectedPatient.primaryConcern ? ` · ${selectedPatient.primaryConcern}` : ""}
              </p>
            ) : null}
          </div>

          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-[#6e6e6e]" htmlFor="title">
                Title
              </label>
              <input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Discharge summary"
                maxLength={160}
                className="mt-1.5 w-full rounded-xl border border-[#e5e5e5] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#c63a22]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-[#6e6e6e]" htmlFor="source">
                Source <span className="font-normal normal-case text-[#9ca3af]">(optional)</span>
              </label>
              <input
                id="source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="Lab report / Transfer note"
                maxLength={80}
                className="mt-1.5 w-full rounded-xl border border-[#e5e5e5] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#c63a22]"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold uppercase tracking-wide text-[#6e6e6e]" htmlFor="record-text">
                Record text
              </label>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-1 text-xs font-semibold text-[#4b4b4b] hover:border-[#c63a22] hover:text-[#c63a22]"
              >
                <Upload className="h-3.5 w-3.5" /> Upload
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => void handleFile(e.target.files?.[0])}
              />
            </div>
            <textarea
              id="record-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder="Paste the record here. Plain text, CSV or JSON from a file all work."
              className="mt-1.5 w-full resize-y rounded-xl border border-[#e5e5e5] bg-white px-3 py-2.5 font-mono text-[13px] leading-relaxed outline-none focus:border-[#c63a22]"
            />
            <div className="mt-1 flex items-center justify-between text-[11px]">
              <span className="text-[#9ca3af]">.txt · .md · .csv · .json</span>
              <span className={text.length > MAX_CHARS ? "font-semibold text-red-600" : "text-[#9ca3af]"}>
                {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
              </span>
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#c63a22] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#a92f1b] disabled:opacity-50 sm:w-auto"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            {busy ? "Saving…" : "Add record"}
          </button>

          <p className="mt-3 flex items-start gap-1.5 text-[11px] text-[#9ca3af]">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Stored in your CareSpeak store. The assistant quotes these documents but never diagnoses or invents values.
          </p>
        </form>

        {/* list */}
        <section className="rounded-2xl border border-[#ececec] bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-[#1f1f1f]">
              Added records
              {records.length > 0 ? <span className="ml-1.5 text-[#9ca3af]">({records.length})</span> : null}
            </h2>
            {records.length > 0 ? (
              <span className="text-[11px] text-[#9ca3af]">{totalChars.toLocaleString()} chars</span>
            ) : null}
          </div>

          {loadingRecords ? (
            <div className="flex items-center gap-2 py-8 text-sm text-[#6e6e6e]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading records…
            </div>
          ) : records.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#e5e5e5] px-4 py-10 text-center">
              <FileText className="mx-auto mb-2 h-8 w-8 text-[#d5d5d5]" />
              <p className="text-sm font-medium text-[#6e6e6e]">No records yet</p>
              <p className="mt-1 text-xs text-[#9ca3af]">
                Add the patient&apos;s history so the portal assistant can answer questions about it.
              </p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {records.map((r) => (
                <li key={r.id} className="rounded-xl border border-[#f0f0f0] bg-[#fafafa] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[#1f1f1f]">{r.title}</p>
                      <p className="mt-0.5 text-[11px] text-[#9ca3af]">
                        {r.source ? `${r.source} · ` : ""}
                        {formatDate(r.createdAt)} · {r.chars.toLocaleString()} chars
                      </p>
                    </div>
                    <button
                      onClick={() => void remove(r)}
                      disabled={deletingId === r.id}
                      title="Delete record"
                      className="shrink-0 rounded-lg p-1.5 text-[#9ca3af] transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    >
                      {deletingId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 rounded-xl bg-[#f7f5f2] px-3 py-3 text-[11px] leading-relaxed text-[#6e6e6e]">
            <strong className="text-[#1f1f1f]">How it is used:</strong> when the nurse scans the patient&apos;s QR
            code, the portal assistant answers questions from these documents plus the live Blink Rate, Alertness, Eye
            Closure and Movement readings — and speaks up when a reading leaves its threshold.
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

function LoginCard({ onSignedIn }: { onSignedIn: (u: CareUser) => void }) {
  const [username, setUsername] = useState("nurse.demo");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await careLogin(username, password);
      onSignedIn(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4 pt-16">
      <form onSubmit={submit} className="w-full rounded-2xl border border-[#ececec] bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <FileText className="h-5 w-5 text-[#c63a22]" />
          <h1 className="text-lg font-bold text-[#1f1f1f]">Patient records — nurse sign in</h1>
        </div>
        <label className="block text-xs font-semibold text-[#6e6e6e]">
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm"
            autoComplete="username"
          />
        </label>
        <label className="mt-3 block text-xs font-semibold text-[#6e6e6e]">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm"
            autoComplete="current-password"
          />
        </label>
        {error ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded-lg bg-[#c63a22] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#a92f1b] disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="mt-3 text-[11px] text-[#9ca3af]">
          Demo credentials come from <span className="font-mono">CARE_NURSE_USER</span> /{" "}
          <span className="font-mono">CARE_NURSE_PASS</span>.
        </p>
      </form>
    </div>
  );
}