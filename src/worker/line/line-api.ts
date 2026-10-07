import { timingSafeEqual } from "../security/tokens.ts";

/**
 * Minimal LINE Messaging API client (https://developers.line.biz/en/reference/messaging-api/).
 * The channel access token comes from a Cloudflare Secret and is only ever put in the
 * Authorization header — never logged, stored or returned.
 */

export const LINE_API_BASE = "https://api.line.me";
/** Path LINE calls (LINE Developers → Messaging API → Webhook URL). */
export const LINE_WEBHOOK_PATH = "/api/line/webhook";
/** A text message holds at most 5,000 characters; a push request at most 5 messages. */
export const LINE_TEXT_MAX = 5000;
export const LINE_MESSAGES_PER_REQUEST = 5;
const TIMEOUT_MS = 10_000;

export interface LineTextMessage {
  type: "text";
  text: string;
}

export type LineSendResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: number; error: string; retryable: boolean; retryAfterSeconds: number | null };

export interface LineBotInfo {
  basicId: string | null;
  displayName: string | null;
}

export interface LineApi {
  /** Push with `X-Line-Retry-Key`: resending the same key never delivers twice (LINE answers 409). */
  push(to: string, messages: LineTextMessage[], retryKey: string): Promise<LineSendResult>;
  reply(replyToken: string, messages: LineTextMessage[]): Promise<LineSendResult>;
  botInfo(): Promise<{ ok: true; info: LineBotInfo } | Extract<LineSendResult, { ok: false }>>;
  /** Monthly message quota; nulls when LINE does not report it. */
  quota(): Promise<{ limit: number | null; used: number | null }>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function failure(res: Response): Promise<Extract<LineSendResult, { ok: false }>> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string") detail = body.message;
  } catch {
    // not JSON
  }
  const retryAfter = Number(res.headers.get("Retry-After"));
  return {
    ok: false,
    status: res.status,
    // 401: token missing/revoked (fixable by the admin, so retried); 408/429/5xx: temporary.
    retryable: res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : null,
    error: `HTTP_${res.status}${detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 160)}` : ""}`,
  };
}

function networkFailure(error: unknown): Extract<LineSendResult, { ok: false }> {
  const name = error instanceof Error ? error.name : "";
  return { ok: false, status: 0, error: name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK", retryable: true, retryAfterSeconds: null };
}

export function createLineApi(token: string, fetchImpl: FetchLike = (i, init) => fetch(i, init), base = LINE_API_BASE): LineApi {
  const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
  const post = async (path: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> =>
    fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json", ...extra }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  const get = (path: string) => fetchImpl(`${base}${path}`, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });

  return {
    async push(to, messages, retryKey) {
      try {
        const res = await post("/v2/bot/message/push", { to, messages }, { "X-Line-Retry-Key": retryKey });
        if (res.ok) return { ok: true, duplicate: false };
        // Same retry key already accepted (e.g. our previous attempt timed out after LINE took it).
        if (res.status === 409 && res.headers.get("x-line-accepted-request-id")) return { ok: true, duplicate: true };
        return await failure(res);
      } catch (error) {
        return networkFailure(error);
      }
    },
    async reply(replyToken, messages) {
      try {
        const res = await post("/v2/bot/message/reply", { replyToken, messages });
        return res.ok ? { ok: true, duplicate: false } : await failure(res);
      } catch (error) {
        return networkFailure(error);
      }
    },
    async botInfo() {
      try {
        const res = await get("/v2/bot/info");
        if (!res.ok) return await failure(res);
        const body = (await res.json()) as { basicId?: unknown; displayName?: unknown };
        return {
          ok: true,
          info: {
            basicId: typeof body.basicId === "string" ? body.basicId : null,
            displayName: typeof body.displayName === "string" ? body.displayName.slice(0, 200) : null,
          },
        };
      } catch (error) {
        return networkFailure(error);
      }
    },
    async quota() {
      try {
        const [q, c] = await Promise.all([get("/v2/bot/message/quota"), get("/v2/bot/message/quota/consumption")]);
        const quota = q.ok ? ((await q.json()) as { type?: string; value?: number }) : null;
        const used = c.ok ? ((await c.json()) as { totalUsage?: number }) : null;
        return {
          limit: quota?.type === "limited" && typeof quota.value === "number" ? quota.value : null,
          used: typeof used?.totalUsage === "number" ? used.totalUsage : null,
        };
      } catch {
        return { limit: null, used: null };
      }
    },
  };
}

/**
 * `X-Line-Retry-Key` must be a UUID. Derived from the notification id so every attempt
 * of the same notification carries the same key (LINE de-duplicates for 24 h).
 */
export function retryKeyFor(notificationId: string): string {
  const hex = notificationId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("notification id is not 128-bit hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Webhook authenticity: base64(HMAC-SHA256(channel secret, raw body)) in `x-line-signature`. */
export async function verifyLineSignature(secret: string, body: Uint8Array, signature: string | null): Promise<boolean> {
  if (!signature || !secret) return false;
  const expected = base64ToBytes(signature.trim());
  if (!expected || expected.length !== 32) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, body as BufferSource));
  return timingSafeEqual(actual, expected);
}

/** Test/e2e helper: the signature LINE would send. */
export async function signLineBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Splits text blocks into ≤ 5 messages of ≤ 5,000 characters; drops the rest with a note. */
export function packMessages(blocks: string[], moreNote: (n: number) => string, maxChars = LINE_TEXT_MAX - 200): LineTextMessage[] {
  const messages: string[] = [];
  let current = "";
  let used = 0;
  for (const block of blocks) {
    const piece = block.length > maxChars ? `${block.slice(0, maxChars - 1)}…` : block;
    const next = current ? `${current}\n\n${piece}` : piece;
    if (next.length <= maxChars) {
      current = next;
      used++;
      continue;
    }
    if (messages.length === LINE_MESSAGES_PER_REQUEST - 1) break;
    messages.push(current);
    current = piece;
    used++;
  }
  if (current) messages.push(current);
  const left = blocks.length - used;
  if (left > 0) messages[messages.length - 1] = `${messages[messages.length - 1]}\n\n${moreNote(left)}`;
  return messages.map((text) => ({ type: "text", text }));
}
