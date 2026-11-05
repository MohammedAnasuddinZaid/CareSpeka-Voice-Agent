"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import * as QRCode from "qrcode";
import {
  Activity,
  AlertCircle,
  AudioLines,
  BadgeCheck,
  Brain,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Clock3,
  Cpu,
  Database,
  Ear,
  History,
  Info,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneOff,
  QrCode,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  Volume2,
  Waves,
  Wifi,
  XCircle,
} from "lucide-react";
import {
  useVoiceCall,
  type TranscriptEntry,
  type TurnMetrics,
  type VoiceCallState,
} from "@/hooks/useVoiceCall";

type HealthResponse = {
  status: string;
  checks: Record<string, boolean>;
  gateway?: { phone_url?: string; ca_url?: string; port?: number };
  voice_link?: { status: string; checks: Record<string, boolean> };
};

type StatusResponse = {
  uptime_s: number;
  active_calls: number;
  max_active_calls: number;
  lan_ip: string;
  phone_url: string;
  ca_url: string;
  models: Record<string, { name: string; license: string; runtime: string }>;
  transcripts_stored: boolean;
};

type Patient = {
  extension: string;
  display_name: string;
  age?: number;
  room?: string;
  primary_concern?: string;
  synthetic?: boolean;
};

type HistoryCall = {
  id: string;
  caller_extension: string;
  callee_extension: string;
  patient_name?: string;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  status: string;
  turns: number;
  avg_latency_ms?: number;
  started_at_label?: string;
};

type HistoryDetail = HistoryCall & {
  transcripts: Array<{
    role: string;
    text: string;
    created_at: string;
    latency_ms?: number;
  }>;
};

const STATE_META: Record<
  VoiceCallState,
  { label: string; hint: string; chip: string; dot: string }
> = {
  IDLE: {
    label: "Ready",
    hint: "Dial the local AI line to begin.",
    chip: "bg-slate-100 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
  },
  DIALING: {
    label: "Dialing",
    hint: "Opening the local voice socket.",
    chip: "bg-sky-50 text-sky-700 border-sky-200",
    dot: "bg-sky-500",
  },
  CONNECTING: {
    label: "Connecting",
    hint: "Preparing speech and language engines.",
    chip: "bg-sky-50 text-sky-700 border-sky-200",
    dot: "bg-sky-500",
  },
  CONNECTED: {
    label: "Connected",
    hint: "The private line is open.",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  LISTENING: {
    label: "Listening",
    hint: "Speak naturally, or hold the talk button.",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  PROCESSING: {
    label: "Thinking",
    hint: "Speech recognition and the local model are working.",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    dot: "bg-amber-500",
  },
  SPEAKING: {
    label: "Aria speaking",
    hint: "Start talking to interrupt, or wait for your turn.",
    chip: "bg-[#c63a22]/5 text-[#c63a22] border-[#c63a22]/20",
    dot: "bg-[#c63a22]",
  },
  ENDED: {
    label: "Call ended",
    hint: "The transcript stays on this computer.",
    chip: "bg-slate-100 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
  },
  ERROR: {
    label: "Line error",
    hint: "Check the local stack and try again.",
    chip: "bg-red-50 text-red-700 border-red-200",
    dot: "bg-red-500",
  },
};

const HISTORY_STATUS: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-700",
  disconnected: "bg-amber-50 text-amber-700",
  time_limit: "bg-amber-50 text-amber-700",
  shutdown: "bg-slate-100 text-slate-600",
  ended: "bg-slate-100 text-slate-600",
};

function backendBase(): string {
  const override = process.env.NEXT_PUBLIC_VOICELINK_BACKEND;
  if (override) return override.replace(/\/$/, "");
  if (typeof window === "undefined") return "http://127.0.0.1:8000";
  if (window.location.port === "3443") return window.location.origin;
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function formatCallTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Waveform({
  analyser,
  color,
  active,
}: {
  analyser: RefObject<AnalyserNode | null>;
  color: string;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let values = new Uint8Array(1024);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      if (!width || !height) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      context.clearRect(0, 0, width, height);
      const middle = height / 2;
      const node = analyser.current;
      if (node) {
        if (values.length !== node.fftSize) values = new Uint8Array(node.fftSize);
        node.getByteTimeDomainData(values);
      } else {
        values.fill(128);
      }

      const amplitude = activeRef.current ? height * 0.42 : height * 0.05;

      context.beginPath();
      context.moveTo(0, middle);
      for (let x = 0; x <= width; x += 2) {
        const index = Math.min(
          values.length - 1,
          Math.floor((x / width) * values.length),
        );
        const sample = (values[index] - 128) / 128;
        context.lineTo(x, middle + sample * amplitude);
      }
      context.lineTo(width, middle);
      context.closePath();

      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, `${color}18`);
      gradient.addColorStop(0.5, `${color}38`);
      gradient.addColorStop(1, `${color}18`);
      context.fillStyle = gradient;
      context.fill();

      context.beginPath();
      for (let x = 0; x <= width; x += 2) {
        const index = Math.min(
          values.length - 1,
          Math.floor((x / width) * values.length),
        );
        const sample = (values[index] - 128) / 128;
        const y = middle + sample * amplitude;
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.strokeStyle = activeRef.current ? color : `${color}55`;
      context.lineWidth = 1.6;
      context.lineJoin = "round";
      context.stroke();

      context.beginPath();
      context.setLineDash([3, 6]);
      context.moveTo(0, middle);
      context.lineTo(width, middle);
      context.strokeStyle = `${color}25`;
      context.lineWidth = 1;
      context.stroke();
      context.setLineDash([]);

      frame = window.requestAnimationFrame(draw);
    };

    draw();
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [analyser, color]);

  return <canvas ref={canvasRef} className="h-[74px] w-full" />;
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border border-[#ececec] bg-[#faf9f7] px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a8a8a]">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-[#1f1f1f]">{value}</div>
      {detail ? <div className="mt-0.5 text-[11px] text-[#8a8a8a]">{detail}</div> : null}
    </div>
  );
}

function StatusRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-[#faf9f7] px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-[#1f1f1f]">{label}</div>
        {detail ? (
          <div className="truncate text-[11px] text-[#8a8a8a]">{detail}</div>
        ) : null}
      </div>
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${
          ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
        }`}
      >
        {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
        {ok ? "Online" : "Offline"}
      </span>
    </div>
  );
}

function TranscriptBubble({ entry }: { entry: TranscriptEntry }) {
  const assistant = entry.role === "assistant";
  return (
    <div className={`flex gap-2.5 ${assistant ? "" : "flex-row-reverse"}`}>
      <div
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          assistant
            ? "bg-[#c63a22]/10 text-[#c63a22]"
            : "bg-emerald-50 text-emerald-700"
        }`}
      >
        {assistant ? <Sparkles className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </div>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
          assistant
            ? "rounded-tl-md border border-[#ececec] bg-white text-[#1f1f1f]"
            : "rounded-tr-md bg-emerald-50 text-[#145c47]"
        }`}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9a9a9a]">
          {assistant ? "Aria · AI agent" : "Caller"}
          {entry.streaming ? (
            <span className="inline-flex items-center gap-1 text-[#c63a22]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#c63a22]" />
              live
            </span>
          ) : null}
        </div>
        <div className="whitespace-pre-wrap">
          {entry.text || (entry.streaming ? "…" : "")}
          {entry.streaming ? (
            <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-[#c63a22] align-middle" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MetricGrid({ metrics }: { metrics: TurnMetrics | null }) {
  if (!metrics) {
    return (
      <p className="rounded-xl bg-[#faf9f7] px-3 py-3 text-xs leading-relaxed text-[#8a8a8a]">
        Turn timings will appear here after the first reply. Values are measured by
        the local server, not estimated.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <Metric
        label="Heard in"
        value={
          metrics.input === "text"
            ? "typed"
            : formatMs(metrics.asr_ms)
        }
        detail={metrics.input === "text" ? "no ASR needed" : "whisper.cpp"}
      />
      <Metric
        label="First token"
        value={formatMs(metrics.llm_first_token_ms)}
        detail="local model"
      />
      <Metric
        label="First audio"
        value={formatMs(metrics.e2e_first_audio_ms)}
        detail="end to end"
      />
      <Metric
        label="Spoken"
        value={`${metrics.tts_sentences ?? 0} sentence${(metrics.tts_sentences ?? 0) === 1 ? "" : "s"}`}
        detail={metrics.interrupted ? "interrupted" : "completed"}
      />
    </div>
  );
}

function PhoneCard({
  phoneUrl,
  caUrl,
  qrDataUrl,
}: {
  phoneUrl?: string;
  caUrl?: string;
  qrDataUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!phoneUrl) return;
    try {
      await navigator.clipboard.writeText(phoneUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="rounded-3xl border border-[#ececec] bg-white p-5 shadow-[0_12px_30px_rgba(18,18,18,0.035)]">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
        <QrCode className="h-4 w-4 text-[#c63a22]" />
        Call from a phone
      </div>
      <p className="text-xs leading-relaxed text-[#6e6e6e]">
        Scan on a device connected to the same Wi-Fi. This is a browser call over
        your LAN — not a PSTN phone number.
      </p>

      <div className="mt-4 flex justify-center">
        {qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrDataUrl}
            alt="QR code for the local VoiceLink phone page"
            className="h-40 w-40 rounded-xl border border-[#ececec] bg-white p-2"
          />
        ) : (
          <div className="flex h-40 w-40 items-center justify-center rounded-xl border border-dashed border-[#d8d5d1] text-xs text-[#9a9a9a]">
            Gateway not detected
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center gap-2 rounded-xl bg-[#faf9f7] px-3 py-2">
          <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-[#22a67e]" />
          <span className="min-w-0 flex-1 truncate text-xs text-[#1f1f1f]">
            {phoneUrl || "Start the local gateway to create a phone link."}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!phoneUrl}
            className="rounded-lg border border-[#e4e1dd] p-1.5 text-[#6e6e6e] transition hover:bg-white disabled:opacity-40"
            title="Copy phone link"
          >
            <Clipboard className="h-3.5 w-3.5" />
          </button>
        </div>
        {copied ? (
          <div className="text-[11px] font-medium text-emerald-700">Link copied.</div>
        ) : null}
        {caUrl ? (
          <a
            href={caUrl}
            className="flex items-center gap-2 text-xs font-medium text-[#c63a22] hover:underline"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Download the local CA certificate
          </a>
        ) : null}
      </div>

      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] leading-relaxed text-amber-900">
        <strong>Phone setup:</strong> install and trust the local CA first, then
        scan the QR and allow the microphone. Browsers block microphone access on
        an untrusted HTTPS page. This is a demo network only — never use it for
        emergencies.
      </div>
    </div>
  );
}

export default function VoiceLinkPage() {
  const [caller, setCaller] = useState("CS-1001");
  const [callee] = useState("CS-0000");
  const [demoMode, setDemoMode] = useState(true);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [history, setHistory] = useState<HistoryCall[]>([]);
  const [historyDetail, setHistoryDetail] = useState<HistoryDetail | null>(null);
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [typed, setTyped] = useState("");
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch(`${backendBase()}/api/voicelink/history?limit=8`);
      if (!response.ok) return;
      const payload = (await response.json()) as { calls: HistoryCall[] };
      setHistory(Array.isArray(payload.calls) ? payload.calls : []);
    } catch {
      // History is optional; a failed fetch must not break an active call.
    }
  }, []);

  const loadLiveStatus = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const [healthResponse, statusResponse, patientResponse] = await Promise.all([
        fetch(
          `${backendBase()}/api/voicelink/health${refresh ? "?refresh=true" : ""}`,
        ),
        fetch(`${backendBase()}/api/voicelink/status`),
        fetch(`${backendBase()}/api/voicelink/patients`),
      ]);
      if (healthResponse.ok) {
        const payload = (await healthResponse.json()) as HealthResponse;
        setHealth(payload);
      } else {
        setHealthError(`Health endpoint returned HTTP ${healthResponse.status}.`);
      }
      if (statusResponse.ok) {
        setStatus((await statusResponse.json()) as StatusResponse);
      }
      if (patientResponse.ok) {
        const payload = (await patientResponse.json()) as { patients: Patient[] };
        setPatients(payload.patients || []);
      }
      setHealthError(null);
    } catch (exc) {
      setHealthError(
        exc instanceof Error
          ? `Local service unreachable: ${exc.message}`
          : "Local service unreachable.",
      );
    } finally {
      if (refresh) setRefreshing(false);
    }
  }, []);

  const call = useVoiceCall({
    caller,
    callee,
    demoMode,
    onCallEnded: () => {
      void loadHistory();
      void loadLiveStatus();
    },
  });

  useEffect(() => {
    void loadLiveStatus();
    void loadHistory();
    const timer = window.setInterval(() => {
      void loadLiveStatus();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [loadHistory, loadLiveStatus]);

  useEffect(() => {
    const phoneUrl = status?.phone_url || health?.gateway?.phone_url;
    if (!phoneUrl) {
      setQrDataUrl("");
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(phoneUrl, {
      margin: 1,
      width: 320,
      color: { dark: "#1f1f1f", light: "#ffffff" },
    })
      .then((value) => {
        if (!cancelled) setQrDataUrl(value);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [status?.phone_url, health?.gateway?.phone_url]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [call.messages]);

  const meta = STATE_META[call.state];
  const checks = health?.checks || health?.voice_link?.checks || {};
  const displayPatient =
    call.session?.patient || patients.find((item) => item.extension === caller) || null;

  const inCall =
    call.state !== "IDLE" && call.state !== "ENDED" && call.state !== "ERROR";
  const canDial = /^CS-\d{4}$/.test(caller.toUpperCase());
  const historyPhoneUrl = status?.phone_url || health?.gateway?.phone_url;
  const caUrl = status?.ca_url || health?.gateway?.ca_url;

  const checkRows = useMemo(
    () => [
      {
        label: "Speech to text",
        ok: Boolean(checks.whisper_model && checks.whisper_server),
        detail: status?.models?.stt?.name || "whisper.cpp",
      },
      {
        label: "Language model",
        ok: Boolean(checks.ollama && checks.llm_model),
        detail: status?.models?.llm?.name || "local Ollama model",
      },
      {
        label: "Text to speech",
        ok: Boolean(checks.tts_model && checks.tts_engine),
        detail: status?.models?.tts?.name || "local VITS voice",
      },
      {
        label: "Voice activity",
        ok: Boolean(checks.vad_model),
        detail: status?.models?.vad?.name || "Silero VAD",
      },
      {
        label: "Local database",
        ok: Boolean(checks.database),
        detail: status?.transcripts_stored ? "SQLite · transcripts on" : "SQLite",
      },
    ],
    [checks, status],
  );

  const openHistory = async (callId: string) => {
    if (historyOpen === callId) {
      setHistoryOpen(null);
      setHistoryDetail(null);
      return;
    }
    setHistoryOpen(callId);
    setHistoryLoading(true);
    try {
      const response = await fetch(`${backendBase()}/api/voicelink/history/${callId}`);
      if (response.ok) {
        setHistoryDetail((await response.json()) as HistoryDetail);
      } else {
        setHistoryDetail(null);
      }
    } catch {
      setHistoryDetail(null);
    } finally {
      setHistoryLoading(false);
    }
  };

  const clearHistory = async () => {
    if (!window.confirm("Delete all local VoiceLink call history? This cannot be undone.")) {
      return;
    }
    try {
      await fetch(`${backendBase()}/api/voicelink/history`, { method: "DELETE" });
      setHistory([]);
      setHistoryOpen(null);
      setHistoryDetail(null);
    } catch {
      // Leave the list untouched if deletion failed.
    }
  };

  const submitTyped = (event: FormEvent) => {
    event.preventDefault();
    if (!typed.trim()) return;
    if (call.sendText(typed)) setTyped("");
  };

  const startPtt = () => {
    void call.startPtt();
  };

  return (
    <div className="min-h-screen bg-[#f7f5f2] pb-20 pt-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 inline-flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-[#c63a22]/20 bg-[#c63a22]/5 px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#c63a22]">
                <PhoneCall className="h-3.5 w-3.5" />
                VoiceLink
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700">
                <ShieldCheck className="h-3.5 w-3.5" />
                Local · private · ₹0 per call
              </span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-[#1f1f1f] sm:text-4xl">
              A real voice line, running on this computer
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#6e6e6e] sm:text-base">
              Microphone → local speech recognition → local language model → local
              speech. No cloud inference, no API keys, no telephony bill. The sample
              patient is synthetic.
            </p>
          </div>
          <div
            className={`inline-flex items-center gap-2 self-start rounded-full border px-4 py-2 text-sm font-semibold lg:self-auto ${meta.chip}`}
          >
            <span className={`h-2 w-2 rounded-full ${meta.dot} ${inCall ? "animate-pulse" : ""}`} />
            {meta.label}
            {call.durationSeconds > 0 ? (
              <span className="font-mono text-xs opacity-70">
                {formatDuration(call.durationSeconds)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.75fr)]">
          <div className="space-y-6">
            <div className="overflow-hidden rounded-3xl border border-[#ececec] bg-white shadow-[0_18px_40px_rgba(18,18,18,0.05)]">
              <div className="border-b border-[#f0eeeb] bg-gradient-to-br from-[#fdf8f5] via-white to-white px-5 py-5 sm:px-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`relative flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg ${
                        call.state === "SPEAKING"
                          ? "bg-gradient-to-br from-[#c63a22] to-[#8f2414] shadow-[#c63a22]/25"
                          : "bg-gradient-to-br from-[#3d3d3d] to-[#1f1f1f] shadow-black/15"
                      }`}
                    >
                      {call.state === "SPEAKING" ? (
                        <>
                          <span className="absolute inset-0 animate-ping rounded-2xl bg-[#c63a22]/20" />
                          <AudioLines className="relative h-6 w-6" />
                        </>
                      ) : (
                        <Sparkles className="h-6 w-6" />
                      )}
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-bold text-[#1f1f1f]">
                          {call.session?.callee_name || "Aria"}
                        </h2>
                        <span className="rounded-full bg-[#f1eeea] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#6e6e6e]">
                          {callee}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                          <BadgeCheck className="h-3 w-3" />
                          AI agent
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-[#6e6e6e]">{meta.hint}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {call.micStatus === "live" ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                        <Mic className="h-3 w-3" />
                        Mic live
                      </span>
                    ) : call.micStatus === "requesting" ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Mic permission
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e4e1dd] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#8a8a8a]">
                        <MicOff className="h-3 w-3" />
                        Mic off
                      </span>
                    )}
                    <span className="rounded-full border border-[#e4e1dd] bg-white px-2.5 py-1 font-mono text-[11px] font-semibold text-[#1f1f1f]">
                      {formatDuration(call.durationSeconds)}
                    </span>
                  </div>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-[#f0ece7] bg-white/80 px-3.5 py-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a8a8a]">
                        <Mic className="h-3 w-3" />
                        Your microphone
                      </span>
                      {call.muted ? (
                        <span className="text-[10px] font-semibold text-red-600">muted</span>
                      ) : call.pttActive ? (
                        <span className="text-[10px] font-semibold text-[#c63a22]">recording</span>
                      ) : (
                        <span className="text-[10px] font-semibold text-emerald-700">open</span>
                      )}
                    </div>
                    <Waveform
                      analyser={call.micAnalyser}
                      color="#c63a22"
                      active={call.micStatus === "live" && !call.muted}
                    />
                  </div>
                  <div className="rounded-2xl border border-[#f0ece7] bg-white/80 px-3.5 py-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a8a8a]">
                        <Volume2 className="h-3 w-3" />
                        Aria&apos;s voice
                      </span>
                      <span className="text-[10px] font-semibold text-emerald-700">
                        {call.agentAudioPlaying ? "playing" : "idle"}
                      </span>
                    </div>
                    <Waveform
                      analyser={call.outputAnalyser}
                      color="#22a67e"
                      active={call.agentAudioPlaying}
                    />
                  </div>
                </div>

                {call.error ? (
                  <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-relaxed text-red-800">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="flex-1">{call.error}</div>
                    {call.micStatus === "denied" ? (
                      <button
                        type="button"
                        onClick={() => void call.retryMicrophone()}
                        className="shrink-0 rounded-lg border border-red-200 bg-white px-2 py-1 font-semibold text-red-700"
                      >
                        Retry mic
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="px-5 py-5 sm:px-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 text-xs font-semibold text-[#4c4c4c]">
                    Caller extension
                    <input
                      value={caller}
                      onChange={(event) => setCaller(event.target.value.toUpperCase())}
                      disabled={inCall}
                      list="voicelink-patients"
                      className="w-full rounded-xl border border-[#e4e1dd] bg-[#faf9f7] px-3 py-2.5 text-sm font-medium text-[#1f1f1f] outline-none transition focus:border-[#c63a22] focus:bg-white disabled:opacity-60"
                      placeholder="CS-1001"
                    />
                    <datalist id="voicelink-patients">
                      {patients.map((patient) => (
                        <option key={patient.extension} value={patient.extension}>
                          {patient.display_name}
                        </option>
                      ))}
                    </datalist>
                  </label>
                  <label className="space-y-1.5 text-xs font-semibold text-[#4c4c4c]">
                    AI extension
                    <input
                      value={callee}
                      readOnly
                      className="w-full rounded-xl border border-[#e4e1dd] bg-[#f1eeea] px-3 py-2.5 text-sm font-medium text-[#6e6e6e] outline-none"
                    />
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2.5">
                  {!inCall ? (
                    <button
                      type="button"
                      onClick={() => void call.startCall()}
                      disabled={!canDial || call.state === "DIALING"}
                      className="inline-flex items-center gap-2 rounded-xl bg-[#c63a22] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-[#c63a22]/20 transition hover:bg-[#a32e1a] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {call.state === "DIALING" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Phone className="h-4 w-4" />
                      )}
                      {call.state === "ENDED" ? "Call again" : "Call CS-0000"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={call.endCall}
                      className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-700 transition hover:bg-red-100"
                    >
                      <PhoneOff className="h-4 w-4" />
                      Hang up
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={call.toggleMute}
                    disabled={!inCall}
                    className={`inline-flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      call.muted
                        ? "border-red-200 bg-red-50 text-red-700"
                        : "border-[#e4e1dd] bg-white text-[#1f1f1f] hover:bg-[#faf9f7]"
                    }`}
                  >
                    {call.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    {call.muted ? "Unmute" : "Mute"}
                  </button>

                  <button
                    type="button"
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      startPtt();
                    }}
                    onPointerUp={call.stopPtt}
                    onPointerCancel={call.stopPtt}
                    onPointerLeave={() => {
                      if (call.pttActive) call.stopPtt();
                    }}
                    onKeyDown={(event) => {
                      if (event.code === "Space" && !event.repeat) {
                        event.preventDefault();
                        startPtt();
                      }
                    }}
                    onKeyUp={(event) => {
                      if (event.code === "Space") {
                        event.preventDefault();
                        call.stopPtt();
                      }
                    }}
                    onContextMenu={(event) => event.preventDefault()}
                    disabled={!inCall || call.micStatus !== "live"}
                    className={`inline-flex touch-none select-none items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      call.pttActive
                        ? "border-[#c63a22] bg-[#c63a22] text-white"
                        : "border-[#e4e1dd] bg-white text-[#1f1f1f] hover:bg-[#faf9f7]"
                    }`}
                    title="Push-to-talk fallback: hold while you speak"
                  >
                    <Radio className={`h-4 w-4 ${call.pttActive ? "animate-pulse" : ""}`} />
                    {call.pttActive ? "Release to send" : "Hold to talk"}
                  </button>

                  <label className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-xl border border-[#e4e1dd] bg-white px-3 py-2.5 text-xs font-medium text-[#4c4c4c]">
                    <input
                      type="checkbox"
                      checked={call.bargeIn}
                      onChange={(event) => call.setBargeIn(event.target.checked)}
                      disabled={!inCall}
                      className="h-4 w-4 accent-[#c63a22]"
                    />
                    Barge-in
                  </label>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-[#8a8a8a]">
                  <span className="inline-flex items-center gap-1">
                    <Waves className="h-3 w-3" />
                    Hands-free VAD segments your speech automatically
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Radio className="h-3 w-3" />
                    Hold-to-talk works when VAD misses quiet speech
                  </span>
                </div>

                <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-[#ececec] bg-[#faf9f7] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 text-xs text-[#4c4c4c]">
                    <Info className="h-3.5 w-3.5 text-[#c63a22]" />
                    <span>{call.status}</span>
                  </div>
                  <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-[11px] font-medium text-[#6e6e6e]">
                    <input
                      type="checkbox"
                      checked={demoMode}
                      onChange={(event) => setDemoMode(event.target.checked)}
                      disabled={inCall}
                      className="h-3.5 w-3.5 accent-[#c63a22]"
                    />
                    Demo mode · synthetic patient
                  </label>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-[#ececec] bg-white shadow-[0_18px_40px_rgba(18,18,18,0.04)]">
              <div className="flex items-center justify-between border-b border-[#f0eeeb] px-5 py-4 sm:px-6">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-[#c63a22]" />
                  <h2 className="text-sm font-semibold text-[#1f1f1f]">Conversation</h2>
                  <span className="rounded-full bg-[#f1eeea] px-2 py-0.5 text-[10px] font-semibold text-[#6e6e6e]">
                    {call.messages.length}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-[#9a9a9a]">
                  <LockKeyhole className="h-3 w-3" />
                  Stored locally
                </div>
              </div>

              <div
                ref={transcriptRef}
                className="max-h-[430px] min-h-[230px] space-y-4 overflow-y-auto px-5 py-5 sm:px-6"
              >
                {call.messages.length === 0 ? (
                  <div className="flex min-h-[190px] flex-col items-center justify-center text-center">
                    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#c63a22]/5 text-[#c63a22]">
                      <PhoneCall className="h-5 w-5" />
                    </div>
                    <p className="text-sm font-semibold text-[#1f1f1f]">
                      No call yet
                    </p>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-[#8a8a8a]">
                      Dial CS-0000. Aria greets you with real local speech, then
                      listens through your microphone or the text box below.
                    </p>
                  </div>
                ) : (
                  call.messages.map((entry) => (
                    <TranscriptBubble key={entry.id} entry={entry} />
                  ))
                )}
              </div>

              <form
                onSubmit={submitTyped}
                className="border-t border-[#f0eeeb] bg-[#fcfbfa] px-4 py-4 sm:px-5"
              >
                <div className="flex items-center gap-2">
                  <input
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    disabled={!inCall}
                    maxLength={600}
                    placeholder={
                      inCall
                        ? "Type instead of speaking…"
                        : "Start a call to type a message"
                    }
                    className="min-w-0 flex-1 rounded-xl border border-[#e4e1dd] bg-white px-3.5 py-2.5 text-sm text-[#1f1f1f] outline-none transition focus:border-[#c63a22] disabled:bg-[#f5f3f0] disabled:text-[#9a9a9a]"
                  />
                  <button
                    type="submit"
                    disabled={!inCall || !typed.trim()}
                    className="inline-flex items-center gap-2 rounded-xl bg-[#1f1f1f] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <MessageSquare className="h-4 w-4" />
                    Send
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-[#9a9a9a]">
                  Typed messages are spoken aloud by Aria and saved with this call.
                  Typing while she speaks interrupts her.
                </p>
              </form>
            </div>
          </div>

          <aside className="space-y-6">
            {displayPatient ? (
              <div className="rounded-3xl border border-[#ececec] bg-white p-5 shadow-[0_12px_30px_rgba(18,18,18,0.035)]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
                    <User className="h-4 w-4 text-[#c63a22]" />
                    Caller
                  </div>
                  {displayPatient.synthetic ? (
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                      synthetic
                    </span>
                  ) : null}
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#c63a22]/5 text-base font-bold text-[#c63a22]">
                    {displayPatient.display_name
                      .split(" ")
                      .map((part) => part[0])
                      .slice(0, 2)
                      .join("")}
                  </div>
                  <div>
                    <div className="text-base font-bold text-[#1f1f1f]">
                      {displayPatient.display_name}
                    </div>
                    <div className="text-xs text-[#8a8a8a]">
                      {displayPatient.extension}
                      {displayPatient.age ? ` · age ${displayPatient.age}` : ""}
                      {displayPatient.room ? ` · room ${displayPatient.room}` : ""}
                    </div>
                  </div>
                </div>
                {displayPatient.primary_concern ? (
                  <div className="mt-4 rounded-xl bg-[#faf9f7] px-3 py-2.5 text-xs leading-relaxed text-[#4c4c4c]">
                    <span className="font-semibold text-[#1f1f1f]">Demo concern: </span>
                    {displayPatient.primary_concern}
                  </div>
                ) : null}
                <p className="mt-3 text-[11px] leading-relaxed text-[#9a9a9a]">
                  This patient record is fake demonstration data. VoiceLink does not
                  connect to a hospital EHR.
                </p>
              </div>
            ) : null}

            <div className="rounded-3xl border border-[#ececec] bg-white p-5 shadow-[0_12px_30px_rgba(18,18,18,0.035)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
                  <Activity className="h-4 w-4 text-[#c63a22]" />
                  System status
                </div>
                <button
                  type="button"
                  onClick={() => void loadLiveStatus(true)}
                  disabled={refreshing}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#e4e1dd] px-2 py-1 text-[11px] font-medium text-[#6e6e6e] transition hover:bg-[#faf9f7] disabled:opacity-50"
                >
                  {refreshing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  Refresh
                </button>
              </div>

              <div className="mt-3 flex items-center justify-between rounded-xl border border-[#ececec] px-3 py-2.5">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a8a8a]">
                    Voice stack
                  </div>
                  <div className="mt-0.5 text-sm font-bold capitalize text-[#1f1f1f]">
                    {health?.status || "checking"}
                  </div>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    health?.status === "ready"
                      ? "bg-emerald-50 text-emerald-700"
                      : health?.status === "degraded"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-red-50 text-red-700"
                  }`}
                >
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-40" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
                  </span>
                  {health?.status || "unknown"}
                </span>
              </div>

              <div className="mt-3 space-y-2">
                {checkRows.map((row) => (
                  <StatusRow key={row.label} {...row} />
                ))}
              </div>

              {healthError ? (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-800">
                  {healthError}
                </div>
              ) : null}

              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-xl bg-[#faf9f7] px-3 py-2">
                  <div className="text-[#8a8a8a]">Active calls</div>
                  <div className="mt-0.5 text-sm font-semibold text-[#1f1f1f]">
                    {status ? `${status.active_calls} / ${status.max_active_calls}` : "—"}
                  </div>
                </div>
                <div className="rounded-xl bg-[#faf9f7] px-3 py-2">
                  <div className="text-[#8a8a8a]">Uptime</div>
                  <div className="mt-0.5 text-sm font-semibold text-[#1f1f1f]">
                    {status ? formatDuration(status.uptime_s) : "—"}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#ececec] px-3 py-2.5 text-[11px] leading-relaxed text-[#6e6e6e]">
                <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#c63a22]" />
                <span>
                  {status?.models?.llm?.name || "Local model"} ·{" "}
                  {status?.models?.stt?.name || "local STT"} ·{" "}
                  {status?.models?.tts?.name || "local TTS"}. All inference stays on
                  this machine.
                </span>
              </div>
            </div>

            <div className="rounded-3xl border border-[#ececec] bg-white p-5 shadow-[0_12px_30px_rgba(18,18,18,0.035)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
                  <Clock3 className="h-4 w-4 text-[#c63a22]" />
                  Last turn
                </div>
                <span className="text-[10px] uppercase tracking-[0.12em] text-[#9a9a9a]">
                  measured
                </span>
              </div>
              <div className="mt-3">
                <MetricGrid metrics={call.metrics} />
              </div>
            </div>

            <div id="phone" className="scroll-mt-24">
              <PhoneCard
                phoneUrl={historyPhoneUrl}
                caUrl={caUrl}
                qrDataUrl={qrDataUrl}
              />
            </div>

            <div className="rounded-3xl border border-[#ececec] bg-white p-5 shadow-[0_12px_30px_rgba(18,18,18,0.035)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#1f1f1f]">
                  <History className="h-4 w-4 text-[#c63a22]" />
                  Local call history
                </div>
                {history.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void clearHistory()}
                    className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] font-medium text-[#9a9a9a] transition hover:bg-red-50 hover:text-red-700"
                    title="Delete all local call history"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear
                  </button>
                ) : null}
              </div>

              <div className="mt-3 space-y-2">
                {history.length === 0 ? (
                  <p className="rounded-xl bg-[#faf9f7] px-3 py-3 text-xs leading-relaxed text-[#8a8a8a]">
                    Completed calls appear here from the local SQLite database.
                  </p>
                ) : (
                  history.map((item) => {
                    const open = historyOpen === item.id;
                    return (
                      <div
                        key={item.id}
                        className="overflow-hidden rounded-xl border border-[#ececec]"
                      >
                        <button
                          type="button"
                          onClick={() => void openHistory(item.id)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition hover:bg-[#faf9f7]"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold text-[#1f1f1f]">
                              {item.patient_name || item.caller_extension}
                              <span className="ml-2 font-mono font-normal text-[#9a9a9a]">
                                {item.id}
                              </span>
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[#9a9a9a]">
                              <span>{formatCallTime(item.started_at)}</span>
                              <span>·</span>
                              <span>{item.turns} turns</span>
                              <span>·</span>
                              <span>{formatDuration((item.duration_ms || 0) / 1000)}</span>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                                HISTORY_STATUS[item.status] || "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {item.status}
                            </span>
                            <ChevronDown
                              className={`h-3.5 w-3.5 text-[#9a9a9a] transition-transform ${
                                open ? "rotate-180" : ""
                              }`}
                            />
                          </div>
                        </button>
                        {open ? (
                          <div className="border-t border-[#f0eeeb] bg-[#fcfbfa] px-3 py-3">
                            {historyLoading ? (
                              <div className="flex items-center gap-2 text-[11px] text-[#8a8a8a]">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Loading local transcript…
                              </div>
                            ) : historyDetail && historyDetail.id === item.id ? (
                              <div className="space-y-2">
                                {historyDetail.transcripts.length === 0 ? (
                                  <p className="text-[11px] text-[#8a8a8a]">
                                    No transcript rows stored for this call.
                                  </p>
                                ) : (
                                  historyDetail.transcripts.map((row, index) => (
                                    <div
                                      key={`${row.created_at}-${index}`}
                                      className="rounded-lg bg-white px-2.5 py-2 text-[11px] leading-relaxed text-[#4c4c4c]"
                                    >
                                      <span className="mr-1.5 font-semibold uppercase tracking-wide text-[#9a9a9a]">
                                        {row.role === "assistant" ? "Aria" : "Caller"}
                                      </span>
                                      {row.text}
                                    </div>
                                  ))
                                )}
                              </div>
                            ) : (
                              <p className="text-[11px] text-[#8a8a8a]">
                                Could not load this local record.
                              </p>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-[#ececec] bg-[#1f1f1f] p-5 text-white shadow-[0_12px_30px_rgba(18,18,18,0.12)]">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4 text-[#f3a58a]" />
                What this is — and is not
              </div>
              <ul className="mt-3 space-y-2 text-[11px] leading-relaxed text-white/65">
                <li className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                  Real microphone, real local STT, LLM, TTS, and real network audio.
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                  Browser calling on your own Wi-Fi through a local HTTPS gateway.
                </li>
                <li className="flex gap-2">
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                  It is not a public phone number, PSTN line, or emergency service.
                </li>
                <li className="flex gap-2">
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                  It is not a medical device and must not be used for diagnosis.
                </li>
              </ul>
            </div>
          </aside>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3 text-[11px] text-[#9a9a9a]">
          <span className="inline-flex items-center gap-1">
            <Ear className="h-3 w-3" /> 16 kHz mono capture
          </span>
          <span className="inline-flex items-center gap-1">
            <Brain className="h-3 w-3" /> local model
          </span>
          <span className="inline-flex items-center gap-1">
            <Database className="h-3 w-3" /> SQLite on this PC
          </span>
          <span className="inline-flex items-center gap-1">
            <Wifi className="h-3 w-3" /> LAN only
          </span>
          <span className="inline-flex items-center gap-1">
            <LockKeyhole className="h-3 w-3" /> no cloud keys
          </span>
        </div>
      </div>
    </div>
  );
}
