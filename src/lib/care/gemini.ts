/**
 * Minimal Gemini client for the care assistant.
 *
 * Server-only. Used only to answer questions the deterministic, record-grounded
 * engine cannot, and to phrase a spoken alert in natural language. It is
 * strictly optional: with no key configured, or when every model is unavailable,
 * callers fall back to `portalBrain`'s deterministic answers. Nothing here
 * fabricates clinical values — the prompts forbid it and the fallback is local.
 *
 * Model choice is explicit:
 *   - voice turns prefer a low-latency Flash-Lite model,
 *   - deep record questions prefer a full Flash model,
 *   - every list ends in a stable "latest" alias so a retirement does not take
 *     the assistant offline.
 *
 * Env: GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)
 *      GEMINI_MODEL     optional primary model override
 *      GEMINI_FAST_MODEL / GEMINI_DEEP_MODEL  optional per-mode overrides
 */

const FAST_MODELS = ["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-2.0-flash-lite"];
const DEEP_MODELS = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash", ...FAST_MODELS];

const DEFAULT_TIMEOUT_MS = 14_000;

export interface GeminiResult {
  text: string;
  model: string;
}

export interface GeminiOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** `fast` is the default for spoken turns; `deep` for a full record answer. */
  prefer?: "fast" | "deep";
  /** Ask the model not to emit markdown or stage directions (spoken turns). */
  spoken?: boolean;
}

export function geminiApiKey(): string | null {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    null
  );
}

export function geminiConfigured(): boolean {
  return Boolean(geminiApiKey());
}

/** Best-effort label for the UI badge; says "not configured" honestly. */
export function geminiModelLabel(prefer: "fast" | "deep" = "fast"): string {
  if (!geminiConfigured()) return "not configured";
  const primary = process.env.GEMINI_MODEL?.trim();
  if (primary) return primary;
  const mode = prefer === "deep" ? process.env.GEMINI_DEEP_MODEL?.trim() : process.env.GEMINI_FAST_MODEL?.trim();
  return mode || (prefer === "deep" ? DEEP_MODELS[0] : FAST_MODELS[0]);
}

function modelsToTry(prefer: "fast" | "deep"): string[] {
  const override = process.env.GEMINI_MODEL?.trim();
  const modeOverride =
    prefer === "deep" ? process.env.GEMINI_DEEP_MODEL?.trim() : process.env.GEMINI_FAST_MODEL?.trim();
  const base = prefer === "deep" ? DEEP_MODELS : FAST_MODELS;
  return [...new Set([override, modeOverride, ...base].filter((m): m is string => Boolean(m)))];
}

interface RawCandidate {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

function extractText(json: RawCandidate): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callModel(
  model: string,
  key: string,
  opts: GeminiOptions,
  includeThinking: boolean
): Promise<{ ok: true; result: GeminiResult } | { ok: false; status: number; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const system = opts.spoken
      ? `${opts.system}\n\nSPOKEN OUTPUT: return plain speech only. No markdown, bullet points, headings, citations, stage directions or emoji.`
      : opts.system;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxTokens ?? 420,
        topP: 0.9,
        ...(includeThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      }
    );

    const json = (await res.json().catch(() => ({}))) as RawCandidate;
    if (!res.ok) {
      return { ok: false, status: res.status, message: json.error?.message ?? res.statusText };
    }
    const text = extractText(json);
    if (!text) {
      const blocked = json.promptFeedback?.blockReason;
      return {
        ok: false,
        status: 204,
        message: blocked ? `blocked: ${blocked}` : "empty response",
      };
    }
    return { ok: true, result: { text, model } };
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : "request failed" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Asks Gemini, trying each model in turn. Returns null when every attempt fails
 * (offline, quota, outage) so the caller can fall back without an exception.
 */
export async function geminiGenerate(opts: GeminiOptions): Promise<GeminiResult | null> {
  const key = geminiApiKey();
  if (!key) return null;

  for (const model of modelsToTry(opts.prefer ?? "fast")) {
    const first = await callModel(model, key, opts, true);
    if (first.ok) return first.result;

    // Some models reject thinkingConfig or a safety setting; retry the same
    // model without the optional thinking block before moving on.
    if (first.status === 400) {
      const retry = await callModel(model, key, opts, false);
      if (retry.ok) return retry.result;
    }

    // A short retry on rate limiting or a transient model outage. This is a
    // portal request, not a batch job, so one 400ms pause is the upper bound.
    if (first.status === 429 || first.status === 503) {
      await sleep(400);
      const retry = await callModel(model, key, opts, false);
      if (retry.ok) return retry.result;
    }

    // Auth errors will not improve by trying another model.
    if (first.status === 401 || first.status === 403) return null;
  }

  return null;
}
