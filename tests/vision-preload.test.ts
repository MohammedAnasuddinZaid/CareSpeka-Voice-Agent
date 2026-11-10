import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: vi.fn(async () => ({})) },
}));

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
const EYE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

type IdleCallback = (cb: () => void, opts?: { timeout: number }) => number;

interface Harness {
  idle: Array<{ cb: () => unknown; opts?: { timeout: number } }>;
  fetch: ReturnType<typeof vi.fn>;
  preloadVisionAssets: (kind: "hand" | "eye") => void;
  forVisionTasks: ReturnType<typeof vi.fn>;
}

/**
 * The module memoises which kinds it has prefetched, so every case imports a
 * fresh copy after `vi.resetModules()`.
 */
async function load(
  options: { connection?: { saveData?: boolean; effectiveType?: string }; idle?: boolean } = {}
): Promise<Harness> {
  const idle: Harness["idle"] = [];
  const win: Record<string, unknown> = {};
  if (options.idle !== false) {
    const ric: IdleCallback = (cb, opts) => {
      idle.push({ cb, opts });
      return idle.length;
    };
    win.requestIdleCallback = ric;
  }
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", options.connection ? { connection: options.connection } : {});
  const fetchSpy = vi.fn(async () => new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);

  vi.resetModules();
  const [{ preloadVisionAssets }, mp] = await Promise.all([
    import("@/lib/visionPreload"),
    import("@mediapipe/tasks-vision"),
  ]);

  // The mocked factory instance is shared across `resetModules`, so reset both
  // recorded calls and any queued one-shot rejections per case.
  const forVisionTasks = vi.mocked(mp.FilesetResolver.forVisionTasks);
  forVisionTasks.mockReset();
  forVisionTasks.mockResolvedValue({} as never);

  return {
    idle,
    fetch: fetchSpy,
    preloadVisionAssets,
    forVisionTasks,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("preload gating", () => {
  it("does nothing without a window", async () => {
    const { preloadVisionAssets, fetch, forVisionTasks } = await load();
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", fetch);

    preloadVisionAssets("hand");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(forVisionTasks).not.toHaveBeenCalled();
  });

  it("respects Save-Data", async () => {
    const { preloadVisionAssets, fetch, idle } = await load({ connection: { saveData: true } });
    preloadVisionAssets("hand");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(idle).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips 2g-class connections", async () => {
    const { preloadVisionAssets, fetch, idle } = await load({
      connection: { effectiveType: "2g" },
    });
    preloadVisionAssets("hand");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(idle).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows 3g and unknown connections", async () => {
    const slow = await load({ connection: { effectiveType: "3g" } });
    slow.preloadVisionAssets("hand");
    expect(slow.idle).toHaveLength(1);

    const unknown = await load({ connection: { effectiveType: "4g" } });
    unknown.preloadVisionAssets("eye");
    expect(unknown.idle).toHaveLength(1);
  });
});

describe("prefetch behaviour", () => {
  it("warms the WASM graph and the model during idle time", async () => {
    const { preloadVisionAssets, fetch, idle, forVisionTasks } = await load();
    // A failed model fetch must never disturb the caller.
    fetch.mockRejectedValueOnce(new TypeError("offline"));

    preloadVisionAssets("hand");
    expect(idle).toHaveLength(1);
    expect(idle[0].opts).toEqual({ timeout: 4000 });

    await idle[0].cb();
    await settle();

    expect(forVisionTasks).toHaveBeenCalledTimes(1);
    expect(forVisionTasks).toHaveBeenCalledWith(WASM_URL);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(HAND_MODEL, { mode: "cors", cache: "force-cache" });
  });

  it("falls back to a 2.5-second timer without requestIdleCallback", async () => {
    const { preloadVisionAssets, fetch, forVisionTasks } = await load({ idle: false });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    preloadVisionAssets("eye");

    const scheduled = setTimeoutSpy.mock.calls.find((call) => call[1] === 2_500);
    expect(scheduled).toBeDefined();
    // Nothing runs until the timer callback is invoked.
    expect(forVisionTasks).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    await (scheduled![0] as () => Promise<void>)();
    expect(forVisionTasks).toHaveBeenCalledWith(WASM_URL);
    expect(fetch).toHaveBeenCalledWith(EYE_MODEL, { mode: "cors", cache: "force-cache" });
    setTimeoutSpy.mockRestore();
  });

  it("prefetches each asset kind at most once", async () => {
    const { preloadVisionAssets, idle } = await load();
    preloadVisionAssets("hand");
    preloadVisionAssets("hand");
    expect(idle).toHaveLength(1);
  });

  it("prefetches distinct kinds independently", async () => {
    const { preloadVisionAssets, idle } = await load();
    preloadVisionAssets("hand");
    preloadVisionAssets("eye");
    expect(idle).toHaveLength(2);
  });

  it("still fetches the model when the WASM loader fails", async () => {
    const { preloadVisionAssets, fetch, idle, forVisionTasks } = await load();
    forVisionTasks.mockRejectedValueOnce(new Error("cdn down"));

    preloadVisionAssets("hand");
    await idle[0].cb();
    await settle();

    expect(forVisionTasks).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(HAND_MODEL, { mode: "cors", cache: "force-cache" });
  });

  it("does not retry a failed prefetch on later calls", async () => {
    const { preloadVisionAssets, idle, forVisionTasks } = await load();
    forVisionTasks.mockRejectedValueOnce(new Error("cdn down"));

    preloadVisionAssets("hand");
    await idle[0].cb();
    await settle();

    preloadVisionAssets("hand");
    expect(idle).toHaveLength(1);
    expect(forVisionTasks).toHaveBeenCalledTimes(1);
  });
});
