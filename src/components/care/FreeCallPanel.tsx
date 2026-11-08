"use client";

/**
 * Free-call fallback panel.
 *
 * Twilio's trial account refuses custom TwiML calls, so this offers the same
 * agent through the browser at zero cost:
 *   - "Talk on this device" embeds the browser call (no phone needed);
 *   - "Open on phone" / the QR moves the same call to a phone.
 *
 * The QR is fetched from the server so it always carries the session capability.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Monitor, PhoneCall, QrCode, Smartphone } from "lucide-react";
import { carePhoneQr, type PhoneQr } from "@/lib/careClient";
import { getActiveCareSession } from "@/lib/session";
import BrowserCall from "@/components/care/PhoneCall";
export default function FreeCallPanel({
  sessionId,
  pair = null,
  inline = true,
  defaultOpen = false,
  className = "",
}: {
  sessionId: string | null;
  pair?: string | null;
  /** Embed the live browser call on this device. */
  inline?: boolean;
  /** Open the inline call immediately (used after Twilio declines the dial). */
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen && inline);
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState<PhoneQr | null>(null);
  const [loading, setLoading] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const [resolvedSession, setResolvedSession] = useState<string | null>(sessionId);
  const [resolvedPair, setResolvedPair] = useState<string | null>(pair ?? null);

  // When this panel is rendered without an explicit session (for example a
  // bare browser-call surface), reuse the session the nurse portal paired with.
  useEffect(() => {
    const active = getActiveCareSession();
    const session = sessionId ?? active?.sessionId ?? null;
    const activePair = active && active.sessionId === session ? active.pair : null;
    setResolvedSession(session);
    setResolvedPair(pair ?? activePair ?? null);
  }, [pair, sessionId]);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const loadQr = useCallback(async () => {
    if (!resolvedSession || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setQrError(null);
    try {
      const res = await carePhoneQr(resolvedSession, resolvedPair);
      setQr(res);
    } catch {
      // Fall back to a plain link; the caller can still open it on this device.
      if (typeof window !== "undefined") {
        const p = new URLSearchParams({ session: resolvedSession });
        if (resolvedPair) p.set("pair", resolvedPair);
        setQr({ url: `${window.location.origin}/care/phone?${p.toString()}`, qrDataUrl: "" });
      }
      setQrError("Could not draw the QR here — the link below still works.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [resolvedPair, resolvedSession]);

  // Fetch once so the direct link is usable without opening the QR first.
  useEffect(() => {
    if (resolvedSession) void loadQr();
  }, [loadQr, resolvedSession]);

  const toggleQr = useCallback(() => {
    setShowQr((v) => !v);
  }, []);

  return (
    <div className={`rounded-2xl border border-[#ececec] bg-white ${className}`}>
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-[#1f1f1f]">
              <PhoneCall className="h-4 w-4 text-[#c63a22]" /> Free browser call
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                No charges
              </span>
            </p>
            <p className="mt-0.5 text-xs text-[#6e6e6e]">
              Same CareSpeak agent and patient context, in the browser. Works now — no Twilio minutes.
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {inline ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              disabled={!resolvedSession}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#1f1f1f] px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-[#c63a22] disabled:opacity-50"
            >
              <Monitor className="h-3.5 w-3.5" /> {open ? "Hide browser call" : "Talk on this device"}
            </button>
          ) : null}

          <button
            type="button"
            onClick={toggleQr}
            disabled={!resolvedSession}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#ececec] bg-white px-3.5 py-2 text-xs font-semibold text-[#1f1f1f] transition hover:border-[#c63a22] disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <QrCode className="h-3.5 w-3.5 text-[#c63a22]" />}
            {showQr ? "Hide QR" : "Open on phone"}
          </button>

          {qr?.url ? (
            <a
              href={qr.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#ececec] bg-white px-3.5 py-2 text-xs font-semibold text-[#6e6e6e] transition hover:border-[#c63a22] hover:text-[#c63a22]"
            >
              <Smartphone className="h-3.5 w-3.5" /> Open link
            </a>
          ) : null}
        </div>

        {showQr ? (
          <div className="mt-3 rounded-xl border border-[#f0e3de] bg-[#fffaf8] p-3">
            {qr?.qrDataUrl ? (
              <div className="flex flex-wrap items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qr.qrDataUrl}
                  alt="QR code that opens the free browser call"
                  className="h-32 w-32 rounded-lg border border-white bg-white"
                />
                <p className="max-w-[16rem] text-xs text-[#6e6e6e]">
                  Scan with your phone camera, then press <span className="font-semibold text-[#1f1f1f]">Start call</span>.
                  The link carries this patient session, so no sign-in is needed.
                </p>
              </div>
            ) : loading ? (
              <p className="flex items-center gap-2 text-xs text-[#6e6e6e]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Drawing the QR…
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#8a8a8a]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span>{qrError ?? "The QR is unavailable right now."}</span>
                <button
                  type="button"
                  onClick={() => void loadQr()}
                  className="rounded-full border border-[#e5dedb] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#1f1f1f] hover:border-[#c63a22] hover:text-[#c63a22]"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {inline && open && resolvedSession ? (
        <div className="border-t border-[#f0e3de] p-3">
          <BrowserCall sessionId={resolvedSession} pair={resolvedPair} compact />
        </div>
      ) : null}
    </div>
  );
}
