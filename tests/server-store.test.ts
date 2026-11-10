import { beforeEach, describe, expect, it } from "vitest";
import { STATUS_RANK, getSessionStore } from "@/lib/server/store";
import { clampFinite, sanitizeVitals } from "@/lib/server/vitals";
import type { GestureLogEntry } from "@/types";

// The store memoises a promise on globalThis for HMR safety; reset it so each
// case starts from a clean memory driver.
function resetStore(): void {
  delete (globalThis as unknown as { __carespeakStoreP?: unknown }).__carespeakStoreP;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

function rawEntry(partial: Partial<Omit<GestureLogEntry, "serverTime">> = {}): Omit<GestureLogEntry, "serverTime"> {
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

beforeEach(resetStore);

describe("session store — entry lifecycle", () => {
  it("appends entries with a server time and a fresh 'none' status", async () => {
    const store = await getSessionStore();
    expect(store.driver).toBe("memory");
    const stored = await store.appendEntry("s1", rawEntry({ id: "e1" }));
    expect(stored.status).toBe("none");
    expect(stored.serverTime).toBeTypeOf("number");
    const list = await store.getEntriesSince("s1", 0);
    expect(list.map((e) => e.id)).toEqual(["e1"]);
  });

  it("never reuses a server time within a session (burst-safe cursor)", async () => {
    const store = await getSessionStore();
    const a = await store.appendEntry("s1", rawEntry({ id: "a" }));
    const b = await store.appendEntry("s1", rawEntry({ id: "b" }));
    const c = await store.appendEntry("s1", rawEntry({ id: "c" }));
    expect(b.serverTime).toBeGreaterThan(a.serverTime!);
    expect(c.serverTime).toBeGreaterThan(b.serverTime!);
  });

  it("getEntriesSince is strictly greater-than the cursor", async () => {
    const store = await getSessionStore();
    const a = await store.appendEntry("s1", rawEntry({ id: "a" }));
    await store.appendEntry("s1", rawEntry({ id: "b" }));
    const after = await store.getEntriesSince("s1", a.serverTime!);
    expect(after.map((e) => e.id)).toEqual(["b"]);
  });

  it("is idempotent on entry id and keeps progressed lifecycle state", async () => {
    const store = await getSessionStore();
    await store.appendEntry("s1", rawEntry({ id: "dup" }));
    await store.setStatus("s1", "dup", "acknowledge");
    const rePosted = await store.appendEntry("s1", rawEntry({ id: "dup" }));
    expect(rePosted.status).toBe("acknowledge");
    expect(rePosted.acknowledged).toBe(true);
    // No duplicate row was created.
    const list = await store.getEntriesSince("s1", 0);
    expect(list.filter((e) => e.id === "dup")).toHaveLength(1);
  });

  it("enforces forward-only status transitions and mirrors flags", async () => {
    const store = await getSessionStore();
    await store.appendEntry("s1", rawEntry({ id: "e1" }));
    await store.setStatus("s1", "e1", "escalate");
    // A late acknowledge must not move escalated → acknowledge.
    await store.setStatus("s1", "e1", "acknowledge");
    let [entry] = await store.getEntriesSince("s1", 0);
    expect(entry.status).toBe("escalate");
    expect(entry.escalated).toBe(true);

    await store.setStatus("s1", "e1", "resolve");
    [entry] = await store.getEntriesSince("s1", 0);
    expect(entry.status).toBe("resolve");
    expect(entry.resolved).toBe(true);
    expect(entry.acknowledged).toBe(true);
  });

  it("bumps server time on a status change so catch-up clients observe it", async () => {
    const store = await getSessionStore();
    const stored = await store.appendEntry("s1", rawEntry({ id: "e1" }));
    const cursor = stored.serverTime!; // copy the number before the in-place mutation
    await store.setStatus("s1", "e1", "resolve");
    const after = await store.getEntriesSince("s1", cursor);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("resolve");
  });

  it("ignores a status update for an unknown entry", async () => {
    const store = await getSessionStore();
    await expect(store.setStatus("s1", "ghost", "resolve")).resolves.toBeUndefined();
    expect(await store.getEntriesSince("s1", 0)).toEqual([]);
  });
});

describe("session store — metrics, vitals, replies, registry", () => {
  it("stamps metrics/vitals with a server receive time and latest-wins per device", async () => {
    const store = await getSessionStore();
    await store.setMetrics("s1", "devA", { alertnessScore: 40 });
    await store.setMetrics("s1", "devA", { alertnessScore: 70 });
    await store.setMetrics("s1", "devB", { alertnessScore: 55 });
    const metrics = await store.getMetrics("s1");
    expect(Object.keys(metrics).sort()).toEqual(["devA", "devB"]);
    expect(metrics.devA.alertnessScore).toBe(70);
    expect(Number.isFinite(Date.parse(metrics.devA.lastSeen!))).toBe(true);

    await store.setVitals("s1", { deviceId: "devA", heartRate: 80, receivedAt: 1 });
    const vitals = await store.getVitals("s1");
    expect(vitals.devA.heartRate).toBe(80);
    expect(vitals.devA.receivedAt).toBeGreaterThan(1); // server-stamped, not client value
  });

  it("filters replies by a strict since cursor", async () => {
    const store = await getSessionStore();
    await store.setReply("s1", { id: "r1", text: "hi", lang: "en", from: "nurse", timestamp: 1000 });
    await store.setReply("s1", { id: "r2", text: "there", lang: "en", from: "nurse", timestamp: 2000 });
    expect((await store.getRepliesSince("s1", 1000)).map((r) => r.id)).toEqual(["r2"]);
    expect(await store.getRepliesSince("s1", 2000)).toEqual([]);
  });

  it("tracks active sessions newest-first", async () => {
    const store = await getSessionStore();
    await store.appendEntry("bedA", rawEntry());
    await store.setMetrics("bedB", "dev", { alertnessScore: 60 });
    const active = await store.getActiveSessions();
    expect(active.map((a) => a.session).sort()).toEqual(["bedA", "bedB"]);
    for (let i = 1; i < active.length; i += 1) {
      expect(active[i - 1].lastSeen).toBeGreaterThanOrEqual(active[i].lastSeen);
    }
  });

  it("returns empty collections for an unknown session", async () => {
    const store = await getSessionStore();
    expect(await store.getEntriesSince("nope", 0)).toEqual([]);
    expect(await store.getMetrics("nope")).toEqual({});
    expect(await store.getVitals("nope")).toEqual({});
    expect(await store.getRepliesSince("nope", 0)).toEqual([]);
  });
});

describe("STATUS_RANK ordering", () => {
  it("orders lifecycle states none < acknowledge < escalate < resolve", () => {
    expect(STATUS_RANK.none).toBeLessThan(STATUS_RANK.acknowledge);
    expect(STATUS_RANK.acknowledge).toBeLessThan(STATUS_RANK.escalate);
    expect(STATUS_RANK.escalate).toBeLessThan(STATUS_RANK.resolve);
  });
});

describe("sanitizeVitals / clampFinite", () => {
  it("clamps into the physiological envelope", () => {
    const out = sanitizeVitals({ heartRate: 500, spo2: 10, temperature: 60, batteryPct: 130 });
    expect(out.heartRate).toBe(300);
    expect(out.spo2).toBe(50);
    expect(out.temperature).toBe(45);
    expect(out.batteryPct).toBe(100);
  });

  it("drops non-finite and non-numeric values", () => {
    const out = sanitizeVitals({
      heartRate: NaN,
      spo2: Infinity,
      temperature: -Infinity,
      batteryPct: "90" as unknown as number,
      sosActive: "yes" as unknown as boolean,
    });
    expect(out.heartRate).toBeUndefined();
    expect(out.spo2).toBeUndefined();
    expect(out.temperature).toBeUndefined();
    expect(out.batteryPct).toBeUndefined();
    expect(out.sosActive).toBe(true);
  });

  it("passes raw RSSI through only when finite", () => {
    expect(sanitizeVitals({ rssi: -70 }).rssi).toBe(-70);
    expect(sanitizeVitals({ rssi: NaN }).rssi).toBeUndefined();
  });

  it("returns a safe object for null/undefined/garbage input", () => {
    expect(sanitizeVitals(null)).toEqual({ sosActive: false });
    expect(sanitizeVitals(undefined)).toEqual({ sosActive: false });
    expect(sanitizeVitals("nope" as unknown as object)).toEqual({ sosActive: false });
  });

  it("clampFinite rejects non-finite and clamps finite values", () => {
    expect(clampFinite(NaN, 0, 10)).toBeUndefined();
    expect(clampFinite(Infinity, 0, 10)).toBeUndefined();
    expect(clampFinite("5", 0, 10)).toBeUndefined();
    expect(clampFinite(-3, 0, 10)).toBe(0);
    expect(clampFinite(42, 0, 10)).toBe(10);
    expect(clampFinite(7, 0, 10)).toBe(7);
  });
});
