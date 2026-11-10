import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getConfig } from "@/app/api/care/config/route";
import { GET as getHealth } from "@/app/api/health/route";
import { GET as getNetworkInfo } from "@/app/api/network-info/route";
import { GET as getPhoneQr } from "@/app/api/care/phone/qr/route";
import { registerPairTokenPersistent } from "@/lib/server/pairing";
import { resetDriverForTests } from "@/lib/care/store";

const SESSION = "AB12CD";

function resetGlobal<T>(key: string): void {
  delete (globalThis as unknown as Record<string, T>)[key];
}

beforeEach(() => {
  resetDriverForTests();
  resetGlobal("__carespeakStoreP");
  resetGlobal("__carespeakPairing");
});

describe("/api/care/config", () => {
  it("returns public runtime config without secrets", async () => {
    const res = await getConfig();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      store: { driver: string };
      webrtc: { iceServers: unknown[]; turnConfigured: boolean };
      limits: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.store.driver).toBe("memory");
    expect(body.webrtc.turnConfigured).toBe(false);
    expect(body.webrtc.iceServers.length).toBeGreaterThanOrEqual(1);
    expect(body.limits.maxSessionMinutes).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/UPSTASH|CARE_NURSE_PASS|TWILIO/i);
  });

  it("adds a TURN server when configured", async () => {
    const prev = {
      url: process.env.CARE_TURN_URL,
      user: process.env.CARE_TURN_USERNAME,
      cred: process.env.CARE_TURN_CREDENTIAL,
    };
    process.env.CARE_TURN_URL = "turn:turn.example.com:3478, turns:turn.example.com:5349";
    process.env.CARE_TURN_USERNAME = "user";
    process.env.CARE_TURN_CREDENTIAL = "secret";
    try {
      const body = (await (await getConfig()).json()) as {
        webrtc: { iceServers: Array<{ urls: string[]; username?: string }>; turnConfigured: boolean };
      };
      expect(body.webrtc.turnConfigured).toBe(true);
      const turn = body.webrtc.iceServers.find((s) => s.urls.some((u) => u.startsWith("turn")));
      expect(turn?.urls).toEqual(["turn:turn.example.com:3478", "turns:turn.example.com:5349"]);
      expect(turn?.username).toBe("user");
    } finally {
      if (prev.url === undefined) delete process.env.CARE_TURN_URL;
      else process.env.CARE_TURN_URL = prev.url;
      if (prev.user === undefined) delete process.env.CARE_TURN_USERNAME;
      else process.env.CARE_TURN_USERNAME = prev.user;
      if (prev.cred === undefined) delete process.env.CARE_TURN_CREDENTIAL;
      else process.env.CARE_TURN_CREDENTIAL = prev.cred;
    }
  });
});

describe("/api/health", () => {
  it("reports the driver and a server timestamp", async () => {
    const before = Date.now();
    const body = (await (await getHealth()).json()) as {
      ok: boolean;
      driver: string;
      redisConfigured: boolean;
      serverTime: number;
    };
    expect(body.ok).toBe(true);
    expect(body.driver).toBe("memory");
    expect(body.redisConfigured).toBe(false);
    expect(body.serverTime).toBeGreaterThanOrEqual(before);
  });
});

describe("/api/network-info", () => {
  it("returns only private IPv4 addresses plus the hostname", async () => {
    const res = await getNetworkInfo();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { hostname: string; lan: Array<{ name: string; address: string }> };
    expect(typeof body.hostname).toBe("string");
    expect(Array.isArray(body.lan)).toBe(true);
    for (const iface of body.lan) {
      expect(iface.address).toMatch(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
    }
  });
});

describe("/api/care/phone/qr", () => {
  it("rejects an invalid session id", async () => {
    const req = new NextRequest("https://care.example.com/api/care/phone/qr?session=bad!!");
    const res = await getPhoneQr(req);
    expect(res.status).toBe(400);
  });

  it("rejects a caller without a nurse cookie or a valid pair token", async () => {
    const req = new NextRequest(`https://care.example.com/api/care/phone/qr?session=${SESSION}`);
    const res = await getPhoneQr(req);
    expect(res.status).toBe(401);
  });

  it("issues a QR + link for a valid pair token and preserves the pair", async () => {
    await registerPairTokenPersistent(SESSION, "pair-token");
    const req = new NextRequest(
      `https://care.example.com/api/care/phone/qr?session=${SESSION.toLowerCase()}&pair=pair-token`
    );
    const res = await getPhoneQr(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; url: string; qrDataUrl: string };
    expect(body.ok).toBe(true);
    const url = new URL(body.url);
    expect(url.pathname).toBe("/care/phone");
    expect(url.searchParams.get("session")).toBe(SESSION);
    expect(url.searchParams.get("pair")).toBe("pair-token");
    expect(body.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});