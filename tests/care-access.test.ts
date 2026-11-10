import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  authorizeSession,
} from "@/lib/care/sessionAccess";
import {
  fail,
  guardNurse,
  isResponse,
  ok,
  publicBaseUrl,
  readBody,
  unauthorized,
  voiceBaseUrl,
} from "@/lib/care/http";
import { buildSessionCookie, login, NURSE_COOKIE } from "@/lib/care/auth";
import { registerPairTokenPersistent, resetPairingForTests } from "@/lib/server/pairing";
import { resetDriverForTests } from "@/lib/care/store";

const URL_OVERRIDES = ["NEXT_PUBLIC_CARESPEAK_URL", "CARESPEAK_PUBLIC_URL", "CARE_VOICE_BASE_URL"];

function request(url = "https://care.example.com/api/care/x", headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

async function nurseRequest(url?: string, extra: Record<string, string> = {}) {
  const outcome = await login("nurse.demo", "nurse.demo");
  const cookie = buildSessionCookie(outcome!.token).split(";")[0];
  return request(url, { ...extra, cookie });
}

beforeEach(() => {
  resetDriverForTests();
  resetPairingForTests();
  delete (globalThis as unknown as { __carespeakStoreP?: unknown }).__carespeakStoreP;
  for (const key of URL_OVERRIDES) delete process.env[key];
});

afterEach(() => {
  for (const key of URL_OVERRIDES) delete process.env[key];
});

describe("authorizeSession", () => {
  it("always allows a signed-in nurse and reports the actor", async () => {
    const access = await authorizeSession(await nurseRequest(), "AB12", null);
    expect(access.allowed).toBe(true);
    expect(access.actor).toEqual({ role: "nurse", userId: "nurse_1", displayName: "Nurse Demo" });
  });

  it("allows a valid pair token without a nurse cookie", async () => {
    await registerPairTokenPersistent("AB12", "pair-token");
    const access = await authorizeSession(request(), "ab12", "pair-token");
    expect(access.allowed).toBe(true);
    expect(access.actor).toBeUndefined();
  });

  it("refuses a wrong or missing pair token", async () => {
    await registerPairTokenPersistent("AB12", "pair-token");
    expect((await authorizeSession(request(), "AB12", "wrong")).allowed).toBe(false);
    expect((await authorizeSession(request(), "AB12", null)).allowed).toBe(false);
    expect((await authorizeSession(request(), "AB12", undefined)).allowed).toBe(false);
    expect((await authorizeSession(request(), "OTHER", "pair-token")).allowed).toBe(false);
  });
});

describe("HTTP envelope helpers", () => {
  it("wraps a success payload with ok:true and no-store", async () => {
    const res = ok({ patientId: 7 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, patientId: 7 });
  });

  it("honours a custom success status", () => {
    expect(ok({}, 201).status).toBe(201);
  });

  it("wraps a failure with ok:false and the message", async () => {
    const res = fail("Bad input");
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: false, error: "Bad input" });
  });

  it("merges extra failure fields, e.g. a retry hint", async () => {
    const res = fail("Too many", 429, { retryAfterMs: 5000 });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "Too many", retryAfterMs: 5000 });
  });

  it("produces a 401 for unauthorized", async () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Sign in to continue." });
    expect((await unauthorized("Custom").json()).error).toBe("Custom");
  });
});

describe("readBody", () => {
  it("parses a JSON body", async () => {
    const req = new NextRequest("https://care.example.com/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await readBody<{ a: number }>(req)).toEqual({ a: 1 });
  });

  it("returns null for an invalid body instead of throwing", async () => {
    const req = new NextRequest("https://care.example.com/x", { method: "POST", body: "not json" });
    expect(await readBody(req)).toBeNull();
  });
});

describe("guardNurse", () => {
  it("returns the nurse for a valid session", async () => {
    const result = await guardNurse(await nurseRequest());
    expect(isResponse(result)).toBe(false);
    expect(isResponse(result) ? null : result.userId).toBe("nurse_1");
  });

  it("returns a 401 response when unauthenticated", async () => {
    const result = await guardNurse(request());
    expect(isResponse(result)).toBe(true);
    expect((result as { status: number }).status).toBe(401);
  });

  it("identifies responses with isResponse", () => {
    expect(isResponse(ok({}))).toBe(true);
    expect(isResponse({ status: 401 })).toBe(false);
    expect(isResponse(null)).toBe(false);
  });
});

describe("public base URL resolution", () => {
  it("prefers an explicit public override", () => {
    process.env.NEXT_PUBLIC_CARESPEAK_URL = "https://care.example.com/";
    expect(publicBaseUrl(request())).toBe("https://care.example.com");
  });

  it("honours forwarded proto and host headers", () => {
    const req = request("http://internal.local/api/care/x", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "public.example.com",
    });
    expect(publicBaseUrl(req)).toBe("https://public.example.com");
  });

  it("falls back to the request origin", () => {
    expect(publicBaseUrl(request("https://care.example.com/api"))).toBe("https://care.example.com");
  });

  it("uses the voice tunnel override for the Twilio webhook base", () => {
    process.env.CARE_VOICE_BASE_URL = "https://tunnel.trycloudflare.com/";
    expect(voiceBaseUrl(request())).toBe("https://tunnel.trycloudflare.com");
  });

  it("falls back to the public base URL when no voice override is set", () => {
    process.env.CARESPEAK_PUBLIC_URL = "https://care.example.com";
    expect(voiceBaseUrl(request())).toBe("https://care.example.com");
  });
});

describe("nurse cookie header parsing", () => {
  it("reads the cookie the guard expects", async () => {
    const outcome = await login("nurse.demo", "nurse.demo");
    const req = new NextRequest("https://care.example.com/x", {
      headers: { cookie: `${NURSE_COOKIE}=${outcome!.token}` },
    });
    const result = await guardNurse(req);
    expect(isResponse(result)).toBe(false);
  });
});
