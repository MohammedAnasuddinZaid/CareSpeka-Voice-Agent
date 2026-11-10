import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisState = vi.hoisted(() => {
  const state = {
    configured: false,
    throwOnGet: false,
    getCalls: [] as string[],
    setCalls: [] as Array<{ key: string; value: unknown; opts?: unknown }>,
    delCalls: [] as string[],
  };
  const store = new Map<string, unknown>();
  return { state, store };
});

vi.mock("@/lib/redis", () => ({
  isRedisConfigured: () => redisState.state.configured,
  getRedis: () => ({
    get: async (key: string) => {
      redisState.state.getCalls.push(key);
      if (redisState.state.throwOnGet) throw new Error("redis down");
      return (redisState.store.get(key) as number | null) ?? null;
    },
    set: async (key: string, value: unknown, opts?: unknown) => {
      redisState.state.setCalls.push({ key, value, opts });
      redisState.store.set(key, value);
      return "OK";
    },
    del: async (key: string) => {
      redisState.state.delCalls.push(key);
      redisState.store.delete(key);
      return 1;
    },
  }),
  resetRedisForTests: () => undefined,
}));

import {
  buildWebhookUrl,
  checkCooldown,
  classifyTwilioFailure,
  clearCooldown,
  isPublicHttpsUrl,
  normalizePhone,
  placeCall,
  resetCooldownsForTests,
  TRIAL_CUSTOM_CALL_MESSAGE,
  voiceSecret,
} from "@/lib/care/voice";

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "CARE_VOICE_SECRET",
];

beforeEach(() => {
  resetCooldownsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  redisState.state.configured = false;
  redisState.state.throwOnGet = false;
  redisState.state.getCalls.length = 0;
  redisState.state.setCalls.length = 0;
  redisState.state.delCalls.length = 0;
  redisState.store.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("phone normalisation edge cases", () => {
  it("accepts bare 8..15 digit numbers and prefixes +", () => {
    expect(normalizePhone("12345678")).toBe("+12345678");
    expect(normalizePhone("12345678901")).toBe("+12345678901");
    expect(normalizePhone("+123456789012345")).toBe("+123456789012345");
  });

  it("rejects numbers outside the E.164 length", () => {
    expect(normalizePhone("1234567")).toBeNull(); // 7 digits
    expect(normalizePhone("+1234567890123456")).toBeNull(); // 16 digits
  });

  it("strips formatting and rejects non-numeric input", () => {
    expect(normalizePhone("(98491) 304-07")).toBe("+919849130407");
    expect(normalizePhone("+")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("voiceSecret derivation", () => {
  it("is empty only when nothing is configured", () => {
    expect(voiceSecret()).toBe("");
  });

  it("derives a stable 32-char token from the auth token", () => {
    process.env.TWILIO_AUTH_TOKEN = "auth-token";
    const first = voiceSecret();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(voiceSecret()).toBe(first);

    process.env.TWILIO_AUTH_TOKEN = "different-token";
    expect(voiceSecret()).not.toBe(first);
  });

  it("prefers an explicit secret over the derived one", () => {
    process.env.TWILIO_AUTH_TOKEN = "auth-token";
    process.env.CARE_VOICE_SECRET = "explicit";
    expect(voiceSecret()).toBe("explicit");
  });
});

describe("public URL validation", () => {
  it("rejects private and loopback hosts", () => {
    expect(isPublicHttpsUrl("https://10.0.0.1")).toBe(false);
    expect(isPublicHttpsUrl("https://172.16.0.1")).toBe(false);
    expect(isPublicHttpsUrl("https://172.31.255.255")).toBe(false);
    expect(isPublicHttpsUrl("https://192.168.1.1:8443")).toBe(false);
    expect(isPublicHttpsUrl("https://127.0.0.1")).toBe(false);
    expect(isPublicHttpsUrl("https://gateway.local")).toBe(false);
  });

  it("accepts a host just outside the private 172.16/12 range", () => {
    expect(isPublicHttpsUrl("https://172.32.0.1")).toBe(true);
  });

  it("requires https and a parseable URL", () => {
    expect(isPublicHttpsUrl("http://example.com")).toBe(false);
    expect(isPublicHttpsUrl("https://example.com")).toBe(true);
    expect(isPublicHttpsUrl("nonsense")).toBe(false);
  });
});

describe("webhook URL composition", () => {
  it("trims a trailing slash and always carries session + turn", () => {
    expect(buildWebhookUrl("https://care.test///", "ab12", 0)).toBe(
      "https://care.test/api/care/voice?session=ab12&turn=0"
    );
  });

  it("appends the secret derived from the auth token when present", () => {
    process.env.TWILIO_AUTH_TOKEN = "auth-token";
    const url = buildWebhookUrl("https://care.test", "AB12", 2);
    expect(url).toContain(`k=${voiceSecret()}`);
  });
});

describe("classifyTwilioFailure", () => {
  it("labels a network failure (status 0) with the message", () => {
    const res = classifyTwilioFailure({ status: 0, message: "socket hang up" });
    expect(res.kind).toBe("network");
    expect(res.error).toBe("socket hang up");
  });

  it("detects the trial custom-call rejection by string code and message", () => {
    expect(classifyTwilioFailure({ status: 400, code: "10002" }).kind).toBe("trial_custom_call");
    expect(
      classifyTwilioFailure({ status: 400, message: "upgrade your account to unlock full functionality" }).kind
    ).toBe("trial_custom_call");
    expect(classifyTwilioFailure({ status: 400, code: 10002 }).error).toBe(TRIAL_CUSTOM_CALL_MESSAGE);
  });

  it("maps unverified recipient and invalid sender codes", () => {
    expect(classifyTwilioFailure({ status: 400, code: 32100 }).kind).toBe("unverified_recipient");
    expect(classifyTwilioFailure({ status: 400, code: 21608 }).kind).toBe("unverified_recipient");
    expect(classifyTwilioFailure({ status: 400, code: 21607 }).kind).toBe("invalid_from");
  });

  it("falls back to a clearly-labelled unknown error", () => {
    const res = classifyTwilioFailure({ status: 500 });
    expect(res.kind).toBe("unknown");
    expect(res.error).toBe("Twilio rejected the call (500).");
    expect(res.detail).toBeUndefined();
  });
});

function twilioEnv() {
  process.env.TWILIO_ACCOUNT_SID = "AC123";
  process.env.TWILIO_AUTH_TOKEN = "secret-token";
  process.env.TWILIO_FROM_NUMBER = "+919908786211";
}

describe("placeCall", () => {
  it("reports missing configuration without touching the network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await placeCall({ to: "+919849130407", url: "https://care.test/voice" });
    expect(res).toEqual({
      ok: false,
      status: 0,
      kind: "not_configured",
      error:
        "Twilio is not fully configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts the dial parameters with Basic auth and returns the call SID", async () => {
    twilioEnv();
    let seen: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), init: init ?? {} };
        return new Response(JSON.stringify({ sid: "CA999", status: "queued" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch
    );

    const res = await placeCall({
      to: "+919849130407",
      url: "https://care.test/api/care/voice?session=AB12&turn=0",
      statusCallback: "https://care.test/api/care/voice/status",
    });

    expect(res).toEqual({ ok: true, sid: "CA999", status: "queued" });
    expect(seen!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("AC123:secret-token").toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = String(seen!.init.body);
    expect(body).toContain("To=%2B919849130407");
    expect(body).toContain("From=%2B919908786211");
    expect(body).toContain("Method=POST");
    expect(body).toContain("StatusCallback=");
  });

  it("omits the status callback when not requested", async () => {
    twilioEnv();
    let body = "";
    vi.stubGlobal(
      "fetch",
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ sid: "CA1" }), { status: 201 });
      }) as typeof fetch
    );
    const res = await placeCall({ to: "+919849130407", url: "https://care.test/voice" });
    expect(res).toEqual({ ok: true, sid: "CA1", status: "queued" });
    expect(body).not.toContain("StatusCallback");
  });

  it("classifies a Twilio rejection into an actionable failure", async () => {
    twilioEnv();
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(
          JSON.stringify({
            code: 32100,
            message: "The number is unverified",
            more_info: "https://www.twilio.com/docs/errors/32100",
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        )) as typeof fetch
    );
    const res = await placeCall({ to: "+919849130407", url: "https://care.test/voice" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("unverified_recipient");
      expect(res.code).toBe(32100);
      expect(res.moreInfo).toContain("32100");
      expect(res.detail).toBe("The number is unverified");
    }
  });

  it("maps a transport failure to a network failure", async () => {
    twilioEnv();
    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new TypeError("connect ECONNREFUSED");
      }) as typeof fetch
    );
    const res = await placeCall({ to: "+919849130407", url: "https://care.test/voice" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("network");
      expect(res.error).toContain("ECONNREFUSED");
    }
  });
});

describe("cooldown with Redis", () => {
  it("reserves the window in Redis and blocks a rapid second dial", async () => {
    redisState.state.configured = true;
    const first = await checkCooldown("SESS:redis", 30_000);
    expect(first.allowed).toBe(true);
    expect(redisState.state.setCalls).toHaveLength(1);
    expect(redisState.state.setCalls[0].key).toBe("care:callcooldown:SESS:redis");
    expect(redisState.state.setCalls[0].opts).toEqual({ px: 30_000 });

    const second = await checkCooldown("SESS:redis", 30_000);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    expect(second.retryAfterMs).toBeLessThanOrEqual(30_000);
    // The blocked attempt must not overwrite the key.
    expect(redisState.state.setCalls).toHaveLength(1);
  });

  it("allows the dial once the stored window has expired", async () => {
    redisState.state.configured = true;
    redisState.store.set("care:callcooldown:SESS:old", Date.now() - 60_000);
    expect((await checkCooldown("SESS:old", 10_000)).allowed).toBe(true);
  });

  it("falls back to the in-process guard when Redis throws", async () => {
    redisState.state.configured = true;
    redisState.state.throwOnGet = true;
    expect((await checkCooldown("SESS:fallback", 5_000)).allowed).toBe(true);
    expect((await checkCooldown("SESS:fallback", 5_000)).allowed).toBe(false);
  });

  it("clears the Redis key when a dial never connected", async () => {
    redisState.state.configured = true;
    await checkCooldown("SESS:clear", 10_000);
    redisState.state.delCalls.length = 0;
    await clearCooldown("SESS:clear");
    expect(redisState.state.delCalls).toEqual(["care:callcooldown:SESS:clear"]);
    expect(redisState.store.has("care:callcooldown:SESS:clear")).toBe(false);
  });

  it("only touches the local map when Redis is not configured", async () => {
    redisState.state.configured = false;
    await checkCooldown("SESS:local", 10_000);
    await clearCooldown("SESS:local");
    expect(redisState.state.delCalls).toEqual([]);
    expect(redisState.state.setCalls).toEqual([]);
  });
});
