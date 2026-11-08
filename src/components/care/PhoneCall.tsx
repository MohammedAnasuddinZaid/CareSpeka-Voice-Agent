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
  Eye,
  Link2,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Send,
  Volume2,
  Waves,
} from "lucide-react";
import {
  CareApiError,
  careCreatePatient,
  careDeletePatient,
  carePortalAsk,
  carePortalBrief,
  carePortalContext,
  carePortalLink,
  carePortalUnlink,
  type PortalContext,
} from "@/lib/careClient";
import { speak, speechSynthesisAvailable, stopSpeaking } from "@/lib/care/browserAI";
import { getActiveCareSession, getSession, rememberCareSession } from "@/lib/session";

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
}

function reading(value: number | undefined, suffix: string, digits = 0): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${value.toFixed(digits)}${suffix}`;
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
  const movement = reading(m?.movementActivity, "%");
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
  const [showDemoPatients, setShowDemoPatients] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
  const askRef = useRef<(text: string) => Promise<void>>(async () => undefined);
  const endRef = useRef<HTMLDivElement | null>(null);

  const append = useCallback((role: Turn["role"], text: string, engine?: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const id = ++turnIdRef.current;
    setTurns((prev) => [...prev.slice(-40), { id, role, text: clean, engine }]);
  }, []);

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
        const res = await carePortalAsk(activeSessionId, question, pairRef.current);
        append("agent", res.result.answer, res.result.engine);
        speakLine(res.result.answer);
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
    [activeSessionId, append, speakLine, stopListening, resumeListening]
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
      setActiveSessionId(fromUrl);
      setActivePair(pair ?? null);
      setSessionReady(true);
      rememberCareSession(fromUrl, pair);
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

  // While the call is live, keep the readings fresh without ever flashing the
  // loading state (the signal chips should update on their own).
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

  // --- call control ---------------------------------------------------------

  const startCall = useCallback(() => {
    if (startedRef.current || !activeSessionId) return;
    startedRef.current = true;
    wantMicRef.current = true;
    setStarted(true);
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

  const linkPatient = useCallback(async () => {
    if (!activeSessionId || !pickedPatient || linking) return;
    setLinking(true);
    setLinkError(null);
    try {
      const res = await carePortalLink(activeSessionId, pickedPatient, pairRef.current);
      setContext(res.context);
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
    } catch (err) {
      setLinkError(err instanceof CareApiError ? err.message : "Could not unlink.");
    } finally {
      setUnlinking(false);
    }
  }, [activeSessionId, unlinking]);

  const addPatient = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!newPatientName.trim() || creatingPatient) return;
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
  const chips = [
    { label: "Blink rate", value: reading(metrics?.blinkRate, "/min"), icon: Eye },
    { label: "Alertness", value: reading(metrics?.alertnessScore, "%"), icon: Activity },
    {
      label: "Eye closure",
      value: reading(metrics?.eyeClosureDuration != null ? metrics.eyeClosureDuration / 1000 : undefined, "s", 1),
      icon: Eye,
    },
    { label: "Movement", value: reading(metrics?.movementActivity, "%"), icon: Waves },
  ].filter((c) => c.value);

  const findings = context?.findings ?? [];
  const worst = context?.worst ?? "ok";

  const status = loadError
    ? { label: "Link problem", tone: "bg-red-50 text-red-700 border-red-200" }
    : loading
      ? { label: "Loading patient", tone: "bg-slate-50 text-slate-600 border-slate-200" }
      : !started
        ? { label: "Ready to call", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" }
        : speaking
          ? { label: "Agent speaking", tone: "bg-[#fff1ee] text-[#c63a22] border-[#f0c8bf]" }
          : thinking
            ? { label: "Checking the record", tone: "bg-amber-50 text-amber-800 border-amber-200" }
            : listening
              ? { label: "Listening", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" }
              : { label: "On call", tone: "bg-slate-50 text-slate-600 border-slate-200" };

  const suggestions = patient
    ? (context?.suggestedQuestions ?? []).slice(0, compact ? 2 : 3)
    : ["What are the live readings?", "Is anything urgent right now?", "What should I check first?"].slice(
        0,
        compact ? 2 : 3
      );

  return (
    <section className={`flex flex-col overflow-hidden rounded-3xl border border-[#ececec] bg-white shadow-sm ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#f0e3de] bg-gradient-to-b from-[#fff7f5] to-white px-4 py-3 sm:px-5">
        <div className="flex items-start gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#c63a22] text-white">
            <PhoneCall className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-[#1f1f1f]">Free browser call</h2>
            <p className="text-[11px] text-[#6e6e6e]">
              {patient ? (
                <>
                  With <span className="font-semibold text-[#1f1f1f]">{patient.displayName}</span>
                  {patient.room ? ` · ${patient.room}` : ""}
                </>
              ) : activeSessionId ? (
                <>
                  Live session <span className="font-semibold text-[#1f1f1f]">{activeSessionId}</span> · no patient linked
                </>
              ) : (
                "Same CareSpeak agent — no phone charges"
              )}
            </p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${status.tone}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" /> {status.label}
        </span>
      </div>

      {chips.length ? (
        <div className="flex flex-wrap gap-1.5 border-b border-[#f4efec] px-4 py-2.5 sm:px-5">
          {chips.map((c) => (
            <span
              key={c.label}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#ececec] bg-[#fbfaf9] px-2.5 py-1 text-[11px] text-[#4b4b4b]"
            >
              <c.icon className="h-3 w-3 text-[#c63a22]" />
              <span className="text-[#8a8a8a]">{c.label}</span>
              <span className="font-semibold text-[#1f1f1f]">{c.value}</span>
            </span>
          ))}
        </div>
      ) : null}

      {findings.length ? (
        <div
          className={`border-b px-4 py-2 text-[11px] sm:px-5 ${
            worst === "critical"
              ? "border-red-100 bg-red-50 text-red-700"
              : "border-amber-100 bg-amber-50 text-amber-800"
          }`}
        >
          <span className="font-semibold">{worst === "critical" ? "Critical" : "Watch"}:</span>{" "}
          {findings.map((f) => `${f.label} ${f.reading}`).join(" · ")}
        </div>
      ) : null}

      {/* patient linking */}
      {!loadError && !loading ? (
        <div className="border-b border-[#f4efec] px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold text-[#6e6e6e]">Patient:</span>
            {context?.patient ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
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
              {showPatientPicker ? "Hide patient options" : "Link a patient (optional)"}
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
                  <option value="">Choose a patient…</option>
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
                  Link
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

      {/* transcript */}
      <div className={`flex-1 space-y-2.5 overflow-y-auto px-4 py-4 sm:px-5 ${compact ? "max-h-64 min-h-[9rem]" : "min-h-[14rem]"}`}>
        {!turns.length && !loading ? (
          <div className="rounded-2xl border border-dashed border-[#e8ddd8] bg-[#fdfbfa] px-4 py-5 text-center text-xs text-[#6e6e6e]">
            <p className="font-semibold text-[#1f1f1f]">Ready when you are</p>
            <p className="mt-1">
              Press <span className="font-semibold text-[#c63a22]">Start call</span> and the agent will
              {patient ? " brief you on this patient" : " report the live readings"}. Then just talk — or type below.
            </p>
          </div>
        ) : null}

        {turns.map((t) => (
          <div key={t.id} className={`flex ${t.role === "caller" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[88%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                t.role === "caller"
                  ? "rounded-br-md bg-[#c63a22] text-white"
                  : "rounded-bl-md border border-[#ececec] bg-[#fbfaf9] text-[#1f1f1f]"
              }`}
            >
              {t.text}
              {t.engine === "rules" ? (
                <span className="mt-1 block text-[10px] opacity-60">rules engine · off-line fallback</span>
              ) : null}
            </div>
          </div>
        ))}

        {thinking ? (
          <div className="flex justify-start">
            <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-[#ececec] bg-[#fbfaf9] px-3.5 py-2 text-xs text-[#6e6e6e]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the care record…
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      {/* controls */}
      <div className="border-t border-[#f0e3de] px-4 py-4 sm:px-5">
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

        <div className="flex flex-wrap items-center gap-2">
          {!started ? (
            <button
              type="button"
              onClick={startCall}
              disabled={loading || Boolean(loadError) || !activeSessionId}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#c63a22] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#a92f1b] disabled:opacity-50 sm:flex-none"
            >
              <PhoneCall className="h-4 w-4" /> Start call
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={toggleMic}
                disabled={thinking || speaking}
                className={`inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition disabled:opacity-60 sm:flex-none ${
                  listening
                    ? "bg-[#c63a22] text-white hover:bg-[#a92f1b]"
                    : "border border-[#e5dedb] bg-white text-[#1f1f1f] hover:border-[#c63a22]"
                }`}
              >
                {speaking ? (
                  <Volume2 className="h-4 w-4" />
                ) : thinking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : listening ? (
                  <Mic className="h-4 w-4" />
                ) : (
                  <MicOff className="h-4 w-4" />
                )}
                {speaking
                  ? "Agent speaking…"
                  : thinking
                    ? "Checking…"
                    : listening
                      ? "Listening — tap to mute"
                      : "Mic is off — tap to talk"}
              </button>
              <button
                type="button"
                onClick={endCall}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#e5dedb] bg-white px-4 py-3 text-sm font-semibold text-[#6e6e6e] transition hover:border-red-300 hover:text-red-600"
              >
                <PhoneOff className="h-4 w-4" /> End call
              </button>
            </>
          )}

          <button
            type="button"
            onClick={toggleVoice}
            className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-xs font-semibold transition ${
              voiceOn
                ? "border-[#ececec] bg-white text-[#1f1f1f]"
                : "border-[#ececec] bg-[#f7f7f7] text-[#8a8a8a]"
            }`}
            title={ttsAvailable ? "Toggle spoken replies" : "This browser has no speech synthesis"}
            disabled={!ttsAvailable}
          >
            <Volume2 className={`h-4 w-4 ${voiceOn ? "text-[#c63a22]" : ""}`} />
            {voiceOn ? "Voice on" : "Voice off"}
          </button>
        </div>

        <form onSubmit={send} className="mt-3 flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={supported ? "Or type your question…" : "Type your question (voice input unavailable here)…"}
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
