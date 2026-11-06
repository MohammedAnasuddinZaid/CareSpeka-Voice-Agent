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
  carePortalAsk,
  carePortalBrief,
  carePortalContext,
  type PortalContext,
} from "@/lib/careClient";
import { speak, speechSynthesisAvailable, stopSpeaking } from "@/lib/care/browserAI";

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

  const pairRef = useRef<string | null>(pair);
  pairRef.current = pair;

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
      if (!question || !sessionId || thinkingRef.current) return;

      thinkingRef.current = true;
      setThinking(true);
      setSendError(null);
      append("caller", question);
      setInput("");
      stopListening();

      try {
        const res = await carePortalAsk(sessionId, question, pairRef.current);
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
    [append, sessionId, speakLine, stopListening, resumeListening]
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

  // --- load the patient context --------------------------------------------

  useEffect(() => {
    if (!sessionId) {
      setLoadError("This call link is missing its session id. Scan the patient's QR code again.");
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(null);
    carePortalContext(sessionId, pair)
      .then((res) => {
        if (active) setContext(res.context);
      })
      .catch((err) => {
        if (active) {
          setLoadError(
            err instanceof CareApiError ? err.message : "Could not reach the care record for this session."
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [pair, sessionId]);

  // Keep the transcript pinned to the newest turn (not on first paint, so the
  // page never scrolls itself away from the header).
  useEffect(() => {
    if (!turns.length && !thinking) return;
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, thinking]);

  // --- call control ---------------------------------------------------------

  const startCall = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    wantMicRef.current = true;
    setStarted(true);
    setMicError(null);
    setSendError(null);

    const opening = context?.patient
      ? (() => {
          thinkingRef.current = true;
          setThinking(true);
          return carePortalBrief(sessionId, pairRef.current)
            .then((res) => res.brief.line)
            .catch(() => "");
        })()
      : Promise.resolve(
          "Hi, this is the CareSpeak assistant. No patient is linked to this session yet, so I can only answer general questions. Link a patient in the nurse portal to hear their briefing."
        );

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
  }, [append, context?.patient, resumeListening, sessionId, speakLine]);

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
    { label: "Eye closure", value: reading(metrics?.eyeClosureDuration, "s", 1), icon: Eye },
    { label: "Movement", value: reading(metrics?.movementActivity, "%"), icon: Waves },
  ].filter((c) => c.value);

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

  const suggestions = (context?.suggestedQuestions ?? []).slice(0, compact ? 2 : 3);

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

      {loadError ? (
        <div className="m-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {loadError}
        </div>
      ) : null}

      {/* transcript */}
      <div className={`flex-1 space-y-2.5 overflow-y-auto px-4 py-4 sm:px-5 ${compact ? "max-h-64 min-h-[9rem]" : "min-h-[14rem]"}`}>
        {!turns.length && !loading ? (
          <div className="rounded-2xl border border-dashed border-[#e8ddd8] bg-[#fdfbfa] px-4 py-5 text-center text-xs text-[#6e6e6e]">
            <p className="font-semibold text-[#1f1f1f]">Ready when you are</p>
            <p className="mt-1">
              Press <span className="font-semibold text-[#c63a22]">Start call</span> and the agent will
              {patient ? " brief you on this patient" : " greet you"}. Then just talk — or type below.
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
              disabled={loading || Boolean(loadError)}
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
            disabled={!input.trim() || thinking || !sessionId}
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
