import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GestureLogEntry } from "@/types";

type GestureLogModule = typeof import("@/lib/gestureLog");

const KEY = "carespeak_gesture_log";

/**
 * The module memoises its BroadcastChannel, so every case imports a fresh copy
 * after `vi.resetModules()`.
 */
let g: GestureLogModule;

async function load(): Promise<GestureLogModule> {
  vi.resetModules();
  g = await import("@/lib/gestureLog");
  return g;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
  return { store, map };
}

class FakeChannel {
  static instances: FakeChannel[] = [];
  static posted: Array<{ channel: number; msg: unknown }> = [];
  listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  close = vi.fn();
  postMessage = vi.fn((msg: unknown) => {
    FakeChannel.posted.push({ channel: FakeChannel.instances.indexOf(this), msg });
  });
  constructor(public name: string) {
    FakeChannel.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, cb: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((c) => c !== cb)
    );
  }
  emit(data: unknown) {
    for (const cb of this.listeners.get("message") ?? []) cb({ data } as MessageEvent);
  }
}

class ThrowingChannel {
  constructor() {
    throw new Error("BroadcastChannel blocked");
  }
}

function installStorage(initial: Record<string, string> = {}) {
  const { store, map } = memoryStorage(initial);
  vi.stubGlobal("window", { localStorage: store });
  vi.stubGlobal("localStorage", store);
  return map;
}

function installChannel() {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
}

function entry(partial: Partial<GestureLogEntry> = {}): GestureLogEntry {
  return {
    id: "g1",
    gesture: "HELP",
    description: "Needs help",
    confidence: 0.9,
    type: "hand",
    timestamp: 1_000,
    language: "en-US",
    ...partial,
  };
}

function throwingStorage(): Storage {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
    clear: () => undefined,
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  FakeChannel.instances = [];
  FakeChannel.posted = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("server rendering", () => {
  it("returns an empty log without a window", async () => {
    const mod = await load();
    expect(mod.loadGestureLog()).toEqual([]);
  });

  it("still returns the entry when it cannot persist or broadcast", async () => {
    const mod = await load();
    const added = mod.addGestureLog("HELP", "Needs help", 0.8, "hand");
    expect(added.gesture).toBe("HELP");
    expect(added.id).toMatch(/^\d+_[a-z0-9]+$/);
    expect(() => mod.applyStatusLocal("g1", "acknowledge")).not.toThrow();
    expect(() => mod.acknowledgeEntry("g1")).not.toThrow();
    expect(() => mod.clearGestureLog()).not.toThrow();
  });
});

describe("addGestureLog", () => {
  it("persists the entry at the front with documented defaults", async () => {
    const map = installStorage();
    const mod = await load();
    const added = mod.addGestureLog("YES", "Patient confirms", 0.75, "eye");

    expect(added).toMatchObject({
      gesture: "YES",
      description: "Patient confirms",
      confidence: 0.75,
      type: "eye",
      language: "en-US",
      source: "camera",
      timestamp: 1_700_000_000_000,
    });
    expect(added).not.toHaveProperty("sessionId");
    expect(JSON.parse(map.get(KEY)!)).toEqual([added]);

    const newer = mod.addGestureLog("NO", "Patient refuses", 0.6, "hand");
    expect((JSON.parse(map.get(KEY)!) as GestureLogEntry[]).map((e) => e.id)).toEqual([
      newer.id,
      added.id,
    ]);
  });

  it("records an explicit source, language and session", async () => {
    installStorage();
    const mod = await load();
    const added = mod.addGestureLog("WATER", "Water please", 0.9, "hand", "hi-IN", {
      source: "manual",
      sessionId: "AB12CD",
    });
    expect(added.source).toBe("manual");
    expect(added.language).toBe("hi-IN");
    expect(added.sessionId).toBe("AB12CD");
  });

  it("omits an empty session id", async () => {
    installStorage();
    const mod = await load();
    expect(
      mod.addGestureLog("HELP", "x", 0.5, "hand", "en-US", { sessionId: "" })
    ).not.toHaveProperty("sessionId");
  });

  it("caps the log at 300 entries", async () => {
    const map = installStorage();
    const mod = await load();
    for (let i = 0; i < 305; i += 1) mod.addGestureLog("HELP", `call-${i}`, 0.5, "hand");
    const stored = JSON.parse(map.get(KEY)!) as GestureLogEntry[];
    expect(stored).toHaveLength(300);
    expect(stored[0].description).toBe("call-304");
    expect(stored[299].description).toBe("call-5");
  });

  it("survives throwing storage", async () => {
    const throwing = throwingStorage();
    vi.stubGlobal("window", { localStorage: throwing });
    vi.stubGlobal("localStorage", throwing);
    const mod = await load();
    expect(mod.addGestureLog("HELP", "x", 0.5, "hand").gesture).toBe("HELP");
  });
});

describe("loadGestureLog validation", () => {
  it("returns [] for corrupt or non-array storage", async () => {
    for (const value of ["{oops", "null", "42", "{}"]) {
      installStorage({ [KEY]: value });
      const mod = await load();
      const log = mod.loadGestureLog();
      expect(Array.isArray(log)).toBe(true);
      expect(log).toEqual([]);
    }
  });

  it("drops malformed entries but keeps valid ones", async () => {
    const good = entry();
    installStorage({
      [KEY]: JSON.stringify([good, null, "junk", { id: "x" }, { gesture: "HELP" }]),
    });
    const mod = await load();
    expect(mod.loadGestureLog()).toEqual([good]);
  });
});

describe("local status application", () => {
  it("acknowledges an entry", async () => {
    const map = installStorage({ [KEY]: JSON.stringify([entry()]) });
    const mod = await load();
    mod.applyStatusLocal("g1", "acknowledge");
    const [stored] = JSON.parse(map.get(KEY)!) as GestureLogEntry[];
    expect(stored.acknowledged).toBe(true);
    expect(typeof stored.acknowledgedAt).toBe("number");
    expect(stored.resolved).toBeUndefined();
  });

  it("escalates an entry", async () => {
    const map = installStorage({ [KEY]: JSON.stringify([entry()]) });
    const mod = await load();
    mod.applyStatusLocal("g1", "escalate");
    const [stored] = JSON.parse(map.get(KEY)!) as GestureLogEntry[];
    expect(stored.escalated).toBe(true);
    expect(typeof stored.escalatedAt).toBe("number");
  });

  it("resolving also acknowledges", async () => {
    const map = installStorage({ [KEY]: JSON.stringify([entry()]) });
    const mod = await load();
    mod.applyStatusLocal("g1", "resolve");
    const [stored] = JSON.parse(map.get(KEY)!) as GestureLogEntry[];
    expect(stored.resolved).toBe(true);
    expect(stored.acknowledged).toBe(true);
    expect(typeof stored.resolvedAt).toBe("number");
  });

  it("leaves the log untouched for an unknown id", async () => {
    const map = installStorage({ [KEY]: JSON.stringify([entry()]) });
    const mod = await load();
    const before = map.get(KEY);
    mod.applyStatusLocal("missing", "resolve");
    expect(map.get(KEY)).toBe(before);
  });
});

describe("without BroadcastChannel", () => {
  it("is a no-op when the API is unavailable", async () => {
    installStorage();
    vi.stubGlobal("BroadcastChannel", undefined);
    const mod = await load();
    expect(() => mod.addGestureLog("HELP", "x", 0.5, "hand")).not.toThrow();
    expect(() => mod.acknowledgeEntry("g1")).not.toThrow();
    expect(() => mod.clearGestureLog()).not.toThrow();
    expect(FakeChannel.posted).toHaveLength(0);
  });

  it("swallows a constructor failure", async () => {
    installStorage();
    vi.stubGlobal("BroadcastChannel", ThrowingChannel);
    const mod = await load();
    expect(() => mod.addGestureLog("HELP", "x", 0.5, "hand")).not.toThrow();
  });

  it("returns a harmless unsubscribe without a channel", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const mod = await load();
    const unsubscribe = mod.subscribeToGestureUpdates({});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe("broadcast integration", () => {
  it("broadcasts a new gesture with its session", async () => {
    installChannel();
    installStorage();
    const mod = await load();
    mod.addGestureLog("HELP", "x", 0.5, "hand", "en-US", { sessionId: "AB12CD" });

    const posted = FakeChannel.posted.at(-1)!.msg as {
      kind: string;
      entry: GestureLogEntry;
      sessionId?: string;
    };
    expect(posted.kind).toBe("new_gesture");
    expect(posted.entry.gesture).toBe("HELP");
    expect(posted.sessionId).toBe("AB12CD");
  });

  it("reuses one channel for every broadcast", async () => {
    installChannel();
    installStorage();
    const mod = await load();
    mod.addGestureLog("HELP", "a", 0.5, "hand");
    mod.acknowledgeEntry("g1");
    mod.clearGestureLog();
    expect(FakeChannel.instances).toHaveLength(1);
    expect(FakeChannel.posted.map((p) => (p.msg as { kind: string }).kind)).toEqual([
      "new_gesture",
      "action",
      "clear",
    ]);
  });

  it("broadcasts an acknowledge action alongside the local update", async () => {
    installChannel();
    const map = installStorage({ [KEY]: JSON.stringify([entry()]) });
    const mod = await load();
    mod.acknowledgeEntry("g1");

    const posted = FakeChannel.posted.at(-1)!.msg as {
      kind: string;
      action: { type: string; entryId: string; timestamp: number };
    };
    expect(posted.kind).toBe("action");
    expect(posted.action).toMatchObject({ type: "acknowledge", entryId: "g1" });
    expect(posted.action.timestamp).toBe(1_700_000_000_000);
    const [stored] = JSON.parse(map.get(KEY)!) as GestureLogEntry[];
    expect(stored.acknowledged).toBe(true);
  });

  it("delivers gesture, clear and action messages to subscribers", async () => {
    installChannel();
    installStorage();
    const mod = await load();
    const seen: string[] = [];
    const onGesture = vi.fn((e: GestureLogEntry) => seen.push(`gesture:${e.id}`));
    const onClear = vi.fn(() => seen.push("clear"));
    const onAction = vi.fn((type: string, id: string) => seen.push(`action:${type}:${id}`));
    const unsubscribe = mod.subscribeToGestureUpdates({ onGesture, onClear, onAction });
    const channel = FakeChannel.instances.at(-1)!;

    channel.emit({ kind: "new_gesture", entry: entry({ id: "g1" }) });
    channel.emit({ kind: "clear" });
    channel.emit({ kind: "action", action: { type: "acknowledge", entryId: "g1" } });
    channel.emit({ kind: "unknown", entry: entry() });
    channel.emit(null);

    expect(seen).toEqual(["gesture:g1", "clear", "action:acknowledge:g1"]);

    unsubscribe();
    channel.emit({ kind: "clear" });
    expect(seen).toHaveLength(3);
  });
});