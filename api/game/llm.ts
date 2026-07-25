import "dotenv/config";

const AI_API_KEY = process.env.DEFAULT_AI_API_KEY ?? "";
const AI_BASE_URL = (process.env.DEFAULT_AI_BASE_URL ?? "").replace(/\/+$/, "");
const AI_MODEL = process.env.DEFAULT_AI_MODEL ?? "";
/** Prefer OpenAI-compatible; set LLM_PROTOCOL=anthropic to force Anthropic shape. */
const AI_PROTOCOL = (process.env.LLM_PROTOCOL ?? "openai").toLowerCase();

export interface LlmHistoryItem {
  role: "user" | "assistant";
  content: string;
}

interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[llm] ${url} → http ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[llm] ${url} → request failed:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tryOpenAI(
  system: string,
  history: LlmHistoryItem[],
  opts: CallOptions,
): Promise<string | null> {
  const data = (await postJson(
    `${AI_BASE_URL}/chat/completions`,
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    {
      model: AI_MODEL,
      messages: [{ role: "system", content: system }, ...history],
      max_tokens: opts.maxTokens ?? 150,
      temperature: opts.temperature ?? 0.9,
      thinking: { type: "disabled" },
    },
    opts.timeoutMs ?? 8_000,
  )) as { choices?: { message?: { content?: unknown } }[] } | null;

  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

async function tryAnthropic(
  system: string,
  history: LlmHistoryItem[],
  opts: CallOptions,
): Promise<string | null> {
  const data = (await postJson(
    `${AI_BASE_URL}/messages`,
    {
      "Content-Type": "application/json",
      "x-api-key": AI_API_KEY,
      Authorization: `Bearer ${AI_API_KEY}`,
      "anthropic-version": "2023-06-01",
    },
    {
      model: AI_MODEL,
      system,
      messages: history,
      max_tokens: opts.maxTokens ?? 150,
      temperature: opts.temperature ?? 0.9,
      thinking: { type: "disabled" },
    },
    opts.timeoutMs ?? 8_000,
  )) as { content?: { type?: string; text?: unknown }[] } | null;

  const block = data?.content?.find((b) => b?.type === "text");
  const text = block?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/**
 * Single-protocol LLM call (default OpenAI-compatible).
 * Does not blind-fall through both providers — that doubled worst-case latency.
 */
export async function callLLM(
  system: string,
  history: LlmHistoryItem[],
  opts: CallOptions = {},
): Promise<string | null> {
  if (!AI_API_KEY || !AI_BASE_URL || !AI_MODEL) {
    console.error("[llm] missing DEFAULT_AI_* credentials");
    return null;
  }
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const next = { ...opts, timeoutMs };
  if (AI_PROTOCOL === "anthropic") {
    return tryAnthropic(system, history, next);
  }
  return tryOpenAI(system, history, next);
}
