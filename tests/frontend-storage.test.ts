import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function fakeStorage(initial: Record<string, string> = {}) {
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

function installWindow(storage: Storage | undefined, origin = "http://localhost:3000") {
  vi.stubGlobal("window", { localStorage: storage, location: { origin } });
  if (storage) vi.stubGlobal("localStorage", storage);
}

import {
  clearSession,
  generateDeviceId,
  getActiveCareSession,
  getDashboardOrigin,
  getNurseDashboardUrl,
  getOrCreateSession,
  getSession,
  rememberCareSession,
  setDashboardOrigin,
  setSessionId,
} from "@/lib/session";
import {
  fetchPairStatus,
  getOrCreatePairToken,
  regeneratePairToken,
  registerPairToken,
} from "@/lib/pairing";

const ID_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session — server rendering (no window)", () => {
  it("mints a storage-free session", () => {
    const session = getOrCreateSession();
    expect(session.sessionId).toMatch(ID_RE);
    expect(session.deviceId).toBe("server");
    expect(typeof session.createdAt).toBe("number");
  });

  it("returns a clean, upper-cased session id without a device id", () => {
    expect(setSessionId("  ab12cd  ")).toMatchObject({ sessionId: "AB12CD", deviceId: "server" });
  });

  it("treats every storage helper as a safe no-op", () => {
    expect(getSession()).toBeNull();
    expect(getActiveCareSession()).toBeNull();
    expect(getDashboardOrigin()).toBe("");
    expect(getNurseDashboardUrl("AB12")).toBe("");
    expect(() => clearSession()).not.toThrow();
    expect(() => rememberCareSession("AB12", "p")).not.toThrow();
    expect(() => setDashboardOrigin("http://x")).not.toThrow();
  });
});

describe("device id", () => {
  it("generates and then reuses a persisted id", () => {
    const { store, map } = fakeStorage();
    installWindow(store);
    const first = generateDeviceId();
    expect(first).toMatch(/^device_[0-9a-z]+_[a-z0-9]{6}$/);
    expect(map.get("carespeak_device_id")).toBe(first);
    expect(generateDeviceId()).toBe(first);
  });

  it("still returns an id when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as unknown as Storage;
    installWindow(throwing);
    expect(generateDeviceId()).toMatch(/^device_/);
  });
});

describe("session lifecycle", () => {
  it("creates, persists and reuses a browser session", () => {
    const { store, map } = fakeStorage();
    installWindow(store);
    const first = getOrCreateSession();
    expect(first.deviceId).not.toBe("server");
    expect(JSON.parse(map.get("carespeak_session")!)).toEqual(first);
    expect(getOrCreateSession()).toEqual(first);
    expect(getSession()).toEqual(first);
  });

  it("replaces a corrupt or incomplete stored session", () => {
    const { store, map } = fakeStorage({
      carespeak_session: JSON.stringify({ sessionId: "AB12CD" }),
    });
    installWindow(store);
    const session = getOrCreateSession();
    expect(session.sessionId).toMatch(ID_RE);
    expect(session.deviceId).toBeTruthy();

    map.set("carespeak_session", "not json");
    expect(getOrCreateSession().sessionId).toMatch(ID_RE);
  });

  it("returns null when getSession reads invalid JSON", () => {
    const { store } = fakeStorage({ carespeak_session: "{oops" });
    installWindow(store);
    expect(getSession()).toBeNull();
  });

  it("pairs to a session by uppercasing and persisting it", () => {
    const { store, map } = fakeStorage({ carespeak_device_id: "device_keep" });
    installWindow(store);
    const session = setSessionId("  xy99zz ");
    expect(session.sessionId).toBe("XY99ZZ");
    expect(session.deviceId).toBe("device_keep");
    expect(getSession()).toEqual(session);
    expect(JSON.parse(map.get("carespeak_session")!).sessionId).toBe("XY99ZZ");
  });

  it("clears both the session and the remembered care session", () => {
    const { store, map } = fakeStorage();
    installWindow(store);
    getOrCreateSession();
    rememberCareSession("AB12CD", "pair");
    expect(map.has("carespeak_session")).toBe(true);
    expect(map.has("carespeak_active_care_session")).toBe(true);
    clearSession();
    expect(map.has("carespeak_session")).toBe(false);
    expect(map.has("carespeak_active_care_session")).toBe(false);
  });

  it("survives storage failures on every write", () => {
    const throwing = {
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
    installWindow(throwing);
    expect(() => getOrCreateSession()).not.toThrow();
    expect(() => clearSession()).not.toThrow();
  });
});

describe("active care session", () => {
  it("remembers a session and trims its pair token", () => {
    installWindow(fakeStorage().store);
    rememberCareSession("  ab12cd ", "  tok  ");
    const active = getActiveCareSession();
    expect(active).toMatchObject({ sessionId: "AB12CD", pair: "tok" });
    expect(typeof active!.at).toBe("number");
  });

  it("stores a null pair when none is supplied", () => {
    installWindow(fakeStorage().store);
    rememberCareSession("AB12CD");
    expect(getActiveCareSession()?.pair).toBeNull();
  });

  it("preserves a known pair when the same session is remembered bare", () => {
    installWindow(fakeStorage().store);
    rememberCareSession("AB12CD", "pair-token");
    rememberCareSession("ab12cd");
    expect(getActiveCareSession()?.pair).toBe("pair-token");
  });

  it("does not carry a pair across different sessions", () => {
    installWindow(fakeStorage().store);
    rememberCareSession("AB12CD", "pair-token");
    rememberCareSession("ZZ99YY");
    expect(getActiveCareSession()).toMatchObject({ sessionId: "ZZ99YY", pair: null });
  });

  it("rejects ids that fail the session-id contract", () => {
    const { store, map } = fakeStorage();
    installWindow(store);
    for (const bad of ["AB", "AB 12", "AB@12", "A".repeat(33)]) rememberCareSession(bad, "p");
    expect(map.has("carespeak_active_care_session")).toBe(false);
  });

  it("returns null for malformed stored values or invalid ids", () => {
    const { store, map } = fakeStorage();
    installWindow(store);
    map.set("carespeak_active_care_session", "{nope");
    expect(getActiveCareSession()).toBeNull();
    map.set("carespeak_active_care_session", JSON.stringify({ sessionId: "AB", pair: null, at: 1 }));
    expect(getActiveCareSession()).toBeNull();
    map.set("carespeak_active_care_session", JSON.stringify({ sessionId: " ab12cd ", pair: " p ", at: undefined }));
    expect(getActiveCareSession()).toEqual({ sessionId: "AB12CD", pair: "p", at: 0 });
  });
});

describe("dashboard origin", () => {
  it("defaults to the current window origin", () => {
    installWindow(fakeStorage().store, "https://care.example.com");
    expect(getDashboardOrigin()).toBe("https://care.example.com");
  });

  it("prefers a persisted reachable origin and trims slashes", () => {
    installWindow(
      fakeStorage({ carespeak_dashboard_origin: "http://192.168.1.5:3000///" }).store,
      "http://localhost:3000"
    );
    expect(getDashboardOrigin()).toBe("http://192.168.1.5:3000");
  });

  it("ignores a persisted value that is not an http(s) origin", () => {
    installWindow(
      fakeStorage({ carespeak_dashboard_origin: "ftp://nope" }).store,
      "https://care.example.com"
    );
    expect(getDashboardOrigin()).toBe("https://care.example.com");
  });

  it("persists a valid override and removes an invalid one", () => {
    const { store, map } = fakeStorage();
    installWindow(store, "http://localhost:3000");
    setDashboardOrigin("  https://care.example.com/  ");
    expect(map.get("carespeak_dashboard_origin")).toBe("https://care.example.com");
    setDashboardOrigin("nonsense");
    expect(map.has("carespeak_dashboard_origin")).toBe(false);
    setDashboardOrigin("");
    expect(map.has("carespeak_dashboard_origin")).toBe(false);
  });

  it("builds the nurse dashboard URL from the resolved origin", () => {
    installWindow(fakeStorage({ carespeak_dashboard_origin: "http://192.168.1.5:3000" }).store);
    expect(getNurseDashboardUrl("AB12CD")).toBe("http://192.168.1.5:3000/nurse-view?session=AB12CD");
  });
});

describe("pairing tokens", () => {
  const TOKEN_RE = /^[0-9a-f]{32}$/;

  it("returns an empty token on the server", () => {
    expect(getOrCreatePairToken("AB12")).toBe("");
    expect(regeneratePairToken("AB12")).toBe("");
  });

  it("creates a stable 32-character token per session", () => {
    const { store, map } = fakeStorage();
    installWindow(store);
    const first = getOrCreatePairToken("AB12");
    expect(first).toMatch(TOKEN_RE);
    expect(map.get("carespeak_pair_AB12")).toBe(first);
    expect(getOrCreatePairToken("AB12")).toBe(first);
    // A different bed gets a different token.
    expect(getOrCreatePairToken("ZZ99")).not.toBe(first);
  });

  it("still returns a token when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as unknown as Storage;
    installWindow(throwing);
    expect(getOrCreatePairToken("AB12")).toMatch(TOKEN_RE);
  });

  it("rotates the token, stores it and posts it to the server", () => {
    const { store, map } = fakeStorage({ carespeak_pair_AB12: "old-token" });
    installWindow(store);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response("{}", { status: 200 });
      })
    );

    const token = regeneratePairToken("AB12");
    expect(token).toMatch(TOKEN_RE);
    expect(token).not.toBe("old-token");
    expect(map.get("carespeak_pair_AB12")).toBe(token);
    expect(calls[0].url).toBe("/api/pair");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      action: "rotate",
      session: "AB12",
      pair: token,
    });
  });

  it("registers a token with the register action", () => {
    installWindow(fakeStorage().store);
    const calls: Array<{ init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init: init ?? {} });
        return new Response("{}", { status: 200 });
      })
    );
    registerPairToken("AB12", "tok");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      action: "register",
      session: "AB12",
      pair: "tok",
    });
  });

  it("swallows a failed registration POST", async () => {
    installWindow(fakeStorage().store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );
    expect(() => registerPairToken("AB12", "tok")).not.toThrow();
    await Promise.resolve();
  });
});

describe("fetchPairStatus", () => {
  function spy(payload: unknown, status = 200) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      })
    );
    return calls;
  }

  it("encodes the session and pair and returns the payload", async () => {
    const calls = spy({
      ok: true,
      registered: true,
      linkedDevices: 2,
      lastScanAt: 123,
      lastScanIp: "1.2.3.4",
    });
    const status = await fetchPairStatus("A B/C", "t&1");
    expect(calls[0]).toBe("/api/pair?session=A%20B%2FC&pair=t%261");
    expect(status).toMatchObject({ registered: true, linkedDevices: 2 });
  });

  it("returns null for a non-ok response", async () => {
    spy({ ok: false }, 500);
    expect(await fetchPairStatus("AB12", "t")).toBeNull();
  });

  it("returns null when the body says ok:false", async () => {
    spy({ ok: false, registered: false });
    expect(await fetchPairStatus("AB12", "t")).toBeNull();
  });

  it("returns null when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );
    expect(await fetchPairStatus("AB12", "t")).toBeNull();
  });
});