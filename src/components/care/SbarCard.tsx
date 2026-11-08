"use client";

import { useState } from "react";
import { ClipboardCopy, X } from "lucide-react";
import type { PortalSbar } from "@/lib/careClient";

export default function SbarCard({ sbar, onClose }: { sbar: PortalSbar; onClose?: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sbar.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mt-3 rounded-2xl border border-[#f0d9d3] bg-[#fff7f5] p-4 text-xs text-[#4b4b4b]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[#1f1f1f]">SBAR handoff</span>
          {sbar.synthetic ? (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
              synthetic demo data
            </span>
          ) : null}
          <span className="text-[10px] text-[#9ca3af]">{new Date(sbar.generatedAt).toLocaleTimeString()}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#4b4b4b] hover:border-[#c63a22] hover:text-[#c63a22]"
          >
            <ClipboardCopy className="h-3 w-3" /> {copied ? "Copied" : "Copy"}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#4b4b4b] hover:text-red-600"
              aria-label="Close handoff"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="space-y-2">
        <Section label="Situation" text={sbar.situation} />
        <Section label="Background" text={sbar.background} />
        <Section label="Assessment" text={sbar.assessment} />
        <Section label="Recommendation" text={sbar.recommendation} />
      </div>
    </div>
  );
}

function Section({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#c63a22]">{label}</div>
      <p className="mt-0.5 leading-relaxed">{text}</p>
    </div>
  );
}
