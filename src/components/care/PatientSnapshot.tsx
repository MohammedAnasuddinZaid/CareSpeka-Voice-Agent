"use client";

import React, { useMemo } from "react";
import { CalendarClock, FileText, HeartPulse, Pill, ShieldCheck, User } from "lucide-react";
import type { ClinicalPatient } from "@/lib/care/types";

interface RecordSummary {
  id: string;
  title: string;
  source?: string;
  chars: number;
  createdAt: string;
}

interface PatientSnapshotProps {
  patient: ClinicalPatient | null;
  records: RecordSummary[];
  className?: string;
}

function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / range) * 24}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={`h-7 w-24 ${className}`}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function PatientSnapshot({ patient, records, className = "" }: PatientSnapshotProps) {
  const grouped = useMemo(() => {
    if (!patient) return [] as Array<{ label: string; series: ClinicalPatient["observations"] }>;
    const map = new Map<string, ClinicalPatient["observations"]>();
    for (const o of patient.observations) {
      const arr = map.get(o.label) ?? [];
      arr.push(o);
      map.set(o.label, arr);
    }
    return [...map.entries()].map(([label, series]) => ({
      label,
      series: [...series].sort((a, b) => a.at.localeCompare(b.at)),
    }));
  }, [patient]);

  if (!patient) {
    return (
      <div className={`rounded-xl border border-dashed border-[#e8ddd8] bg-[#fdfbfa] px-4 py-5 text-center text-xs text-[#6e6e6e] ${className}`}>
        <User className="mx-auto mb-2 h-5 w-5 text-[#c63a22]" />
        <p className="font-semibold text-[#1f1f1f]">No patient linked</p>
        <p className="mt-1">Link a patient to open their chart, history and inserted records.</p>
        <a href="/care/records" className="mt-2 inline-flex items-center gap-1 font-semibold text-[#c63a22] hover:underline">
          <FileText className="h-3.5 w-3.5" /> Open records
        </a>
      </div>
    );
  }

  const recentEncounters = [...patient.encounters]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);
  const activeConditions = patient.conditions.filter((c) => c.status === "active");
  const activeMeds = patient.medications.filter((m) => m.status === "active");
  const allergies = patient.allergies;

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-[#1f1f1f]">{patient.displayName}</span>
            {patient.synthetic ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                synthetic demo data
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-[#6e6e6e]">
            {patient.age != null ? `${patient.age} years` : "Age unknown"}
            {patient.sex ? ` · ${patient.sex}` : ""}
            {patient.room ? ` · ${patient.room}` : ""}
            {patient.language ? ` · ${patient.language}` : ""}
          </p>
        </div>
        <a
          href={`/care/records${patient.id ? `?patientId=${encodeURIComponent(patient.id)}` : ""}`}
          className="inline-flex items-center gap-1 rounded-lg border border-[#e5e5e5] bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#4b4b4b] hover:border-[#c63a22] hover:text-[#c63a22]"
        >
          <FileText className="h-3.5 w-3.5" /> Records
        </a>
      </div>

      {patient.primaryConcern ? (
        <div className="rounded-lg border border-[#f0e3de] bg-[#fff7f5] px-3 py-2 text-xs text-[#4b4b4b]">
          <span className="font-semibold text-[#1f1f1f]">Primary concern:</span> {patient.primaryConcern}
        </div>
      ) : null}

      {patient.carePlan ? (
        <div className="rounded-lg border border-[#ececec] bg-[#fbfaf9] px-3 py-2 text-xs text-[#4b4b4b]">
          <span className="font-semibold text-[#1f1f1f]">Care plan:</span> {patient.carePlan}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-[#ececec] bg-white p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            <HeartPulse className="h-3 w-3 text-[#c63a22]" /> Active conditions
          </div>
          {activeConditions.length ? (
            <ul className="space-y-1 text-xs text-[#1f1f1f]">
              {activeConditions.map((c) => (
                <li key={c.id}>
                  {c.name}
                  {c.code ? <span className="ml-1 text-[10px] text-[#9ca3af]">{c.code}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[#9ca3af]">None recorded</p>
          )}
        </div>
        <div className="rounded-xl border border-[#ececec] bg-white p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            <Pill className="h-3 w-3 text-[#c63a22]" /> Active medications
          </div>
          {activeMeds.length ? (
            <ul className="space-y-1 text-xs text-[#1f1f1f]">
              {activeMeds.map((m) => (
                <li key={m.id}>
                  {m.name}
                  {m.dose ? <span className="ml-1 text-[#6e6e6e]">{m.dose}</span> : null}
                  {m.frequency ? <span className="ml-1 text-[10px] text-[#9ca3af]">{m.frequency}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[#9ca3af]">None recorded</p>
          )}
        </div>
        <div className="rounded-xl border border-[#ececec] bg-white p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            <ShieldCheck className="h-3 w-3 text-[#c63a22]" /> Allergies
          </div>
          {allergies.length ? (
            <ul className="space-y-1 text-xs text-[#1f1f1f]">
              {allergies.map((a) => (
                <li key={a.id}>
                  {a.substance}
                  {a.reaction ? <span className="ml-1 text-[#6e6e6e]">({a.reaction})</span> : null}
                  <span className="ml-1 text-[10px] text-[#9ca3af]">{a.severity}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[#9ca3af]">None recorded</p>
          )}
        </div>
      </div>

      {grouped.length ? (
        <div className="rounded-xl border border-[#ececec] bg-white p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            <CalendarClock className="h-3 w-3 text-[#c63a22]" /> Recorded observations
          </div>
          <div className="space-y-2">
            {grouped.map(({ label, series }) => {
              const numeric = series
                .filter((o) => typeof o.value === "number")
                .map((o) => Number(o.value));
              const latest = series[series.length - 1];
              const previous = series[series.length - 2];
              const trend =
                previous &&
                typeof latest.value === "number" &&
                typeof previous.value === "number" &&
                latest.value !== previous.value
                  ? latest.value > previous.value
                    ? "↑"
                    : "↓"
                  : "";
              return (
                <div key={label} className="flex items-center justify-between gap-3 border-b border-[#f4efec] pb-2 last:border-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[#1f1f1f]">{label}</p>
                    <p className="text-[11px] text-[#6e6e6e]">
                      {latest.value}
                      {latest.unit ? ` ${latest.unit}` : ""} {trend}
                      <span className="ml-1 text-[10px] text-[#9ca3af]">· {latest.at.slice(0, 10)}</span>
                    </p>
                  </div>
                  <Sparkline values={numeric} className="text-[#c63a22]" />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {recentEncounters.length ? (
        <div className="rounded-xl border border-[#ececec] bg-white p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">Recent encounters</div>
          <ol className="relative space-y-2 border-l border-[#f0e3de] pl-3">
            {recentEncounters.map((e) => (
              <li key={e.id} className="text-xs text-[#4b4b4b]">
                <span className="absolute -left-[5px] mt-1 h-2 w-2 rounded-full bg-[#c63a22]" />
                <span className="font-semibold text-[#1f1f1f]">{e.at.slice(0, 10)}</span>
                <span className="ml-1 text-[10px] uppercase tracking-wide text-[#9ca3af]">{e.kind}</span>
                {e.by ? <span className="ml-1 text-[10px] text-[#9ca3af]">· {e.by}</span> : null}
                <p className="mt-0.5">{e.summary}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {records.length ? (
        <div className="rounded-xl border border-[#ececec] bg-white p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            Inserted records ({records.length})
          </div>
          <ul className="space-y-1.5">
            {records.slice(0, 10).map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-2 text-xs text-[#4b4b4b]">
                <span className="min-w-0">
                  <span className="font-semibold text-[#1f1f1f]">{r.title}</span>
                  {r.source ? <span className="ml-1 text-[10px] text-[#9ca3af]">({r.source})</span> : null}
                </span>
                <span className="shrink-0 text-[10px] text-[#9ca3af]">{r.createdAt.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
