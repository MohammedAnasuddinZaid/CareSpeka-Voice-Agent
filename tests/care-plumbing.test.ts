import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  fail,
  isResponse,
  ok,
  publicBaseUrl,
  readBody,
  unauthorized,
  voiceBaseUrl,
} from "@/lib/care/http";
import {
  hashToken,
  isExpired,
  minutesFromNow,
  newId,
  newJoinCode,
  newToken,
  safeEqual,
} from "@/lib/care/crypto";
import { makeQrDataUrl } from "@/lib/care/qr";
import { buildReport, extractDuration } from "@/lib/care/report";
import { createPatient, createSession } from "@/lib/care/repo";
import { resetDriverForTests } from "@/lib/care/store";
import { sessionView } from "@/lib/care/view";
import { getSeedPatient } from "@/lib/care/seedPatients";
import {
  generateDeviceId,
  getActiveCareSession,
  getDashboardOrigin,
  getNurseDashboardUrl,
  getOrCreateSession,
  getSession,
  setSessionId,
} from "@/lib/session";
import type { CareTranscriptEntry } from "@/lib/care/types";

beforeEach(() => {
  resetDriverForTests();
});

describe("care crypto", () => {
  it("hashes deterministically to a 64-char sha-256 hex digest", () => {
    const a = hashToken("secret");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("secret")).toBe(a);
    expect(hashToken("secret2")).not.toBe(a);
  });

  it("creates high-entropy URL-safe tokens", () => {
    const token = newToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(newToken()).not.toBe(token);
  });

  it("creates a six-digit join code", () => {
    for (let i = 0; i < 20; i += 1) expect(newJoinCode()).toMatch(/^\d{6}$/);
  });

  it("prefixes ids", () => {
    expect(newId("rep")).toMatch(/^rep_[0-9a-f]{16}$/);
  });

  it("compares digests in constant time and rejects mismatches", () => {
    const a = hashToken("a");
    expect(safeEqual(a, a)).toBe(true);
    expect(safeEqual(a, hashToken("b"))).toBe(false);
    expect(safeEqual(a, a.slice(1))).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("detects expiry but treats missing/invalid as not expired", () => {
    expect(isExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isExpired(new Date(Date.now() + 60000).toISOString())).toBe(false);
    expect(isExpired(undefined)).toBe(false);
    expect(isExpired(null)).toBe(false);
    expect(isExpired("not-a-date")).toBe(false);
  });

  it("formats minutes-from-now in the future", () => {
    const iso = minutesFromNow(5);
    expect(Date.parse(iso)).toBeGreaterThan(Date.now());
  });
});

describe("QR generation", () => {
  it("produces a PNG data URL that encodes the text", async () => {
    const url = await makeQrDataUrl("https://example.com/care/join?t=abc");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url.length).toBeGreaterThan(200);
  });
});

describe("care HTTP helpers", () => {
  it("wraps success payloads with ok + no-store", async () => {
    const res = ok({ session: { id: "wc_1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ ok: true, session: { id: "wc_1" } });
  });

  it("uses the given status for failures and merges extras", async () => {
    const res = fail("bad input", 422, { field: "name" });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "bad input", field: "name" });
  });

  it("returns 401 for unauthorized", async () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "Sign in to continue." });
  });

  it("reads a JSON body and returns null for malformed JSON", async () => {
    const good = new NextRequest("https://example.com/x", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    await expect(readBody(good)).resolves.toEqual({ a: 1 });

    const bad = new NextRequest("https://example.com/x", { method: "POST", body: "not json" });
    await expect(readBody(bad)).resolves.toBeNull();
  });

  it("recognises NextResponse instances", () => {
    expect(isResponse(ok({}))).toBe(true);
    expect(isResponse({ ok: true })).toBe(false);
    expect(isResponse(null)).toBe(false);
  });

  it("builds a public base URL from forwarded headers", () => {
    const req = new NextRequest("https://internal.local/api/care/join", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "care.example.com" },
    });
    expect(publicBaseUrl(req)).toBe("https://care.example.com");
  });

  it("prefers an explicit public URL override and strips trailing slashes", () => {
    const prev = process.env.NEXT_PUBLIC_CARESPEAK_URL;
    process.env.NEXT_PUBLIC_CARESPEAK_URL = "https://care.example.com/";
    try {
      const req = new NextRequest("http://localhost:3000/api/care/join");
      expect(publicBaseUrl(req)).toBe("https://care.example.com");
      expect(voiceBaseUrl(req)).toBe("https://care.example.com");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_CARESPEAK_URL;
      else process.env.NEXT_PUBLIC_CARESPEAK_URL = prev;
    }
  });
});

describe("sessionView never leaks server secrets", () => {
  it("strips token hashes and nurse id for patients", async () => {
    const patient = await createPatient({ displayName: "Test Patient", age: 60 });
    const { session, joinToken } = await createSession({
      patientId: patient.id,
      nurseId: "nurse_1",
      nurseName: "Nurse Demo",
    });
    const view = await sessionView(session, {
      forNurse: false,
      joinToken,
      baseUrl: "https://care.example.com",
    });
    expect(view.patient?.id).toBe(patient.id);
    expect(view).not.toHaveProperty("joinTokenHash");
    expect(view).not.toHaveProperty("participantTokenHash");
    expect(view).not.toHaveProperty("nurseId");
    expect(view).not.toHaveProperty("joinCode");
    expect(view).not.toHaveProperty("joinUrl");
  });

  it("gives the nurse the join code and a tokenised URL", async () => {
    const patient = await createPatient({ displayName: "Nurse View Patient" });
    const { session, joinToken } = await createSession({
      patientId: patient.id,
      nurseId: "nurse_1",
      nurseName: "Nurse Demo",
    });
    const view = await sessionView(session, {
      forNurse: true,
      joinToken,
      baseUrl: "https://care.example.com",
    });
    expect(view.joinCode).toBe(session.joinCode);
    expect(view.joinUrl).toBe(
      `https://care.example.com/care/join?t=${encodeURIComponent(joinToken)}`
    );
    // Never the raw join token outside the URL.
    expect(JSON.stringify(view)).not.toContain(session.joinTokenHash);
  });

  it("deep-links the joining page when the raw token is gone after a refresh", async () => {
    const patient = await createPatient({ displayName: "Refresh Patient" });
    const { session } = await createSession({
      patientId: patient.id,
      nurseId: "nurse_1",
      nurseName: "Nurse Demo",
    });
    const view = await sessionView(session, { forNurse: true, baseUrl: "https://care.example.com" });
    expect(view.joinUrl).toBe("https://care.example.com/care/join");
  });
});

function transcriptEntry(
  seq: number,
  role: "patient" | "agent",
  text: string,
  sessionId = "wc_test"
): CareTranscriptEntry {
  return { id: `t${seq}`, seq, sessionId, role, text, at: new Date().toISOString() };
}

describe("report builder", () => {
  const patient = getSeedPatient("pt_0001")!;

  it("extracts durations in the order the nurse expects", () => {
    expect(extractDuration([transcriptEntry(1, "patient", "I have been breathless for 3 days")])).toBe(
      "3 days"
    );
    expect(extractDuration([transcriptEntry(1, "patient", "it started 2 weeks ago")])).toBe("2 weeks");
    expect(extractDuration([transcriptEntry(1, "patient", "for 5 hours now")])).toBe("5 hours");
    expect(extractDuration([transcriptEntry(1, "patient", "since yesterday")])).toBe("Since yesterday");
    expect(extractDuration([transcriptEntry(1, "patient", "I feel fine")])).toMatch(/not stated/i);
  });

  it("ignores agent text when extracting the patient's duration", () => {
    expect(
      extractDuration([
        transcriptEntry(1, "agent", "Has this gone on for 3 days?"),
        transcriptEntry(2, "patient", "no"),
      ])
    ).toMatch(/not stated/i);
  });

  it("extracts patient-reported symptoms and keeps provenance honest", () => {
    const report = buildReport({
      sessionId: "wc_test",
      patientId: patient.id,
      patient,
      entries: [
        transcriptEntry(1, "agent", "How have you been?"),
        transcriptEntry(2, "patient", "I have had chest tightness and I am short of breath"),
      ],
      durationMs: 65_000,
    });

    expect(report.status).toBe("draft");
    expect(report.sections.reasonForInteraction).toBe(patient.primaryConcern);
    expect(report.sections.patientReportedSymptoms.length).toBeGreaterThan(0);
    // Every symptom fact is patient-reported, never record-derived.
    expect(report.sections.patientReportedSymptoms.every((f) => f.provenance === "patient")).toBe(true);
    expect(report.sections.medicationsDiscussed.every((f) => f.provenance !== "ai")).toBe(true);
    expect(report.sections.escalations.join(" ")).toMatch(/red-flag/i);
    expect(report.sections.aiSummary).toContain("65 seconds");
    expect(report.sections.aiSummary).toMatch(/no diagnosis/i);
    expect(report.sourceFlags).toMatchObject({
      recordDerived: true,
      patientReported: true,
      aiGenerated: true,
      reviewed: false,
    });
    expect(report.transcriptRef).toEqual({ count: 2, firstSeq: 1, lastSeq: 2 });
  });

  it("leaves concerns and escalations empty for a benign call", () => {
    const report = buildReport({
      sessionId: "wc_benign",
      patientId: patient.id,
      patient,
      entries: [transcriptEntry(1, "patient", "I have been feeling well this week")],
    });
    expect(report.sections.escalations).toHaveLength(0);
    expect(report.sections.concernsForNurse).toHaveLength(0);
    expect(report.sections.suggestedFollowUp.join(" ")).toMatch(/care plan/i);
  });

  it("handles a report with no patient and no transcript", () => {
    const report = buildReport({
      sessionId: "wc_empty",
      patientId: "unknown",
      patient: null,
      entries: [],
    });
    expect(report.sections.reasonForInteraction).toMatch(/patient-initiated/i);
    expect(report.transcriptRef).toEqual({ count: 0, firstSeq: 0, lastSeq: 0 });
    expect(report.sourceFlags.recordDerived).toBe(false);
    expect(report.sourceFlags.patientReported).toBe(false);
  });
});

describe("session helpers in a server (no-window) context", () => {
  it("generates a stable-looking device id", () => {
    expect(generateDeviceId()).toMatch(/^device_[a-z0-9]+_[a-z0-9]{6}$/);
  });

  it("creates a server session with a safe id alphabet", () => {
    const session = getOrCreateSession();
    expect(session.deviceId).toBe("server");
    expect(session.sessionId).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it("normalises a manually-entered session id", () => {
    const session = setSessionId("  ab12cd ");
    expect(session.sessionId).toBe("AB12CD");
    expect(session.deviceId).toBe("server");
  });

  it("returns no browser-only state on the server", () => {
    expect(getSession()).toBeNull();
    expect(getActiveCareSession()).toBeNull();
    expect(getDashboardOrigin()).toBe("");
    expect(getNurseDashboardUrl("AB12CD")).toBe("");
  });
});