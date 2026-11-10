import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dequeueAll,
  enqueue,
  enqueueMetricsLatestWins,
  remove,
  requestBackgroundSync,
} from "@/lib/outbox";
import type { GestureLogEntry } from "@/types";

/** Minimal IndexedDB good enough for the outbox's one-store usage. */
function createFakeIdb() {
  const tables = new Map<string, Map<number, unknown>>();
  let seq = 1;
  let opens = 0;

  function request<T>(compute: () => T) {
    const req = { result: undefined as T | undefined, error: null as unknown, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
    queueMicrotask(() => {
      try {
        req.result = compute();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
    });
    return req;
  }

  const db = {
    objectStoreNames: { contains: (name: string) => tables.has(name) },
    createObjectStore: (name: string) => {
      tables.set(name, new Map());
      return {};
    },
    transaction: () => ({
      objectStore: (name: string) => {
        const table = tables.get(name)!;
        return {
          add: (value: unknown) =>
            request(() => {
              const key = seq++;
              table.set(key, value);
              return key;
            }),
          getAllKeys: () => request(() => Array.from(table.keys())),
          getAll: () => request(() => Array.from(table.values())),
          delete: (key: number) =>
            request(() => {
              table.delete(key);
              return true;
            }),
        };
      },
    }),
  };

  const indexedDB = {
    open: () => {
      opens += 1;
      const req = {
        result: db,
        error: null as unknown,
        onupgradeneeded: null as null | (() => void),
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
      };
      queueMicrotask(() => {
        if (!tables.has("outbox")) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };

  return {
    indexedDB,
    tables,
    opens: () => opens,
    reset: () => {
      for (const table of tables.values()) table.clear();
      seq = 1;
    },
  };
}

/**
 * The module memoises its connection, so the same fake DB must serve every
 * case in this file; `reset()` gives each test a clean store.
 */
let fakeIdb: ReturnType<typeof createFakeIdb> | null = null;

function installFakeIndexedDB() {
  if (!fakeIdb) fakeIdb = createFakeIdb();
  vi.stubGlobal("indexedDB", fakeIdb.indexedDB);
  return fakeIdb;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function alertEntry(id: string): GestureLogEntry {
  return {
    id,
    gesture: "HELP",
    description: "",
    confidence: 0.9,
    type: "hand",
    timestamp: 1,
    language: "en-US",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fakeIdb?.reset();
});

describe("without IndexedDB", () => {
  it("degrades every queue operation to a safe no-op", async () => {
    expect(await dequeueAll()).toEqual([]);
    await expect(
      enqueue({ channel: "alert", body: { type: "new_gesture", entry: alertEntry("e1") } })
    ).resolves.toBeUndefined();
    await expect(remove(1)).resolves.toBeUndefined();
    await expect(
      enqueueMetricsLatestWins({
        channel: "metrics",
        body: { type: "metrics", patientMetrics: { alertnessScore: 50 }, deviceId: "dev" },
      })
    ).resolves.toBeUndefined();
  });
});

describe("queue persistence", () => {
  it("stores, lists and removes items in order", async () => {
    installFakeIndexedDB();
    await enqueue({ channel: "alert", body: { type: "new_gesture", entry: alertEntry("e1") } });
    await enqueue({ channel: "action", body: { type: "acknowledge", entryId: "e1", action: { type: "acknowledge", entryId: "e1", timestamp: 1 } } });

    const items = await dequeueAll();
    expect(items.map((i) => i.key)).toEqual([1, 2]);
    expect(items[0].payload.channel).toBe("alert");
    expect(items[1].payload.channel).toBe("action");

    await remove(1);
    const remaining = await dequeueAll();
    expect(remaining.map((i) => i.key)).toEqual([2]);
  });

  it("autoincrements keys and returns an empty list initially", async () => {
    const { opens } = installFakeIndexedDB();
    expect(await dequeueAll()).toEqual([]);
    await enqueue({ channel: "alert", body: { type: "new_gesture", entry: alertEntry("a") } });
    await enqueue({ channel: "alert", body: { type: "new_gesture", entry: alertEntry("b") } });
    expect((await dequeueAll()).map((i) => i.key)).toEqual([1, 2]);
    // The connection promise is cached: only one open for the whole process.
    expect(opens()).toBe(1);
  });
});

describe("metrics latest-wins", () => {
  it("replaces older queued metrics for the same device only", async () => {
    installFakeIndexedDB();
    await enqueue({ channel: "alert", body: { type: "new_gesture", entry: alertEntry("e1") } });
    await enqueueMetricsLatestWins({
      channel: "metrics",
      body: { type: "metrics", patientMetrics: { alertnessScore: 10 }, deviceId: "dev1" },
    });
    await enqueueMetricsLatestWins({
      channel: "metrics",
      body: { type: "metrics", patientMetrics: { alertnessScore: 20 }, deviceId: "dev2" },
    });
    await enqueueMetricsLatestWins({
      channel: "metrics",
      body: { type: "metrics", patientMetrics: { alertnessScore: 90 }, deviceId: "dev1" },
    });

    const items = await dequeueAll();
    const metrics = items
      .map((i) => i.payload)
      .filter((p) => p.channel === "metrics") as Array<{
      body: { deviceId: string; patientMetrics: { alertnessScore: number } };
    }>;
    expect(metrics).toHaveLength(2);
    expect(metrics.find((m) => m.body.deviceId === "dev1")!.body.patientMetrics.alertnessScore).toBe(90);
    expect(metrics.find((m) => m.body.deviceId === "dev2")!.body.patientMetrics.alertnessScore).toBe(20);
    // The alert is untouched.
    expect(items.filter((i) => i.payload.channel === "alert")).toHaveLength(1);
  });
});

describe("background sync", () => {
  it("registers a background-sync tag with the service worker", async () => {
    installFakeIndexedDB();
    const register = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ sync: { register } }) } });
    requestBackgroundSync();
    await settle();
    expect(register).toHaveBeenCalledWith("carespeak-flush");
  });

  it("swallows a rejected registration", async () => {
    const register = vi.fn(async () => {
      throw new Error("not allowed");
    });
    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ sync: { register } }) } });
    expect(() => requestBackgroundSync()).not.toThrow();
    await settle();
    expect(register).toHaveBeenCalled();
  });

  it("is safe with no service worker or no navigator", async () => {
    vi.stubGlobal("navigator", {});
    expect(() => requestBackgroundSync()).not.toThrow();
    vi.unstubAllGlobals();
    expect(() => requestBackgroundSync()).not.toThrow();
  });
});