import { describe, expect, it } from "vitest";
import { evaluateEscalations } from "@/lib/escalation";
import { newestMetrics, newestVitals } from "@/lib/liveMetrics";
import type { DeviceVitals, GestureLogEntry, PatientMetrics } from "@/types";

const NOW = 1_700_000_000_000;

function entry(partial: Partial<GestureLogEntry> & { id: string; gesture: string; timestamp: number }): GestureLogEntry {
  return {
    description: "",
    confidence: 0.9,
    type: "hand",
    language: "en-US",
    ...partial,
  } as GestureLogEntry;
}

function help(id: string, at: number, flags: Partial<GestureLogEntry> = {}) {
  return entry({ id, gesture: "HELP", timestamp: at, ...flags });
}

describe("help_frequency rule", () => {
  it("escalates the newest unacknowledged HELP once three land in the window", () => {
    const log = [help("a", NOW - 60_000), help("b", NOW - 30_000), help("c", NOW - 1_000)];
    const decisions = evaluateEscalations(log, null, NOW);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ rule: "help_frequency", entryId: "c" });
    expect(decisions[0].reason).toContain("3 HELP calls");
  });

  it("does nothing with only two HELP calls", () => {
    expect(evaluateEscalations([help("a", NOW - 1_000), help("b", NOW - 500)], null, NOW)).toEqual([]);
  });

  it("ignores HELP calls older than the window", () => {
    const log = [help("a", NOW - 200_000), help("b", NOW - 190_000), help("c", NOW - 500)];
    expect(evaluateEscalations(log, null, NOW)).toEqual([]);
  });

  it("skips already-handled entries and targets the newest actionable one", () => {
    const log = [
      help("old", NOW - 90_000),
      help("ack", NOW - 30_000, { acknowledged: true }),
      help("bright", NOW - 1_000),
    ];
    const decisions = evaluateEscalations(log, null, NOW);
    expect(decisions.map((d) => d.entryId)).toEqual(["bright"]);

    const allHandled = [help("x", NOW - 3_000, { resolved: true }), help("y", NOW - 2_000, { escalated: true }), help("z", NOW - 1_000, { acknowledged: true })];
    // z is acknowledged but y is escalated, x resolved: no actionable target.
    expect(evaluateEscalations(allHandled, null, NOW)).toEqual([]);
  });
});

describe("low_alertness rule", () => {
  const metrics = (score: number | null, lastSeen?: string): PatientMetrics & { lastSeen?: string } => ({
    alertnessScore: score ?? undefined,
    lastSeen,
  });

  it("escalates the newest actionable entry for a fresh, low score", () => {
    const log = [entry({ id: "e1", gesture: "HELLO", timestamp: NOW - 5_000 })];
    const decisions = evaluateEscalations(log, metrics(10, new Date(NOW - 5_000).toISOString()), NOW);
    expect(decisions.map((d) => d.rule)).toContain("low_alertness");
    expect(decisions.find((d) => d.rule === "low_alertness")?.entryId).toBe("e1");
  });

  it("ignores a score at or above the threshold", () => {
    const log = [entry({ id: "e1", gesture: "HELLO", timestamp: NOW })];
    expect(evaluateEscalations(log, metrics(25, new Date(NOW).toISOString()), NOW)).toEqual([]);
  });

  it("ignores a stale reading outside the freshness window", () => {
    const log = [entry({ id: "e1", gesture: "HELLO", timestamp: NOW })];
    expect(evaluateEscalations(log, metrics(5, new Date(NOW - 60_000).toISOString()), NOW)).toEqual([]);
  });

  it("does nothing without metrics or without an actionable entry", () => {
    expect(evaluateEscalations([entry({ id: "e1", gesture: "HELLO", timestamp: NOW })], null, NOW)).toEqual([]);
    expect(
      evaluateEscalations([], metrics(5, new Date(NOW).toISOString()), NOW)
    ).toEqual([]);
  });
});

describe("prolonged_inactivity rule", () => {
  it("alerts when the device has been silent mid-session", () => {
    const log = [entry({ id: "e1", gesture: "HELLO", timestamp: NOW - 5 * 60_000 })];
    const decisions = evaluateEscalations(log, null, NOW);
    expect(decisions.map((d) => d.rule)).toContain("prolonged_inactivity");
    expect(decisions.find((d) => d.rule === "prolonged_inactivity")?.entryId).toBe("e1");
    expect(decisions.find((d) => d.rule === "prolonged_inactivity")?.reason).toContain("No patient activity");
  });

  it("does nothing when the session is empty or already escalated", () => {
    expect(evaluateEscalations([], null, NOW)).toEqual([]);
    const log = [entry({ id: "e1", gesture: "HELLO", timestamp: NOW - 5 * 60_000, escalated: true })];
    expect(evaluateEscalations(log, null, NOW)).toEqual([]);
  });

  it("does nothing when the last activity was too long ago to be an active session", () => {
    const log = [entry({ id: "e1", gesture: "HELLO", timestamp: NOW - 40 * 60_000 })];
    expect(evaluateEscalations(log, null, NOW).some((d) => d.rule === "prolonged_inactivity")).toBe(false);
  });

  it("does not fire when a recent entry is still fresh", () => {
    const log = [entry({ id: "e1", gesture: "HELLO", timestamp: NOW - 1_000 })];
    expect(evaluateEscalations(log, null, NOW)).toEqual([]);
  });
});

describe("newestMetrics", () => {
  it("returns null for empty or missing maps", () => {
    expect(newestMetrics(null)).toBeNull();
    expect(newestMetrics(undefined)).toBeNull();
    expect(newestMetrics({})).toBeNull();
  });

  it("returns the device with the freshest lastSeen", () => {
    const map: Record<string, PatientMetrics> = {
      devA: { alertnessScore: 40, lastSeen: new Date(NOW - 10_000).toISOString() },
      devB: { alertnessScore: 70, lastSeen: new Date(NOW - 1_000).toISOString() },
    };
    expect(newestMetrics(map)).toBe(map.devB);
  });

  it("returns a single entry unchanged", () => {
    const map: Record<string, PatientMetrics> = { only: { alertnessScore: 50 } };
    expect(newestMetrics(map)).toBe(map.only);
  });
});

describe("newestVitals", () => {
  it("returns null for empty or missing maps", () => {
    expect(newestVitals(null)).toBeNull();
    expect(newestVitals({})).toBeNull();
  });

  it("returns the device with the greatest receivedAt", () => {
    const map: Record<string, DeviceVitals> = {
      a: { deviceId: "a", receivedAt: 100, heartRate: 70 },
      b: { deviceId: "b", receivedAt: 500, heartRate: 90 },
      c: { deviceId: "c", receivedAt: 300, heartRate: 80 },
    };
    expect(newestVitals(map)).toBe(map.b);
  });

  it("keeps the first entry when timestamps tie", () => {
    const map: Record<string, DeviceVitals> = {
      a: { deviceId: "a", receivedAt: 100 },
      b: { deviceId: "b", receivedAt: 100 },
    };
    expect(newestVitals(map)).toBe(map.a);
  });
});
