"use client";

/**
 * Patient joining page for the Web Voice Call — Demo.
 *
 * Deliberately phone-first and simple: confirm, grant the microphone, talk, hear
 * the AI, end. The patient's device never downloads a model. If on-device Whisper
 * is not running on the nurse side, the patient's own browser speech recognition
 * can send text — clearly labelled, and never presented as an on-device model.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Mic, MicOff, PhoneOff, ShieldCheck } from "lucide-react";
import {
  careConfig,
  careJoin,
  careJoinPreview,
  carePostEvent,
  careSendSignal,
  type CareConfig,
} from "@/lib/careClient";
import { speak, speechSynthesisAvailable, stopSpeaking } from "@/lib/care/browserAI";
import { useCareRtc } from "@/hooks/useCareRtc";
import { Badge, Notice, Spinner, formatTime } from "@/components/dashboard/ui";
import type { JoinPreview, PatientMessage } from "@/lib/care/types";

type Phase = "loading" | "invalid" | "ready" | "joining" | "joined" | "ended";

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
  const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike; SpeechRecognition?: new () => SpeechRecognitionLike };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export default function PatientJoin({ token }: { token: string | null }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [config, setConfig] = useState<CareConfig | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [participantToken, setParticipantToken] = useState<string | null>(null);
  const [micState, setMicState] = useState<"idle" | "granted" | "denied" | "requesting">("idle");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [useDeviceSpeech, setUseDeviceSpeech] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const hasRemoteAudio = Boolean(remoteStream && remoteStream.getAudioTracks().length);

  const resume = useCallback(async (stored: string) => {
    try {
      const res = await careJoin({ resumeToken: stored });
      setParticipantToken(res.participantToken);
      setSessionId(res.sessionId);
      setPhase("joining");
    } catch {
      /* stale token; ignore */
    }
  }, []);

  // load config + preview
  useEffect(() => {
    careConfig().then(setConfig).catch(() => undefined);
    if (!token) {
      setPhase("ready");
      return;
    }
    careJoinPreview(token)
      .then((p) => {
        setPreview(p);
        setSessionId(p.sessionId);
        setPhase(p.expired ? "invalid" : "ready");
        if (p.expired) setError("This joining link has expired. Ask the nurse to generate a new one.");
        const stored = sessionStorage.getItem(`care_participant_${p.sessionId}`);
        if (stored && !p.expired) {
          void resume(stored);
        }
      })
      .catch((err) => {
        setPhase("invalid");
        setError(err instanceof Error ? err.message : "This joining link is invalid.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const join = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      setError(null);
      setPhase("joining");
      try {
        const res = await careJoin({
          token: token ?? undefined,
          code: !token && code ? code : undefined,
          name: name || preview?.patientName,
        });
        setParticipantToken(res.participantToken);
        setSessionId(res.sessionId);
        sessionStorage.setItem(`care_participant_${res.sessionId}`, res.participantToken);
        await requestMic(res.sessionId, res.participantToken);
      } catch (err) {
        setPhase("ready");
        setError(err instanceof Error ? err.message : "Could not join the session.");
      }
    },
    [code, name, preview?.patientName, token]
  );

  const requestMic = useCallback(async (sid: string, ptoken: string) => {
    setMicState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      setLocalStream(stream);
      setMicState("granted");
      setPhase("joined");
      void carePostEvent(sid, "mic.granted", {}, ptoken).catch(() => undefined);
    } catch {
      setMicState("denied");
      setPhase("joined");
      if (sid) void carePostEvent(sid, "mic.denied", {}, ptoken).catch(() => undefined);
    }
  }, []);

  // WebRTC
  const rtc = useCareRtc({
    sessionId: sessionId ?? "",
    role: "patient",
    participant: participantToken,
    iceServers: config?.webrtc.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
    pollMs: config?.limits.signalPollMs ?? 1200,
    enabled: phase === "joined" && Boolean(sessionId) && Boolean(participantToken),
    localStream,
    onRemoteStream: setRemoteStream,
    onData: (msg) => {
      if (msg.type === "agent" && typeof msg.text === "string") {
        // Prefer real AI audio when a WebRTC audio track is present.
        if (!hasRemoteAudio && speechSynthesisAvailable()) {
          setAiSpeaking(true);
          speak(msg.text, {
            onStart: () => setAiSpeaking(true),
            onEnd: () => setAiSpeaking(false),
          });
        }
      } else if (msg.type === "session_ended") {
        stopSpeaking();
        setPhase("ended");
      }
    },
  });

  // Play real AI audio if the nurse sends a TTS track.
  useEffect(() => {
    if (audioRef.current) audioRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  // Patient-side speech recognition (optional, labelled).
  useEffect(() => {
    if (phase !== "joined" || !useDeviceSpeech || micState !== "granted" || !participantToken) return;
    const rec = getRecognition();
    if (!rec) return;
    recognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
      }
      if (text.trim()) {
        rtc.sendData({ type: "patient_text", text: text.trim() });
      }
    };
    rec.onerror = () => setError("Phone speech recognition had a problem. You can still speak — the AI will respond if the nurse's browser is listening.");
    rec.onend = () => {
      if (phase === "joined" && recognitionRef.current) {
        try {
          recognitionRef.current.start();
        } catch {
          /* ignore restart races */
        }
      }
    };
    try {
      rec.start();
      setListening(true);
    } catch {
      /* ignore */
    }
    return () => {
      recognitionRef.current = null;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      setListening(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, useDeviceSpeech, micState, participantToken]);

  const endCall = useCallback(async () => {
    stopSpeaking();
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
    localStream?.getTracks().forEach((t) => t.stop());
    if (sessionId && participantToken) {
      void carePostEvent(sessionId, "participant.disconnected", {}, participantToken).catch(() => undefined);
      void careSendSignal(sessionId, "bye", { at: Date.now() }, participantToken).catch(() => undefined);
    }
    setPhase("ended");
  }, [localStream, participantToken, sessionId]);

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-xl flex-col justify-center px-4 py-8">
      <div className="rounded-3xl border border-[#ececec] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[#c63a22]" />
          <span className="text-sm font-bold text-[#1f1f1f]">CareSpeak</span>
          <Badge tone="info">Web Voice Call — Demo</Badge>
        </div>

        {phase === "loading" ? <Spinner label="Checking your invitation…" /> : null}

        {phase === "invalid" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-lg font-bold text-[#1f1f1f]">
              <AlertTriangle className="h-5 w-5 text-red-600" /> This link cannot be used
            </div>
            <Notice tone="danger">{error ?? "The invitation is invalid or already used."}</Notice>
            <form onSubmit={join} className="space-y-2">
              <label className="block text-xs font-semibold text-[#6e6e6e]">
                Enter the joining code from the nurse
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  className="mt-1 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-center font-mono text-lg tracking-widest"
                  placeholder="000000"
                />
              </label>
              <button type="submit" className="w-full rounded-lg bg-[#c63a22] px-4 py-2 text-sm font-semibold text-white">
                Try joining
              </button>
            </form>
          </div>
        ) : null}

        {phase === "ready" ? (
          <div className="space-y-3">
            <h1 className="text-xl font-bold text-[#1f1f1f]">Your care session is ready</h1>
            {preview ? (
              <p className="text-sm text-[#4b4b4b]">
                <span className="font-semibold">{preview.nurseName}</span> would like to check in with{" "}
                <span className="font-semibold">{preview.patientName}</span> using the AI care assistant.
              </p>
            ) : (
              <p className="text-sm text-[#4b4b4b]">Enter your joining code to continue.</p>
            )}
            {preview?.messages && preview.messages.length ? <NurseMessages messages={preview.messages} /> : null}
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <form onSubmit={join} className="space-y-2">
              {!token ? (
                <label className="block text-xs font-semibold text-[#6e6e6e]">
                  Joining code
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    className="mt-1 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-center font-mono text-lg tracking-widest"
                    placeholder="000000"
                  />
                </label>
              ) : null}
              <label className="block text-xs font-semibold text-[#6e6e6e]">
                Your name (optional)
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm"
                  placeholder={preview?.patientName ?? "Patient"}
                />
              </label>
              <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#c63a22] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#a92f1b]">
                <Mic className="h-4 w-4" /> Join and allow microphone
              </button>
            </form>
            <p className="text-[11px] text-[#9ca3af]">
              You will be asked to allow your microphone. Nothing is installed, and no account is needed.
            </p>
          </div>
        ) : null}

        {phase === "joining" ? <Spinner label="Connecting you to the nurse…" /> : null}

        {phase === "joined" ? (
          <div className="space-y-4">
            {micState === "denied" ? (
              <Notice tone="warning">
                Microphone access was blocked, so the AI cannot hear you. Allow the microphone in your browser settings,
                then reload this page.
              </Notice>
            ) : null}
            {micState === "requesting" ? <Spinner label="Requesting microphone…" /> : null}

            <div className="rounded-2xl border border-[#ececec] bg-[#fafafa] p-4 text-center">
              <div className="text-sm font-semibold text-[#1f1f1f]">
                {aiSpeaking ? "The care assistant is speaking…" : listening ? "Listening — speak normally" : "Connected"}
              </div>
              <div className="mt-1 text-xs text-[#6e6e6e]">
                Connection: {rtc.pcState} · {rtc.status}
              </div>
              <div className="mt-3 flex justify-center gap-2">
                <Badge tone={micState === "granted" ? "success" : "danger"}>
                  {micState === "granted" ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
                  {micState === "granted" ? "Microphone on" : "Microphone off"}
                </Badge>
                <Badge tone={aiSpeaking ? "info" : "neutral"}>{aiSpeaking ? "AI speaking" : "AI ready"}</Badge>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-[#4b4b4b]">
              <input type="checkbox" checked={useDeviceSpeech} onChange={(e) => setUseDeviceSpeech(e.target.checked)} />
              Use my phone's speech recognition to send my words (works without any download)
            </label>
            {useDeviceSpeech && !listening ? <div className="text-[11px] text-[#9ca3af]">Starting speech recognition…</div> : null}

            {error ? <Notice tone="warning">{error}</Notice> : null}

            <button
              onClick={endCall}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#e5e5e5] px-4 py-2.5 text-sm font-semibold text-[#4b4b4b] hover:bg-[#f7f7f7]"
            >
              <PhoneOff className="h-4 w-4" /> End session
            </button>
          </div>
        ) : null}

        {phase === "ended" ? (
          <div className="space-y-3 text-center">
            <div className="text-lg font-bold text-[#1f1f1f]">Session ended</div>
            <p className="text-sm text-[#6e6e6e]">
              Thank you. The nurse will review the conversation and any follow-up. You can close this page.
            </p>
          </div>
        ) : null}
      </div>

      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      <p className="mt-4 text-center text-[11px] text-[#9ca3af]">
        This is a browser-to-browser demonstration call, not a telephone call.
      </p>
    </div>
  );
}

function NurseMessages({ messages }: { messages: PatientMessage[] }) {
  return (
    <div className="rounded-2xl border border-[#f0d9d3] bg-[#fff7f5] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#c63a22]">Messages from your nurse</div>
      <ul className="space-y-2">
        {messages.slice(0, 5).map((m) => (
          <li key={m.id} className="text-sm text-[#4b4b4b]">
            <span className="block text-[11px] text-[#9ca3af]">{formatTime(m.createdAt)}</span>
            {m.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
