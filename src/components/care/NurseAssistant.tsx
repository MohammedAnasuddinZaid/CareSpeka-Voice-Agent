"use client";

/**
 * The nurse's voice assistant.
 *
 * The nurse speaks (or types) a question about a patient, and the assistant
 * answers from the stored record. The same input can dictate a message to a
 * patient ("send Anita a message saying ..."), which the server persists.
 *
 * Speech input uses the browser's built-in Web Speech API when available; there
 * is always a text fallback. The answer is spoken with the browser's speech
 * synthesis. Nothing here is a language model — answers come from the
 * deterministic server engine over real data.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Mic, MicOff, Send, Sparkles, Volume2, VolumeX } from "lucide-react";
import { Badge, Notice } from "@/components/dashboard/ui";
import { careAskAssistant, CareApiError, type AssistantReply } from "@/lib/careClient";
import { speak, speechSynthesisAvailable, stopSpeaking } from "@/lib/care/browserAI";

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

interface Turn {
  id: number;
  role: "nurse" | "assistant";
  text: string;
  intent?: string;
}

export default function NurseAssistant({
  patientId,
  patientName,
  onStartCall,
  onMessageSent,
}: {
  patientId: string | null;
  patientName?: string | null;
  onStartCall: (patientId: string) => void;
  onMessageSent: () => void;
}) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [suggestions, setSuggestions] = useState<string[]>([
    "Who needs follow-up today?",
    "Which patients were escalated?",
  ]);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const idRef = useRef(0);
  const endRef = useRef<HTMLDivElement | null>(null);
  const ttsAvailable = speechSynthesisAvailable();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, thinking]);

  // Refresh the focused-patient suggestions whenever the selection changes.
  useEffect(() => {
    if (!patientId) return;
    let active = true;
    void careAskAssistant("", patientId)
      .then((r) => {
        if (active) setSuggestions(r.suggestedQuestions);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [patientId]);

  const runQuestion = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || thinking) return;
      setInput("");
      setError(null);
      setThinking(true);
      setTurns((t) => [...t, { id: ++idRef.current, role: "nurse", text: q }]);
      try {
        const reply: AssistantReply = await careAskAssistant(q, patientId);
        setTurns((t) => [...t, { id: ++idRef.current, role: "assistant", text: reply.answer, intent: reply.intent }]);
        if (reply.suggestedQuestions?.length) setSuggestions(reply.suggestedQuestions);
        if (reply.action?.type === "send_message") onMessageSent();
        if (reply.action?.type === "start_call") onStartCall(reply.action.patientId);
        if (speakReplies) speak(reply.answer);
      } catch (err) {
        const msg = err instanceof CareApiError ? err.message : "The assistant could not answer. Try again.";
        setError(msg);
      } finally {
        setThinking(false);
      }
    },
    [onMessageSent, onStartCall, patientId, speakReplies, thinking]
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
      setError("Voice input is not supported in this browser. Type your question instead.");
      return;
    }
    recognitionRef.current = rec;
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      if (text.trim()) void runQuestion(text.trim());
    };
    rec.onerror = () => {
      setError("I could not hear that. Check the microphone and try again.");
      setListening(false);
    };
    rec.onend = () => setListening(false);
    try {
      rec.start();
      setListening(true);
      setError(null);
    } catch {
      setError("Microphone could not be started.");
      setListening(false);
    }
  }, [listening, runQuestion]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void runQuestion(input);
  };

  return (
    <section className="rounded-2xl border border-[#f0d9d3] bg-gradient-to-b from-[#fff7f5] to-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#c63a22] text-white">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-bold text-[#1f1f1f]">Ask your care assistant</h2>
            <p className="text-xs text-[#6e6e6e]">
              Speak or type. {patientName ? `Focused on ${patientName}.` : "Ask about any patient."}
            </p>
          </div>
        </div>
        {ttsAvailable ? (
          <button
            onClick={() => {
              if (speakReplies) stopSpeaking();
              setSpeakReplies((v) => !v);
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-1 text-xs font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7]"
            title="Toggle spoken answers"
          >
            {speakReplies ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
            {speakReplies ? "Voice on" : "Voice off"}
          </button>
        ) : null}
      </div>

      <div className="mb-3 max-h-[320px] space-y-2 overflow-y-auto pr-1">
        {turns.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#e5e5e5] px-4 py-6 text-center text-sm text-[#9ca3af]">
            Try “What medications is {patientName ? patientName.split(" ")[0] : "Anita"} on?” or
            “Send Anita a message saying please weigh yourself tomorrow morning.”
          </p>
        ) : (
          turns.map((t) => (
            <div key={t.id} className={`flex ${t.role === "nurse" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm ${
                  t.role === "nurse" ? "bg-[#c63a22] text-white" : "bg-[#f1f5f9] text-[#1f1f1f]"
                }`}
              >
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">
                  {t.role === "nurse" ? "You" : "Care assistant"}
                </div>
                {t.text}
                {t.intent ? (
                  <div className="mt-1">
                    <Badge tone="info">{t.intent.replace(/_/g, " ")}</Badge>
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
        {thinking ? <div className="text-xs text-[#9ca3af]">Checking the record…</div> : null}
        <div ref={endRef} />
      </div>

      {error ? (
        <div className="mb-3">
          <Notice tone="warning">{error}</Notice>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-2">
        {suggestions.slice(0, 5).map((s) => (
          <button
            key={s}
            onClick={() => void runQuestion(s)}
            disabled={thinking}
            className="rounded-full border border-[#e5e5e5] bg-white px-3 py-1 text-xs font-medium text-[#4b4b4b] transition hover:border-[#c63a22] hover:text-[#c63a22] disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleListen}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition ${
            listening ? "animate-pulse bg-red-600" : "bg-[#1f1f1f] hover:bg-black"
          }`}
          title={listening ? "Stop listening" : "Speak your question"}
        >
          {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={listening ? "Listening…" : "Type a question or a message to send…"}
          className="h-11 flex-1 rounded-full border border-[#e5e5e5] bg-white px-4 text-sm outline-none focus:border-[#c63a22]"
        />
        <button
          type="submit"
          disabled={thinking || !input.trim()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#c63a22] text-white transition hover:bg-[#a92f1b] disabled:opacity-40"
          title="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
      <p className="mt-2 text-[11px] text-[#9ca3af]">
        Answers are read from the patient record. The assistant never diagnoses or invents vitals.
      </p>
    </section>
  );
}
