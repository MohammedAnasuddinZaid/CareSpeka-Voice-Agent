"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceCallState =
  | "IDLE"
  | "DIALING"
  | "CONNECTING"
  | "CONNECTED"
  | "LISTENING"
  | "PROCESSING"
  | "SPEAKING"
  | "ENDED"
  | "ERROR";

export type CallerPatient = {
  extension: string;
  display_name: string;
  age?: number;
  room?: string;
  primary_concern?: string;
  notes?: string;
  synthetic?: boolean;
};

export type VoiceSession = {
  call_id: string;
  caller: string;
  callee: string;
  callee_name: string;
  patient: CallerPatient | null;
  demo_mode: boolean;
  limits?: { max_turns?: number; max_minutes?: number };
  capabilities?: {
    vad?: boolean;
    push_to_talk?: boolean;
    text_fallback?: boolean;
    barge_in?: boolean;
  };
};

export type TranscriptEntry = {
  id: string;
  turnId?: string;
  role: "assistant" | "user";
  text: string;
  at: number;
  streaming?: boolean;
  greeting?: boolean;
};

export type TurnMetrics = {
  turn_id?: string;
  input?: string;
  asr_ms?: number | null;
  llm_first_token_ms?: number | null;
  llm_total_ms?: number | null;
  tts_first_ms?: number | null;
  tts_total_ms?: number | null;
  tts_sentences?: number;
  e2e_first_audio_ms?: number | null;
  interrupted?: boolean;
  interrupt_reason?: string;
};

type ServerEvent = {
  type: string;
  state?: string;
  call_id?: string;
  turn_id?: string;
  role?: "assistant" | "user";
  text?: string;
  seq?: number;
  mime?: string;
  data_b64?: string;
  duration_ms?: number;
  message?: string;
  code?: string;
  fatal?: boolean;
  reason?: string;
  greeting?: boolean;
  barge_in?: boolean;
  muted?: boolean;
  event?: string;
  source?: string;
  metrics?: TurnMetrics;
  patient?: CallerPatient;
  callee_name?: string;
  caller?: string;
  callee?: string;
  demo_mode?: boolean;
  limits?: VoiceSession["limits"];
  capabilities?: VoiceSession["capabilities"];
  interrupted?: boolean;
  final?: boolean;
};

type AudioChunk = {
  turnId: string;
  seq: number;
  data: string;
  mime: string;
};

type Options = {
  caller: string;
  callee: string;
  demoMode: boolean;
  onCallEnded?: (callId: string) => void;
};

type OptionsRef = Options;

const TARGET_RATE = 16000;
const VALID_STATES: VoiceCallState[] = [
  "IDLE",
  "DIALING",
  "CONNECTING",
  "CONNECTED",
  "LISTENING",
  "PROCESSING",
  "SPEAKING",
  "ENDED",
  "ERROR",
];

function backendBase(): string {
  const override = process.env.NEXT_PUBLIC_VOICELINK_BACKEND;
  if (override) return override.replace(/\/$/, "");
  if (typeof window === "undefined") return "http://127.0.0.1:8000";
  if (window.location.port === "3443") return window.location.origin;
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

function websocketUrl(): string {
  return `${backendBase().replace(/^http/, "ws")}/ws/voicelink`;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function downmixToPcm16(input: Float32Array, sourceRate: number): Int16Array {
  if (sourceRate === TARGET_RATE) {
    const direct = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const value = Math.max(-1, Math.min(1, input[index]));
      direct[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    return direct;
  }
  const outputLength = Math.max(
    1,
    Math.floor((input.length * TARGET_RATE) / sourceRate),
  );
  const output = new Int16Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = (index * sourceRate) / TARGET_RATE;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, input.length - 1);
    const fraction = position - lower;
    const value = Math.max(
      -1,
      Math.min(1, input[lower] * (1 - fraction) + input[upper] * fraction),
    );
    output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return output;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function useVoiceCall(options: Options) {
  const optionsRef = useRef<OptionsRef>(options);
  optionsRef.current = options;

  const [state, setState] = useState<VoiceCallState>("IDLE");
  const [connection, setConnection] = useState<
    "disconnected" | "connecting" | "open"
  >("disconnected");
  const [session, setSession] = useState<VoiceSession | null>(null);
  const [messages, setMessages] = useState<TranscriptEntry[]>([]);
  const [status, setStatus] = useState("Ready for a local call.");
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [micStatus, setMicStatus] = useState<
    "off" | "requesting" | "live" | "denied"
  >("off");
  const [muted, setMuted] = useState(false);
  const [bargeIn, setBargeInState] = useState(true);
  const [pttActive, setPttActive] = useState(false);
  const [agentAudioPlaying, setAgentAudioPlaying] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<VoiceCallState>("IDLE");
  const mutedRef = useRef(false);
  const bargeInRef = useRef(true);
  const pttActiveRef = useRef(false);
  const sessionRef = useRef<VoiceSession | null>(null);
  const startingRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const intentionalEndRef = useRef(false);
  const endTimerRef = useRef<number | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const micSinkRef = useRef<GainNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const queueRef = useRef<AudioChunk[]>([]);
  const playingRef = useRef(false);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const playbackGenerationRef = useRef(0);
  const lastSeqByTurnRef = useRef<Record<string, number>>({});
  const playedSeqByTurnRef = useRef<Record<string, number>>({});
  const closedTurnsRef = useRef<Set<string>>(new Set());
  const doneSentRef = useRef<Set<string>>(new Set());

  const changeState = useCallback((next: VoiceCallState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    if (startedAtRef.current === null) return;
    const timer = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setDurationSeconds(
          Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)),
        );
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [session?.call_id]);

  const sendJson = useCallback((payload: Record<string, unknown>): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const maybeAcknowledgePlayback = useCallback((turnId: string) => {
    if (!closedTurnsRef.current.has(turnId)) return;
    if (playingRef.current || queueRef.current.length > 0) return;
    const last = lastSeqByTurnRef.current[turnId] ?? 0;
    const played = playedSeqByTurnRef.current[turnId] ?? 0;
    if (last > 0 && played >= last && !doneSentRef.current.has(turnId)) {
      doneSentRef.current.add(turnId);
      sendJson({ type: "playback_done", seq: last });
    }
  }, [sendJson]);

  const stopPlayback = useCallback(() => {
    playbackGenerationRef.current += 1;
    queueRef.current = [];
    sourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    });
    sourcesRef.current.clear();
    playingRef.current = false;
    setAgentAudioPlaying(false);
  }, []);

  const playQueue = useCallback(async () => {
    const context = audioContextRef.current;
    if (!context || playingRef.current) return;
    playingRef.current = true;
    const generation = playbackGenerationRef.current;

    while (queueRef.current.length > 0) {
      if (generation !== playbackGenerationRef.current) break;
      const item = queueRef.current.shift();
      if (!item) break;
      try {
        const buffer = await context.decodeAudioData(decodeBase64(item.data));
        if (generation !== playbackGenerationRef.current) break;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(outputGainRef.current ?? context.destination);
        sourcesRef.current.add(source);
        setAgentAudioPlaying(true);
        await new Promise<void>((resolve) => {
          source.onended = () => {
            sourcesRef.current.delete(source);
            playedSeqByTurnRef.current[item.turnId] = Math.max(
              playedSeqByTurnRef.current[item.turnId] ?? 0,
              item.seq,
            );
            resolve();
          };
          source.start();
        });
        if (generation !== playbackGenerationRef.current) break;
        maybeAcknowledgePlayback(item.turnId);
      } catch {
        setError(
          "The browser could not decode the agent audio. Check that this device allows audio playback.",
        );
        break;
      }
    }

    if (generation === playbackGenerationRef.current) {
      playingRef.current = false;
      setAgentAudioPlaying(false);
      Object.keys(lastSeqByTurnRef.current).forEach((turnId) => {
        maybeAcknowledgePlayback(turnId);
      });
    }
  }, [maybeAcknowledgePlayback]);

  const ensureAudioContext = useCallback(async (): Promise<AudioContext> => {
    let context = audioContextRef.current;
    if (!context || context.state === "closed") {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      context = new AudioContextCtor();
      audioContextRef.current = context;

      const outputGain = context.createGain();
      outputGain.gain.value = 1;
      const outputAnalyser = context.createAnalyser();
      outputAnalyser.fftSize = 1024;
      outputAnalyser.smoothingTimeConstant = 0.72;
      outputGain.connect(outputAnalyser);
      outputAnalyser.connect(context.destination);
      outputGainRef.current = outputGain;
      outputAnalyserRef.current = outputAnalyser;

      const micSink = context.createGain();
      micSink.gain.value = 0;
      micSink.connect(context.destination);
      micSinkRef.current = micSink;

      // Unlock playback for browsers that require a gesture before audio.
      const unlock = context.createBufferSource();
      unlock.buffer = context.createBuffer(1, 1, context.sampleRate);
      unlock.connect(context.destination);
      unlock.start();
    }
    if (context.state === "suspended") {
      await context.resume();
    }
    return context;
  }, []);

  const shouldStreamAudio = useCallback((): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (mutedRef.current && !pttActiveRef.current) return false;
    if (pttActiveRef.current) return true;
    const current = stateRef.current;
    if (current === "LISTENING" || current === "CONNECTED") return true;
    if (current === "SPEAKING" && bargeInRef.current) return true;
    return false;
  }, []);

  const attachCapture = useCallback(async (stream: MediaStream) => {
    const context = await ensureAudioContext();
    const source = context.createMediaStreamSource(stream);
    micSourceRef.current = source;

    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    micAnalyserRef.current = analyser;
    source.connect(analyser);
    if (micSinkRef.current) analyser.connect(micSinkRef.current);

    const sendFrame = (pcm: Int16Array) => {
      if (!shouldStreamAudio()) return;
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(pcm.buffer);
    };

    try {
      await context.audioWorklet.addModule("/worklets/voicelink-capture.js");
      const node = new AudioWorkletNode(context, "voicelink-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate: TARGET_RATE },
      });
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (event.data instanceof ArrayBuffer) {
          sendFrame(new Int16Array(event.data));
        }
      };
      source.connect(node);
      if (micSinkRef.current) node.connect(micSinkRef.current);
      workletRef.current = node;
    } catch {
      // Safari and older browsers: ScriptProcessor fallback.
      const processor = context.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        event.outputBuffer.getChannelData(0).fill(0);
        if (!shouldStreamAudio()) return;
        sendFrame(downmixToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate));
      };
      source.connect(processor);
      if (micSinkRef.current) processor.connect(micSinkRef.current);
      processorRef.current = processor;
    }
  }, [ensureAudioContext, shouldStreamAudio]);

  const startMicrophone = useCallback(async (): Promise<boolean> => {
    if (micStreamRef.current) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatus("denied");
      setError("This browser does not expose microphone capture.");
      return false;
    }
    setMicStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      micStreamRef.current = stream;
      await attachCapture(stream);
      setMicStatus("live");
      return true;
    } catch (exc) {
      setMicStatus("denied");
      setError(
        exc instanceof Error
          ? `Microphone access failed: ${exc.message}. Typed messages still work.`
          : "Microphone access was denied. Typed messages still work.",
      );
      return false;
    }
  }, [attachCapture]);

  const cleanupMedia = useCallback(() => {
    pttActiveRef.current = false;
    setPttActive(false);
    stopPlayback();
    workletRef.current?.disconnect();
    workletRef.current?.port.close();
    workletRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    micAnalyserRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    outputGainRef.current?.disconnect();
    outputGainRef.current = null;
    outputAnalyserRef.current = null;
    micSinkRef.current?.disconnect();
    micSinkRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close().catch(() => undefined);
    }
    audioContextRef.current = null;
    setMicStatus("off");
    setAgentAudioPlaying(false);
  }, [stopPlayback]);

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close();
      } catch {
        // Ignore close races.
      }
    }
    setConnection("disconnected");
  }, []);

  const resetTurnBookkeeping = useCallback(() => {
    queueRef.current = [];
    sourcesRef.current.clear();
    lastSeqByTurnRef.current = {};
    playedSeqByTurnRef.current = {};
    closedTurnsRef.current.clear();
    doneSentRef.current.clear();
    playingRef.current = false;
  }, []);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "hello": {
          setStatus("Local line ready.");
          break;
        }
        case "call_started": {
          const nextSession: VoiceSession = {
            call_id: event.call_id || "",
            caller: event.caller || optionsRef.current.caller,
            callee: event.callee || optionsRef.current.callee,
            callee_name: event.callee_name || "Aria",
            patient: event.patient ?? null,
            demo_mode: Boolean(event.demo_mode),
            limits: event.limits,
            capabilities: event.capabilities,
          };
          sessionRef.current = nextSession;
          setSession(nextSession);
          startedAtRef.current = Date.now();
          setDurationSeconds(0);
          setMessages([]);
          setMetrics(null);
          setError(null);
          changeState("CONNECTED");
          setStatus(
            nextSession.patient
              ? `Connected to ${nextSession.patient.display_name}'s local line.`
              : "Connected to the local VoiceLink line.",
          );
          break;
        }
        case "state": {
          if (event.state && VALID_STATES.includes(event.state as VoiceCallState)) {
            changeState(event.state as VoiceCallState);
            if (event.state === "PROCESSING") {
              setStatus("Thinking locally on this computer...");
            } else if (event.state === "LISTENING") {
              setStatus(
                pttActiveRef.current
                  ? "Recording. Release to send."
                  : "Listening. Speak naturally.",
              );
            } else if (event.state === "SPEAKING") {
              setStatus("Aria is speaking. You can interrupt.");
            }
          }
          break;
        }
        case "assistant": {
          const turnId = event.turn_id || newId("greeting");
          setMessages((current) => {
            if (current.some((item) => item.turnId === turnId)) return current;
            return [
              ...current,
              {
                id: turnId,
                turnId,
                role: "assistant",
                text: event.text || "",
                at: Date.now(),
                greeting: Boolean(event.greeting),
              },
            ];
          });
          break;
        }
        case "transcript": {
          const text = (event.text || "").trim();
          if (event.role === "user" && text) {
            const turnId = event.turn_id || newId("user");
            setMessages((current) => {
              if (current.some((item) => item.turnId === turnId && item.role === "user")) {
                return current;
              }
              return [
                ...current,
                {
                  id: `user-${turnId}`,
                  turnId,
                  role: "user",
                  text,
                  at: Date.now(),
                },
              ];
            });
            setStatus("Heard you. Preparing a reply.");
          }
          break;
        }
        case "assistant_start": {
          const turnId = event.turn_id || newId("turn");
          setMessages((current) => {
            if (current.some((item) => item.turnId === turnId)) return current;
            return [
              ...current,
              {
                id: turnId,
                turnId,
                role: "assistant",
                text: "",
                at: Date.now(),
                streaming: true,
              },
            ];
          });
          break;
        }
        case "assistant_delta": {
          const turnId = event.turn_id || "";
          setMessages((current) =>
            current.map((item) =>
              item.turnId === turnId && item.role === "assistant"
                ? { ...item, text: item.text + (event.text || "") }
                : item,
            ),
          );
          break;
        }
        case "assistant_end": {
          const turnId = event.turn_id || "";
          setMessages((current) =>
            current.map((item) =>
              item.turnId === turnId && item.role === "assistant"
                ? {
                    ...item,
                    text: event.text || item.text,
                    streaming: false,
                    greeting: Boolean(event.greeting) || item.greeting,
                  }
                : item,
            ),
          );
          if (event.metrics && Object.keys(event.metrics).length > 0) {
            setMetrics(event.metrics);
          }
          if (turnId) {
            closedTurnsRef.current.add(turnId);
            maybeAcknowledgePlayback(turnId);
          }
          if (event.interrupted) {
            setStatus("Reply interrupted. Listening again.");
          }
          break;
        }
        case "audio": {
          const turnId = event.turn_id || "";
          if (!turnId || !event.data_b64) break;
          const seq = Number(event.seq || 0);
          lastSeqByTurnRef.current[turnId] = Math.max(
            lastSeqByTurnRef.current[turnId] ?? 0,
            seq,
          );
          queueRef.current.push({
            turnId,
            seq,
            data: event.data_b64,
            mime: event.mime || "audio/wav",
          });
          void playQueue();
          break;
        }
        case "interrupted": {
          stopPlayback();
          setMessages((current) =>
            current.map((item) =>
              item.streaming ? { ...item, streaming: false } : item,
            ),
          );
          setStatus("You interrupted Aria. Listening.");
          break;
        }
        case "vad": {
          if (event.event === "speech_start") {
            setStatus(
              event.source === "ptt"
                ? "Recording. Release to send."
                : "Hearing your voice...",
            );
          } else if (event.event === "speech_end") {
            setStatus("Processing your speech locally...");
          }
          break;
        }
        case "metrics": {
          setMetrics(event as TurnMetrics);
          break;
        }
        case "config_ack": {
          if (typeof event.barge_in === "boolean") {
            bargeInRef.current = event.barge_in;
            setBargeInState(event.barge_in);
          }
          if (typeof event.muted === "boolean") {
            mutedRef.current = event.muted;
            setMuted(event.muted);
          }
          break;
        }
        case "notice": {
          if (event.message) setStatus(event.message);
          break;
        }
        case "error": {
          if (event.message) {
            setError(event.message);
            setStatus(event.message);
          }
          if (event.fatal) {
            changeState("ERROR");
            setStatus("The local line closed.");
          }
          break;
        }
        case "call_ended": {
          const endedId = event.call_id || sessionRef.current?.call_id || "";
          if (startedAtRef.current !== null) {
            setDurationSeconds(
              Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)),
            );
          }
          startedAtRef.current = null;
          changeState("ENDED");
          setStatus(
            event.reason === "caller_hangup"
              ? "Call ended. Transcript saved locally."
              : `Call ended (${event.reason || "ended"}).`,
          );
          setSession(null);
          sessionRef.current = null;
          intentionalEndRef.current = true;
          cleanupMedia();
          closeSocket();
          if (endTimerRef.current) {
            window.clearTimeout(endTimerRef.current);
            endTimerRef.current = null;
          }
          if (endedId) optionsRef.current.onCallEnded?.(endedId);
          break;
        }
        default:
          break;
      }
    },
    [
      changeState,
      cleanupMedia,
      closeSocket,
      maybeAcknowledgePlayback,
      playQueue,
      stopPlayback,
    ],
  );

  const startCall = useCallback(async () => {
    if (socketRef.current || startingRef.current) return;
    startingRef.current = true;
    setError(null);
    setStatus("Opening a private line on this computer...");
    changeState("DIALING");
    resetTurnBookkeeping();
    setConnection("connecting");
    intentionalEndRef.current = false;
    mutedRef.current = false;
    setMuted(false);

    await ensureAudioContext();
    const micReady = await startMicrophone();
    if (!micReady) {
      setStatus("Microphone unavailable. You can still type; the agent will speak.");
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(websocketUrl());
    } catch (exc) {
      startingRef.current = false;
      setError(
        exc instanceof Error
          ? `Could not open the local voice socket: ${exc.message}`
          : "Could not open the local voice socket.",
      );
      changeState("ERROR");
      setConnection("disconnected");
      return;
    }
    startingRef.current = false;
    socketRef.current = socket;
    socket.onopen = () => {
      setConnection("open");
      socket.send(
        JSON.stringify({
          type: "start_call",
          caller: optionsRef.current.caller,
          callee: optionsRef.current.callee,
          demo_mode: optionsRef.current.demoMode,
        }),
      );
    };
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") return;
      try {
        handleEvent(JSON.parse(message.data) as ServerEvent);
      } catch {
        setError("Received an unreadable message from the local voice service.");
      }
    };
    socket.onerror = () => {
      setError(
        "Could not reach the local VoiceLink service. Start the local stack with start.ps1 and retry.",
      );
      setStatus("Connection failed.");
      setConnection("disconnected");
      changeState("ERROR");
    };
    socket.onclose = () => {
      setConnection("disconnected");
      socketRef.current = null;
      if (!intentionalEndRef.current) {
        cleanupMedia();
        if (stateRef.current !== "ENDED") changeState("ERROR");
        setStatus("The local voice service disconnected.");
      }
    };
  }, [
    changeState,
    cleanupMedia,
    ensureAudioContext,
    handleEvent,
    resetTurnBookkeeping,
    startMicrophone,
  ]);

  const endCall = useCallback(() => {
    setStatus("Ending the call...");
    intentionalEndRef.current = true;
    if (!sendJson({ type: "end_call" })) {
      cleanupMedia();
      closeSocket();
      changeState("ENDED");
      setSession(null);
      sessionRef.current = null;
      return;
    }
    if (endTimerRef.current) window.clearTimeout(endTimerRef.current);
    endTimerRef.current = window.setTimeout(() => {
      cleanupMedia();
      closeSocket();
      changeState("ENDED");
      setSession(null);
      sessionRef.current = null;
    }, 6000);
  }, [changeState, cleanupMedia, closeSocket, sendJson]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    sendJson({ type: "config", muted: next });
    setStatus(next ? "Microphone muted for this call." : "Microphone unmuted.");
  }, [sendJson]);

  const setBargeIn = useCallback(
    (next: boolean) => {
      bargeInRef.current = next;
      setBargeInState(next);
      sendJson({ type: "config", barge_in: next });
      setStatus(
        next
          ? "Barge-in on. Speaking while Aria talks will interrupt her."
          : "Barge-in off. Aria finishes before listening.",
      );
    },
    [sendJson],
  );

  const startPtt = useCallback(async () => {
    if (!sessionRef.current) return;
    if (!micStreamRef.current) {
      const ready = await startMicrophone();
      if (!ready) return;
    }
    pttActiveRef.current = true;
    setPttActive(true);
    sendJson({ type: "ptt_start" });
    setStatus("Recording. Release to send.");
  }, [sendJson, startMicrophone]);

  const stopPtt = useCallback(() => {
    if (!pttActiveRef.current) return;
    pttActiveRef.current = false;
    setPttActive(false);
    sendJson({ type: "ptt_stop" });
    setStatus("Processing your recorded speech locally...");
  }, [sendJson]);

  const sendText = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || !sessionRef.current) return false;
      return sendJson({ type: "text_input", text: clean });
    },
    [sendJson],
  );

  const retryMicrophone = useCallback(async () => {
    setError(null);
    const ready = await startMicrophone();
    if (ready) setStatus("Microphone ready.");
    return ready;
  }, [startMicrophone]);

  useEffect(() => {
    return () => {
      intentionalEndRef.current = true;
      if (endTimerRef.current) window.clearTimeout(endTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
      cleanupMedia();
    };
  }, [cleanupMedia]);

  return {
    state,
    connection,
    session,
    messages,
    status,
    error,
    metrics,
    durationSeconds,
    micStatus,
    muted,
    bargeIn,
    pttActive,
    agentAudioPlaying,
    micAnalyser: micAnalyserRef,
    outputAnalyser: outputAnalyserRef,
    startCall,
    endCall,
    toggleMute,
    setBargeIn,
    startPtt,
    stopPtt,
    sendText,
    retryMicrophone,
  };
}
