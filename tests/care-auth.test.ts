import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEMO_CREDENTIALS_WARNING,
  NURSE_COOKIE,
  PARTICIPANT_HEADER,
  buildSessionCookie,
  clearSessionCookie,
  login,
  logout,
  nurseFromRequest,
  participantFromRequest,
} from "@/lib/care/auth";
import { getLogin } from "@/lib/care/repo";
import { hashToken } from "@/lib/care/crypto";
import { resetDriverForTests } from "@/lib/care/store";

const ENV_KEYS = [
  "CARE_NURSE_USER",
  "CARE_NURSE_PASS",
  "CARE_NURSE_NAME",
  "CARE_ADMIN_USER",
  "CARE_ADMIN_PASS",
];

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://care.example.com/api/care/auth/me", { headers });
}

beforeEach(() => {
  resetDriverForTests();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("login", () => {
  it("signs in the built-in demo nurse", async () => {
    const outcome = await login("nurse.demo", "nurse.demo");
    expect(outcome).not.toBeNull();
    expect(outcome!.record).toMatchObject({
      userId: "nurse_1",
      username: "nurse.demo",
      displayName: "Nurse Demo",
      role: "nurse",
    });
    expect(Date.parse(outcome!.record.expiresAt)).toBeGreaterThan(Date.now());
    // Only the hash of the token is persisted.
    expect(await getLogin(hashToken(outcome!.token))).toEqual(outcome!.record);
    expect(DEMO_CREDENTIALS_WARNING).toContain("CARE_NURSE_USER");
  });

  it("trims and lower-cases the username", async () => {
    await expect(login("  NURSE.DEMO  ", "nurse.demo")).resolves.not.toBeNull();
  });

  it("rejects a wrong password or unknown user", async () => {
    expect(await login("nurse.demo", "nope")).toBeNull();
    expect(await login("ghost", "nurse.demo")).toBeNull();
  });

  it("uses the configured nurse and display name", async () => {
    process.env.CARE_NURSE_USER = "ward1";
    process.env.CARE_NURSE_PASS = "s3cret";
    process.env.CARE_NURSE_NAME = "Ward Nurse";
    const outcome = await login("ward1", "s3cret");
    expect(outcome!.record).toMatchObject({ username: "ward1", displayName: "Ward Nurse", role: "nurse" });
    // The default demo credentials no longer work.
    expect(await login("nurse.demo", "nurse.demo")).toBeNull();
  });

  it("adds an admin credential only when both admin variables are set", async () => {
    process.env.CARE_ADMIN_USER = "boss";
    expect(await login("boss", "anything")).toBeNull(); // password not configured

    process.env.CARE_ADMIN_PASS = "adm1n";
    const admin = await login("boss", "adm1n");
    expect(admin!.record).toMatchObject({ userId: "admin_1", role: "admin", displayName: "Administrator" });
  });
});

describe("logout", () => {
  it("invalidates the stored session token", async () => {
    const outcome = await login("nurse.demo", "nurse.demo");
    await logout(outcome!.token);
    expect(await getLogin(hashToken(outcome!.token))).toBeNull();
  });

  it("is safe with a missing token", async () => {
    await expect(logout(null)).resolves.toBeUndefined();
    await expect(logout(undefined)).resolves.toBeUndefined();
  });
});

describe("nurseFromRequest", () => {
  it("restores the nurse from a valid cookie", async () => {
    const outcome = await login("nurse.demo", "nurse.demo");
    const req = request({ cookie: `${NURSE_COOKIE}=${encodeURIComponent(outcome!.token)}` });
    expect(await nurseFromRequest(req)).toEqual(outcome!.record);
  });

  it("picks the care session cookie out of several", async () => {
    const outcome = await login("nurse.demo", "nurse.demo");
    const req = request({ cookie: `theme=dark; ${NURSE_COOKIE}=${outcome!.token}; other=1` });
    expect((await nurseFromRequest(req))?.userId).toBe("nurse_1");
  });

  it("returns null without a cookie or with an unknown token", async () => {
    expect(await nurseFromRequest(request())).toBeNull();
    expect(await nurseFromRequest(request({ cookie: `${NURSE_COOKIE}=ghost` }))).toBeNull();
  });

  it("survives a malformed percent escape instead of throwing a 500", async () => {
    const req = request({ cookie: `${NURSE_COOKIE}=%E0%A4%A` });
    await expect(nurseFromRequest(req)).resolves.toBeNull();
  });
});

describe("participantFromRequest", () => {
  it("reads the dedicated participant header", async () => {
    expect(await participantFromRequest(request({ [PARTICIPANT_HEADER]: "  tok123  " }))).toBe("tok123");
  });

  it("falls back to a Bearer authorization header", async () => {
    expect(await participantFromRequest(request({ authorization: "Bearer abc.def" }))).toBe("abc.def");
    expect(await participantFromRequest(request({ authorization: "bearer lower" }))).toBe("lower");
  });

  it("ignores a non-bearer authorization header", async () => {
    expect(await participantFromRequest(request())).toBeNull();
    expect(await participantFromRequest(request({ authorization: "Basic abc" }))).toBeNull();
  });
});

describe("session cookies", () => {
  it("builds an HttpOnly, SameSite=Lax cookie without Secure outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    const cookie = buildSessionCookie("a b/c");
    expect(cookie).toContain(`${NURSE_COOKIE}=${encodeURIComponent("a b/c")}`);
    expect(cookie).toContain("Path=/; HttpOnly; SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${8 * 60 * 60}`);
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(buildSessionCookie("t")).toContain("; Secure");
    expect(clearSessionCookie()).toContain("; Secure");
  });

  it("clears the cookie with Max-Age=0", () => {
    vi.stubEnv("NODE_ENV", "development");
    const cleared = clearSessionCookie();
    expect(cleared).toContain(`${NURSE_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).not.toContain("Secure");
  });
});
