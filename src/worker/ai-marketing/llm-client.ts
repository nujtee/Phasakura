import type { FetchLike } from "../line/line-api.ts";

/**
 * Anthropic Messages API, called from the Worker only (AI Marketing A3). The key is the Cloudflare Secret AI_API_KEY:
 * never stored, logged or returned — error texts are cut down to the provider's message without anything key-like.
 */
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";

/**
 * Cost estimate per million tokens in US dollars (input, output) and the baht rate used for the monthly budget.
 * Kept on the high side so the budget stops early rather than late; the provider's bill is the real figure.
 */
export const PRICE_USD_PER_MTOK = { input: 3, output: 15 } as const;
export const THB_PER_USD = 37;

export function costSatang(inputTokens: number, outputTokens: number): number {
  const usd = (inputTokens * PRICE_USD_PER_MTOK.input + outputTokens * PRICE_USD_PER_MTOK.output) / 1_000_000;
  return Math.ceil(usd * THB_PER_USD * 100);
}

export type LlmResult =
  | { ok: true; text: string; inputTokens: number; outputTokens: number; model: string }
  | { ok: false; error: string; inputTokens: number; outputTokens: number };

const TIMEOUT_MS = 90_000;

/** Provider error text without anything that could be a credential. */
export function scrubError(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[key]").replace(/[A-Za-z0-9_-]{40,}/g, "[…]").replace(/\s+/g, " ").slice(0, 200);
}

export async function anthropicMessage(opts: {
  apiKey: string; model: string; system: string; user: string; maxTokens: number; fetch?: FetchLike;
}): Promise<LlmResult> {
  const f = opts.fetch ?? ((input, init) => fetch(input, init));
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  try {
    const res = await f(ANTHROPIC_URL, {
      method: "POST",
      signal,
      headers: { "x-api-key": opts.apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      }),
    });
    const body = (await res.json().catch(() => null)) as {
      content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; model?: string;
      error?: { type?: string; message?: string };
    } | null;
    const inputTokens = Math.max(0, Number(body?.usage?.input_tokens) || 0);
    const outputTokens = Math.max(0, Number(body?.usage?.output_tokens) || 0);
    if (!res.ok) {
      return { ok: false, error: scrubError(`HTTP ${res.status}${body?.error?.message ? ` ${body.error.message}` : ""}`), inputTokens, outputTokens };
    }
    const text = (body?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (!text.trim()) return { ok: false, error: "EMPTY_ANSWER", inputTokens, outputTokens };
    return { ok: true, text, inputTokens, outputTokens, model: typeof body?.model === "string" ? body.model.slice(0, 80) : opts.model };
  } catch (e) {
    return { ok: false, error: scrubError(e instanceof Error ? `NETWORK ${e.name === "TimeoutError" ? "timeout" : e.message}` : "NETWORK"), inputTokens: 0, outputTokens: 0 };
  }
}
