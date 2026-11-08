/**
 * Minimal Gemini client for the nurse portal.
 *
 * Server-only. Used only to answer questions the deterministic, record-grounded
 * engine cannot, and to phrase a spoken alert in natural language. It is
 * strictly optional: with no key configured, or when every model is unavailable,
 * callers fall back to `portalBrain`'s deterministic answers. Nothing here
 * fabricates clinical values — the prompts forbid it and the fallback is local.
 *
 * Env: GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)
 *      GEMINI_MODEL     optional primary model override
 */

const DEFAULT_MODELS = [
  "gemini-flash-lite-latest",
];

const DEFAULT_TIMEOUT_MS = 12_000;

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
export function geminiModelLabel(): string {
  if (!geminiConfigured()) return "not configured";
  const primary = process.env.GEMINI_MODEL?.trim();
  return primary || DEFAULT_MODELS[0];
}

function modelsToTry(): string[] {
  const override = process.env.GEMINI_MODEL?.trim();
  const list = override ? [override, ...DEFAULT_MODELS] : DEFAULT_MODELS;
  return [...new Set(list)];
}

interface RawCandidate {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { code?: number; message?: string; status?: string };
}

function extractText(json: RawCandidate): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
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
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxTokens ?? 400,
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
    if (!text) return { ok: false, status: 204, message: "empty response" };
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

  for (const model of modelsToTry()) {
    const first = await callModel(model, key, opts, true);
    if (first.ok) return first.result;

    // Some models reject thinkingConfig; retry the same model without it.
    if (first.status === 400) {
      const retry = await callModel(model, key, opts, false);
      if (retry.ok) return retry.result;
    }

    // 503/429/404 are model-specific — try the next one. Auth errors (401/403)
    // will not improve, so stop early.
    if (first.status === 401 || first.status === 403) return null;
  }

  return null;
}