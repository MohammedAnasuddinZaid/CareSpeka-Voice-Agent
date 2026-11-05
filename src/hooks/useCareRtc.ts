"use client";

/**
 * Native WebRTC + HTTP-polling signalling for the Web Voice Call — Demo.
 *
 * Media is peer-to-peer. Only SDP/ICE control messages pass through the Vercel
 * API (as short-lived records), which is what makes this survive serverless
 * cross-instance routing without a media server or WebSocket server.
 *
 * The nurse is always the offerer; the patient only answers. Adding the AI TTS
 * track later triggers a clean renegotiation from the nurse side.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { carePollSignals, careSendSignal } from "@/lib/careClient";
import type { CareSignal } from "@/lib/care/types";

export type RtcStatus = "idle" | "negotiating" | "connected" | "reconnecting" | "failed" | "closed";

export interface CareRtcOptions {
  sessionId: string;
  role: "nurse" | "patient";
  participant?: string | null;
  iceServers: RTCIceServer[];
  pollMs?: number;
  enabled: boolean;
  /** Offerer waits for this before creating the first offer. */
  start?: boolean;
  localStream?: MediaStream | null;
  onRemoteStream?: (stream: MediaStream) => void;
  onData?: (msg: Record<string, unknown>) => void;
  onStatus?: (status: RtcStatus) => void;
}

export interface CareRtcHandle {
  status: RtcStatus;
  pcState: RTCPeerConnectionState;
  iceState: RTCIceConnectionState;
  error: string | null;
  sendData: (msg: Record<string, unknown>) => void;
  addTrack: (track: MediaStreamTrack, stream?: MediaStream) => void;
  restart: () => void;
}

export function useCareRtc(opts: CareRtcOptions): CareRtcHandle {
  const { sessionId, role, participant, iceServers, pollMs = 1200, enabled } = opts;
  const [status, setStatus] = useState<RtcStatus>("idle");
  const [pcState, setPcState] = useState<RTCPeerConnectionState>("new");
  const [iceState, setIceState] = useState<RTCIceConnectionState>("new");
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const sinceRef = useRef(0);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteSetRef = useRef(false);
  const outgoingTracksRef = useRef<Set<string>>(new Set());
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const emitStatus = useCallback((s: RtcStatus) => {
    setStatus(s);
    optsRef.current.onStatus?.(s);
  }, []);

  const sendSignal = useCallback(
    async (kind: "offer" | "answer" | "ice" | "ready" | "bye", data: unknown) => {
      try {
        await careSendSignal(sessionId, kind, data, participant);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Signal send failed");
      }
    },
    [sessionId, participant]
  );

  const attachDataChannel = useCallback((dc: RTCDataChannel) => {
    dc.onmessage = (ev) => {
      try {
        optsRef.current.onData?.(JSON.parse(ev.data));
      } catch {
        /* ignore malformed */
      }
    };
    dc.onopen = () => emitStatus("connected");
  }, [emitStatus]);

  const createPc = useCallback((): RTCPeerConnection => {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: optsRef.current.iceServers });
    pcRef.current = pc;
    remoteSetRef.current = false;
    pendingIceRef.current = [];

    pc.onicecandidate = (ev) => {
      if (ev.candidate) void sendSignal("ice", ev.candidate.toJSON());
      else void sendSignal("ice", null);
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      optsRef.current.onRemoteStream?.(stream);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      setPcState(st);
      if (st === "connected") emitStatus("connected");
      else if (st === "connecting" || st === "new") emitStatus("negotiating");
      else if (st === "disconnected") emitStatus("reconnecting");
      else if (st === "failed") emitStatus("failed");
      else if (st === "closed") emitStatus("closed");
    };
    pc.oniceconnectionstatechange = () => setIceState(pc.iceConnectionState);

    if (optsRef.current.role === "nurse") {
      const dc = pc.createDataChannel("care", { ordered: true });
      dcRef.current = dc;
      attachDataChannel(dc);
    } else {
      pc.ondatachannel = (ev) => {
        dcRef.current = ev.channel;
        attachDataChannel(ev.channel);
      };
    }

    const local = optsRef.current.localStream;
    if (local) {
      for (const track of local.getTracks()) {
        if (!outgoingTracksRef.current.has(track.id)) {
          pc.addTrack(track, local);
          outgoingTracksRef.current.add(track.id);
        }
      }
    }
    return pc;
  }, [attachDataChannel, emitStatus, sendSignal]);

  const negotiate = useCallback(async () => {
    const pc = createPc();
    try {
      emitStatus("negotiating");
      const offer = await pc.createOffer({ iceRestart: false });
      await pc.setLocalDescription(offer);
      await sendSignal("offer", { type: offer.type, sdp: offer.sdp });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Offer failed");
      emitStatus("failed");
    }
  }, [createPc, emitStatus, sendSignal]);

  const drainPendingIce = useCallback(async (pc: RTCPeerConnection) => {
    const q = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const cand of q) {
      try {
        await pc.addIceCandidate(cand);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const handleSignal = useCallback(
    async (signal: CareSignal) => {
      const pc = pcRef.current ?? createPc();
      const data = signal.data as Record<string, unknown> | null;
      try {
        if (signal.kind === "offer" && optsRef.current.role === "patient") {
          const sdp = data as unknown as RTCSessionDescriptionInit;
          await pc.setRemoteDescription(sdp);
          remoteSetRef.current = true;
          await drainPendingIce(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await sendSignal("answer", { type: answer.type, sdp: answer.sdp });
          emitStatus("negotiating");
        } else if (signal.kind === "answer" && optsRef.current.role === "nurse") {
          await pc.setRemoteDescription(data as unknown as RTCSessionDescriptionInit);
          remoteSetRef.current = true;
          await drainPendingIce(pc);
        } else if (signal.kind === "ice") {
          if (!data) return;
          const cand = data as RTCIceCandidateInit;
          if (remoteSetRef.current && pc.remoteDescription) {
            await pc.addIceCandidate(cand).catch(() => undefined);
          } else {
            pendingIceRef.current.push(cand);
          }
        } else if (signal.kind === "bye") {
          emitStatus("closed");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Signal handling failed");
      }
    },
    [createPc, drainPendingIce, emitStatus, sendSignal]
  );

  // Poll the signalling queue.
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const { signals } = await carePollSignals(sessionId, sinceRef.current, participant);
        for (const s of signals) {
          if (!active) return;
          sinceRef.current = Math.max(sinceRef.current, s.idx + 1);
          await handleSignal(s);
        }
      } catch {
        /* transient; keep polling */
      }
      if (active) timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, sessionId, participant, pollMs, handleSignal]);

  // Offerer: negotiate once the peer is present (or immediately if told to).
  useEffect(() => {
    if (!enabled || role !== "nurse") return;
    if (!opts.start) return;
    if (pcRef.current?.localDescription) return;
    void negotiate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, role, opts.start]);

  // Answerer: create the peer connection up-front so the first offer is handled.
  useEffect(() => {
    if (!enabled || role !== "patient") return;
    createPc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, role]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try {
        dcRef.current?.close();
      } catch {
        /* ignore */
      }
      try {
        pcRef.current?.close();
      } catch {
        /* ignore */
      }
      pcRef.current = null;
      dcRef.current = null;
      outgoingTracksRef.current.clear();
    };
  }, []);

  const sendData = useCallback((msg: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify(msg));
      } catch {
        /* ignore */
      }
    }
  }, []);

  const addTrack = useCallback(
    (track: MediaStreamTrack, stream?: MediaStream) => {
      const pc = createPc();
      if (outgoingTracksRef.current.has(track.id)) return;
      if (stream) pc.addTrack(track, stream);
      else pc.addTrack(track);
      outgoingTracksRef.current.add(track.id);
      // Renegotiate so the patient receives the new track.
      if (role === "nurse" && pc.localDescription) void negotiate();
    },
    [createPc, negotiate, role]
  );

  const restart = useCallback(() => {
    setError(null);
    if (role === "nurse") {
      void negotiate();
    } else {
      createPc();
    }
  }, [createPc, negotiate, role]);

  return { status, pcState, iceState, error, sendData, addTrack, restart };
}
