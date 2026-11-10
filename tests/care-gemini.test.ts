import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  geminiApiKey,
  geminiConfigured,
  geminiGenerate,
  geminiModelLabel,
} from "@/lib/care/gemini";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_FAST_MODEL",
  "GEMINI_DEEP_MODEL",
];

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: {
    systemInstruction: { parts: Array<{ text: string }> };
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    safetySettings: Array<{ category: string; threshold: string }>;
    generationConfig: Record<string, unknown>;
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub that plays a queue of handlers and records every request. */
function scriptedFetch(handlers: Array<(url: string) => Response>) {
  const calls: CapturedCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as CapturedCall["body"],
    });
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch #${calls.length} to ${url}`);
    return handler(url);
  }) as typeof fetch;
  return { fn, calls };
}

function candidate(text: string): Response {
  return jsonResponse(200, { candidates: [{ content: { parts: [{ text }] } }] });
}

const MODEL_RE = /\/models\/([^:]+):generateContent/;
function modelOf(url: string): string {
  return decodeURIComponent(MODEL_RE.exec(url)?.[1] ?? "");
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("key and configuration resolution", () => {
  it("prefers GEMINI_API_KEY, then the Google fallbacks", () => {
    expect(geminiApiKey()).toBeNull();
    process.env.GOOGLE_API_KEY = "a";
    expect(geminiApiKey()).toBe("a");
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "b";
    expect(geminiApiKey()).toBe("b");
    process.env.GEMINI_API_KEY = "c";
    expect(geminiApiKey()).toBe("c");
  });

  it("reports configuration from any key variable", () => {
    expect(geminiConfigured()).toBe(false);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "k";
    expect(geminiConfigured()).toBe(true);
  });

  it("labels the model honestly, including when unconfigured", () => {
    expect(geminiModelLabel()).toBe("not configured");
    process.env.GEMINI_API_KEY = "k";
    expect(geminiModelLabel("fast")).toBe("gemini-flash-lite-latest");
    expect(geminiModelLabel("deep")).toBe("gemini-2.5-flash");

    process.env.GEMINI_FAST_MODEL = "my-fast";
    expect(geminiModelLabel("fast")).toBe("my-fast");
    // The deep label is unaffected by a fast-only override.
    expect(geminiModelLabel("deep")).toBe("gemini-2.5-flash");

    process.env.GEMINI_DEEP_MODEL = "my-deep";
    expect(geminiModelLabel("deep")).toBe("my-deep");

    // The primary override wins over both per-mode overrides.
    process.env.GEMINI_MODEL = "primary";
    expect(geminiModelLabel("fast")).toBe("primary");
    expect(geminiModelLabel("deep")).toBe("primary");
  });
});

describe("geminiGenerate request shape", () => {
  it("returns null without calling fetch when no key is set", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await geminiGenerate({ system: "s", prompt: "p" })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends the system prompt, contents, safety settings and sampling config", async () => {
    process.env.GEMINI_API_KEY = "secret-key";
    const { fn, calls } = scriptedFetch([() => candidate("Hello there")]);
    vi.stubGlobal("fetch", fn);

    const result = await geminiGenerate({
      system: "You are CareSpeak.",
      prompt: "How are you?",
      maxTokens: 100,
      temperature: 0.7,
    });

    expect(result).toEqual({ text: "Hello there", model: "gemini-flash-lite-latest" });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["x-goog-api-key"]).toBe("secret-key");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].body.systemInstruction.parts[0].text).toBe("You are CareSpeak.");
    expect(calls[0].body.contents).toEqual([{ role: "user", parts: [{ text: "How are you?" }] }]);
    expect(calls[0].body.safetySettings).toHaveLength(4);
    expect(calls[0].body.safetySettings.every((s) => s.threshold === "BLOCK_ONLY_HIGH")).toBe(true);
    expect(calls[0].body.generationConfig.temperature).toBe(0.7);
    expect(calls[0].body.generationConfig.maxOutputTokens).toBe(100);
    expect(calls[0].body.generationConfig.topP).toBe(0.9);
    expect(calls[0].body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("defaults temperature and max tokens when unset", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn, calls } = scriptedFetch([() => candidate("ok")]);
    vi.stubGlobal("fetch", fn);
    await geminiGenerate({ system: "s", prompt: "p" });
    expect(calls[0].body.generationConfig.temperature).toBe(0.2);
    expect(calls[0].body.generationConfig.maxOutputTokens).toBe(420);
  });

  it("appends a spoken-output instruction for voice turns", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn, calls } = scriptedFetch([() => candidate("spoken")]);
    vi.stubGlobal("fetch", fn);
    await geminiGenerate({ system: "Base", prompt: "p", spoken: true });
    const system = calls[0].body.systemInstruction.parts[0].text;
    expect(system).toContain("Base");
    expect(system).toContain("SPOKEN OUTPUT");
    expect(system).toContain("No markdown");
  });

  it("joins multiple content parts from one candidate", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn } = scriptedFetch([
      () =>
        jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: "Take " }, { text: "your tablets." }] } }],
        }),
    ]);
    vi.stubGlobal("fetch", fn);
    expect((await geminiGenerate({ system: "s", prompt: "p" }))?.text).toBe("Take your tablets.");
  });
});

describe("model selection and fallback", () => {
  it("tries the fast list in order and stops at the first success", async () => {
    process.env.GEMINI_API_KEY = "k";
    const overloaded = () => jsonResponse(503, { error: { message: "overloaded" } });
    const { fn, calls } = scriptedFetch([
      overloaded,
      overloaded,
      overloaded,
      overloaded,
      () => candidate("third time lucky"),
      () => candidate("should not be reached"),
    ]);
    vi.stubGlobal("fetch", fn);
    vi.useFakeTimers();

    const promise = geminiGenerate({ system: "s", prompt: "p" });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result?.text).toBe("third time lucky");
    expect(result?.model).toBe("gemini-2.0-flash-lite");
    // Two models were exhausted (each retried once after the 503), then the third.
    expect(calls.map((c) => modelOf(c.url))).toEqual([
      "gemini-flash-lite-latest",
      "gemini-flash-lite-latest",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash-lite",
    ]);
  });

  it("starts a deep request with the full Flash model", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn, calls } = scriptedFetch([() => candidate("deep answer")]);
    vi.stubGlobal("fetch", fn);
    const result = await geminiGenerate({ system: "s", prompt: "p", prefer: "deep" });
    expect(modelOf(calls[0].url)).toBe("gemini-2.5-flash");
    expect(result?.model).toBe("gemini-2.5-flash");
  });

  it("uses GEMINI_MODEL as the first attempt for both modes", async () => {
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_MODEL = "custom-primary";
    const { fn, calls } = scriptedFetch([() => candidate("ok"), () => candidate("ok")]);
    vi.stubGlobal("fetch", fn);
    await geminiGenerate({ system: "s", prompt: "p", prefer: "fast" });
    await geminiGenerate({ system: "s", prompt: "p", prefer: "deep" });
    expect(modelOf(calls[0].url)).toBe("custom-primary");
    expect(modelOf(calls[1].url)).toBe("custom-primary");
  });

  it("honours the per-mode override before the built-in list", async () => {
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_DEEP_MODEL = "deep-custom";
    const { fn, calls } = scriptedFetch([() => candidate("ok")]);
    vi.stubGlobal("fetch", fn);
    const result = await geminiGenerate({ system: "s", prompt: "p", prefer: "deep" });
    expect(modelOf(calls[0].url)).toBe("deep-custom");
    expect(result?.model).toBe("deep-custom");
  });
});

describe("failure and retry handling", () => {
  it("retries the same model without the thinking block after a 400", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn, calls } = scriptedFetch([
      () => jsonResponse(400, { error: { message: "unknown field thinkingConfig" } }),
      () => candidate("recovered"),
    ]);
    vi.stubGlobal("fetch", fn);
    const result = await geminiGenerate({ system: "s", prompt: "p" });
    expect(result?.text).toBe("recovered");
    expect(calls).toHaveLength(2);
    expect(calls[0].body.generationConfig.thinkingConfig).toBeDefined();
    expect(calls[1].body.generationConfig.thinkingConfig).toBeUndefined();
    // The retry targets the same model.
    expect(modelOf(calls[0].url)).toBe(modelOf(calls[1].url));
  });

  it("waits, then retries once after a 429", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn, calls } = scriptedFetch([
      () => jsonResponse(429, { error: { message: "quota exceeded" } }),
      () => candidate("after the pause"),
    ]);
    vi.stubGlobal("fetch", fn);
    vi.useFakeTimers();

    const promise = geminiGenerate({ system: "s", prompt: "p" });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result?.text).toBe("after the pause");
    expect(calls).toHaveLength(2);
  });

  it("short-circuits on an auth error instead of trying more models", async () => {
    process.env.GEMINI_API_KEY = "bad";
    const { fn, calls } = scriptedFetch([() => jsonResponse(401, { error: { message: "bad key" } })]);
    vi.stubGlobal("fetch", fn);
    expect(await geminiGenerate({ system: "s", prompt: "p" })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("short-circuits on a 403 as well", async () => {
    process.env.GEMINI_API_KEY = "bad";
    const { fn, calls } = scriptedFetch([() => jsonResponse(403, { error: { message: "forbidden" } })]);
    vi.stubGlobal("fetch", fn);
    expect(await geminiGenerate({ system: "s", prompt: "p" })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("tries the next model when a model returns empty content", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn, calls } = scriptedFetch([
      () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: "   " }] } }] }),
      () => candidate("real answer"),
    ]);
    vi.stubGlobal("fetch", fn);
    const result = await geminiGenerate({ system: "s", prompt: "p" });
    expect(result?.text).toBe("real answer");
    expect(calls).toHaveLength(2);
  });

  it("reports a blocked response as empty and falls through to the next model", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn, calls } = scriptedFetch([
      () => jsonResponse(200, { promptFeedback: { blockReason: "SAFETY" } }),
      () => candidate("allowed"),
    ]);
    vi.stubGlobal("fetch", fn);
    expect((await geminiGenerate({ system: "s", prompt: "p" }))?.text).toBe("allowed");
    expect(calls).toHaveLength(2);
  });

  it("treats a non-JSON body as an empty response", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn, calls } = scriptedFetch([
      () => new Response("<html>gateway</html>", { status: 200 }),
      () => candidate("recovered"),
    ]);
    vi.stubGlobal("fetch", fn);
    expect((await geminiGenerate({ system: "s", prompt: "p" }))?.text).toBe("recovered");
    expect(calls).toHaveLength(2);
  });

  it("returns null after every model fails on the network", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn, calls } = scriptedFetch([
      () => {
        throw new TypeError("fetch failed");
      },
      () => {
        throw new TypeError("fetch failed");
      },
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    vi.stubGlobal("fetch", fn);
    expect(await geminiGenerate({ system: "s", prompt: "p" })).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("returns null when every model is empty", async () => {
    process.env.GEMINI_API_KEY = "k";
    const { fn } = scriptedFetch([
      () => jsonResponse(200, {}),
      () => jsonResponse(200, {}),
      () => jsonResponse(200, {}),
    ]);
    vi.stubGlobal("fetch", fn);
    expect(await geminiGenerate({ system: "s", prompt: "p" })).toBeNull();
  });
});
