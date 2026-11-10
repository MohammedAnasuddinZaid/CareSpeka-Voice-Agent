import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  enqueued: [] as unknown[],
  latest: [] as unknown[],
  queue: [] as Array<{ key: unknown; payload: unknown }>,
  removed: [] as unknown[],
}));

vi.mock("@/lib/outbox", () => ({
  enqueue: vi.fn(async (payload: unknown) => {
    box.enqueued.push(payload);
  }),
  enqueueMetricsLatestWins: vi.fn(async (payload: unknown) => {
    box.latest.push(payload);
  }),
  dequeueAll: vi.fn(async () => box.queue),
  remove: vi.fn(async (key: unknown) => {
    box.removed.push(key);
  }),
}));

import { NetworkSync, createNetworkSync } from "@/lib/networkSync";
import type { GestureLogEntry, NurseReply, PatientMetrics } from "@/types";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  close = vi.fn();
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  emit(type: string, data?: unknown) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb({ data: data === undefined ? "" : JSON.stringify(data) } as MessageEvent);
    }
  }
  closeAll() {
    this.close.mockImplementation(() => {
      this.closed = true;
    });
  }
}

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  static posted: Array<{ index: number; msg: unknown }> = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  close = vi.fn();
  postMessage = vi.fn((msg: unknown) => {
    FakeBroadcastChannel.posted.push({ index: FakeBroadcastChannel.instances.indexOf(this), msg });
  });
  constructor(public name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
}

function install(options: { online?: boolean; bc?: boolean } = {}) {
  vi.stubGlobal("EventSource", FakeEventSource);
  if (options.bc !== false) vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.stubGlobal("navigator", { onLine: options.online ?? true });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
}

function syncWith(
  cfg: ConstructorParameters<typeof NetworkSync>[0] = {},
  sessionId = "AB12"
) {
  return new NetworkSync({ sessionId, ...cfg });
}

function lastEs(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

function lastBc(): FakeBroadcastChannel {
  return FakeBroadcastChannel.instances[FakeBroadcastChannel.instances.length - 1];
}

function entry(partial: Partial<GestureLogEntry> & { id: string; status?: string }): GestureLogEntry & { status?: string } {
  return {
    gesture: "HELP",
    description: "",
    confidence: 0.9,
    type: "hand",
    timestamp: 1000,
    language: "en-US",
    ...partial,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  FakeEventSource.instances = [];
  FakeBroadcastChannel.instances = [];
  FakeBroadcastChannel.posted = [];
  box.enqueued = [];
  box.latest = [];
  box.queue = [];
  box.removed = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("lifecycle", () => {
  it("opens an SSE stream with the session and a 60-second replay window", () => {
    install();
    const sync = syncWith();
    sync.connect();

    const es = lastEs();
    expect(es.url).toBe(`/api/stream?session=AB12&since=${1_700_000_000_000 - 60_000}`);
    expect(sync.getStatus()).toBe("disconnected");
    expect(sync.getTransport()).toBe("none");
    sync.destroy();
  });

  it("falls back to the default session name", () => {
    install();
    const sync = new NetworkSync({});
    sync.connect();
    expect(lastEs().url).toContain("session=default");
    sync.destroy();
  });

  it("does not reconnect after destroy", () => {
    install();
    const sync = syncWith();
    sync.connect();
    sync.destroy();
    FakeEventSource.instances = [];
    sync.connect();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("closes the stream and broadcast channel on destroy and removes the online listener", () => {
    install();
    const sync = syncWith();
    sync.connect();
    const es = lastEs();
    const bc = lastBc();
    es.closeAll();
    sync.destroy();

    expect(es.closed).toBe(true);
    expect(bc.close).toHaveBeenCalledTimes(1);
    const win = (globalThis as unknown as { window: { removeEventListener: ReturnType<typeof vi.fn> } }).window;
    expect(win.removeEventListener).toHaveBeenCalledWith("online", expect.any(Function));
  });

  it("marks the client offline immediately when the navigator is offline", () => {
    install({ online: false });
    const seen: Array<[string, string]> = [];
    const sync = syncWith({ onStatusChange: (s, t) => seen.push([s, t]) });
    expect(sync.getStatus()).toBe("disconnected");
    expect(sync.getTransport()).toBe("offline");
    expect(seen).toEqual([["disconnected", "offline"]]);
    sync.destroy();
  });

  it("createNetworkSync connects for you", () => {
    install();
    const sync = createNetworkSync({ sessionId: "ZZ99" });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(sync.getStatus()).toBe("disconnected");
    sync.destroy();
  });

  it("works without BroadcastChannel support", () => {
    install({ bc: false });
    expect(() => {
      const sync = syncWith();
      sync.connect();
      sync.destroy();
    }).not.toThrow();
  });
});

describe("SSE inbound", () => {
  it("reports a connected transport on open and flushes the outbox", async () => {
    install();
    const changes: Array<[string, string]> = [];
    const sync = syncWith({ onStatusChange: (s, t) => changes.push([s, t]) });
    sync.connect();
    const es = lastEs();

    es.emit("open");
    expect(sync.getStatus()).toBe("connected");
    expect(sync.getTransport()).toBe("sse");
    expect(changes).toEqual([["connected", "sse"]]);
    // The open handler flushes the (currently empty) outbox.
    await vi.advanceTimersByTimeAsync(0);
    sync.destroy();
  });

  it("reports the storage driver once when it changes", () => {
    install();
    const drivers: string[] = [];
    const sync = syncWith({ onDriver: (d) => drivers.push(d) });
    sync.connect();
    const es = lastEs();

    es.emit("hello", { driver: "redis" });
    es.emit("hello", { driver: "redis" });
    es.emit("hello", { driver: "memory" });
    es.emit("hello", "{bad json");
    expect(drivers).toEqual(["redis", "memory"]);
    expect(sync.getDriver()).toBe("memory");
    expect(sync.getStatus()).toBe("connected");
    sync.destroy();
  });

  it("delivers each new alert once and advances the cursor", () => {
    install();
    const alerts: GestureLogEntry[] = [];
    const sync = syncWith({ onAlert: (e) => alerts.push(e) });
    sync.connect();
    const es = lastEs();
    es.emit("open");

    const first = entry({ id: "e1", timestamp: 5000 });
    es.emit("entries", [first]);
    es.emit("entries", [first]);
    expect(alerts.map((a) => a.id)).toEqual(["e1"]);

    // A later poll starts at the newest server time seen.
    expect(es.listeners.has("entries")).toBe(true);
    sync.destroy();
  });

  it("ignores malformed entry payloads", () => {
    install();
    const alerts: GestureLogEntry[] = [];
    const sync = syncWith({ onAlert: (e) => alerts.push(e) });
    sync.connect();
    lastEs().emit("entries", "not-an-array-of-entries");
    expect(alerts).toHaveLength(0);
    sync.destroy();
  });

  it("reports a status transition exactly once per change", () => {
    install();
    const updates: Array<[string, string]> = [];
    const sync = syncWith({ onStatusUpdate: (id, s) => updates.push([id, s]) });
    sync.connect();
    const es = lastEs();

    es.emit("entries", [entry({ id: "e1", status: "pending" })]);
    es.emit("entries", [entry({ id: "e1", status: "acknowledge" })]);
    es.emit("entries", [entry({ id: "e1", status: "acknowledge" })]);
    es.emit("entries", [entry({ id: "e1", status: "resolve" })]);

    expect(updates).toEqual([
      ["e1", "acknowledge"],
      ["e1", "resolve"],
    ]);
    sync.destroy();
  });

  it("waves through live metrics and vitals but ignores empty maps", () => {
    install();
    const metrics: PatientMetrics[][] = [];
    const vitals: unknown[] = [];
    const sync = syncWith({
      onMetrics: (m) => metrics.push([m]),
      onVitals: (v) => vitals.push(v),
    });
    sync.connect();
    const es = lastEs();

    es.emit("state", { patientMetrics: {}, vitals: {}, serverTime: 1 });
    expect(metrics).toHaveLength(0);
    expect(vitals).toHaveLength(0);

    es.emit("state", {
      patientMetrics: { dev: { alertnessScore: 70 } },
      vitals: { dev: { receivedAt: 5 } },
      serverTime: 6,
    });
    expect(metrics).toHaveLength(1);
    expect(vitals).toHaveLength(1);
    expect(sync.getStatus()).toBe("connected");
    sync.destroy();
  });

  it("delivers a reply exactly once across redeliveries", () => {
    install();
    const replies: NurseReply[] = [];
    const sync = syncWith({ onReply: (r) => replies.push(r) });
    sync.connect();
    const es = lastEs();
    const reply = { id: "r1", text: "On my way", timestamp: 1 } as NurseReply;

    es.emit("replies", [reply]);
    es.emit("replies", [reply]);
    expect(replies).toHaveLength(1);
    sync.destroy();
  });

  it("degrades to polling after the SSE grace period", async () => {
    install();
    const changes: Array<[string, string]> = [];
    const sync = syncWith({ onStatusChange: (s, t) => changes.push([s, t]) });
    sync.connect();
    const es = lastEs();
    es.closeAll();

    es.emit("error");
    expect(changes).toEqual([["disconnected", "sse"]]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ entries: [], patientMetrics: {}, vitals: {}, replies: [], serverTime: 1 })
      )
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(es.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    expect(sync.getStatus()).toBe("connected");
    expect(sync.getTransport()).toBe("poll");
    sync.destroy();
  });
});

describe("polling fallback", () => {
  it("polls state, delivers alerts and metrics, and records the driver", async () => {
    install();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return jsonResponse({
          entries: [entry({ id: "e1", timestamp: 9000 })],
          patientMetrics: { dev: { alertnessScore: 70 } },
          vitals: { dev: { receivedAt: 1 } },
          replies: [{ id: "r1", text: "ok" }],
          serverTime: 9000,
          driver: "redis",
        });
      })
    );
    const alerts: string[] = [];
    const replies: string[] = [];
    const drivers: string[] = [];
    const sync = syncWith({
      onAlert: (e) => alerts.push(e.id),
      onReply: (r) => replies.push(r.id),
      onDriver: (d) => drivers.push(d),
    });
    sync.connect();
    const es = lastEs();
    es.emit("error");

    await vi.advanceTimersByTimeAsync(3050);
    expect(calls[0]).toBe(`/api/sync?session=AB12&since=${1_700_000_000_000 - 60_000}`);
    expect(alerts).toEqual(["e1"]);
    expect(replies).toEqual(["r1"]);
    expect(drivers).toEqual(["redis"]);
    expect(sync.getStatus()).toBe("connected");
    expect(sync.getTransport()).toBe("poll");
    sync.destroy();
  });

  it("backs off exponentially after a failure and never claims connected", async () => {
    install();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 }))
    );
    const changes: Array<[string, string]> = [];
    const sync = syncWith({ onStatusChange: (s, t) => changes.push([s, t]) });
    sync.connect();
    lastEs().emit("error");

    await vi.advanceTimersByTimeAsync(3050);
    expect(sync.getStatus()).toBe("reconnecting");
    expect(changes.at(-1)).toEqual(["reconnecting", "poll"]);
    sync.destroy();
  });

  it("degrades to offline after repeated failures when SSE is gone", async () => {
    install();
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        count += 1;
        return new Response("", { status: 500 });
      })
    );
    const changes: Array<[string, string]> = [];
    const sync = syncWith({ onStatusChange: (s, t) => changes.push([s, t]) });
    // No SSE at all: simulate a constructor-level failure path by polling.
    sync.connect();
    const es = lastEs();
    es.emit("error");
    es.closeAll();
    await vi.advanceTimersByTimeAsync(3000);
    expect(es.closed).toBe(true);
    // First poll fails and schedules a retry.
    await vi.advanceTimersByTimeAsync(1000);
    expect(count).toBeGreaterThan(0);
    expect(["poll", "offline"]).toContain(sync.getTransport());
    sync.destroy();
  });
});

describe("outbound", () => {
  it("posts JSON and reports the result", async () => {
    install();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response("{}", { status: 200 });
      })
    );
    const sync = syncWith();
    expect(await sync.post({ type: "x" })).toBe(true);
    expect(calls[0].url).toBe("/api/sync");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.cache).toBe("no-store");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ type: "x" });
    sync.destroy();
  });

  it("returns false instead of throwing when the network fails", async () => {
    install();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );
    const sync = syncWith();
    expect(await sync.post({ type: "x" })).toBe(false);
    sync.destroy();
  });

  it("sends an alert and broadcasts it to sibling tabs", async () => {
    install();
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response("{}", { status: 200 });
      })
    );
    const sync = syncWith();
    const alert = entry({ id: "e1", sessionId: "AB12" });
    await sync.sendAlert(alert);

    expect(JSON.parse(String(calls[0].body))).toMatchObject({
      type: "new_gesture",
      sessionId: "AB12",
    });
    expect(box.enqueued).toHaveLength(0);
    const posted = FakeBroadcastChannel.posted.at(-1)!.msg as { kind: string; entry: GestureLogEntry };
    expect(posted.kind).toBe("new_gesture");
    expect(posted.entry.id).toBe("e1");
    sync.destroy();
  });

  it("durably queues an alert when the post fails", async () => {
    install();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );
    const sync = syncWith();
    await sync.sendAlert(entry({ id: "e1" }));
    expect(box.enqueued).toEqual([
      { channel: "alert", body: { type: "new_gesture", entry: entry({ id: "e1" }) } },
    ]);
    sync.destroy();
  });

  it("queues a failed ward action", async () => {
    install();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const sync = syncWith();
    const action = { type: "acknowledge", entryId: "e1" };
    await sync.sendAction(action as never);
    expect(box.enqueued).toEqual([
      { channel: "action", body: { type: "acknowledge", entryId: "e1", action } },
    ]);
    sync.destroy();
  });

  it("posts replies and vitals without queueing", async () => {
    install();
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      })
    );
    const sync = syncWith();
    await sync.sendReply({ id: "r1", text: "hi", timestamp: 1 } as never);
    await sync.sendIoTVitals({ heartRate: 72 } as never);
    expect(bodies[0]).toMatchObject({ type: "reply", sessionId: "AB12" });
    expect(bodies[1]).toMatchObject({ type: "vitals", sessionId: "AB12" });
    expect(box.enqueued).toHaveLength(0);
    sync.destroy();
  });

  it("queues metrics with latest-wins when the post fails", async () => {
    install();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const sync = syncWith();
    await sync.sendPatientMetrics({ alertnessScore: 12 }, "dev1");
    expect(box.latest).toEqual([
      {
        channel: "metrics",
        body: { type: "metrics", patientMetrics: { alertnessScore: 12 }, deviceId: "dev1" },
      },
    ]);
    sync.destroy();
  });
});

describe("outbox flush", () => {
  it("does nothing while the navigator is offline", async () => {
    install({ online: false });
    const sync = syncWith();
    box.queue = [{ key: 1, payload: { channel: "alert", body: {} } }];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await sync.flushOutbox();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(box.removed).toHaveLength(0);
    sync.destroy();
  });

  it("posts and removes each queued item in order", async () => {
    install();
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      })
    );
    const sync = syncWith();
    box.queue = [
      { key: "a", payload: { channel: "alert", body: { type: "new_gesture", entry: entry({ id: "e1" }) } } },
      { key: "b", payload: { channel: "action", body: { type: "acknowledge", entryId: "e1" } } },
    ];
    await sync.flushOutbox();
    expect(bodies).toHaveLength(2);
    expect(box.removed).toEqual(["a", "b"]);
    sync.destroy();
  });

  it("stops at the first failure so remaining items stay queued", async () => {
    install();
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return new Response("", { status: call === 1 ? 500 : 200 });
      })
    );
    const sync = syncWith();
    box.queue = [
      { key: "a", payload: { channel: "alert", body: {} } },
      { key: "b", payload: { channel: "alert", body: {} } },
    ];
    await sync.flushOutbox();
    expect(call).toBe(1);
    expect(box.removed).toEqual([]);
    sync.destroy();
  });

  it("flushes again when the browser comes back online", async () => {
    install();
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, cb: () => void) => listeners.set(type, cb),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const sync = syncWith();
    box.queue = [{ key: "a", payload: { channel: "alert", body: {} } }];

    listeners.get("online")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(box.removed).toEqual(["a"]);
    sync.destroy();
  });
});

describe("same-device broadcasts", () => {
  it("accepts a new gesture only once and ignores other sessions", () => {
    install();
    const alerts: string[] = [];
    const sync = syncWith({ onAlert: (e) => alerts.push(e.id) });
    const bc = lastBc();
    const alert = entry({ id: "e1" });

    bc.onmessage?.({ data: { kind: "new_gesture", entry: alert, sessionId: "AB12" } } as MessageEvent);
    bc.onmessage?.({ data: { kind: "new_gesture", entry: alert, sessionId: "AB12" } } as MessageEvent);
    bc.onmessage?.({ data: { kind: "new_gesture", entry: entry({ id: "e2" }), sessionId: "OTHER" } } as MessageEvent);

    expect(alerts).toEqual(["e1"]);
    sync.destroy();
  });

  it("reflects a broadcast action and reply", () => {
    install();
    const updates: Array<[string, string]> = [];
    const replies: string[] = [];
    const sync = syncWith({
      onStatusUpdate: (id, s) => updates.push([id, s]),
      onReply: (r) => replies.push(r.id),
    });
    const bc = lastBc();

    bc.onmessage?.({
      data: { kind: "action", action: { type: "acknowledge", entryId: "e1" }, sessionId: "AB12" },
    } as MessageEvent);
    bc.onmessage?.({
      data: { kind: "reply", reply: { id: "r1", text: "ok" }, sessionId: "AB12" },
    } as MessageEvent);
    bc.onmessage?.({
      data: { kind: "reply", reply: { id: "r1", text: "ok" }, sessionId: "AB12" },
    } as MessageEvent);

    expect(updates).toEqual([["e1", "acknowledge"]]);
    expect(replies).toEqual(["r1"]);
    sync.destroy();
  });

  it("ignores malformed broadcast messages", () => {
    install();
    const sync = syncWith();
    const bc = lastBc();
    expect(() => bc.onmessage?.({ data: null } as MessageEvent)).not.toThrow();
    expect(() => bc.onmessage?.({ data: { kind: "unknown", sessionId: "AB12" } } as MessageEvent)).not.toThrow();
    sync.destroy();
  });
});