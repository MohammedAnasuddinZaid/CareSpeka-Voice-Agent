"use client";

/**
 * Live talking assistant for the nurse portal.
 *
 * Mounted on /nurse-view, i.e. the page a nurse lands on after scanning the
 * patient's QR code. It:
 *   - loads the session's linked patient and inserted records,
 *   - watches the live Blink Rate / Alertness / Eye Closure / Movement readings,
 *   - speaks an alert when a reading leaves its threshold (deduped, mutable),
 *   - answers spoken or typed questions from the record + live signals,
 *   - says honestly which engine answered (Gemini or local rules) and whether
 *     the answer came from cache.
 *
 * It never diagnoses, never invents a vital, and degrades to the deterministic
 * engine when Gemini is unavailable.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileText,
  Loader2,
  Mic,
  MicOff,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Volume2,
  VolumeX,
  Activity,
  Link2,
  PhoneCall,
  Monitor,
  ShieldCheck,
} from "lucide-react";
import {
  CareApiError,
  careDeletePatient,
  carePortalAlert,
  carePortalAsk,
  carePortalBrief,
  carePortalCall,
  carePortalContext,
  carePortalLink,
  carePortalUnlink,
  type PortalAlert,
  type PortalContext,
  type PortalSeverity,
} from "@/lib/careClient";
import { speak, speechSynthesisAvailable, stopSpeaking } from "@/lib/care/browserAI";
import { getActiveCareSession, rememberCareSession } from "@/lib/session";
import FreeCallPanel from "@/components/care/FreeCallPanel";

// ---------------------------------------------------------------------------
// speech input (browser Web Speech API, optional)
// ---------------------------------------------------------------------------

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getRecognition(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

// ---------------------------------------------------------------------------
// severity helpers
// ---------------------------------------------------------------------------

const RANK: Record<PortalSeverity, number> = { ok: 0, watch: 1, warning: 2, critical: 3 };

const SEVERITY_STYLE: Record<PortalSeverity, { chip: string; dot: string; label: string }> = {
  critical: { chip: "border-red-200 bg-red-50 text-red-700", dot: "bg-red-500", label: "Critical" },
  warning: { chip: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500", label: "Warning" },
  watch: { chip: "border-sky-200 bg-sky-50 text-sky-700", dot: "bg-sky-500", label: "Watch" },
  ok: { chip: "border-emerald-200 bg-emerald-50 text-emerald-700", dot: "bg-emerald-500", label: "Within thresholds" },
};

type SeverityFloor = "all" | "warning" | "critical";

interface Turn {
  id: number;
  role: "nurse" | "assistant";
  text: string;
  engine?: "gemini" | "rules";
  model?: string;
  cached?: boolean;
  intent?: string;
}

interface AlertEntry {
  id: number;
  at: number;
  line: string;
  severity: PortalSeverity;
  engine: "gemini" | "rules";
  cached: boolean;
}

const ALERT_INTERVALS = [
  { label: "15s", value: 15_000 },
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
];

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export default function PortalAssistant({
  sessionId,
  pair,
}: {
  sessionId: string | null;
  pair?: string | null;
}) {
  const [context, setContext] = useState<PortalContext | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);

  const [pickedPatient, setPickedPatient] = useState("");
  const [linking, setLinking] = useState(false);
  const [showDemoPatients, setShowDemoPatients] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [alerts, setAlerts] = useState<AlertEntry[]>([]);

  // settings
  const [voiceOn, setVoiceOn] = useState(true);
  const [autoAlert, setAutoAlert] = useState(true);
  const [alertInterval, setAlertInterval] = useState(15_000);
  const [severityFloor, setSeverityFloor] = useState<SeverityFloor>("all");
  const [showSettings, setShowSettings] = useState(false);
  const [showLinkPatient, setShowLinkPatient] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  // phone calling
  const [autoCall, setAutoCall] = useState(true);
  const [calling, setCalling] = useState(false);
  const [callNotice, setCallNotice] = useState<string | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [freeOpen, setFreeOpen] = useState(false);

  const resolvedPair = useMemo(() => {
    if (pair) return pair;
    if (typeof window === "undefined") return null;
    const fromUrl = new URLSearchParams(window.location.search).get("pair");
    if (fromUrl) return fromUrl;
    const active = getActiveCareSession();
    if (active?.sessionId === sessionId) return active.pair;
    return null;
  }, [pair, sessionId]);

  const pairRef = useRef<string | null>(resolvedPair);
  pairRef.current = resolvedPair;

  // Keep the browser-wide "active care session" in sync with this portal, so
  // the free browser call opens on the session the nurse is paired to.
  useEffect(() => {
    if (sessionId) rememberCareSession(sessionId, resolvedPair);
  }, [resolvedPair, sessionId]);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const idRef = useRef(0);
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastSigRef = useRef<string>("");
  const briefedRef = useRef<string | null>(null);
  const voiceRef = useRef(voiceOn);
  voiceRef.current = voiceOn;
  const ttsAvailable = useMemo(() => speechSynthesisAvailable(), []);
  const callingRef = useRef(false);
  const contextReqRef = useRef(0);
  const hasPatientRef = useRef(false);
  hasPatientRef.current = Boolean(context?.patient);

  // Reset per-session memory when the session changes.
  useEffect(() => {
    briefedRef.current = null;
    lastSigRef.current = "";
  }, [sessionId]);

  const speakLine = useCallback((line: string) => {
    if (!voiceRef.current || !line) return;
    try {
      stopSpeaking();
      speak(line, {
        onStart: () => setSpeaking(true),
        onEnd: () => setSpeaking(false),
      });
    } catch {
      setSpeaking(false);
    }
  }, []);

  // --- phone call ----------------------------------------------------------
  const placeCall = useCallback(
    async (reason: "emergency" | "demo") => {
      if (!sessionId || callingRef.current) return;
      callingRef.current = true;
      setCalling(true);
      setCallNotice(null);
      setCallError(null);
      try {
        const res = await carePortalCall(sessionId, pairRef.current, { reason });
        setCallNotice(
          reason === "emergency"
            ? `Emergency call placed to ${res.to}. The CareSpeak agent is briefing them now.`
            : `Calling ${res.to}. The CareSpeak agent will brief you as soon as you answer.`
        );
      } catch (err) {
        setCallError(err instanceof CareApiError ? err.message : "Could not place the call.");
        // Twilio's free trial blocks custom call scripts — offer the free
        // browser call in the same card instead of a raw provider error.
        if (err instanceof CareApiError && err.code === "trial_custom_call") setFreeOpen(true);
      } finally {
        callingRef.current = false;
        setCalling(false);
      }
    },
    [sessionId]
  );

  // --- context -------------------------------------------------------------
  const loadContext = useCallback(
    async (quiet = false) => {
      if (!sessionId) {
        setContext(null);
        return null;
      }
      const reqId = ++contextReqRef.current;
      if (!quiet) setLoadingContext(true);
      setContextError(null);
      try {
        const res = await carePortalContext(sessionId, pairRef.current);
        if (reqId !== contextReqRef.current) return null;
        setContext(res.context);
        const linkedPatientId = res.context.link?.patientId;
        if (linkedPatientId) setPickedPatient((prev) => prev || linkedPatientId);
        return res.context;
      } catch (err) {
        if (reqId !== contextReqRef.current) return null;
        setContextError(err instanceof CareApiError ? err.message : "Could not reach the care store.");
        return null;
      } finally {
        if (reqId === contextReqRef.current) setLoadingContext(false);
      }
    },
    [sessionId]
  );

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  // Refresh context every 12s so the readings shown match the live stream.
  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(() => void loadContext(true), 12_000);
    return () => window.clearInterval(timer);
  }, [loadContext, sessionId]);

  // One spoken orientation per linked patient.
  useEffect(() => {
    if (!sessionId || !context?.patient) return;
    if (briefedRef.current === context.patient.id) return;
    briefedRef.current = context.patient.id;
    let active = true;
    void carePortalBrief(sessionId, pairRef.current)
      .then((res) => {
        if (!active || !res.brief.line) return;
        speakLine(res.brief.line);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [context?.patient, sessionId, speakLine]);

  // --- automatic alert watcher --------------------------------------------
  useEffect(() => {
    if (!sessionId || !autoAlert) return;
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await carePortalAlert(sessionId, pairRef.current, false);
        if (cancelled) return;
        const alert: PortalAlert = res.alert;

        // Keep the chips in sync with the live readings.
        if (alert.findings) {
          setContext((c) => (c ? { ...c, findings: alert.findings, worst: alert.severity } : c));
        }

        if (!alert.line) {
          lastSigRef.current = "";
        } else {
          const sig = alert.findings
            .map((f) => (f.key === "signal_stale" ? `${f.key}:${f.severity}` : `${f.key}:${f.reading}`))
            .sort()
            .join("|");
          const passes = RANK[alert.severity] >= RANK[severityFloor === "all" ? "watch" : severityFloor];
          if (sig && sig !== lastSigRef.current) {
            lastSigRef.current = sig;
            setAlerts((prev) => [
              { id: ++idRef.current, at: Date.now(), line: alert.line, severity: alert.severity, engine: alert.engine, cached: alert.cached },
              ...prev,
            ].slice(0, 12));
            if (passes) speakLine(alert.line);

            // A critical reading also phones the nurse, unless they turned it off.
            // The server dedupes with a 90s cooldown so a jittery sensor cannot
            // place a burst of calls.
            if (autoCall && alert.severity === "critical" && hasPatientRef.current) {
              void placeCall("emergency");
            }
          }
        }
      } catch {
        /* transient; next tick retries */
      }
      if (!cancelled) timer = window.setTimeout(tick, alertInterval);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [alertInterval, autoAlert, autoCall, placeCall, sessionId, severityFloor, speakLine]);

  // --- chat ----------------------------------------------------------------
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns.length, thinking]);

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!sessionId || !question || thinking) return;
      setInput("");
      setChatError(null);
      setThinking(true);
      setTurns((t) => [...t, { id: ++idRef.current, role: "nurse", text: question }]);
      try {
        const res = await carePortalAsk(sessionId, question, pairRef.current);
        const r = res.result;
        setTurns((t) => [
          ...t,
          { id: ++idRef.current, role: "assistant", text: r.answer, engine: r.engine, model: r.model, cached: r.cached, intent: r.intent },
        ]);
        speakLine(r.answer);
      } catch (err) {
        setChatError(err instanceof CareApiError ? err.message : "The assistant could not answer. Try again.");
      } finally {
        setThinking(false);
      }
    },
    [sessionId, speakLine, thinking]
  );

  const toggleListen = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setListening(false);
      return;
    }
    const rec = getRecognition();
    if (!rec) {
      setChatError("Voice input is not supported in this browser. Type your question instead.");
      return;
    }
    recognitionRef.current = rec;
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      if (text.trim()) void ask(text.trim());
    };
    rec.onerror = () => {
      setChatError("I could not hear that. Check the microphone and try again.");
      setListening(false);
    };
    rec.onend = () => setListening(false);
    try {
      rec.start();
      setListening(true);
      setChatError(null);
    } catch {
      setChatError("Microphone could not be started.");
      setListening(false);
    }
  }, [ask, listening]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(input);
  };

  // --- linking -------------------------------------------------------------
  const linkPatient = async () => {
    if (!sessionId || !pickedPatient || linking) return;
    setLinking(true);
    setContextError(null);
    try {
      const res = await carePortalLink(sessionId, pickedPatient, pairRef.current);
      setContext(res.context);
      setTurns([]);
      setAlerts([]);
      lastSigRef.current = "";
      briefedRef.current = null;
    } catch (err) {
      setContextError(err instanceof CareApiError ? err.message : "Could not link that patient.");
    } finally {
      setLinking(false);
    }
  };

const removePatient = async (id: string) => {
  if (!sessionId) return;
  if (!window.confirm("Remove this patient and their records?")) return;
  setDeletingId(id);
  setContextError(null);
  try {
    await careDeletePatient(id);
    const res = await carePortalContext(sessionId, pairRef.current);
    setContext(res.context);
    if (pickedPatient === id) setPickedPatient("");
  } catch (err) {
    setContextError(err instanceof CareApiError ? err.message : "Could not remove the patient.");
  } finally {
    setDeletingId(null);
  }
};

  const refreshNow = async () => {
    const ctx = await loadContext(true);
    if (ctx?.patient) {
      briefedRef.current = ctx.patient.id;
      void carePortalBrief(sessionId!, pairRef.current)
        .then((res) => res.brief.line && speakLine(res.brief.line))
        .catch(() => undefined);
    }
  };

  // --- derived -------------------------------------------------------------
  const patient = context?.patient ?? null;
  const worst = context?.worst ?? "ok";
  const severityStyle = SEVERITY_STYLE[worst];
  const findingCount = context?.findings.length ?? 0;
  const suggestions = patient
    ? context?.suggestedQuestions?.length
      ? context.suggestedQuestions
      : ["What is this patient's history?", "What medications are they on?", "Is anything urgent right now?"]
    : ["What are the live readings?", "Is anything urgent right now?", "What should I check first?"];
  const engineLabel = context?.engine.gemini ? context.engine.model : "local rules";

  // --- render --------------------------------------------------------------
  if (!sessionId) {
    return (
      <section className="mb-6 rounded-3xl border border-[#ececec] bg-white p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
          <Sparkles className="h-4 w-4 text-[#c63a22]" /> Live assistant
        </div>
        <p className="mt-1 text-sm text-[#6e6e6e]">
          Scan the patient&apos;s QR code (or enter the session id) to start the assistant.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-6 overflow-hidden rounded-3xl border border-[#f0d9d3] bg-gradient-to-b from-[#fff7f5] to-white shadow-sm">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#f0e3de] px-5 py-4">
        <div className="flex items-start gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#c63a22] text-white">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-bold text-[#1f1f1f]">Live care assistant</h2>
            <p className="text-xs text-[#6e6e6e]">
              {patient ? (
                <>
                  Watching <span className="font-semibold text-[#1f1f1f]">{patient.displayName}</span>
                  {patient.room ? ` · ${patient.room}` : ""}
                </>
              ) : sessionId ? (
                <>
                  Live session <span className="font-semibold text-[#1f1f1f]">{sessionId}</span> · readings only (link a patient for
                  history)
                </>
              ) : (
                "Open this from a paired nurse portal to see live readings."
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${severityStyle.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${severityStyle.dot}`} /> {severityStyle.label}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#ececec] bg-white px-2.5 py-1 text-[11px] font-medium text-[#6e6e6e]">
            {context?.engine.gemini ? <Sparkles className="h-3 w-3 text-[#c63a22]" /> : <ShieldCheck className="h-3 w-3 text-[#22a67e]" />}
            {engineLabel}
          </span>
          <button
            onClick={() => void placeCall("demo")}
            disabled={!patient || calling}
            className="inline-flex items-center gap-1 rounded-full bg-[#c63a22] px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-[#a92f1b] disabled:opacity-50"
            title="Call the care line and let the agent brief you"
          >
            {calling ? <Loader2 className="h-3 w-3 animate-spin" /> : <PhoneCall className="h-3 w-3" />}
            {calling ? "Calling" : "Call me"}
          </button>
          <button
            onClick={() => setFreeOpen((v) => !v)}
            disabled={!sessionId}
            className="inline-flex items-center gap-1 rounded-full border border-[#ececec] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#6e6e6e] transition hover:border-[#c63a22] hover:text-[#c63a22] disabled:opacity-50"
            title="Talk to the same agent in this browser — free, no phone charges"
          >
            <Monitor className="h-3 w-3" /> Browser call
          </button>
          {patient ? (
            <button
              onClick={async () => {
                if (!sessionId) return;
                try {
                  const res = await carePortalUnlink(sessionId, pairRef.current);
                  setContext(res.context);
                  setTurns([]);
                  setAlerts([]);
                  lastSigRef.current = "";
                  briefedRef.current = null;
                } catch (err) {
                  setContextError(err instanceof CareApiError ? err.message : "Could not unlink.");
                }
              }}
              className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 transition hover:bg-red-100"
              title="Unlink this patient (keep them in records)"
            >
              Unlink
            </button>
          ) : null}
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full border border-[#ececec] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#6e6e6e] hover:text-[#1f1f1f]"
            title="Advanced options"
          >
            <Settings2 className="h-3 w-3" /> Options {showSettings ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {freeOpen ? (
        <div className="border-b border-[#f0e3de] px-4 py-3 sm:px-5">
          <FreeCallPanel sessionId={sessionId} pair={resolvedPair} inline />
          <p className="mt-2 text-[11px] text-[#8a8a8a]">
            The browser call runs here; your chat microphone pauses while it is active.
          </p>
        </div>
      ) : null}

      {/* advanced options */}
      {showSettings ? (
        <div className="grid gap-3 border-b border-[#f0e3de] bg-white/70 px-5 py-4 sm:grid-cols-2">
          <Toggle
            label="Speak answers and alerts"
            hint={ttsAvailable ? "Uses the browser's speech synthesis." : "This browser has no speech synthesis."}
            checked={voiceOn}
            disabled={!ttsAvailable}
            onChange={(v) => {
              setVoiceOn(v);
              if (!v) stopSpeaking();
            }}
          />
          <Toggle
            label="Watch for emergencies automatically"
            hint="Polls the live readings and speaks when a threshold is crossed."
            checked={autoAlert}
            onChange={setAutoAlert}
          />
          <Toggle
            label="Phone me on a critical alert"
            hint="Places a real call to the care line; the agent reads the situation aloud."
            checked={autoCall}
            onChange={setAutoCall}
          />
          <label className="block text-xs font-semibold text-[#6e6e6e]">
            Alert check interval
            <select
              value={alertInterval}
              onChange={(e) => setAlertInterval(Number(e.target.value))}
              disabled={!autoAlert}
              className="mt-1 w-full rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-2 text-sm font-normal text-[#1f1f1f] disabled:opacity-50"
            >
              {ALERT_INTERVALS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-semibold text-[#6e6e6e]">
            Speak at or above
            <select
              value={severityFloor}
              onChange={(e) => setSeverityFloor(e.target.value as SeverityFloor)}
              disabled={!autoAlert || !voiceOn}
              className="mt-1 w-full rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-2 text-sm font-normal text-[#1f1f1f] disabled:opacity-50"
            >
              <option value="all">Every finding (watch and above)</option>
              <option value="warning">Warnings and criticals</option>
              <option value="critical">Criticals only</option>
            </select>
          </label>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            <button
              onClick={refreshNow}
              disabled={loadingContext}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5e5] bg-white px-3 py-1.5 text-xs font-semibold text-[#4b4b4b] hover:border-[#c63a22] hover:text-[#c63a22] disabled:opacity-50"
            >
              {loadingContext ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh &amp; re-brief
            </button>
            {ttsAvailable ? (
              <button
                onClick={() => {
                  setVoiceOn(true);
                  speakLine("Voice enabled.");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5e5] bg-white px-3 py-1.5 text-xs font-semibold text-[#4b4b4b] hover:border-[#c63a22] hover:text-[#c63a22]"
              >
                <Volume2 className="h-3.5 w-3.5" /> Test voice
              </button>
            ) : null}
            {speaking ? (
              <button
                onClick={() => { stopSpeaking(); setSpeaking(false); }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5e5] bg-white px-3 py-1.5 text-xs font-semibold text-[#c63a22]"
              >
                <VolumeX className="h-3.5 w-3.5" /> Stop speaking
              </button>
            ) : null}
            <span className="text-[11px] text-[#9ca3af]">
              {context ? `${context.records.length} record(s) · ${context.recordChars.toLocaleString()} chars · session ${context.sessionId}` : null}
            </span>
          </div>
        </div>
      ) : null}

      {/* optional patient link — live readings work without it */}
      {!patient ? (
        <div className="border-b border-[#f0e3de] px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-[#1f1f1f]">
              <Activity className="h-4 w-4 text-[#c63a22]" /> Live session {sessionId}
              <span className="text-[11px] font-normal text-[#6e6e6e]">
                readings only — patient history is optional
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowLinkPatient((v) => !v)}
              className="inline-flex items-center gap-1 rounded-full border border-[#e5e5e5] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#6e6e6e] hover:border-[#c63a22] hover:text-[#c63a22]"
            >
              <Link2 className="h-3 w-3" /> {showLinkPatient ? "Hide patient options" : "Link patient (optional)"}
            </button>
          </div>

          {showLinkPatient ? (
            <div className="mt-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  value={pickedPatient}
                  onChange={(e) => setPickedPatient(e.target.value)}
                  className="flex-1 rounded-xl border border-[#e5e5e5] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#c63a22]"
                >
                  <option value="">Choose a patient…</option>
                  {(context?.patients ?? [])
                    .filter((p) => showDemoPatients || !p.synthetic)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                        {p.room ? ` — ${p.room}` : ""}
                        {p.synthetic ? " (demo)" : ""}
                      </option>
                    ))}
                </select>
                <button
                  onClick={() => void linkPatient()}
                  disabled={!pickedPatient || linking}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c63a22] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#a92f1b] disabled:opacity-50"
                >
                  {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  Link patient
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowDemoPatients((v) => !v)}
                  className="text-[11px] font-semibold text-[#8a8a8a] hover:text-[#c63a22]"
                >
                  {showDemoPatients ? "Hide demo patients" : "Show demo patients"}
                </button>
                {(context?.patients ?? []).filter((p) => showDemoPatients || !p.synthetic).length ? (
                  <details className="w-full">
                    <summary className="cursor-pointer text-[11px] font-semibold text-[#8a8a8a] hover:text-red-600">
                      Remove a patient
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(context?.patients ?? [])
                        .filter((p) => showDemoPatients || !p.synthetic)
                        .map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => void removePatient(p.id)}
                            disabled={deletingId === p.id}
                            className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-[10px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                          >
                            {deletingId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                            Remove {p.displayName}
                          </button>
                        ))}
                    </div>
                  </details>
                ) : null}
              </div>
              <a
                href={pickedPatient ? `/care/records?patientId=${encodeURIComponent(pickedPatient)}` : "/care/records"}
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#c63a22] hover:underline"
              >
                <FileText className="h-3.5 w-3.5" /> Add previous records so the assistant knows the history
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* live readings / findings */}
      {sessionId ? (
        <div className="border-b border-[#f0e3de] px-5 py-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#6e6e6e]">
            <Activity className="h-3.5 w-3.5" /> Live readings
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Reading label="Alertness" value={fmtPct(context?.metrics?.alertnessScore)} />
            <Reading label="Blink rate" value={fmtRate(context?.metrics?.blinkRate)} />
            <Reading label="Eye closure" value={fmtSeconds(context?.metrics?.eyeClosureDuration)} />
            <Reading label="Movement" value={fmtMovement(context?.metrics?.movementActivity)} />
          </div>
          {findingCount > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {context!.findings.map((f) => {
                const style = SEVERITY_STYLE[f.severity];
                return (
                  <span key={`${f.key}-${f.reading}`} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${style.chip}`}>
                    <AlertTriangle className="h-3 w-3" />
                    {f.label} {f.reading} · {f.note}
                  </span>
                );
              })}
            </div>
          ) : context?.metrics ? (
            <p className="mt-2 text-[11px] text-emerald-700">All monitored readings are inside their thresholds.</p>
          ) : (
            <p className="mt-2 text-[11px] text-[#9ca3af]">
              Waiting for the patient device to stream blink rate, alertness, eye closure and movement.
            </p>
          )}
        </div>
      ) : null}

      {/* alert feed */}
      {alerts.length > 0 ? (
        <div className="border-b border-[#f0e3de] px-5 py-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-[#6e6e6e]">Recent spoken alerts</span>
            <button onClick={() => setAlerts([])} className="text-[11px] font-medium text-[#9ca3af] hover:text-[#1f1f1f]">
              clear
            </button>
          </div>
          <ul className="max-h-32 space-y-1.5 overflow-y-auto pr-1">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-start gap-2 text-xs text-[#4b4b4b]">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_STYLE[a.severity].dot}`} />
                <span className="flex-1">{a.line}</span>
                <span className="shrink-0 text-[10px] text-[#9ca3af]">
                  {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* chat */}
      <div className="px-5 py-4">
        {contextError ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {contextError}
          </div>
        ) : null}

        {callNotice ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <PhoneCall className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {callNotice}
          </div>
        ) : null}
        {callError ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {callError}
          </div>
        ) : null}

        <div className="mb-3 max-h-[340px] space-y-2 overflow-y-auto pr-1">
          {turns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#e5e5e5] px-4 py-5 text-center">
              <p className="text-sm font-medium text-[#4b4b4b]">
                {patient
                  ? `Ask about ${patient.displayName.split(" ")[0]} — by voice or text.`
                  : sessionId
                    ? "Ask about the live readings — by voice or text."
                    : "Pair with a patient device to begin."}
              </p>
              <p className="mt-1 text-xs text-[#9ca3af]">
                Answers use the inserted records and the live Blink Rate, Alertness, Eye Closure and Movement readings.
              </p>
            </div>
          ) : (
            turns.map((t) => (
              <div key={t.id} className={`flex ${t.role === "nurse" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm ${
                    t.role === "nurse" ? "bg-[#c63a22] text-white" : "bg-[#f1f5f9] text-[#1f1f1f]"
                  }`}
                >
                  <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">
                    {t.role === "nurse" ? "You" : "Care assistant"}
                  </div>
                  {t.text}
                  {t.role === "assistant" && t.engine ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold text-[#6e6e6e]">
                        {t.engine === "gemini" ? t.model : "local rules"}
                      </span>
                      {t.cached ? (
                        <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold text-[#6e6e6e]">cached</span>
                      ) : null}
                      {t.intent ? (
                        <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold text-[#6e6e6e]">
                          {t.intent.replace(/_/g, " ")}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
          {thinking ? (
            <div className="flex items-center gap-1.5 text-xs text-[#9ca3af]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the record and live readings…
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        {chatError ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {chatError}
          </div>
        ) : null}

        {suggestions.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {suggestions.slice(0, 5).map((s) => (
              <button
                key={s}
                onClick={() => void ask(s)}
                disabled={thinking}
                className="rounded-full border border-[#e5e5e5] bg-white px-3 py-1 text-xs font-medium text-[#4b4b4b] transition hover:border-[#c63a22] hover:text-[#c63a22] disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <form onSubmit={submit} className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleListen}
            disabled={!sessionId || freeOpen}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition disabled:opacity-40 ${
              listening ? "animate-pulse bg-red-600" : "bg-[#1f1f1f] hover:bg-black"
            }`}
            title={freeOpen ? "Voice chat paused while the browser call is active" : listening ? "Stop listening" : "Speak your question"}
          >
            {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!sessionId}
            placeholder={
              !sessionId
                ? "Waiting for a session"
                : listening
                  ? "Listening…"
                  : patient
                    ? "Ask about the patient or the live readings…"
                    : "Ask about the live readings…"
            }
            className="h-11 flex-1 rounded-full border border-[#e5e5e5] bg-white px-4 text-sm outline-none focus:border-[#c63a22] disabled:bg-[#f7f7f7]"
          />
          <button
            type="submit"
            disabled={thinking || !input.trim() || !sessionId}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#c63a22] text-white transition hover:bg-[#a92f1b] disabled:opacity-40"
            title="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>

        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-[#9ca3af]">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
          Answers are grounded in the inserted records and live readings. The assistant reports thresholds but never
          diagnoses or invents values; when it cannot answer it says so.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#ececec] bg-white px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-[#1f1f1f]">{value}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
        checked ? "border-[#c63a22]/30 bg-[#c63a22]/5" : "border-[#ececec] bg-white"
      } ${disabled ? "opacity-50" : "hover:border-[#c63a22]/40"}`}
    >
      <span>
        <span className="block text-xs font-semibold text-[#1f1f1f]">{label}</span>
        {hint ? <span className="mt-0.5 block text-[11px] text-[#9ca3af]">{hint}</span> : null}
      </span>
      <span className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${checked ? "bg-[#c63a22]" : "bg-[#d5d5d5]"}`}>
        <span className={`h-4 w-4 rounded-full bg-white transition ${checked ? "translate-x-4" : "translate-x-0"}`} />
      </span>
    </button>
  );
}

function fmtPct(n: number | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${Math.round(n)}%`;
}

function fmtRate(n: number | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}/min`;
}

function fmtSeconds(ms: number | undefined): string {
  return ms == null || !Number.isFinite(ms) ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

function fmtMovement(n: number | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${Math.round(n * 100)}%`;
}
