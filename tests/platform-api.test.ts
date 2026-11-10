import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  backendBase,
  getAudit,
  getCalls,
  getEscalations,
  getPatients,
  login,
  me,
  saveProviderSecrets,
} from "@/lib/platformApi";

interface Captured {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function spyFetch(response: Response | (() => Response)) {
  const calls: Captured[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
  vi.stubGlobal("fetch", fn);
  return calls;
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_VOICELINK_BACKEND;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_VOICELINK_BACKEND;
});

describe("backendBase", () => {
  it("prefers an explicit override and trims a trailing slash", () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.example.com/";
    expect(backendBase()).toBe("https://api.example.com");
  });

  it("defaults to loopback when there is no window", () => {
    expect(backendBase()).toBe("http://127.0.0.1:8000");
  });

  it("uses the same origin on the HTTPS dev port", () => {
    vi.stubGlobal("window", { location: { origin: "https://localhost:3443", port: "3443", protocol: "https:", hostname: "localhost" } });
    expect(backendBase()).toBe("https://localhost:3443");
  });

  it("points at port 8000 otherwise", () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:3000", port: "3000", protocol: "http:", hostname: "localhost" } });
    expect(backendBase()).toBe("http://localhost:8000");
  });
});

describe("request plumbing", () => {
  it("sends credentialed, no-store GETs to the backend", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    const calls = spyFetch(jsonResponse(200, { ok: true, patients: [] }));
    const result = await getPatients();
    expect(result).toEqual({ ok: true, patients: [] });
    expect(calls[0].url).toBe("https://api.test/api/platform/patients");
    expect(calls[0].init.credentials).toBe("include");
    expect(calls[0].init.cache).toBe("no-store");
    expect(calls[0].init.method).toBe("GET");
  });

  it("sets a JSON content type only when there is a body", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    const calls = spyFetch(jsonResponse(200, { ok: true, user: { id: 1 } }));
    await login("nurse", "pw");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ username: "nurse", password: "pw" });
  });

  it("builds query strings for optional filters", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    const calls = spyFetch(() => jsonResponse(200, { ok: true, calls: [], telephony: {} }));
    await getCalls();
    await getCalls(42);
    expect(calls[0].url).toBe("https://api.test/api/platform/calls");
    expect(calls[1].url).toBe("https://api.test/api/platform/calls?patient_id=42");
  });

  it("encodes the escalation state filter", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    const calls = spyFetch(jsonResponse(200, { ok: true, escalations: [], actions: {} }));
    await getEscalations("needs review");
    expect(calls[0].url).toBe("https://api.test/api/platform/escalations?state=needs%20review");
  });

  it("passes a numeric audit limit", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    const calls = spyFetch(jsonResponse(200, { ok: true, entries: [] }));
    await getAudit(5);
    expect(calls[0].url).toBe("https://api.test/api/platform/audit?limit=5");
  });

  it("serialises provider secret values", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    const calls = spyFetch(jsonResponse(200, { ok: true, stored: ["TWILIO_AUTH_TOKEN"] }));
    await saveProviderSecrets({ TWILIO_AUTH_TOKEN: "abc" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ values: { TWILIO_AUTH_TOKEN: "abc" } });
  });
});

describe("error mapping", () => {
  it("throws an ApiError with a string detail", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    spyFetch(jsonResponse(400, { detail: "Bad request" }));
    await expect(getPatients()).rejects.toMatchObject({
      name: "Error",
      status: 400,
      code: "http_400",
      message: "Bad request",
    });
  });

  it("carries a structured code and message from an object detail", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    spyFetch(jsonResponse(409, { detail: { code: "duplicate", message: "Already exists" } }));
    const err = await getPatients().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "duplicate", message: "Already exists" });
  });

  it("falls back to a generic message for an empty error body", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    spyFetch(new Response("", { status: 500 }));
    await expect(getPatients()).rejects.toMatchObject({ status: 500, code: "http_500", message: "Request failed (500)." });
  });

  it("treats a non-JSON error body as the detail text", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    spyFetch(new Response("upstream gateway error", { status: 502 }));
    await expect(getPatients()).rejects.toMatchObject({ status: 502, message: "upstream gateway error" });
  });

  it("returns parsed JSON on success", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    spyFetch(jsonResponse(200, { ok: true, patients: [{ id: 1 }] }));
    expect(await getPatients()).toEqual({ ok: true, patients: [{ id: 1 }] });
  });
});

describe("me() 401 handling", () => {
  it("returns null for an unauthenticated session", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    spyFetch(jsonResponse(401, { detail: "Not signed in" }));
    expect(await me()).toBeNull();
  });

  it("rethrows any other failure", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    spyFetch(jsonResponse(500, { detail: "boom" }));
    await expect(me()).rejects.toMatchObject({ status: 500 });
  });

  it("returns the user on success", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    spyFetch(jsonResponse(200, { ok: true, user: { id: 7, username: "n" } }));
    expect(await me()).toMatchObject({ id: 7, username: "n" });
  });
});

describe("login", () => {
  it("unwraps the session user", async () => {
    process.env.NEXT_PUBLIC_VOICELINK_BACKEND = "https://api.test";
    spyFetch(jsonResponse(200, { ok: true, user: { id: 3, username: "ward", role: "nurse" } }));
    expect(await login("ward", "pw")).toMatchObject({ id: 3, role: "nurse" });
  });
});
