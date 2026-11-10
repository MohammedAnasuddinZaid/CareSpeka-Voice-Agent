/**
 * Browser-hosted AI for the Web Voice Call — Demo.
 *
 * The nurse's browser is the AI host: it captures the patient's WebRTC audio,
 * runs voice-activity detection, optionally transcribes with Whisper and reasons
 * with WebLLM (both loaded lazily from a CDN, opt-in, never auto-downloaded),
 * and speaks the reply.
 *
 * Everything here is defensive: if a model is missing, slow, or unsupported the
 * caller falls back to the server care engine and clear labels, never silently
 * to a paid API.
 */

export type AiStage = "idle" | "loading" | "ready" | "error" | "unsupported";

export interface AiStatus {
  asr: AiStage;
  llm: AiStage;
  vad: AiStage;
  tts: AiStage;
  detail?: string;
  progress?: number;
  webgpu: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamicImport = (url: string): Promise<any> => {
  const fn = new Function("u", "return import(u)");
  return fn(url);
};

export function webgpuAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as unknown as { gpu?: unknown }).gpu);
}

// ---------------------------------------------------------------------------
// speech capture + energy VAD (static worklet, resamples to 16 kHz mono float)
// ---------------------------------------------------------------------------

const CAPTURE_WORKLET_URL = "/worklets/care-capture.js";

export interface SpeechCaptureOptions {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array, durationMs: number) => void;
  threshold?: number;
  silenceMs?: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
}

/** Captures a MediaStream and emits complete utterances (16 kHz mono float). */
export class SpeechCapture {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private speaking = false;
  private running = false;

  constructor(private opts: SpeechCaptureOptions = {}) {}

  async start(stream: MediaStream): Promise<void> {
    if (this.running) return;
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    await this.ctx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, "care-capture", { processorOptions: { targetRate: 16000 } });
    this.node.port.onmessage = (e) => this.onFrame(new Float32Array(e.data as ArrayBuffer));
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.running = true;
  }

  private onFrame(frame: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const frameMs = (frame.length / 16000) * 1000;
    const threshold = this.opts.threshold ?? 0.012;

    if (rms >= threshold) {
      if (!this.speaking) {
        this.speaking = true;
        this.opts.onSpeechStart?.();
      }
      this.speechMs += frameMs;
      this.silenceMs = 0;
      this.chunks.push(frame);
    } else if (this.speaking) {
      this.chunks.push(frame);
      this.silenceMs += frameMs;
      if (this.silenceMs >= (this.opts.silenceMs ?? 700)) {
        this.flush();
      }
    }

    if (this.speaking && this.speechMs >= (this.opts.maxUtteranceMs ?? 15000)) {
      this.flush();
    }
  }

  private flush(): void {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const audio = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      audio.set(c, offset);
      offset += c.length;
    }
    const durationMs = (total / 16000) * 1000;
    const enough = this.speechMs >= (this.opts.minSpeechMs ?? 250);
    this.chunks = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.speaking = false;
    this.opts.onSpeechEnd?.(audio, durationMs);
    void enough; // durationMs is the authoritative speech length
  }

  setActive(active: boolean): void {
    this.node?.port.postMessage({ type: "active", value: active });
    if (!active) {
      this.chunks = [];
      this.speechMs = 0;
      this.silenceMs = 0;
      this.speaking = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      this.node?.disconnect();
      this.source?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* ignore */
    }
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.node = null;
    this.source = null;
    this.sink = null;
  }
}

// ---------------------------------------------------------------------------
// ASR — Transformers.js Whisper (opt-in)
// ---------------------------------------------------------------------------

export class Transcriber {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private transcriber: any = null;
  status: AiStage = "idle";
  onProgress?: (p: number, detail: string) => void;

  async load(model = "Xenova/whisper-tiny.en"): Promise<void> {
    if (this.transcriber) return;
    this.status = "loading";
    try {
      const mod = await dynamicImport("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.1/+esm");
      mod.env.allowLocalModels = false;
      const device = webgpuAvailable() ? "webgpu" : "wasm";
      this.transcriber = await mod.pipeline("automatic-speech-recognition", model, {
        device,
        progress_callback: (info: { status?: string; progress?: number; file?: string }) => {
          if (info?.status === "progress" && typeof info.progress === "number") {
            this.onProgress?.(info.progress, info.file || model);
          }
        },
      });
      this.status = "ready";
    } catch (err) {
      this.status = "error";
      throw err;
    }
  }

  async transcribe(audio: Float32Array): Promise<{ text: string; engine: string }> {
    if (!this.transcriber) throw new Error("Whisper is not loaded.");
    const result = await this.transcriber(audio, { language: "en", task: "transcribe" });
    const text = String(result?.text ?? "").trim();
    return { text, engine: "whisper (on-device, Transformers.js)" };
  }
}

// ---------------------------------------------------------------------------
// LLM — WebLLM (opt-in, WebGPU)
// ---------------------------------------------------------------------------

export class CareLLM {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private engine: any = null;
  status: AiStage = "idle";
  onProgress?: (p: number, detail: string) => void;

  async load(model = "Llama-3.2-1B-Instruct-q4f16_1-MLC"): Promise<void> {
    if (this.engine) return;
    if (!webgpuAvailable()) {
      this.status = "unsupported";
      throw new Error("WebGPU is not available in this browser; using the server care engine instead.");
    }
    this.status = "loading";
    try {
      const webllm = await dynamicImport("https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm");
      this.engine = await webllm.CreateMLCEngine(model, {
        initProgressCallback: (r: { progress?: number; text?: string }) =>
          this.onProgress?.(r?.progress ?? 0, r?.text || model),
      });
      this.status = "ready";
    } catch (err) {
      this.status = "error";
      throw err;
    }
  }

  async chat(system: string, history: Array<{ role: "user" | "assistant"; content: string }>, userText: string): Promise<string> {
    if (!this.engine) throw new Error("WebLLM is not loaded.");
    const messages = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ];
    const reply = await this.engine.chat.completions.create({ messages, temperature: 0.3, max_tokens: 220 });
    return String(reply?.choices?.[0]?.message?.content ?? "").trim();
  }
}

// ---------------------------------------------------------------------------
// TTS — browser speech synthesis (labelled). Neural TTS can be plugged in.
// ---------------------------------------------------------------------------

export function speechSynthesisAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

const PREFERRED_VOICES = [
  "Google UK English Female",
  "Microsoft Zira Desktop - English (United States)",
  "Microsoft Zira - English (United States)",
  "Samantha",
  "Karen",
  "Moira",
  "Tessa",
  "Fiona",
];

function pickVoice(): SpeechSynthesisVoice | null {
  if (!speechSynthesisAvailable()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  for (const name of PREFERRED_VOICES) {
    const match = voices.find((v) => v.name === name);
    if (match) return match;
  }
  return (
    voices.find((v) => /^en[-_]/i.test(v.lang) && /female|woman/i.test(v.name)) ||
    voices.find((v) => /^en[-_]/i.test(v.lang)) ||
    voices[0] ||
    null
  );
}

function voiceByLanguage(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return (
    voices.find((v) => /^en[-_]GB/i.test(v.lang) && /female|woman|natural|google/i.test(v.name)) ||
    voices.find((v) => /^en[-_]GB/i.test(v.lang)) ||
    voices.find((v) => /^en[-_]/i.test(v.lang)) ||
    voices[0] ||
    null
  );
}

/** Splits a long answer into utterance-sized sentences for steady playback. */
function speechChunks(text: string, max = 180): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = sentence.trim();
    if (!next) continue;
    if (current && current.length + next.length + 1 > max) {
      chunks.push(current);
      current = next;
    } else {
      current = current ? `${current} ${next}` : next;
    }
    // A single monster sentence is split on commas or hard slices.
    while (current.length > max) {
      const breakAt = Math.max(current.lastIndexOf(", ", max), current.lastIndexOf("; ", max));
      const at = breakAt > max * 0.5 ? breakAt + 1 : max;
      chunks.push(current.slice(0, at).trim());
      current = current.slice(at).trim();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function speak(
  text: string,
  opts: { onStart?: () => void; onEnd?: () => void; voiceName?: string } = {}
): () => void {
  if (!speechSynthesisAvailable() || !text.trim()) {
    opts.onEnd?.();
    return () => undefined;
  }

  let cancelled = false;
  let started = false;
  let runOnce = false;
  let watchdog: number | null = null;

  const chunks = speechChunks(text);
  const voice = (() => {
    const voices = window.speechSynthesis.getVoices();
    if (opts.voiceName) return voices.find((v) => v.name === opts.voiceName) ?? pickVoice();
    return pickVoice() ?? voiceByLanguage(voices);
  })();

  const finish = () => {
    if (watchdog != null) window.clearTimeout(watchdog);
    watchdog = null;
    if (!cancelled) opts.onEnd?.();
  };

  const speakAt = (index: number) => {
    if (cancelled) return;
    if (index >= chunks.length) {
      finish();
      return;
    }
    try {
      window.speechSynthesis.resume();
    } catch {
      /* ignore */
    }
    const utter = new SpeechSynthesisUtterance(chunks[index]);
    const activeVoice = voice ?? pickVoice() ?? voiceByLanguage(window.speechSynthesis.getVoices());
    utter.lang = activeVoice?.lang || "en-GB";
    utter.rate = 0.94;
    utter.pitch = 1.0;
    utter.volume = 1.0;
    if (activeVoice) utter.voice = activeVoice;
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      if (watchdog != null) window.clearTimeout(watchdog);
      watchdog = null;
      speakAt(index + 1);
    };
    utter.onstart = () => {
      if (!started) {
        started = true;
        opts.onStart?.();
      }
      // Chrome sometimes stays paused after a long utterance, and a voice can
      // stall without firing end/error at all. Resume early; if the chunk is
      // still stuck well past its expected duration, move to the next one so a
      // call is never left waiting on silent synthesis.
      if (watchdog != null) window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
        advance();
      }, Math.max(12_000, chunks[index].length * 130 + 6_000));
    };
    utter.onend = advance;
    utter.onerror = advance;
    window.speechSynthesis.speak(utter);
  };

  const run = () => {
    if (cancelled || runOnce) return;
    runOnce = true;
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      // A short gap lets the engine finish cancelling any previous utterance.
      window.setTimeout(() => speakAt(0), 45);
    } catch {
      finish();
    }
  };

  // Some browsers (notably Chrome) populate the voice list asynchronously and
  // need a short delay after cancel() before a new utterance will play.
  if (window.speechSynthesis.getVoices().length === 0) {
    const onVoices = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", onVoices);
      window.setTimeout(run, 60);
    };
    window.speechSynthesis.addEventListener("voiceschanged", onVoices);
    window.setTimeout(() => {
      window.speechSynthesis.removeEventListener("voiceschanged", onVoices);
      run();
    }, 250);
  } else {
    window.setTimeout(run, 40);
  }

  return () => {
    cancelled = true;
    if (watchdog != null) window.clearTimeout(watchdog);
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  };
}

export function stopSpeaking(): void {
  if (speechSynthesisAvailable()) window.speechSynthesis.cancel();
}

// ---------------------------------------------------------------------------
// system prompt shared with the on-device LLM
// ---------------------------------------------------------------------------

export function careSystemPrompt(patient: {
  displayName: string;
  age: number | null;
  conditions: Array<{ name: string }>;
  medications: Array<{ name: string; dose?: string }>;
  allergies: Array<{ substance: string }>;
  carePlan?: string;
}): string {
  return [
    "You are CareSpeak, a cautious healthcare care-coordination assistant speaking on a voice call.",
    "You are NOT a doctor. Never diagnose, never prescribe, never invent vital signs or history.",
    "Use only the patient context below. Ask short, clear follow-up questions, one or two at a time.",
    "Be warm and plain-spoken. Keep replies under 60 words because they are spoken aloud.",
    "If the patient reports a red-flag symptom (chest pain, breathlessness at rest, fainting, severe bleeding, new confusion, or thoughts of self-harm), tell them their care team is being alerted and advise contacting emergency services if they worsen.",
    "",
    `Patient: ${patient.displayName}, age ${patient.age ?? "unknown"}.`,
    `Active conditions: ${patient.conditions.map((c) => c.name).join(", ") || "none recorded"}.`,
    `Medications: ${patient.medications.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ""}`).join(", ") || "none recorded"}.`,
    `Allergies: ${patient.allergies.map((a) => a.substance).join(", ") || "none recorded"}.`,
    patient.carePlan ? `Care plan: ${patient.carePlan}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
