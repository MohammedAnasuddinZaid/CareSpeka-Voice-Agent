"use client";

/**
 * Nurse dashboard for the Web Voice Call — Demo.
 *
 * Real state only: it creates a session, shows the QR, negotiates native WebRTC,
 * hosts the browser AI (Whisper / WebLLM, opt-in) or falls back to the server
 * care engine, streams the live transcript, and produces a reviewable report.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  LogOut,
  Play,
  ShieldCheck,
  Square,
  UserRound,
  X,
} from "lucide-react";
import {
  CareApiError,
  careConfig,
  careCreateSession,
  careFallbackAgent,
  careGenerateReport,
  careGetSession,
  careListPatients,
  careListSessions,
  careLogin,
  careLogout,
  careMe,
  carePatchReport,
  carePostEvent,
  carePostTranscript,
  careRegenerateQr,
  careAudit,
  careSessionAction,
  type CareConfig,
  type CareUser,
  type InsightsPayload,
  type PatientSummary,
} from "@/lib/careClient";
import {
  CareLLM,
  SpeechCapture,
  Transcriber,
  careSystemPrompt,
  speak,
  speechSynthesisAvailable,
  stopSpeaking,
  webgpuAvailable,
  type AiStatus,
} from "@/lib/care/browserAI";
import { useCareRtc } from "@/hooks/useCareRtc";
import { Badge, Empty, Notice, Panel, Spinner, formatDurationMs, formatTime } from "@/components/dashboard/ui";
import {
  AiEnginePanel,
  AuditTimeline,
  ClinicalProfilePanel,
  ConnectionPanel,
  EventFeed,
  InsightsPanel,
  QrCard,
  ReportPanel,
  TaskList,
  TranscriptPanel,
  sessionTone,
} from "@/components/care/panels";
import type {
  CareAuditEntry,
  CareEvent,
  CareReport,
  CareSessionView,
  CareTask,
  CareTranscriptEntry,
} from "@/lib/care/types";

export default function CareDashboard() {
  const [authState, setAuthState] = useState<"checking" | "anon" | "ready">("checking");
  const [user, setUser] = useState<CareUser | null>(null);
  const [config, setConfig] = useState<CareConfig | null>(null);

  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [sessions, setSessions] = useState<Array<Record<string, unknown>>>([]);
  const [audit, setAudit] = useState<CareAuditEntry[]>([]);

  const [session, setSession] = useState<CareSessionView | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<CareEvent[]>([]);
  const [transcript, setTranscript] = useState<CareTranscriptEntry[]>([]);
  const [insights, setInsights] = useState<InsightsPayload | null>(null);
  const [tasks, setTasks] = useState<CareTask[]>([]);
  const [report, setReport] = useState<CareReport | null>(null);

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [patientSpeechOnDevice, setPatientSpeechOnDevice] = useState(false);

  const [aiStatus, setAiStatus] = useState<AiStatus>({
    asr: "idle",
    llm: "idle",
    vad: "idle",
    tts: speechSynthesisAvailable() ? "ready" : "unsupported",
    webgpu: false,
  });

  const sinceEventRef = useRef(0);
  const sinceTranscriptRef = useRef(0);
  const transcriptRef = useRef<CareTranscriptEntry[]>([]);
  const transcriberRef = useRef<Transcriber | null>(null);
  const llmRef = useRef<CareLLM | null>(null);
  const captureRef = useRef<SpeechCapture | null>(null);
  const busyRef = useRef(false);
  const greetedRef = useRef(false);
  const nurseSpeakRef = useRef(false);
  const rtcRef = useRef<ReturnType<typeof useCareRtc> | null>(null);

  transcriptRef.current = transcript;

  useEffect(() => {
    setAiStatus((s) => ({ ...s, webgpu: webgpuAvailable() }));
  }, []);

  // --- bootstrap -----------------------------------------------------------
  const refreshLists = useCallback(async () => {
    try {
      const [p, s, a] = await Promise.all([careListPatients(), careListSessions(), careAudit(undefined, 120)]);
      setPatients(p.patients);
      setSessions(s.sessions as unknown as Array<Record<string, unknown>>);
      setAudit(a.audit);
    } catch (err) {
      if (err instanceof CareApiError && err.status === 401) setAuthState("anon");
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await careMe();
        if (!active) return;
        setUser(me.user);
        setAuthState("ready");
      } catch {
        if (active) setAuthState("anon");
        return;
      }
      try {
        const cfg = await careConfig();
        if (active) setConfig(cfg);
      } catch {
        /* non-fatal */
      }
      if (active) await refreshLists();
    })();
    return () => {
      active = false;
    };
  }, [refreshLists]);

  // --- elapsed timer -------------------------------------------------------
  useEffect(() => {
    if (!session || (session.status !== "active" && session.status !== "ending")) {
      setElapsedMs(session?.durationMs ?? 0);
      return;
    }
    const startMs = session.startedAt ? Date.parse(session.startedAt) : Date.parse(session.createdAt);
    const update = () => setElapsedMs(Date.now() - startMs);
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [session]);

  // --- session polling -----------------------------------------------------
  useEffect(() => {
    const id = session?.id;
    if (!id) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const data = await careGetSession(id, {
          sinceEvent: sinceEventRef.current,
          sinceTranscript: sinceTranscriptRef.current,
        });
        if (!active) return;
        setSession(data.session);
        if (data.events.length) {
          sinceEventRef.current = Math.max(...data.events.map((e) => e.seq));
          setEvents((prev) => [...prev, ...data.events]);
        }
        if (data.transcript.length) {
          sinceTranscriptRef.current = Math.max(...data.transcript.map((t) => t.seq));
          setTranscript((prev) => [...prev, ...data.transcript]);
        }
        if (data.insights) setInsights(data.insights);
        if (data.tasks) setTasks(data.tasks);
      } catch {
        /* keep polling */
      }
      if (active) timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session?.id]);

  // --- agent reply pipeline ------------------------------------------------
  const deliverAgent = useCallback((text: string) => {
    rtcRef.current?.sendData({ type: "agent", text });
    if (nurseSpeakRef.current) speak(text);
  }, []);

  const runAgentReply = useCallback(
    async (lastPatientText: string) => {
      const id = session?.id;
      const patient = session?.patient;
      if (!id || !patient) return;
      if (llmRef.current?.status === "ready") {
        try {
          const history = transcriptRef.current
            .filter((e) => e.role === "patient" || e.role === "agent")
            .slice(-8)
            .map((e) => ({ role: e.role === "agent" ? ("assistant" as const) : ("user" as const), content: e.text }));
          const reply = await llmRef.current.chat(careSystemPrompt(patient), history, lastPatientText);
          if (reply) {
            await carePostTranscript(id, { role: "agent", text: reply, engine: "WebLLM (on-device)" });
            deliverAgent(reply);
            return;
          }
        } catch {
          /* fall through to the server engine */
        }
      }
      const res = await careFallbackAgent(id, "reply");
      deliverAgent(res.text);
    },
    [deliverAgent, session?.id, session?.patient]
  );

  const handleUtterance = useCallback(
    async (audio: Float32Array) => {
      const id = session?.id;
      if (!id || busyRef.current) return;
      const transcriber = transcriberRef.current;
      if (!transcriber || transcriber.status !== "ready") return;
      busyRef.current = true;
      try {
        const { text, engine } = await transcriber.transcribe(audio);
        if (text) {
          await carePostTranscript(id, { role: "patient", text, engine });
          await runAgentReply(text);
        }
      } catch {
        /* ignore single-utterance failure */
      } finally {
        busyRef.current = false;
      }
    },
    [runAgentReply, session?.id]
  );
  const handleUtteranceRef = useRef(handleUtterance);
  handleUtteranceRef.current = handleUtterance;

  // --- capture patient audio when the peer stream arrives ------------------
  useEffect(() => {
    if (!remoteStream) return;
    let capture: SpeechCapture | null = null;
    let cancelled = false;
    (async () => {
      try {
        capture = new SpeechCapture({
          onSpeechStart: () => session?.id && void carePostEvent(session.id, "speech.started").catch(() => undefined),
          onSpeechEnd: (audio) => void handleUtteranceRef.current(audio),
        });
        await capture.start(remoteStream);
        if (cancelled) {
          void capture.stop();
          return;
        }
        captureRef.current = capture;
        setAiStatus((s) => ({ ...s, vad: "ready" }));
      } catch {
        setAiStatus((s) => ({ ...s, vad: "error" }));
      }
    })();
    return () => {
      cancelled = true;
      void capture?.stop();
      if (captureRef.current === capture) captureRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteStream]);

  // --- RTC -----------------------------------------------------------------
  const handlePatientData = useCallback(
    async (msg: Record<string, unknown>) => {
      const id = session?.id;
      if (!id) return;
      if (msg.type === "patient_text" && typeof msg.text === "string") {
        await carePostTranscript(id, { role: "patient", text: msg.text, engine: "patient device (Web Speech)" }).catch(() => undefined);
        await runAgentReply(msg.text);
      } else if (msg.type === "bye") {
        setNotice("The patient ended their side of the call.");
      }
    },
    [runAgentReply, session?.id]
  );

  const rtc = useCareRtc({
    sessionId: session?.id ?? "",
    role: "nurse",
    iceServers: config?.webrtc.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
    pollMs: config?.limits.signalPollMs ?? 1200,
    enabled: Boolean(session && session.status === "active"),
    start: session?.status === "active",
    onRemoteStream: (s) => setRemoteStream(s),
    onData: (m) => void handlePatientData(m),
  });
  rtcRef.current = rtc;

  useEffect(() => {
    if (session?.status === "active" && session.participantName) {
      void carePostEvent(session.id, "agent.connected", { host: "nurse-browser" }).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status, session?.participantName]);

  // --- greeting ------------------------------------------------------------
  useEffect(() => {
    const id = session?.id;
    if (!id || session?.status !== "active") return;
    if (greetedRef.current) return;
    if (transcriptRef.current.some((e) => e.role === "agent")) return;
    greetedRef.current = true;
    void careFallbackAgent(id, "greeting")
      .then((r) => deliverAgent(r.text))
      .catch(() => undefined);
  }, [deliverAgent, session?.id, session?.status]);

  // --- actions -------------------------------------------------------------
  const startSession = useCallback(
    async (patientId: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await careCreateSession(patientId);
        sinceEventRef.current = 0;
        sinceTranscriptRef.current = 0;
        greetedRef.current = false;
        setEvents([]);
        setTranscript([]);
        setInsights(null);
        setTasks([]);
        setReport(null);
        setSession(res.session);
        setQrDataUrl(res.qrDataUrl);
        setJoinUrl(res.session.joinUrl);
        setNotice("Session created. Ask the patient to scan the QR code.");
        await refreshLists();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not start the session.");
      } finally {
        setBusy(false);
      }
    },
    [refreshLists]
  );

  const endSession = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      stopSpeaking();
      rtcRef.current?.sendData({ type: "session_ended" });
      const res = await careSessionAction(session.id, "end", { reason: "nurse_ended" });
      if (res.session) setSession(res.session);
      const rep = await careGenerateReport(session.id);
      setReport(rep.report);
      setNotice("Session ended. A draft report is ready for review.");
      void careAudit().then((a) => setAudit(a.audit));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end the session.");
    } finally {
      setBusy(false);
    }
  }, [session]);

  const regenerateQr = useCallback(async () => {
    if (!session) return;
    try {
      const res = await careRegenerateQr(session.id);
      setSession(res.session);
      setQrDataUrl(res.qrDataUrl);
      setJoinUrl(res.session.joinUrl);
      setNotice("A fresh joining link and code were generated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not regenerate the link.");
    }
  }, [session]);

  const acknowledgeEscalation = useCallback(async () => {
    if (!session) return;
    try {
      const res = await careSessionAction(session.id, "escalation.acknowledged");
      if (res.session) setSession(res.session);
    } catch {
      /* ignore */
    }
  }, [session]);

  const addTask = useCallback(
    async (title: string) => {
      if (!session) return;
      try {
        await careSessionAction(session.id, "task.create", { title });
        const data = await careGetSession(session.id);
        if (data.tasks) setTasks(data.tasks);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not add the task.");
      }
    },
    [session]
  );

  const editReport = useCallback(
    async (summary: string, note: string) => {
      if (!report) return;
      const res = await carePatchReport(report.id, { action: "edit", nurseEditedSummary: summary, reviewNote: note });
      setReport(res.report);
    },
    [report]
  );

  const approveReport = useCallback(
    async (note: string) => {
      if (!report) return;
      const res = await carePatchReport(report.id, { action: "approve", reviewNote: note });
      setReport(res.report);
      setNotice("Report approved and saved to the record.");
    },
    [report]
  );

  const reopenReport = useCallback(async () => {
    if (!report) return;
    const res = await carePatchReport(report.id, { action: "reopen" });
    setReport(res.report);
  }, [report]);

  const loadAsr = useCallback(async () => {
    const t = new Transcriber();
    transcriberRef.current = t;
    t.onProgress = (p, detail) => setAiStatus((s) => ({ ...s, asr: "loading", detail: `Speech model ${Math.round(p * 100)}% — ${detail}` }));
    setAiStatus((s) => ({ ...s, asr: "loading", detail: "Downloading speech model…" }));
    try {
      await t.load(config?.ai.asrModel);
      setAiStatus((s) => ({ ...s, asr: "ready", detail: undefined }));
    } catch (err) {
      setAiStatus((s) => ({ ...s, asr: "error", detail: err instanceof Error ? err.message : "Speech model failed to load." }));
    }
  }, [config?.ai.asrModel]);

  const loadLlm = useCallback(async () => {
    const l = new CareLLM();
    llmRef.current = l;
    l.onProgress = (p, detail) => setAiStatus((s) => ({ ...s, llm: "loading", detail: `Language model ${Math.round(p * 100)}% — ${detail}` }));
    setAiStatus((s) => ({ ...s, llm: "loading", detail: "Downloading language model…" }));
    try {
      await l.load(config?.ai.llmModel);
      setAiStatus((s) => ({ ...s, llm: "ready", detail: undefined }));
    } catch (err) {
      setAiStatus((s) => ({ ...s, llm: "error", detail: err instanceof Error ? err.message : "Language model failed to load." }));
    }
  }, [config?.ai.llmModel]);

  const signOut = useCallback(async () => {
    await careLogout().catch(() => undefined);
    setUser(null);
    setAuthState("anon");
    setSession(null);
  }, []);

  const copy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label} copied to clipboard.`);
    } catch {
      setError("Clipboard is unavailable — copy manually.");
    }
  }, []);

  const usingFallback = aiStatus.llm !== "ready";

  // --- render --------------------------------------------------------------
  if (authState === "checking") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Checking your session…" />
      </div>
    );
  }

  if (authState === "anon") {
    return <LoginScreen onSignedIn={(u) => { setUser(u); setAuthState("ready"); void refreshLists(); void careConfig().then(setConfig).catch(() => undefined); }} />;
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-[#c63a22]" />
            <h1 className="text-xl font-bold text-[#1f1f1f]">CareSpeak — Web Voice Call</h1>
            <Badge tone="info">Demo</Badge>
          </div>
          <p className="mt-0.5 text-xs text-[#6e6e6e]">
            Browser-to-browser AI care calls. This is a demonstration channel, not a telephone call.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {config ? (
            <Badge tone={config.store.persistent ? "success" : "warning"} title={`store: ${config.store.driver}`}>
              <ShieldCheck className="h-3 w-3" /> {config.store.persistent ? `persistent (${config.store.driver})` : `NOT persistent (${config.store.driver})`}
            </Badge>
          ) : null}
          <span className="text-sm text-[#4b4b4b]">{user?.displayName}</span>
          <button onClick={signOut} className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] px-2.5 py-1 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7]">
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </header>

      {!config?.store.persistent ? (
        <div className="mb-4">
          <Notice tone="warning">
            Persistent storage is not configured. Set <span className="font-mono">UPSTASH_REDIS_REST_URL</span> and{" "}
            <span className="font-mono">UPSTASH_REDIS_REST_TOKEN</span> so sessions survive across serverless instances and devices.
          </Notice>
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4">
          <Notice tone="info">
            <span className="flex items-center justify-between gap-2">
              <span>{notice}</span>
              <button onClick={() => setNotice(null)} aria-label="Dismiss">
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </Notice>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <Notice tone="danger">
            <span className="flex items-center justify-between gap-2">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss">
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </Notice>
        </div>
      ) : null}

      {session ? (
        <LiveWorkspace
          session={session}
          qrDataUrl={qrDataUrl}
          joinUrl={joinUrl}
          events={events}
          transcript={transcript}
          insights={insights}
          tasks={tasks}
          report={report}
          elapsedMs={elapsedMs}
          aiStatus={aiStatus}
          rtc={rtc}
          busy={busy}
          usingFallback={usingFallback}
          patientSpeechOnDevice={patientSpeechOnDevice}
          onToggleOnDevice={setPatientSpeechOnDevice}
          onEnd={endSession}
          onRegenerate={regenerateQr}
          onCopy={copy}
          onAck={acknowledgeEscalation}
          onAddTask={addTask}
          onEditReport={editReport}
          onApproveReport={approveReport}
          onReopenReport={reopenReport}
          onLoadAsr={loadAsr}
          onLoadLlm={loadLlm}
          onExit={() => {
            setSession(null);
            void refreshLists();
          }}
        />
      ) : (
        <SetupView patients={patients} sessions={sessions} audit={audit} busy={busy} onStart={startSession} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

function LoginScreen({ onSignedIn }: { onSignedIn: (u: CareUser) => void }) {
  const [username, setUsername] = useState("nurse.demo");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
      <form onSubmit={submit} className="w-full rounded-2xl border border-[#ececec] bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <Activity className="h-5 w-5 text-[#c63a22]" />
          <h1 className="text-lg font-bold text-[#1f1f1f]">CareSpeak — nurse sign in</h1>
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
          <div className="mt-3">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded-lg bg-[#c63a22] px-4 py-2 text-sm font-semibold text-white hover:bg-[#a92f1b] disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="mt-3 text-[11px] text-[#9ca3af]">
          Demo credentials are configured by environment variables. Set{" "}
          <span className="font-mono">CARE_NURSE_USER</span> / <span className="font-mono">CARE_NURSE_PASS</span> before real use.
        </p>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// setup view
// ---------------------------------------------------------------------------

function SetupView({
  patients,
  sessions,
  audit,
  busy,
  onStart,
}: {
  patients: PatientSummary[];
  sessions: Array<Record<string, unknown>>;
  audit: CareAuditEntry[];
  busy: boolean;
  onStart: (patientId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const patient = useMemo(() => patients.find((p) => p.id === selected) ?? null, [patients, selected]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <Panel title="Patients" subtitle="Select a patient to start a Web Voice Call — Demo">
        {patients.length === 0 ? (
          <Empty>No patients available.</Empty>
        ) : (
          <ul className="divide-y divide-[#f1f1f1]">
            {patients.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setSelected(p.id)}
                  className={`flex w-full items-center gap-3 px-1 py-3 text-left transition ${
                    selected === p.id ? "bg-[#fdf2ef]" : "hover:bg-[#fafafa]"
                  }`}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f1f5f9] text-[#475569]">
                    <UserRound className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-[#1f1f1f]">{p.displayName}</span>
                    <span className="block truncate text-xs text-[#6e6e6e]">
                      {p.age ? `${p.age} yrs · ` : ""}
                      {p.primaryConcern || "No primary concern recorded"}
                    </span>
                  </span>
                  <span className="flex gap-1">
                    <Badge tone="neutral">{p.activeConditions} cond.</Badge>
                    <Badge tone={p.allergies ? "danger" : "neutral"}>{p.allergies} allergy</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="space-y-4">
        <Panel title="Start a session" subtitle={patient ? patient.displayName : "No patient selected"}>
          {patient ? (
            <div className="space-y-3 text-sm text-[#4b4b4b]">
              <p>{patient.primaryConcern || "No primary concern recorded."}</p>
              <button
                onClick={() => onStart(patient.id)}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-[#c63a22] px-4 py-2 text-sm font-semibold text-white hover:bg-[#a92f1b] disabled:opacity-50"
              >
                <Play className="h-4 w-4" /> Start Web Voice Call — Demo
              </button>
            </div>
          ) : (
            <Empty>Pick a patient from the list.</Empty>
          )}
        </Panel>

        <Panel title="Recent sessions" subtitle="Past Web Voice Call — Demo sessions">
          {sessions.length === 0 ? (
            <Empty>No sessions yet.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {sessions.slice(0, 8).map((s) => (
                <li key={String(s.id)} className="flex items-center gap-2">
                  <Badge tone={sessionTone(String(s.status))}>{String(s.status)}</Badge>
                  <span className="text-[#4b4b4b]">{String(s.patientName)}</span>
                  <span className="ml-auto text-xs text-[#9ca3af]">{formatTime(String(s.createdAt))}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <AuditTimeline entries={audit} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// live workspace
// ---------------------------------------------------------------------------

function LiveWorkspace(props: {
  session: CareSessionView;
  qrDataUrl: string | null;
  joinUrl?: string;
  events: CareEvent[];
  transcript: CareTranscriptEntry[];
  insights: InsightsPayload | null;
  tasks: CareTask[];
  report: CareReport | null;
  elapsedMs: number;
  aiStatus: AiStatus;
  rtc: ReturnType<typeof useCareRtc>;
  busy: boolean;
  usingFallback: boolean;
  patientSpeechOnDevice: boolean;
  onToggleOnDevice: (v: boolean) => void;
  onEnd: () => void;
  onRegenerate: () => void;
  onCopy: (text: string, label: string) => void;
  onAck: () => void;
  onAddTask: (title: string) => void;
  onEditReport: (summary: string, note: string) => void;
  onApproveReport: (note: string) => void;
  onReopenReport: () => void;
  onLoadAsr: () => void;
  onLoadLlm: () => void;
  onExit: () => void;
}) {
  const { session, rtc } = props;
  const live = session.status === "active";

  return (
    <div className="space-y-4">
      {session.escalated ? (
        <Notice tone="danger">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 font-semibold">
              <Activity className="h-4 w-4" /> Escalation raised — a red-flag symptom was reported. Review immediately.
            </span>
            <button onClick={props.onAck} className="rounded-lg border border-red-300 px-2.5 py-1 text-xs font-semibold hover:bg-white">
              Acknowledge
            </button>
          </div>
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={sessionTone(session.status)}>{session.status}</Badge>
        <span className="text-sm text-[#4b4b4b]">
          {session.patient?.displayName} · {session.patientId}
        </span>
        <span className="text-xs text-[#9ca3af]">Elapsed {formatDurationMs(props.elapsedMs)}</span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={props.onEnd}
            disabled={props.busy || session.status === "ended"}
            className="inline-flex items-center gap-1 rounded-lg bg-[#1f1f1f] px-3 py-1.5 text-xs font-semibold text-white hover:bg-black disabled:opacity-40"
          >
            <Square className="h-3.5 w-3.5" /> End session
          </button>
          <button onClick={props.onExit} className="rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7]">
            Back to patients
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr_0.9fr]">
        <div className="space-y-4">
          <ConnectionPanel
            session={session}
            status={rtc.status}
            pcState={rtc.pcState}
            iceState={rtc.iceState}
            elapsedMs={props.elapsedMs}
            aiStatus={props.aiStatus}
            onReconnect={rtc.restart}
            error={rtc.error}
          />
          {!live ? (
            <QrCard
              qrDataUrl={props.qrDataUrl}
              joinUrl={props.joinUrl}
              joinCode={session.joinCode}
              expiresAt={session.joinExpiresAt}
              onCopyLink={() => props.joinUrl && props.onCopy(props.joinUrl, "Joining link")}
              onCopyCode={() => session.joinCode && props.onCopy(session.joinCode, "Joining code")}
              onRegenerate={props.onRegenerate}
              onOpen={() => props.joinUrl && window.open(props.joinUrl, "_blank", "noopener")}
            />
          ) : null}
          <TranscriptPanel entries={props.transcript} live={live} />
        </div>

        <div className="space-y-4">
          <ClinicalProfilePanel patient={session.patient ?? null} />
          <InsightsPanel insights={props.insights} escalated={session.escalated} />
        </div>

        <div className="space-y-4">
          <AiEnginePanel
            aiStatus={props.aiStatus}
            onLoadAsr={props.onLoadAsr}
            onLoadLlm={props.onLoadLlm}
            patientSpeechOnDevice={props.patientSpeechOnDevice}
            onToggleOnDevice={props.onToggleOnDevice}
            usingFallback={props.usingFallback}
          />
          <EventFeed events={props.events} />
          <TaskList tasks={props.tasks} />
        </div>
      </div>

      <ReportPanel
        report={props.report}
        editable
        onEdit={props.onEditReport}
        onApprove={props.onApproveReport}
        onReopen={props.onReopenReport}
        onAddTask={props.onAddTask}
      />

      {session.status === "ended" ? (
        <Notice tone="success">Session ended. The report above is the permanent record for this interaction.</Notice>
      ) : null}
    </div>
  );
}
