"use client";

/**
 * Free browser call with the CareSpeak agent.
 *
 * This is the zero-cost path when Twilio cannot place a real call (for example
 * its free trial blocks custom TwiML). It runs entirely in the browser:
 *   - the patient context and briefing come from the same portal brain the
 *     phone webhook uses;
 *   - speech input uses the browser Web Speech API when available;
 *   - replies are spoken with speech synthesis, and the transcript is always
 *     shown, with a text box as a fallback for browsers without speech input.
 *
 * Nothing here needs a phone number, telephony minutes, or an API key.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Download,
  Eye,
  HeartPulse,
  Link2,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Send,
  ShieldAlert,
  Sparkles,
  Stethoscope,
  Thermometer,
  Timer,
  Volume2,
  VolumeX,
  Waves,
  Wind,
} from "lucide-react";
import {
  CareApiError,
  careCreatePatient,
  careDeletePatient,
  carePortalAsk,
  carePortalBrief,
  carePortalContext,
  carePortalLink,
  carePortalSbar,
  carePortalUnlink,
  carePostTranscript,
  type PortalContext,
  type PortalSbar,
} from "@/lib/careClient";
import type { PortalDetail } from "@/lib/careClient";
import { speak, speechSynthesisAvailable, stopSpeaking } from "@/lib/care/browserAI";
import { getActiveCareSession, getSession, rememberCareSession } from "@/lib/session";
import PatientSnapshot from "@/components/care/PatientSnapshot";
import SbarCard from "@/components/care/SbarCard";

// ---------------------------------------------------------------------------
// browser speech recognition (optional, never assumed)
// ---------------------------------------------------------------------------

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
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

interface Turn {
  id: number;
  role: "caller" | "agent";
  text: string;
  engine?: string;
  scope?: "record" | "general" | "mixed" | "chitchat" | "meta" | "emergency";
  grounded?: boolean;
  citations?: Array<{ title: string; kind: string; source?: string; at?: string }>;
}

const CALL_TURNS_PREFIX = "carespeak.call.turns.v1";
const CALL_TURNS_LIMIT = 40;

function callTurnsKey(sessionId: string): string {
  return `${CALL_TURNS_PREFIX}.${sessionId}`;
}

/**
 * The in-call transcript survives a reload, a phone lock or a browser crash.
 * It is scoped to the session so two sessions never share a conversation.
 */
function loadSavedTurns(sessionId: string): Turn[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(callTurnsKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
      .filter((t) => (t.role === "caller" || t.role === "agent") && typeof t.text === "string")
      .slice(-CALL_TURNS_LIMIT)
      .map((t, i) => ({
        id: typeof t.id === "number" && Number.isFinite(t.id) ? t.id : i + 1,
        role: t.role as Turn["role"],
        text: String(t.text),
        engine: typeof t.engine === "string" ? t.engine : undefined,
        scope: typeof t.scope === "string" ? (t.scope as Turn["scope"]) : undefined,
        grounded: typeof t.grounded === "boolean" ? t.grounded : undefined,
        citations: Array.isArray(t.citations)
          ? (t.citations as Turn["citations"])
          : undefined,
      }));
  } catch {
    return [];
  }
}

function saveTurns(sessionId: string, turns: Turn[]): void {
  if (typeof window === "undefined") return;
  try {
    if (turns.length) {
      window.localStorage.setItem(callTurnsKey(sessionId), JSON.stringify(turns.slice(-CALL_TURNS_LIMIT)));
    } else {
      window.localStorage.removeItem(callTurnsKey(sessionId));
    }
  } catch {
    /* storage full or blocked — the live transcript still works */
  }
}

function reading(value: number | undefined, suffix: string, digits = 0): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${value.toFixed(digits)}${suffix}`;
}

/** Read a numeric wearable value without trusting the shape of the payload. */
function vitalNumber(vitals: Record<string, unknown> | null, key: string): number | undefined {
  const raw = vitals?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Two initials for the call avatar, e.g. "Anita Sharma" -> "AS". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** mm:ss call clock. */
function fmtDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function normalizeSessionId(raw: string | null | undefined): string {
  const clean = raw?.trim().toUpperCase() ?? "";
  return /^[A-Z0-9_-]{3,32}$/.test(clean) ? clean : "";
}

/** Spoken summary of whatever the patient device is streaming right now. */
function liveSummary(ctx: PortalContext | null): string {
  if (!ctx) return "No live readings have arrived from the patient device yet.";
  const parts: string[] = [];
  const m = ctx.metrics;
  const blink = reading(m?.blinkRate, " per minute", 1);
  const alertness = reading(m?.alertnessScore, "%");
  const closure = reading(m?.eyeClosureDuration != null ? m.eyeClosureDuration / 1000 : undefined, " seconds", 1);
  const movement = reading(m?.movementActivity != null ? m.movementActivity * 100 : undefined, "%");
  if (blink) parts.push(`blink rate ${blink}`);
  if (alertness) parts.push(`alertness ${alertness}`);
  if (closure) parts.push(`eye closure ${closure}`);
  if (movement) parts.push(`movement ${movement}`);
  const head = parts.length ? `Live readings right now: ${parts.join(", ")}.` : "No live readings have arrived from the patient device yet.";
  if (!parts.length) return head;
  const findings = ctx.findings ?? [];
  const outside = findings.map((f) => `${f.label.toLowerCase()} ${f.reading}`).join(", ");
  return findings.length ? `${head} Outside the thresholds: ${outside}.` : `${head} All monitored readings are inside their thresholds.`;
}

export default function BrowserCall({
  sessionId,
  pair = null,
  compact = false,
  className = "",
}: {
  sessionId: string;
  pair?: string | null;
  compact?: boolean;
  className?: string;
}) {
  const [context, setContext] = useState<PortalContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The call can be opened three ways: with an explicit ?session=... from a QR,
  // embedded in the nurse portal, or bare. In the last case we reuse the
  // session the portal is currently paired to in this browser.
  const [activeSessionId, setActiveSessionId] = useState(() => normalizeSessionId(sessionId));
  const [activePair, setActivePair] = useState<string | null>(pair ?? null);
  const [sessionReady, setSessionReady] = useState(() => Boolean(normalizeSessionId(sessionId)));

  const [started, setStarted] = useState(false);
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);

  // patient linking (so a sync session can be attached to a real patient)
  const [pickedPatient, setPickedPatient] = useState("");
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [showAddPatient, setShowAddPatient] = useState(false);
  const [showPatientPicker, setShowPatientPicker] = useState(false);
  const [newPatientName, setNewPatientName] = useState("");
  const [newPatientConcern, setNewPatientConcern] = useState("");
  const [creatingPatient, setCreatingPatient] = useState(false);
  const [showDemoPatients, setShowDemoPatients] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // advanced options
  const [detail, setDetail] = useState<PortalDetail>("standard");
  const [sbar, setSbar] = useState<PortalSbar | null>(null);
  const [sbarLoading, setSbarLoading] = useState(false);
  const [sbarError, setSbarError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [followUps, setFollowUps] = useState<string[]>([]);

  // Advanced: a live call clock and a lightweight animated waveform so the call
  // feels alive without any extra network or audio work.
  const [callSeconds, setCallSeconds] = useState(0);
  const [waveTick, setWaveTick] = useState(0);
  const [endedAt, setEndedAt] = useState<{ seconds: number; turns: number } | null>(null);

  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;

  const pairRef = useRef<string | null>(pair);
  pairRef.current = activePair;

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const startedRef = useRef(false);
  const wantMicRef = useRef(true);
  const speakingRef = useRef(false);
  const thinkingRef = useRef(false);
  const voiceRef = useRef(true);
  voiceRef.current = voiceOn;
  const speechGenRef = useRef(0);
  const turnIdRef = useRef(0);
  const [historyReady, setHistoryReady] = useState("");
  const restoredHistoryRef = useRef("");
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const askRef = useRef<(text: string) => Promise<void>>(async () => undefined);
  const endRef = useRef<HTMLDivElement | null>(null);
  const callSecondsRef = useRef(0);
  callSecondsRef.current = callSeconds;

  const append = useCallback(
    (
      role: Turn["role"],
      text: string,
      engine?: string,
      meta?: Pick<Turn, "scope" | "grounded" | "citations">
    ) => {
      const clean = text.replace(/\s+/g, " ").trim();
      if (!clean) return;
      const id = ++turnIdRef.current;
      setTurns((prev) => [...prev.slice(-40), { id, role, text: clean, engine, ...meta }]);
      // Persist to the session transcript when the nurse is signed in. Pair-only
      // calls are not allowed to write nurse/agent turns and fail silently.
      const session = activeSessionIdRef.current;
      if (session) {
        carePostTranscript(
          session,
          { role: role === "caller" ? "nurse" : "agent", text: clean, engine },
          null
        ).catch(() => undefined);
      }
    },
    []
  );

  // --- speech in ------------------------------------------------------------

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* not started */
      }
    }
    setListening(false);
  }, []);

  const resumeListening = useCallback(() => {
    if (!startedRef.current || !wantMicRef.current) return;
    const rec = recognitionRef.current;
    if (!rec) return;
    window.setTimeout(() => {
      if (!startedRef.current || !wantMicRef.current) return;
      if (speakingRef.current || thinkingRef.current) return;
      try {
        rec.start();
        setListening(true);
      } catch {
        /* Chrome throws if start() races an existing session — harmless */
      }
    }, 280);
  }, []);

  // --- speech out -----------------------------------------------------------

  const speakLine = useCallback(
    (line: string) => {
      const gen = ++speechGenRef.current;
      const text = line.trim();
      if (!voiceRef.current || !ttsAvailable || !text) {
        speakingRef.current = false;
        setSpeaking(false);
        resumeListening();
        return;
      }
      stopListening();
      speakingRef.current = true;
      setSpeaking(true);
      try {
        speak(text, {
          onStart: () => {
            if (gen === speechGenRef.current) setSpeaking(true);
          },
          onEnd: () => {
            if (gen !== speechGenRef.current) return;
            speakingRef.current = false;
            setSpeaking(false);
            resumeListening();
          },
        });
      } catch {
        speakingRef.current = false;
        setSpeaking(false);
        resumeListening();
      }
    },
    [resumeListening, stopListening, ttsAvailable]
  );

  // --- one agent turn -------------------------------------------------------

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim().slice(0, 1000);
      if (!question || !activeSessionId || thinkingRef.current) return;

      thinkingRef.current = true;
      setThinking(true);
      setSendError(null);
      append("caller", question);
      setInput("");
      stopListening();

      try {
        const history: Array<{ role: "nurse" | "assistant"; text: string }> = turnsRef.current.slice(-8).map((t) => ({
          role: t.role === "caller" ? "nurse" : "assistant",
          text: t.text,
        }));
        const res = await carePortalAsk(activeSessionId, question, pairRef.current, {
          voice: voiceOn,
          detail,
          history,
        });
        append("agent", res.result.answer, res.result.engine, {
          scope: res.result.scope,
          grounded: res.result.grounded,
          citations: res.result.citations,
        });
        speakLine(res.result.answer);
        setFollowUps(res.result.followUps ?? []);
      } catch (err) {
        const message =
          err instanceof CareApiError ? err.message : "The care agent could not answer. Try again.";
        setSendError(message);
        const fallback = "Sorry, I could not reach the care record just now. Please try that again.";
        append("agent", fallback);
        speakLine(fallback);
      } finally {
        thinkingRef.current = false;
        setThinking(false);
        if (!speakingRef.current) resumeListening();
      }
    },
    [activeSessionId, append, detail, speakLine, stopListening, resumeListening, voiceOn]
  );

  askRef.current = ask;

  // --- recognition lifecycle ------------------------------------------------

  useEffect(() => {
    setTtsAvailable(speechSynthesisAvailable());
    const rec = getRecognition();
    setSupported(Boolean(rec));
    if (!rec) return;
    recognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";

    rec.onresult = (e) => {
      // Never transcribe the agent's own spoken answer (echo) or a turn that is
      // already being processed.
      if (speakingRef.current || thinkingRef.current) return;
      let transcript = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        transcript += e.results[i]?.[0]?.transcript ?? "";
      }
      if (transcript.trim()) void askRef.current(transcript);
    };
    rec.onerror = (e) => {
      setListening(false);
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        wantMicRef.current = false;
        setMicError("Microphone access was blocked. Allow it in the browser, or type your question below.");
      }
    };
    rec.onend = () => {
      setListening(false);
      if (startedRef.current && wantMicRef.current && !speakingRef.current && !thinkingRef.current) {
        window.setTimeout(() => {
          if (!startedRef.current || !wantMicRef.current) return;
          if (speakingRef.current || thinkingRef.current) return;
          try {
            rec.start();
            setListening(true);
          } catch {
            /* ignore overlapping start */
          }
        }, 320);
      }
    };

    return () => {
      startedRef.current = false;
      recognitionRef.current = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      stopSpeaking();
    };
  }, []);

  // --- resolve the session this call should use -----------------------------

  useEffect(() => {
    const fromUrl = normalizeSessionId(sessionId);
    if (fromUrl) {
      const active = getActiveCareSession();
      const resolvedPair = pair ?? (active?.sessionId === fromUrl ? active.pair : null);
      setActiveSessionId(fromUrl);
      setActivePair(resolvedPair);
      setSessionReady(true);
      rememberCareSession(fromUrl, resolvedPair);
      return;
    }

    // No ?session= in the URL: reuse whatever the nurse portal paired with in
    // this browser, falling back to the legacy patient-device session key.
    const remembered = getActiveCareSession();
    const legacy = getSession();
    const id = remembered?.sessionId ?? normalizeSessionId(legacy?.sessionId);
    setActiveSessionId(id);
    setActivePair(remembered?.pair ?? null);
    setSessionReady(true);
    if (id) rememberCareSession(id, remembered?.pair ?? null);
  }, [pair, sessionId]);

  // --- durable in-call transcript ------------------------------------------

  // Restore the saved transcript once per session, before new turns append.
  useEffect(() => {
    if (!activeSessionId) {
      restoredHistoryRef.current = "";
      setHistoryReady("");
      return;
    }
    if (restoredHistoryRef.current === activeSessionId) return;
    restoredHistoryRef.current = activeSessionId;
    const saved = loadSavedTurns(activeSessionId);
    if (saved.length) {
      turnIdRef.current = Math.max(turnIdRef.current, ...saved.map((t) => t.id));
      setTurns(saved);
    }
    setHistoryReady(activeSessionId);
  }, [activeSessionId]);

  // Persist only after the restore gate, so the first render never wipes it.
  useEffect(() => {
    if (!activeSessionId || historyReady !== activeSessionId) return;
    saveTurns(activeSessionId, turns);
  }, [activeSessionId, historyReady, turns]);

  // --- load / refresh the patient context -----------------------------------

  useEffect(() => {
    if (!sessionReady) return;
    if (!activeSessionId) {
      setLoadError("No CareSpeak session is connected yet. Open this call from the paired nurse portal, or scan the patient's QR code.");
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setLoadError(null);
    carePortalContext(activeSessionId, activePair)
      .then((res) => {
        if (!active) return;
        setContext(res.context);
        if (res.context.link) setPickedPatient(res.context.link.patientId);
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(
          err instanceof CareApiError ? err.message : "Could not reach the care record for this session."
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activePair, activeSessionId, sessionReady]);

  // Keep the patient context fresh even before the call starts, so a phone that
  // was opened before the nurse linked a patient picks up the link quickly.
  useEffect(() => {
    if (started || !activeSessionId) return;
    let active = true;
    const refresh = () => {
      if (!active || document.hidden) return;
      carePortalContext(activeSessionId, pairRef.current)
        .then((res) => {
          if (active) {
            setContext(res.context);
            if (res.context.link) setPickedPatient(res.context.link.patientId);
            if (!res.context.patient) setShowPatientPicker(true);
          }
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 2000);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    refresh();
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeSessionId, started]);

  // While the call is live, keep the readings fresh without ever flashing the
  // loading state (the signal tiles should update on their own).
  useEffect(() => {
    if (!started || !activeSessionId) return;
    let active = true;
    const refresh = () => {
      if (!active || document.hidden) return;
      carePortalContext(activeSessionId, pairRef.current)
        .then((res) => {
          if (active) setContext(res.context);
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 10_000);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    refresh();
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeSessionId, started]);

  // Keep the transcript pinned to the newest turn (not on first paint, so the
  // page never scrolls itself away from the header).
  useEffect(() => {
    if (!turns.length && !thinking) return;
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, thinking]);

  // Call clock — runs only while a call is live.
  useEffect(() => {
    if (!started) {
      setCallSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setCallSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [started]);

  // Waveform tick — a small, CPU-cheap animation frame source for the meter.
  useEffect(() => {
    if (!started) return;
    const timer = window.setInterval(() => setWaveTick((v) => (v + 1) % 1000), 260);
    return () => window.clearInterval(timer);
  }, [started]);

  // --- call control ---------------------------------------------------------

  const startCall = useCallback(() => {
    if (startedRef.current || !activeSessionId) return;
    startedRef.current = true;
    wantMicRef.current = true;
    setStarted(true);
    setEndedAt(null);
    setMicError(null);
    setSendError(null);
    thinkingRef.current = true;
    setThinking(true);

    // Always ask the portal brain: with a linked patient it briefs on their
    // history, without one it reports whatever the device is streaming now.
    const opening = carePortalBrief(activeSessionId, pairRef.current)
      .then((res) => res.brief.line || `Hi, this is the CareSpeak assistant. ${liveSummary(context)}`)
      .catch(() => `Hi, this is the CareSpeak assistant. ${liveSummary(context)}`);

    void opening
      .then((line) => {
        if (!startedRef.current) return;
        if (line) {
          append("agent", line);
          speakLine(line);
        } else {
          resumeListening();
        }
      })
      .finally(() => {
        thinkingRef.current = false;
        setThinking(false);
        if (!speakingRef.current) resumeListening();
      });
  }, [activeSessionId, append, context, resumeListening, speakLine]);

  const endCall = useCallback(() => {
    startedRef.current = false;
    wantMicRef.current = false;
    speechGenRef.current += 1;
    speakingRef.current = false;
    stopListening();
    stopSpeaking();
    setSpeaking(false);
    setStarted(false);
    if (turnsRef.current.length) {
      setEndedAt({ seconds: callSecondsRef.current, turns: turnsRef.current.length });
    }
  }, [stopListening]);

  const toggleMic = useCallback(() => {
    if (!startedRef.current) return;
    if (wantMicRef.current) {
      wantMicRef.current = false;
      stopListening();
    } else {
      wantMicRef.current = true;
      setMicError(null);
      resumeListening();
    }
  }, [resumeListening, stopListening]);

  const toggleVoice = useCallback(() => {
    setVoiceOn((v) => {
      const next = !v;
      if (!next) {
        speechGenRef.current += 1;
        speakingRef.current = false;
        setSpeaking(false);
        stopSpeaking();
        resumeListening();
      }
      return next;
    });
  }, [resumeListening]);

  // --- patient linking ------------------------------------------------------

  const visiblePatients = (context?.patients ?? []).filter(
    (p) => showDemoPatients || !p.synthetic
  );

  const generateSbar = useCallback(async () => {
    if (!activeSessionId || !context?.patient || sbarLoading) return;
    setSbarLoading(true);
    setSbarError(null);
    try {
      const res = await carePortalSbar(activeSessionId, pairRef.current);
      setSbar(res.sbar);
    } catch (err) {
      setSbarError(err instanceof CareApiError ? err.message : "Could not build the handoff.");
    } finally {
      setSbarLoading(false);
    }
  }, [activeSessionId, context?.patient, sbarLoading]);

  const copyTranscript = useCallback(async () => {
    const text = turnsRef.current.map((t) => `${t.role === "caller" ? "Nurse" : "Assistant"}: ${t.text}`).join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setSendError("Could not copy the transcript. Your browser blocked clipboard access.");
    }
  }, []);

  /** Download the transcript as a plain-text note for the patient file. */
  const downloadTranscript = useCallback(() => {
    const history = turnsRef.current;
    if (!history.length) return;
    const session = activeSessionIdRef.current || "session";
    const patientName = context?.patient?.displayName ?? "No patient linked";
    const header = [
      "CareSpeak — browser care call transcript",
      `Session: ${session}`,
      `Patient: ${patientName}`,
      `Exported: ${new Date().toISOString()}`,
      "",
      "Synthetic demo data unless this deployment is connected to a real record.",
    ];
    const body = history.flatMap((t) => {
      const label = t.role === "caller" ? "Nurse" : "CareSpeak agent";
      const tags = [
        t.engine === "gemini" ? "gemini" : t.engine === "rules" ? "local rules" : "",
        t.scope === "general" ? "general guidance" : t.grounded ? "from chart" : "",
      ].filter(Boolean);
      const lines = [`${label}${tags.length ? ` [${tags.join(", ")}]` : ""}: ${t.text}`];
      if (t.citations?.length) {
        lines.push(
          `    Sources: ${t.citations
            .slice(0, 4)
            .map((c) => c.title.replace(/^General guidance — /, ""))
            .join("; ")}`
        );
      }
      return lines;
    });
    const blob = new Blob([[...header, "", ...body, ""].join("\n")], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `carespeak-${session.toLowerCase()}-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [context?.patient?.displayName]);

  const linkPatient = useCallback(async () => {
    if (!activeSessionId || !pickedPatient || linking) return;
    setLinking(true);
    setLinkError(null);
    try {
      const res = await carePortalLink(activeSessionId, pickedPatient, pairRef.current);
      setContext(res.context);
      setTurns([]);
      setFollowUps([]);
      setSbar(null);
      setPickedPatient(res.context.link?.patientId ?? pickedPatient);
    } catch (err) {
      setLinkError(err instanceof CareApiError ? err.message : "Could not link the patient.");
    } finally {
      setLinking(false);
    }
  }, [activeSessionId, linking, pickedPatient]);

  const unlinkPatient = useCallback(async () => {
    if (!activeSessionId || unlinking) return;
    setUnlinking(true);
    setLinkError(null);
    try {
      const res = await carePortalUnlink(activeSessionId, pairRef.current);
      setContext(res.context);
      setPickedPatient("");
      setTurns([]);
      setFollowUps([]);
      setSbar(null);
    } catch (err) {
      setLinkError(err instanceof CareApiError ? err.message : "Could not unlink.");
    } finally {
      setUnlinking(false);
    }
  }, [activeSessionId, unlinking]);

  const addPatient = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!newPatientName.trim() || creatingPatient || !activeSessionId) return;
      setCreatingPatient(true);
      setLinkError(null);
      try {
        const res = await careCreatePatient({
          displayName: newPatientName.trim(),
          primaryConcern: newPatientConcern.trim() || undefined,
        });
        const created = res.patient;
        // link it straight away
        const linked = await carePortalLink(activeSessionId, created.id, pairRef.current);
        setContext(linked.context);
        setPickedPatient(created.id);
        setTurns([]);
        setFollowUps([]);
        setSbar(null);
        setNewPatientName("");
        setNewPatientConcern("");
        setShowAddPatient(false);
      } catch (err) {
        setLinkError(err instanceof CareApiError ? err.message : "Could not add the patient.");
      } finally {
        setCreatingPatient(false);
      }
    },
    [activeSessionId, creatingPatient, newPatientConcern, newPatientName]
  );

  const removePatient = useCallback(
    async (id: string) => {
      if (!activeSessionId) return;
      if (!window.confirm("Remove this patient and their records?")) return;
      setDeletingId(id);
      setLinkError(null);
      try {
        await careDeletePatient(id);
        // refresh context
        const res = await carePortalContext(activeSessionId, pairRef.current);
        setContext(res.context);
        if (pickedPatient === id) setPickedPatient("");
      } catch (err) {
        setLinkError(err instanceof CareApiError ? err.message : "Could not remove the patient.");
      } finally {
        setDeletingId(null);
      }
    },
    [activeSessionId, pickedPatient]
  );

  const send = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      if (!input.trim()) return;
      void ask(input);
    },
    [ask, input]
  );

  // --- render ---------------------------------------------------------------

  const patient = context?.patient ?? null;
  const metrics = context?.metrics ?? null;
  const vitals = context?.vitals ?? null;

  const tiles = [
    { label: "Blink rate", value: reading(metrics?.blinkRate, ""), unit: "/min", icon: Eye },
    { label: "Alertness", value: reading(metrics?.alertnessScore, ""), unit: "%", icon: Activity },
    {
      label: "Eye closure",
      value: reading(metrics?.eyeClosureDuration != null ? metrics.eyeClosureDuration / 1000 : undefined, "", 1),
      unit: "s",
      icon: Eye,
    },
    {
      label: "Movement",
      value: reading(metrics?.movementActivity != null ? metrics.movementActivity * 100 : undefined, ""),
      unit: "%",
      icon: Waves,
    },
    { label: "Oxygen", value: reading(vitalNumber(vitals, "spo2"), ""), unit: "%", icon: Wind },
    { label: "Heart rate", value: reading(vitalNumber(vitals, "heartRate"), ""), unit: "bpm", icon: HeartPulse },
    { label: "Temperature", value: reading(vitalNumber(vitals, "temperature"), "", 1), unit: "°C", icon: Thermometer },
  ].filter((t) => t.value);

  const findings = context?.findings ?? [];
  const worst = context?.worst ?? "ok";

  const status = loadError
    ? { label: "Link problem", tone: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" }
    : loading
      ? { label: "Loading session", tone: "bg-slate-50 text-slate-600 border-slate-200", dot: "bg-slate-400" }
      : !started
        ? { label: "Ready to call", tone: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" }
        : speaking
          ? { label: "Agent speaking", tone: "bg-[#fff1ee] text-[#c63a22] border-[#f0c8bf]", dot: "bg-[#c63a22]" }
          : thinking
            ? { label: "Checking the record", tone: "bg-amber-50 text-amber-800 border-amber-200", dot: "bg-amber-400" }
            : listening
              ? { label: "Listening", tone: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" }
              : { label: "On call", tone: "bg-slate-50 text-slate-600 border-slate-200", dot: "bg-slate-400" };

  const suggestions = patient
    ? (followUps.length ? followUps : context?.suggestedQuestions ?? []).slice(0, compact ? 2 : 3)
    : ["What are the live readings?", "Is anything urgent right now?", "What should I check first?"].slice(
        0,
        compact ? 2 : 3
      );

  const waveActive = speaking || listening;
  const waveTone = speaking
    ? "bg-[#c63a22]"
    : thinking
      ? "bg-amber-400"
      : listening
        ? "bg-emerald-500"
        : "bg-[#d8d0cd]";
  const wave = [12, 18, 24, 14, 20, 12, 18, 26, 15, 21, 11, 17, 9, 15, 22, 13].map((base, i) => {
    const phase = Math.abs(Math.sin((waveTick + i) * 0.8));
    const amp = waveActive ? (speaking ? 1 : 0.72) : 0.2;
    return Math.max(3, Math.round(base * (0.45 + 0.55 * phase) * amp) + 3);
  });

  const micState = speaking
    ? { label: "Agent speaking", ring: "bg-[#c63a22]/25", btn: "bg-[#c63a22] text-white hover:bg-[#a92f1b]" }
    : thinking
      ? { label: "Checking record", ring: "bg-amber-400/25", btn: "bg-amber-100 text-amber-700 hover:bg-amber-200" }
      : listening
        ? { label: "Listening", ring: "bg-emerald-500/25", btn: "bg-emerald-500 text-white hover:bg-emerald-600" }
        : { label: "Mic is off", ring: "bg-transparent", btn: "border border-[#e5dedb] bg-white text-[#6e6e6e] hover:border-[#c63a22]" };

  return (
    <section className={`flex flex-col overflow-hidden rounded-3xl border border-[#ececec] bg-white shadow-[0_18px_50px_-30px_rgba(198,58,34,0.45)] ${className}`}>
      {/* ── call hero ──────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden border-b border-[#f0e3de] bg-gradient-to-br from-[#fff6f3] via-white to-[#fffaf9] px-4 pb-4 pt-5 sm:px-6">
        <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-[#c63a22]/5 blur-2xl" />
        <div className="relative flex items-start gap-3">
          <div className="relative shrink-0">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#c63a22] to-[#a92f1b] text-sm font-bold tracking-wide text-white shadow-sm">
              {patient ? initials(patient.displayName) : <PhoneCall className="h-5 w-5" />}
            </span>
            <span
              className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white ${
                !started
                  ? "bg-slate-300"
                  : speaking
                    ? "bg-[#c63a22]"
                    : listening
                      ? "bg-emerald-500"
                      : thinking
                        ? "bg-amber-400"
                        : "bg-slate-400"
              }`}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="truncate text-base font-bold leading-tight text-[#1f1f1f]">
                {patient ? patient.displayName : activeSessionId ? "Live care session" : "Free browser call"}
              </h2>
              {patient?.synthetic ? (
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">
                  demo
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-xs text-[#6e6e6e]">
              {patient
                ? [patient.age ? `${patient.age} y` : null, patient.sex || null, patient.room || null]
                    .filter(Boolean)
                    .join(" · ") || "Patient linked"
                : activeSessionId
                  ? `Session ${activeSessionId}`
                  : "Same CareSpeak agent · no phone charges"}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${status.tone}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot} ${started && !thinking ? "animate-pulse" : ""}`} />
              {status.label}
            </span>
            {started ? (
              <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-[#6e6e6e]">
                <Timer className="h-3 w-3" /> {fmtDuration(callSeconds)}
              </span>
            ) : null}
          </div>
        </div>

        {/* live waveform meter */}
        {started ? (
          <div className="relative mt-3 flex items-center gap-3 border-t border-[#f4e7e3] pt-3">
            <div className="flex h-7 flex-1 items-center gap-[3px]" aria-hidden>
              {wave.map((h, i) => (
                <span
                  key={i}
                  className={`flex-1 rounded-full transition-[height,background-color] duration-200 ease-out ${waveTone}`}
                  style={{ height: `${h}px`, opacity: waveActive ? 1 : 0.5 }}
                />
              ))}
            </div>
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
              {speaking ? "Speaking" : thinking ? "Thinking" : listening ? "Listening" : "Live"}
            </span>
          </div>
        ) : null}
      </div>

      {/* ── live readings ──────────────────────────────────────────────── */}
      {tiles.length ? (
        <div className="grid grid-cols-2 gap-2 border-b border-[#f4efec] px-4 py-3 sm:grid-cols-4 sm:px-6">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-2xl border border-[#f0e9e6] bg-[#fcfbfa] px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
                <t.icon className="h-3 w-3 text-[#c63a22]" /> {t.label}
              </div>
              <div className="mt-0.5 flex items-baseline gap-0.5">
                <span className="text-lg font-bold tabular-nums text-[#1f1f1f]">{t.value}</span>
                <span className="text-[11px] font-medium text-[#8a8a8a]">{t.unit}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* ── findings ───────────────────────────────────────────────────── */}
      {findings.length ? (
        <div
          className={`flex items-start gap-2 border-b px-4 py-2.5 text-xs sm:px-6 ${
            worst === "critical"
              ? "border-red-100 bg-red-50 text-red-700"
              : "border-amber-100 bg-amber-50 text-amber-800"
          }`}
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <span className="font-semibold">{worst === "critical" ? "Critical reading" : "Watch reading"}:</span>{" "}
            {findings.map((f) => `${f.label} ${f.reading}`).join(" · ")}
          </div>
        </div>
      ) : null}

      {/* ── patient linking ────────────────────────────────────────────── */}
      {!loadError && !loading ? (
        <div className="border-b border-[#f4efec] px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">Patient</span>
            {context?.patient ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                <Stethoscope className="h-3 w-3" />
                {context.patient.displayName}
                {context.patient.room ? ` · ${context.patient.room}` : ""}
                <button
                  type="button"
                  onClick={() => void unlinkPatient()}
                  disabled={unlinking}
                  className="ml-1 text-emerald-700 hover:text-red-600"
                  title="Unlink this patient (keep them in records)"
                >
                  {unlinking ? <Loader2 className="h-3 w-3 animate-spin" /> : "×"}
                </button>
              </span>
            ) : activeSessionId ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700">
                Live session {activeSessionId}
              </span>
            ) : (
              <span className="text-[11px] text-amber-700">No session connected</span>
            )}
            <button
              type="button"
              onClick={() => setShowPatientPicker((v) => !v)}
              className="text-[10px] font-semibold text-[#8a8a8a] hover:text-[#c63a22]"
            >
              {showPatientPicker ? "Hide patient options" : patient ? "Switch patient" : "Link a patient (optional)"}
            </button>
          </div>

          {showPatientPicker ? (
            <div className="mt-3 rounded-xl border border-[#eee] bg-[#fbfaf9] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={pickedPatient}
                  onChange={(e) => setPickedPatient(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-[#c63a22]"
                >
                  <option value="">Choose a patient...</option>
                  {visiblePatients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                      {p.room ? ` — ${p.room}` : ""}
                      {p.synthetic ? " (demo)" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void linkPatient()}
                  disabled={!pickedPatient || linking || !activeSessionId}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#c63a22] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#a92f1b] disabled:opacity-50"
                >
                  {linking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
                  {patient ? "Switch" : "Link"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddPatient((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] bg-white px-3 py-1.5 text-xs font-semibold text-[#1f1f1f] hover:border-[#c63a22]"
                >
                  + Add patient
                </button>
                <button
                  type="button"
                  onClick={() => setShowDemoPatients((v) => !v)}
                  className="text-[10px] font-semibold text-[#8a8a8a] hover:text-[#c63a22]"
                >
                  {showDemoPatients ? "Hide demo" : "Show demo"}
                </button>
              </div>
              <p className="mt-2 text-[10px] text-[#8a8a8a]">
                Optional. Linking adds the patient&apos;s history and care plan; the live readings above work without it.
              </p>
            </div>
          ) : null}

          {linkError ? (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {linkError}
            </div>
          ) : null}

          {showPatientPicker && showAddPatient ? (
            <form onSubmit={addPatient} className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <input
                value={newPatientName}
                onChange={(e) => setNewPatientName(e.target.value)}
                placeholder="Patient name"
                required
                className="rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-[#c63a22]"
              />
              <input
                value={newPatientConcern}
                onChange={(e) => setNewPatientConcern(e.target.value)}
                placeholder="Primary concern (optional)"
                className="rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-[#c63a22]"
              />
              <button
                type="submit"
                disabled={creatingPatient || !newPatientName.trim()}
                className="inline-flex items-center justify-center gap-1 rounded-lg bg-[#1f1f1f] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#c63a22] disabled:opacity-50"
              >
                {creatingPatient ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Add &amp; link
              </button>
            </form>
          ) : null}

          {/* remove a patient */}
          {visiblePatients.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] font-semibold text-[#8a8a8a] hover:text-red-600">
                Remove a patient
              </summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {visiblePatients.map((p) => (
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
      ) : null}

      {/* ── advanced options ───────────────────────────────────────────── */}
      {!loadError && !loading ? (
        <details className="border-b border-[#f4efec] px-4 py-3 sm:px-6">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold text-[#6e6e6e] hover:text-[#c63a22]">
            <Sparkles className="h-3 w-3" /> Advanced options (SBAR, chart, transcript, depth)
          </summary>
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void generateSbar()}
                disabled={!patient || sbarLoading || !activeSessionId}
                className="inline-flex items-center gap-1 rounded-lg bg-[#c63a22] px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-[#a92f1b] disabled:opacity-50"
              >
                {sbarLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                SBAR handoff
              </button>
              <button
                type="button"
                onClick={() => void copyTranscript()}
                disabled={!turns.length}
                className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] bg-white px-3 py-1.5 text-[11px] font-semibold text-[#4b4b4b] hover:border-[#c63a22] hover:text-[#c63a22] disabled:opacity-50"
              >
                <ClipboardCopy className="h-3 w-3" /> {copied ? "Copied" : "Copy transcript"}
              </button>
              <button
                type="button"
                onClick={downloadTranscript}
                disabled={!turns.length}
                className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] bg-white px-3 py-1.5 text-[11px] font-semibold text-[#4b4b4b] hover:border-[#c63a22] hover:text-[#c63a22] disabled:opacity-50"
              >
                <Download className="h-3 w-3" /> Download
              </button>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-[#6e6e6e]">
                <span className="font-semibold">Depth</span>
                <select
                  value={detail}
                  onChange={(e) => setDetail(e.target.value as PortalDetail)}
                  className="rounded-lg border border-[#e5e5e5] bg-white px-2 py-1 text-[11px] text-[#1f1f1f] outline-none focus:border-[#c63a22]"
                >
                  <option value="brief">Brief</option>
                  <option value="standard">Standard</option>
                  <option value="deep">Deep history</option>
                </select>
              </label>
            </div>
            {sbarError ? (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {sbarError}
              </div>
            ) : null}
            {sbar ? <SbarCard sbar={sbar} onClose={() => setSbar(null)} /> : null}
            <details className="mt-3 rounded-xl border border-[#ececec] bg-[#fbfaf9] p-3">
              <summary className="cursor-pointer text-[11px] font-semibold text-[#6e6e6e] hover:text-[#c63a22]">
                Chart snapshot &amp; history
              </summary>
              <div className="mt-3">
                <PatientSnapshot patient={patient} records={context?.records ?? []} />
              </div>
            </details>
          </div>
        </details>
      ) : null}

      {loadError ? (
        <div className="m-4 flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {loadError}
          {!activeSessionId ? (
            <a href="/nurse-view" className="rounded-full border border-red-300 bg-white px-2.5 py-1 text-[11px] font-semibold hover:bg-red-100">
              Open nurse portal
            </a>
          ) : null}
        </div>
      ) : null}

      {/* ── transcript ─────────────────────────────────────────────────── */}
      <div className={`flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-6 ${compact ? "max-h-64 min-h-[9rem]" : "min-h-[14rem]"}`}>
        {!turns.length && !loading ? (
          <div className="mx-auto max-w-sm rounded-2xl border border-dashed border-[#e8ddd8] bg-[#fdfbfa] px-4 py-6 text-center text-xs text-[#6e6e6e]">
            <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-[#fff1ee] text-[#c63a22]">
              <PhoneCall className="h-4 w-4" />
            </span>
            <p className="font-semibold text-[#1f1f1f]">Ready when you are</p>
            <p className="mt-1">
              Press <span className="font-semibold text-[#c63a22]">Start call</span> and the agent will
              {patient ? " brief you on this patient" : " report the live readings"}. Then just talk — or type below.
            </p>
          </div>
        ) : null}

        {turns.map((t) => (
          <div key={t.id} className={`flex items-end gap-2 ${t.role === "caller" ? "justify-end" : "justify-start"}`}>
            {t.role === "agent" ? (
              <span className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#c63a22] to-[#a92f1b] text-[9px] font-bold text-white">
                AI
              </span>
            ) : null}
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm ${
                t.role === "caller"
                  ? "rounded-br-md bg-[#c63a22] text-white"
                  : "rounded-bl-md border border-[#ececec] bg-white text-[#1f1f1f]"
              }`}
            >
              {t.text}
              {t.scope === "general" ? (
                <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                  general guidance · not from the chart
                </span>
              ) : t.citations?.length ? (
                <span className="mt-1 block text-[10px] opacity-60">
                  Sources: {t.citations.slice(0, 3).map((c) => c.title.replace(/^General guidance — /, "")).join(" · ")}
                </span>
              ) : t.engine === "rules" ? (
                <span className="mt-1 block text-[10px] opacity-60">rules engine · off-line fallback</span>
              ) : null}
            </div>
          </div>
        ))}

        {thinking ? (
          <div className="flex justify-start">
            <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-[#ececec] bg-white px-3.5 py-2 text-xs text-[#6e6e6e] shadow-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#c63a22]" /> Checking the care record...
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      {/* ── controls ───────────────────────────────────────────────────── */}
      <div className="border-t border-[#f0e3de] bg-[#fffdfc] px-4 py-4 sm:px-6">
        {endedAt ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-100 bg-emerald-50 px-3.5 py-2.5">
            <div className="flex items-center gap-2 text-xs text-emerald-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                <span className="font-semibold">Call ended</span> · {fmtDuration(endedAt.seconds)} ·{" "}
                {endedAt.turns} turn{endedAt.turns === 1 ? "" : "s"} captured
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void copyTranscript()}
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                <ClipboardCopy className="h-3 w-3" /> {copied ? "Copied" : "Copy notes"}
              </button>
              <button
                type="button"
                onClick={downloadTranscript}
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                <Download className="h-3 w-3" /> Save
              </button>
              <button
                type="button"
                onClick={() => setEndedAt(null)}
                className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-900"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
        {micError ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {micError}
          </div>
        ) : null}
        {sendError ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {sendError}
          </div>
        ) : null}

        {!started ? (
          <button
            type="button"
            onClick={startCall}
            disabled={loading || Boolean(loadError) || !activeSessionId}
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-[#c63a22] to-[#a92f1b] px-4 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:from-[#a92f1b] hover:to-[#8f2716] disabled:opacity-50"
          >
            <PhoneCall className="h-4 w-4" /> Start call
          </button>
        ) : (
          <div className="flex items-start justify-center gap-8 sm:gap-12">
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={toggleVoice}
                disabled={!ttsAvailable}
                title={ttsAvailable ? "Toggle spoken replies" : "This browser has no speech synthesis"}
                className={`inline-flex h-12 w-12 items-center justify-center rounded-full border transition disabled:opacity-40 ${
                  voiceOn
                    ? "border-[#ececec] bg-white text-[#c63a22] hover:border-[#c63a22]"
                    : "border-[#ececec] bg-[#f7f7f7] text-[#8a8a8a]"
                }`}
              >
                {voiceOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
              </button>
              <span className="text-[10px] font-semibold text-[#6e6e6e]">{voiceOn ? "Voice on" : "Voice off"}</span>
            </div>

            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={toggleMic}
                disabled={thinking || speaking}
                className={`relative inline-flex h-16 w-16 items-center justify-center rounded-full transition disabled:opacity-70 ${micState.btn}`}
                aria-label={micState.label}
              >
                {(listening || speaking) && !thinking ? (
                  <span className={`absolute inset-0 animate-ping rounded-full ${micState.ring}`} />
                ) : null}
                <span className="relative">
                  {speaking ? (
                    <Volume2 className="h-6 w-6" />
                  ) : thinking ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : listening ? (
                    <Mic className="h-6 w-6" />
                  ) : (
                    <MicOff className="h-6 w-6" />
                  )}
                </span>
              </button>
              <span className="text-[10px] font-semibold text-[#6e6e6e]">{micState.label}</span>
            </div>

            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={endCall}
                className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-red-200 bg-red-50 text-red-600 transition hover:bg-red-100"
                aria-label="End call"
              >
                <PhoneOff className="h-5 w-5" />
              </button>
              <span className="text-[10px] font-semibold text-[#6e6e6e]">End</span>
            </div>
          </div>
        )}

        <form onSubmit={send} className="mt-4 flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={supported ? "Or type your question..." : "Type your question (voice input unavailable here)..."}
            aria-label="Type a question for the care agent"
            className="min-w-0 flex-1 rounded-xl border border-[#e5e5e5] bg-white px-3.5 py-2.5 text-sm text-[#1f1f1f] outline-none transition focus:border-[#c63a22]"
          />
          <button
            type="submit"
            disabled={!input.trim() || thinking || !activeSessionId}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#1f1f1f] text-white transition hover:bg-[#c63a22] disabled:opacity-40"
            aria-label="Send question"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>

        {suggestions.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void ask(q)}
                disabled={thinking}
                className="rounded-full border border-[#ececec] bg-white px-2.5 py-1 text-[11px] text-[#4b4b4b] transition hover:border-[#c63a22] hover:text-[#c63a22] disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        ) : null}

        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-[#8a8a8a]">
          <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-[#22a67e]" />
          {supported === false
            ? "Voice input is not supported in this browser — typing works exactly the same. Replies are still spoken when available."
            : "Voice input is processed by your browser's speech recognition. Nothing is recorded; the transcript is shown above."}
        </p>
      </div>
    </section>
  );
}
