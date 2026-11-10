import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CareApiError,
  careAudit,
  careGetSession,
  careListMessages,
  careLogin,
  careLogout,
  careMe,
  carePhoneQr,
  carePollSignals,
  carePortalAsk,
  carePortalContext,
  careSendSignal,
  careTasks,
} from "@/lib/careClient";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request envelope", () => {
  it("posts JSON with cookies included", async () => {
    const calls = spyFetch(jsonResponse(200, { ok: true, user: { userId: "nurse_1" } }));
    const result = await careLogin("nurse.demo", "pw");
    expect(result.user.userId).toBe("nurse_1");
    expect(calls[0].url).toBe("/api/care/auth/login");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.credentials).toBe("include");
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ username: "nurse.demo", password: "pw" });
  });

  it("does not set a content type for a bodyless request", async () => {
    const calls = spyFetch(jsonResponse(200, { ok: true, user: {}, store: {} }));
    await careMe();
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("returns an empty object for a successful empty body", async () => {
    spyFetch(new Response("", { status: 200 }));
    await expect(careLogout()).resolves.toEqual({});
  });

  it("maps a transport failure to a status-0 CareApiError", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new TypeError("offline");
      }) as typeof fetch
    );
    const err = await careMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CareApiError);
    expect(err).toMatchObject({ status: 0, message: "Network unavailable. Check your connection." });
  });

  it("throws the server error text and status", async () => {
    spyFetch(jsonResponse(403, { ok: false, error: "Nurse sign-in required.", code: "unauthorized" }));
    await expect(careMe()).rejects.toMatchObject({
      name: "CareApiError",
      status: 403,
      message: "Nurse sign-in required.",
      code: "unauthorized",
    });
  });

  it("treats ok:false on a 200 as a failure", async () => {
    spyFetch(jsonResponse(200, { ok: false, error: "Rejected" }));
    await expect(careLogout()).rejects.toMatchObject({ status: 200, message: "Rejected", code: "" });
  });

  it("falls back to a generic message when the server omits one", async () => {
    spyFetch(jsonResponse(500, {}));
    await expect(careMe()).rejects.toMatchObject({ status: 500, message: "Request failed (500)" });
  });
});

describe("participant authorisation", () => {
  it("forwards the participant token as a header", async () => {
    const calls = spyFetch(jsonResponse(200, { session: {}, events: [], transcript: [] }));
    await careGetSession("sess_1", { participant: "participant-token" });
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("x-care-participant")).toBe("participant-token");
  });

  it("does not send the header without a participant", async () => {
    const calls = spyFetch(jsonResponse(200, { session: {}, events: [], transcript: [] }));
    await careGetSession("sess_1");
    expect((calls[0].init.headers as Headers).get("x-care-participant")).toBeNull();
  });

  it("threads the participant through signal posts", async () => {
    const calls = spyFetch(jsonResponse(200, { signal: { id: "s" } }));
    await careSendSignal("sess_1", "offer", { sdp: "x" }, "p-token");
    expect((calls[0].init.headers as Headers).get("x-care-participant")).toBe("p-token");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      sessionId: "sess_1",
      kind: "offer",
      data: { sdp: "x" },
    });
  });
});

describe("query construction", () => {
  it("adds transcript and event cursors only when non-zero", async () => {
    const calls = spyFetch(() => jsonResponse(200, { session: {}, events: [], transcript: [] }));
    await careGetSession("sess_1");
    await careGetSession("sess_1", { sinceEvent: 5, sinceTranscript: 9 });
    expect(calls[0].url).toBe("/api/care/sessions/sess_1");
    expect(calls[1].url).toBe("/api/care/sessions/sess_1?sinceEvent=5&sinceTranscript=9");
  });

  it("encodes session ids in signal polling", async () => {
    const calls = spyFetch(jsonResponse(200, { signals: [], role: "nurse" }));
    await carePollSignals("A B/C", 123);
    expect(calls[0].url).toBe("/api/care/signal?sessionId=A%20B%2FC&since=123");
  });

  it("always sends the audit limit", async () => {
    const calls = spyFetch(jsonResponse(200, { audit: [] }));
    await careAudit();
    await careAudit("pt_1", 25);
    expect(calls[0].url).toBe("/api/care/audit?limit=200");
    expect(calls[1].url).toBe("/api/care/audit?patientId=pt_1&limit=25");
  });

  it("filters tasks and messages by patient", async () => {
    const calls = spyFetch(() => jsonResponse(200, { tasks: [], messages: [] }));
    await careTasks();
    await careTasks("pt 1");
    await careListMessages();
    await careListMessages("pt 1");
    expect(calls[0].url).toBe("/api/care/tasks");
    expect(calls[1].url).toBe("/api/care/tasks?patientId=pt%201");
    expect(calls[2].url).toBe("/api/care/messages");
    expect(calls[3].url).toBe("/api/care/messages?patientId=pt%201");
  });

  it("builds the portal context URL with an optional pair token", async () => {
    const calls = spyFetch(() => jsonResponse(200, { context: {} }));
    await carePortalContext("AB12");
    await carePortalContext("AB12", "pair token");
    expect(calls[0].url).toBe("/api/care/portal?session=AB12");
    expect(calls[1].url).toBe("/api/care/portal?session=AB12&pair=pair+token");
  });

  it("builds the phone QR URL with the session capability", async () => {
    const calls = spyFetch(jsonResponse(200, { url: "https://x/care/phone", qrDataUrl: "data:" }));
    await carePhoneQr("AB12", "pair");
    expect(calls[0].url).toBe("/api/care/phone/qr?session=AB12&pair=pair");
  });
});

describe("portal ask payload", () => {
  it("sends the question with voice and detail options", async () => {
    const calls = spyFetch(jsonResponse(200, { result: { answer: "ok" } }));
    await carePortalAsk("AB12", "latest readings?", "pair", { voice: true, detail: "deep" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      session: "AB12",
      pair: "pair",
      action: "ask",
      question: "latest readings?",
      voice: true,
      detail: "deep",
      history: undefined,
    });
  });

  it("omits absent optional values", async () => {
    const calls = spyFetch(jsonResponse(200, { result: { answer: "ok" } }));
    await carePortalAsk("AB12", "hello");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.pair).toBeUndefined();
    expect(body.voice).toBeUndefined();
  });
});