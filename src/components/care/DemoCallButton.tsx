"use client";

/**
 * Demo phone-call button.
 *
 * Placed on the patient's own screen (where the QR is) and in the nurse portal.
 * One tap asks the server to phone the care line with Twilio and connect the
 * person who answers to the CareSpeak voice agent, which opens with the linked
 * patient, their records and the live readings. No emergency has to be raised
 * first — this is the safe way to show the calling flow.
 *
 * It never dials by accident: a confirmation is shown first, and the server
 * enforces a short cooldown so the free Twilio balance cannot be hammered.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, PhoneCall, Monitor } from "lucide-react";
import { CareApiError, carePortalCall } from "@/lib/careClient";
import { getOrCreatePairToken } from "@/lib/pairing";
import FreeCallPanel from "@/components/care/FreeCallPanel";

type CallState = "idle" | "calling" | "done" | "error" | "wait";

/** Mirrors the demo cooldown in /api/care/call so the button never fires early. */
const DEMO_COOLDOWN_MS = 8_000;

export default function DemoCallButton({
  sessionId,
  pair,
  className = "",
  label = "Call me (demo)",
  compact = false,
}: {
  sessionId: string | null;
  pair?: string | null;
  className?: string;
  label?: string;
  compact?: boolean;
}) {
  const [state, setState] = useState<CallState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [freeOpen, setFreeOpen] = useState(false);

  useEffect(() => {
    if (!waitUntil) return;
    let timer: ReturnType<typeof setInterval>;
    const tick = () => {
      const next = Date.now();
      setNow(next);
      if (next >= waitUntil) clearInterval(timer);
    };
    timer = setInterval(tick, 400);
    tick();
    return () => clearInterval(timer);
  }, [waitUntil]);

  const waitSeconds = waitUntil > now ? Math.ceil((waitUntil - now) / 1000) : 0;

  // The patient laptop keeps its pair token in localStorage; the nurse portal
  // passes the token from the scanned QR. Either is accepted by the server.
  const resolvedPair = useMemo(() => {
    if (pair) return pair;
    if (!sessionId) return null;
    return getOrCreatePairToken(sessionId) || null;
  }, [pair, sessionId]);

  const call = useCallback(async () => {
    if (!sessionId || state === "calling" || waitSeconds > 0) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(
        "This places a real phone call to the care line. When you answer, the CareSpeak agent will brief you on the patient and their live readings. Continue?"
      );
      if (!confirmed) return;
    }

    setState("calling");
    setMessage(null);
    try {
      const res = await carePortalCall(sessionId, resolvedPair, { reason: "demo" });
      setState("done");
      setWaitUntil(Date.now() + DEMO_COOLDOWN_MS);
      setNow(Date.now());
      setMessage(`Calling ${res.to}. The CareSpeak agent will brief you as soon as you answer.`);
    } catch (err) {
      if (err instanceof CareApiError && err.status === 429) {
        // A call is already ringing (possibly placed from the other device).
        // Treat it as information, not a failure, and count down in the button.
        const seconds = Number(err.message.match(/in (\d+)s/i)?.[1] ?? 0) || 8;
        setState("wait");
        setWaitUntil(Date.now() + Math.max(1, seconds) * 1000);
        setNow(Date.now());
        setMessage("A call from this session is already ringing — answer your phone, then try again.");
      } else {
        setState("error");
        setMessage(err instanceof CareApiError ? err.message : "Could not place the call. Try again.");
        // Twilio's trial cannot run our TwiML. Offer the free browser call
        // instead of leaving the user with a dead end.
        if (err instanceof CareApiError && err.code === "trial_custom_call") setFreeOpen(true);
      }
    }
  }, [resolvedPair, sessionId, state, waitSeconds]);

  return (
    <div
      className={`rounded-2xl border border-[#ececec] bg-white ${compact ? "px-4 py-3" : "p-4"} ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-[#1f1f1f]">
            <PhoneCall className="h-4 w-4 text-[#c63a22]" /> Phone briefing
          </p>
          <p className="mt-0.5 text-xs text-[#6e6e6e]">
            Calls the care line and lets the CareSpeak agent read the patient&apos;s situation aloud.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void call()}
            disabled={!sessionId || state === "calling" || waitSeconds > 0}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#c63a22] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#a92f1b] disabled:opacity-50"
          >
            {state === "calling" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : waitSeconds > 0 ? (
              <Clock3 className="h-4 w-4" />
            ) : (
              <PhoneCall className="h-4 w-4" />
            )}
            {state === "calling"
              ? "Calling..."
              : waitSeconds > 0
                ? `Wait ${waitSeconds}s`
                : state === "done"
                  ? "Call again"
                  : label}
          </button>
          <button
            type="button"
            onClick={() => setFreeOpen((v) => !v)}
            disabled={!sessionId}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[#e5dedb] bg-white px-4 py-2.5 text-sm font-semibold text-[#1f1f1f] transition hover:border-[#c63a22] hover:text-[#c63a22] disabled:opacity-50"
            title="Talk to the same agent in this browser — free, no phone call"
          >
            <Monitor className="h-4 w-4" /> Browser call
          </button>
        </div>
      </div>

      {message ? (
        <div
          className={`mt-2.5 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
            state === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : state === "wait"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {state === "error" ? (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : state === "wait" ? (
            <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>{message}</span>
        </div>
      ) : null}

      {freeOpen ? (
        <FreeCallPanel sessionId={sessionId} pair={resolvedPair} className="mt-3" defaultOpen />
      ) : null}
    </div>
  );
}