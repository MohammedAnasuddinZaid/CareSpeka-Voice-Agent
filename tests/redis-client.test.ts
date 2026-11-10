import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisCtor = vi.hoisted(() => vi.fn());

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor(options: unknown) {
      redisCtor(options);
    }
  },
}));

import { getRedis, isRedisConfigured, resetRedisForTests } from "@/lib/redis";

const URL_KEY = "UPSTASH_REDIS_REST_URL";
const TOKEN_KEY = "UPSTASH_REDIS_REST_TOKEN";

beforeEach(() => {
  resetRedisForTests();
  redisCtor.mockClear();
  vi.stubEnv(URL_KEY, "");
  vi.stubEnv(TOKEN_KEY, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRedisForTests();
});

describe("isRedisConfigured", () => {
  it("is false when neither variable is set", () => {
    expect(isRedisConfigured()).toBe(false);
  });

  it("is false when only one variable is set", () => {
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    expect(isRedisConfigured()).toBe(false);

    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOKEN_KEY, "secret");
    expect(isRedisConfigured()).toBe(false);
  });

  it("is true only when both variables are set", () => {
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOKEN_KEY, "secret");
    expect(isRedisConfigured()).toBe(true);
  });
});

describe("getRedis", () => {
  it("throws a clear, actionable error when unconfigured", () => {
    expect(() => getRedis()).toThrow(/Upstash Redis is not configured/);
    expect(redisCtor).not.toHaveBeenCalled();
  });

  it("builds the client from the environment exactly once", () => {
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOKEN_KEY, "secret");

    const first = getRedis();
    const second = getRedis();

    expect(second).toBe(first);
    expect(redisCtor).toHaveBeenCalledTimes(1);
    expect(redisCtor).toHaveBeenCalledWith({
      url: "https://example.upstash.io",
      token: "secret",
    });
  });

  it("re-reads the environment after the test reset", () => {
    vi.stubEnv(URL_KEY, "https://one.upstash.io");
    vi.stubEnv(TOKEN_KEY, "one");
    getRedis();
    expect(redisCtor).toHaveBeenCalledTimes(1);

    resetRedisForTests();
    vi.stubEnv(URL_KEY, "https://two.upstash.io");
    vi.stubEnv(TOKEN_KEY, "two");
    getRedis();

    expect(redisCtor).toHaveBeenCalledTimes(2);
    expect(redisCtor).toHaveBeenLastCalledWith({
      url: "https://two.upstash.io",
      token: "two",
    });
  });

  it("does not cache a failed construction", () => {
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOKEN_KEY, "secret");
    expect(() => getRedis()).not.toThrow();

    // A reset forces a fresh construction rather than reusing a stale client.
    resetRedisForTests();
    expect(() => getRedis()).not.toThrow();
    expect(redisCtor).toHaveBeenCalledTimes(2);
  });
});