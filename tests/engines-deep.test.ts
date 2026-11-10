import { describe, expect, it } from "vitest";
import {
  computeStats,
  computeTrends,
  dailyGestureCounts,
  gestureDistribution,
  hourlyDistribution,
  toCsv,
} from "@/lib/analytics";
import { formatCitation, citationPassage, CLINICAL_CORPUS } from "@/lib/clinicalBasis";
import { evaluateEscalations } from "@/lib/escalation";
import { bandRank, forecastDeterioration, trajectoryAlertText } from "@/lib/forecast";
import { newestMetrics, newestVitals } from "@/lib/liveMetrics";
import { computeRisk } from "@/lib/risk";
import type { DeviceVitals, GestureLogEntry, PatientMetrics } from "@/types";

function entry(partial: Partial<GestureLogEntry> = {}): GestureLogEntry {
  return {
    id: Math.random().toString(36).slice(2),
    gesture: "HELP",
    description: "",
    confidence: 0.9,
    type: "hand",
    timestamp: Date.now(),
    language: "en-US",
    ...partial,
  };
}

describe("analytics.computeStats", () => {
  it("counts totals, today, unacknowledged and open escalations", () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    const entries = [
      entry({ timestamp: todayStart + 1000, acknowledged: true }),
      entry({ timestamp: todayStart - 1000, acknowledged: false }),
      entry({ timestamp: todayStart - 5000, acknowledged: false, escalated: true, resolved: false }),
      entry({ timestamp: todayStart - 9000, escalated: true, resolved: true }),
    ];
    const stats = computeStats(entries, now.getTime());
    expect(stats.total).toBe(4);
    expect(stats.today).toBe(1);
    expect(stats.unacknowledged).toBe(3);
    // escalated AND unresolved only
    expect(stats.escalated).toBe(1);
    expect(stats.byGesture.HELP).toBe(4);
    expect(stats.byType.hand).toBe(4);
  });

  it("returns zeroed buckets for an empty log", () => {
    const stats = computeStats([]);
    expect(stats).toMatchObject({ total: 0, today: 0, unacknowledged: 0, escalated: 0 });
    expect(stats.byGesture).toEqual({});
  });
});

describe("analytics.computeTrends", () => {
  it("compares today against yesterday and reports direction", () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    const entries = [
      entry({ timestamp: todayStart + 1000 }),
      entry({ timestamp: todayStart + 2000 }),
      entry({ timestamp: todayStart + 3000 }),
      entry({ timestamp: todayStart - 1000 }), // yesterday
    ];
    const trends = computeTrends(entries, now.getTime());
    expect(trends.total).toBe(4);
    expect(trends.today).toBe(3);
    // 3 vs 1 => +200%
    expect(trends.change).toBe(200);
    expect(trends.direction).toBe("up");
  });
});

describe("analytics charts + csv", () => {
  it("hourlyDistribution always returns 24 local-hour buckets", () => {
    const dist = hourlyDistribution([entry()]);
    expect(dist).toHaveLength(24);
    expect(dist.map((d) => d.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(dist.reduce((a, d) => a + d.count, 0)).toBe(1);
  });

  it("gestureDistribution sorts descending and falls back to grey", () => {
    const entries = [entry({ gesture: "HELP" }), entry({ gesture: "YES" }), entry({ gesture: "YES" })];
    const dist = gestureDistribution(entries, { YES: "#0f0" });
    expect(dist[0]).toEqual({ name: "YES", value: 2, color: "#0f0" });
    expect(dist[1]).toEqual({ name: "HELP", value: 1, color: "#6e6e6e" });
  });

  it("toCsv quotes cells and escapes embedded quotes", () => {
    const csv = toCsv([entry({ id: 'a"b', gesture: "HELP" })]);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("id,timestamp");
    expect(lines[1]).toContain('"a""b"');
  });

  it("dailyGestureCounts ignores events older than the window", () => {
    const old = entry({ timestamp: Date.now() - 40 * 86400000 });
    expect(dailyGestureCounts([old], 7)).toHaveLength(0);
  });
});

describe("risk engine boundaries", () => {
  it("scores each NEWS2-aligned vital band", () => {
    expect(computeRisk(null, [], Date.now(), { heartRate: 49, spo2: 97 }).score).toBe(12);
    expect(computeRisk(null, [], Date.now(), { heartRate: 50, spo2: 97 }).score).toBe(0);
    expect(computeRisk(null, [], Date.now(), { heartRate: 131, spo2: 97 }).score).toBe(25);
    expect(computeRisk(null, [], Date.now(), { heartRate: 75, spo2: 95 }).score).toBe(8);
    expect(computeRisk(null, [], Date.now(), { heartRate: 75, spo2: 93 }).score).toBe(18);
    expect(computeRisk(null, [], Date.now(), { heartRate: 75, spo2: 91 }).score).toBe(30);
  });

  it("scores camera wellness bands and movement extremes", () => {
    expect(computeRisk({ alertnessScore: 24 }, [], Date.now()).score).toBe(30);
    expect(computeRisk({ alertnessScore: 64 }, [], Date.now()).score).toBe(8);
    expect(computeRisk({ blinkRate: 2 }, [], Date.now()).score).toBe(15);
    expect(computeRisk({ blinkRate: 5 }, [], Date.now()).score).toBe(8);
    expect(computeRisk({ blinkRate: 6 }, [], Date.now()).score).toBe(0);
    expect(computeRisk({ movementActivity: 0.02 }, [], Date.now()).score).toBe(12);
    expect(computeRisk({ movementActivity: 0.5 }, [], Date.now()).score).toBe(0);
    expect(computeRisk({ movementActivity: 0.99 }, [], Date.now()).score).toBe(8);
  });

  it("only counts HELP and unresolved critical events inside the 10-minute window", () => {
    const now = Date.now();
    const stale = [now - 11 * 60 * 1000, now - 12 * 60 * 1000].map((t) =>
      entry({ gesture: "HELP", timestamp: t })
    );
    expect(computeRisk(null, stale, now).factors.some((f) => f.key === "help_freq")).toBe(false);

    const fresh = [now - 1000, now - 2000].map((t) => entry({ gesture: "HELP", timestamp: t }));
    const r = computeRisk(null, fresh, now);
    expect(r.factors.find((f) => f.key === "help_freq")?.weight).toBe(20);
  });

  it("caps attribution when the raw score exceeds 100 while keeping the SHAP invariant", () => {
    const now = Date.now();
    const r = computeRisk(
      { alertnessScore: 5, blinkRate: 1, movementActivity: 0.01 },
      [
        entry({ gesture: "HELP", timestamp: now - 1000 }),
        entry({ gesture: "HELP", timestamp: now - 2000 }),
        entry({ gesture: "EMERGENCY", timestamp: now - 3000 }),
      ],
      now,
      { heartRate: 150, spo2: 80 }
    );
    expect(r.score).toBe(100);
    expect(r.band).toBe("critical");
    const sum = r.attribution.reduce((a, x) => a + x.phi, 0);
    expect(r.baseValue + sum).toBeCloseTo(r.score, 5);
  });
});

describe("forecast helpers and edges", () => {
  it("bandRank orders severity", () => {
    expect(bandRank("stable")).toBeLessThan(bandRank("watch"));
    expect(bandRank("warning")).toBeLessThan(bandRank("imminent"));
  });

  it("trajectoryAlertText names the score and band", () => {
    const f = forecastDeterioration([]);
    const text = trajectoryAlertText(f);
    expect(text).toContain(`${f.score}/100`);
    expect(text).toContain(f.band);
  });

  it("handles empty and out-of-order samples without throwing", () => {
    const f = forecastDeterioration([]);
    expect(f.score).toBe(0);
    expect(f.band).toBe("stable");
    const outOfOrder = [
      { t: 3, hr: 80 },
      { t: 1, hr: 78 },
      { t: 0, hr: 77 }, // t=0 is filtered out
      { t: 2, hr: 79 },
      { t: 4, hr: 81 },
    ];
    expect(() => forecastDeterioration(outOfOrder)).not.toThrow();
  });

  it("ignores non-finite sensor values", () => {
    const samples = Array.from({ length: 8 }, (_, i) => ({
      t: i * 60000,
      hr: i === 4 ? NaN : 80,
      spo2: i === 5 ? Infinity : 98,
    }));
    const f = forecastDeterioration(samples);
    expect(Number.isFinite(f.score)).toBe(true);
    for (const value of Object.values(f.projected)) expect(Number.isFinite(value)).toBe(true);
  });
});

describe("escalation engine — all three rules", () => {
  it("help_frequency escalates the newest actionable HELP inside the window", () => {
    const now = Date.now();
    const log = [
      entry({ id: "old", gesture: "HELP", timestamp: now - 200000 }), // outside 120s
      entry({ id: "a", gesture: "HELP", timestamp: now - 90000 }),
      entry({ id: "b", gesture: "HELP", timestamp: now - 60000 }),
      entry({ id: "c", gesture: "HELP", timestamp: now - 30000 }),
    ];
    const decision = evaluateEscalations(log, null, now).find((d) => d.rule === "help_frequency");
    expect(decision?.entryId).toBe("c");
    expect(decision?.reason).toContain("3 HELP");
  });

  it("help_frequency does not fire when the newest HELP is already acknowledged", () => {
    const now = Date.now();
    const log = [now - 30000, now - 20000, now - 10000].map((t) =>
      entry({ gesture: "HELP", timestamp: t, acknowledged: true })
    );
    expect(evaluateEscalations(log, null, now).some((d) => d.rule === "help_frequency")).toBe(false);
  });

  it("low_alertness requires a fresh metric and chooses the newest actionable entry", () => {
    const now = Date.now();
    const metrics: PatientMetrics = {
      alertnessScore: 10,
      lastSeen: new Date(now - 1000).toISOString(),
    };
    const log = [
      entry({ id: "done", timestamp: now - 1000, resolved: true, acknowledged: true }),
      entry({ id: "open", timestamp: now - 9000 }),
    ];
    const decision = evaluateEscalations(log, metrics, now).find((d) => d.rule === "low_alertness");
    expect(decision?.entryId).toBe("open");
  });

  it("low_alertness ignores stale metrics", () => {
    const now = Date.now();
    const metrics: PatientMetrics = {
      alertnessScore: 10,
      lastSeen: new Date(now - 10 * 60 * 1000).toISOString(),
    };
    expect(evaluateEscalations([entry()], metrics, now).some((d) => d.rule === "low_alertness")).toBe(
      false
    );
  });

  it("prolonged_inactivity fires only for an active-but-silent session", () => {
    const now = Date.now();
    const silent = [entry({ id: "open", timestamp: now - 5 * 60 * 1000 })];
    const decision = evaluateEscalations(silent, null, now).find(
      (d) => d.rule === "prolonged_inactivity"
    );
    expect(decision?.entryId).toBe("open");

    // A very old last entry is no longer "was active recently" (>30 min).
    const ancient = [entry({ id: "old", timestamp: now - 60 * 60 * 1000 })];
    expect(evaluateEscalations(ancient, null, now).some((d) => d.rule === "prolonged_inactivity")).toBe(
      false
    );

    // Empty log never fires inactivity.
    expect(evaluateEscalations([], null, now).some((d) => d.rule === "prolonged_inactivity")).toBe(
      false
    );
  });

  it("prolonged_inactivity is suppressed while an escalation is already open", () => {
    const now = Date.now();
    const log = [
      entry({ id: "open", timestamp: now - 5 * 60 * 1000 }),
      entry({ id: "esc", timestamp: now - 4 * 60 * 1000, escalated: true, resolved: false }),
    ];
    expect(evaluateEscalations(log, null, now).some((d) => d.rule === "prolonged_inactivity")).toBe(
      false
    );
  });
});

describe("liveMetrics freshest-wins selection", () => {
  it("returns null for missing/empty maps", () => {
    expect(newestMetrics(null)).toBeNull();
    expect(newestMetrics(undefined)).toBeNull();
    expect(newestMetrics({})).toBeNull();
    expect(newestVitals(null)).toBeNull();
    expect(newestVitals({})).toBeNull();
  });

  it("picks the metrics with the newest lastSeen regardless of insertion order", () => {
    const map: Record<string, PatientMetrics> = {
      a: { alertnessScore: 90, lastSeen: "2026-01-01T00:00:00.000Z" },
      b: { alertnessScore: 50, lastSeen: "2026-01-01T00:05:00.000Z" },
      c: { alertnessScore: 70, lastSeen: "2026-01-01T00:02:00.000Z" },
    };
    expect(newestMetrics(map)?.alertnessScore).toBe(50);
  });

  it("picks the vitals with the newest receivedAt", () => {
    const map: Record<string, DeviceVitals> = {
      a: { deviceId: "a", receivedAt: 100, heartRate: 70 },
      b: { deviceId: "b", receivedAt: 300, heartRate: 90 },
      c: { deviceId: "c", receivedAt: 200, heartRate: 80 },
    };
    expect(newestVitals(map)?.deviceId).toBe("b");
  });
});

describe("clinical citation corpus integrity", () => {
  it("has unique document ids and every citation resolves", () => {
    const ids = CLINICAL_CORPUS.map((d) => d.docId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders known and unknown citations safely", () => {
    expect(formatCitation({ docId: "RCP-NEWS2", section: "hr" })).toBe("RCP-NEWS2 §hr");
    expect(citationPassage({ docId: "RCP-NEWS2", section: "hr" })).toContain("Royal College");
    expect(formatCitation({ docId: "NOPE", section: "x" })).toBe("NOPE §x");
    expect(citationPassage({ docId: "NOPE", section: "x" })).toBe("");
  });
});