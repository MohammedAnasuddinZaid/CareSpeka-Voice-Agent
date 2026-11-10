import { beforeEach, describe, expect, it } from "vitest";
import {
  getPairSummary,
  getScans,
  hasRegistration,
  hasRegistrationPersistent,
  recordScan,
  registerPairToken,
  registerPairTokenPersistent,
  resetPairingForTests,
  rotatePairToken,
  rotatePairTokenPersistent,
  verifyPairToken,
  verifyPairTokenPersistent,
} from "@/lib/server/pairing";
import { resetDriverForTests } from "@/lib/care/store";

function headers(partial: Record<string, string> = {}): Headers {
  return new Headers(partial);
}

beforeEach(() => {
  resetPairingForTests();
  resetDriverForTests();
});

describe("in-memory pairing registry", () => {
  it("registers, verifies, and treats session ids case-insensitively", () => {
    expect(registerPairToken("ab12cd", "tok-1")).toBe(true);
    expect(hasRegistration("AB12CD")).toBe(true);
    expect(verifyPairToken("ab12cd", "tok-1")).toBe(true);
    expect(verifyPairToken("AB12CD", "wrong")).toBe(false);
    expect(verifyPairToken("missing", "tok-1")).toBe(false);
  });

  it("rebuffs a different token for an already-registered session", () => {
    expect(registerPairToken("bed1", "first")).toBe(true);
    expect(registerPairToken("bed1", "second")).toBe(false);
    expect(verifyPairToken("bed1", "first")).toBe(true);
  });

  it("rejects empty or overlong tokens", () => {
    expect(registerPairToken("bed1", "")).toBe(false);
    expect(registerPairToken("bed1", "x".repeat(65))).toBe(false);
  });

  it("rotates to a supplied token or generates one", () => {
    expect(rotatePairToken("missing")).toBeNull();
    registerPairToken("bed1", "old");
    expect(rotatePairToken("bed1", "new")).toBe("new");
    expect(verifyPairToken("bed1", "old")).toBe(false);
    expect(verifyPairToken("bed1", "new")).toBe(true);

    const generated = rotatePairToken("bed1");
    expect(generated).toBeTruthy();
    expect(generated).not.toBe("new");
    expect(verifyPairToken("bed1", generated!)).toBe(true);
  });
});

describe("scan tracking", () => {
  it("records a scan only with the correct token, capturing IP/device/role", () => {
    registerPairToken("bed1", "tok");
    const scan = recordScan(
      "bed1",
      "tok",
      "nurse",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)",
      headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })
    );
    expect(scan).not.toBeNull();
    expect(scan!.ip).toBe("203.0.113.9");
    expect(scan!.role).toBe("nurse");
    expect(scan!.device).toContain("iPhone");

    expect(recordScan("bed1", "bad", "nurse", null, headers())).toBeNull();
    expect(getScans("bed1")).toHaveLength(1);
  });

  it("falls back to x-real-ip / cf-connecting-ip / local", () => {
    registerPairToken("bed1", "tok");
    expect(recordScan("bed1", "tok", "r", null, headers({ "x-real-ip": "198.51.100.4" }))!.ip).toBe("198.51.100.4");
    expect(recordScan("bed1", "tok", "r", null, headers({ "cf-connecting-ip": "198.51.100.5" }))!.ip).toBe(
      "198.51.100.5"
    );
    expect(recordScan("bed1", "tok", "r", null, headers())!.ip).toBe("local");
  });

  it("keeps the newest 20 scans, newest first", () => {
    registerPairToken("bed1", "tok");
    for (let i = 0; i < 25; i += 1) recordScan("bed1", "tok", "r", `dev-${i}`, headers());
    const scans = getScans("bed1");
    expect(scans).toHaveLength(20);
    expect(scans[0].device).toBe("dev-24");
  });

  it("summarises distinct linked devices from scans", () => {
    registerPairToken("bed1", "tok");
    expect(getPairSummary("bed1")).toEqual({ linkedDevices: 0, lastScanAt: null, lastScanIp: null });
    recordScan("bed1", "tok", "r", "a", headers({ "x-forwarded-for": "1.1.1.1" }));
    recordScan("bed1", "tok", "r", "b", headers({ "x-forwarded-for": "1.1.1.1" }));
    recordScan("bed1", "tok", "r", "c", headers({ "x-forwarded-for": "2.2.2.2" }));
    const summary = getPairSummary("bed1");
    expect(summary.linkedDevices).toBe(2);
    expect(summary.lastScanIp).toBe("2.2.2.2");
    expect(summary.lastScanAt).toBeTypeOf("number");
  });
});

describe("durable pairing layer", () => {
  it("persists a registration and verifies after the in-memory cache is lost", async () => {
    expect(await registerPairTokenPersistent("bed1", "tok")).toBe(true);
    resetPairingForTests(); // simulate a lost in-process cache
    expect(hasRegistration("bed1")).toBe(false);
    expect(await hasRegistrationPersistent("bed1")).toBe(true);
    expect(await verifyPairTokenPersistent("bed1", "tok")).toBe(true);
    // Verification warms the in-process fast path.
    expect(verifyPairToken("bed1", "tok")).toBe(true);
  });

  it("refuses to overwrite a different persisted token", async () => {
    expect(await registerPairTokenPersistent("bed1", "first")).toBe(true);
    expect(await registerPairTokenPersistent("bed1", "second")).toBe(false);
    resetPairingForTests();
    expect(await verifyPairTokenPersistent("bed1", "first")).toBe(true);
    expect(await verifyPairTokenPersistent("bed1", "second")).toBe(false);
  });

  it("rotates a persisted token, including after a cache wipe", async () => {
    expect(await rotatePairTokenPersistent("missing")).toBeNull();
    await registerPairTokenPersistent("bed1", "old");
    resetPairingForTests();
    const next = await rotatePairTokenPersistent("bed1", "new");
    expect(next).toBe("new");
    expect(await verifyPairTokenPersistent("bed1", "old")).toBe(false);
    expect(await verifyPairTokenPersistent("bed1", "new")).toBe(true);
  });
});