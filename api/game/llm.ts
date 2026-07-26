import "dotenv/config";

/**
 * Secrets are loaded only from process environment (e.g. local `.env` which
 * is gitignored, or host/CI secret store). They are never embedded in the
 * client bundle and must never be logged.
 */
const AI_API_KEY = process.env.DEFAULT_AI_API_KEY ?? "";
const AI_BASE_URL = (process.env.DEFAULT_AI_BASE_URL ?? "").replace(/\/+$/, "");
const AI_MODEL = process.env.DEFAULT_AI_MODEL ?? "";
/** Prefer OpenAI-compatible; set LLM_PROTOCOL=anthropic to force Anthropic shape. */
const AI_PROTOCOL = (process.env.LLM_PROTOCOL ?? "openai").toLowerCase();
const DISABLE_THINKING =
  (process.env.LLM_DISABLE_THINKING ?? "true").toLowerCase() !== "false";

const GLOBAL_LLM_CONCURRENCY = 8;
const MAX_LLM_WAITERS = 64;
let activeLlmCalls = 0;

interface LlmWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

const llmWaiters: LlmWaiter[] = [];

class LlmSlotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmSlotError";
  }
}

async function acquireLlmSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new LlmSlotError("aborted");
  }
  if (activeLlmCalls < GLOBAL_LLM_CONCURRENCY) {
    activeLlmCalls += 1;
    return;
  }
  if (llmWaiters.length >= MAX_LLM_WAITERS) {
    throw new LlmSlotError("queue_full");
  }

  await new Promise<void>((resolve, reject) => {
    const waiter: LlmWaiter = {
      resolve: () => {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        resolve();
      },
      reject: (err) => {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        reject(err);
      },
      signal,
    };
    if (signal) {
      waiter.onAbort = () => {
        const idx = llmWaiters.indexOf(waiter);
        if (idx >= 0) llmWaiters.splice(idx, 1);
        waiter.reject(new LlmSlotError("aborted"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    llmWaiters.push(waiter);
  });
}

function releaseLlmSlot(): void {
  const next = llmWaiters.shift();
  if (next) {
    // Handoff: waiter inherits the active slot count.
    next.resolve();
    return;
  }
  activeLlmCalls = Math.max(0, activeLlmCalls - 1);
}

export interface LlmHistoryItem {
  role: "user" | "assistant";
  content: string;
}

interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sk-[a-zA-Z0-9]+/g, "[REDACTED_KEY]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s]+/gi, "$1[REDACTED]");
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(timer);
      return null;
    }
    outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  let acquired = false;
  try {
    await acquireLlmSlot(outerSignal);
    acquired = true;
    if (outerSignal?.aborted || controller.signal.aborted) {
      return null;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[llm] request failed → http ${res.status}: ${redactSecrets(text).slice(0, 200)}`,
      );
      return null;
    }
    return await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/abort|queue_full/i.test(msg)) {
      console.error(`[llm] request failed:`, redactSecrets(msg));
    }
    return null;
  } finally {
    if (acquired) releaseLlmSlot();
    clearTimeout(timer);
    if (outerSignal) {
      outerSignal.removeEventListener("abort", onOuterAbort);
    }
  }
}

function openAiBody(
  system: string,
  history: LlmHistoryItem[],
  opts: CallOptions,
) {
  const body: Record<string, unknown> = {
    model: AI_MODEL,
    messages: [{ role: "system", content: system }, ...history],
    max_tokens: opts.maxTokens ?? 150,
    temperature: opts.temperature ?? 0.9,
  };
  if (DISABLE_THINKING) {
    body.thinking = { type: "disabled" };
  }
  return body;
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
    openAiBody(system, history, opts),
    opts.timeoutMs ?? 5_000,
    opts.signal,
  )) as { choices?: { message?: { content?: unknown } }[] } | null;

  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

async function tryAnthropic(
  system: string,
  history: LlmHistoryItem[],
  opts: CallOptions,
): Promise<string | null> {
  const body: Record<string, unknown> = {
    model: AI_MODEL,
    system,
    messages: history,
    max_tokens: opts.maxTokens ?? 150,
    temperature: opts.temperature ?? 0.9,
  };
  if (DISABLE_THINKING) {
    body.thinking = { type: "disabled" };
  }
  const data = (await postJson(
    `${AI_BASE_URL}/messages`,
    {
      "Content-Type": "application/json",
      "x-api-key": AI_API_KEY,
      Authorization: `Bearer ${AI_API_KEY}`,
      "anthropic-version": "2023-06-01",
    },
    body,
    opts.timeoutMs ?? 5_000,
    opts.signal,
  )) as { content?: { type?: string; text?: unknown }[] } | null;

  const block = data?.content?.find((b) => b?.type === "text");
  const text = block?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/**
 * Single-protocol LLM call (default OpenAI-compatible).
 * Key is read from env at process start only — never returned to clients.
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
  if (opts.signal?.aborted) return null;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const next = { ...opts, timeoutMs };
  if (AI_PROTOCOL === "anthropic") {
    return tryAnthropic(system, history, next);
  }
  return tryOpenAI(system, history, next);
}

/** For health checks — never expose the key itself. */
export function llmConfigured(): boolean {
  return Boolean(AI_API_KEY && AI_BASE_URL && AI_MODEL);
}

/** Test helper */
export function __resetLlmSemaphoreForTests() {
  activeLlmCalls = 0;
  llmWaiters.length = 0;
}
