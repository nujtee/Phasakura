/**
 * PayPal Checkout — REST Orders v2, server side only (intent CAPTURE).
 *
 *   create order  → guest approves at PayPal (link rel "payer-action") → we capture after our own checks.
 *
 * The client id / secret are Cloudflare Secrets (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET). Nothing from PayPal
 * that identifies the payer (name, e-mail, address) is read or kept: only order / capture ids, status and amount.
 * Parsing is strict; anything unexpected is an ERROR, which never confirms a booking.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type PaypalEnvironment = "sandbox" | "live";

export const PAYPAL_BASE: Record<PaypalEnvironment, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

export const PAYPAL_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export interface CapturedPayment {
  captureId: string;
  amountSatang: number;
  currency: string;
  customId: string | null;
}

export type CreateOrderResult = { ok: true; orderId: string; approveUrl: string } | { ok: false; error: string };

export type CaptureResult =
  | ({ kind: "COMPLETED" } & CapturedPayment)
  /** PayPal holds the money for review (eCheck, risk review…): staff confirm by hand. */
  | ({ kind: "PENDING"; reason: string | null } & CapturedPayment)
  /** The payer's funding source was refused, or the order was never approved / has expired. Nothing was taken. */
  | { kind: "DECLINED"; code: string }
  | { kind: "ALREADY_CAPTURED" }
  /** Network / unexpected answer: we do not know — ask again later (GET order). */
  | { kind: "ERROR"; code: string };

export type OrderLookup =
  | { kind: "OK"; status: string; capture: (CapturedPayment & { status: string }) | null }
  | { kind: "NOT_FOUND" }
  | { kind: "ERROR"; code: string };

/** "1300.00" → 130000; null for anything that is not a plain positive amount with ≤ 2 decimals. */
export function parseAmount(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,10}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function formatAmount(satang: number): string {
  return `${Math.floor(satang / 100)}.${String(satang % 100).padStart(2, "0")}`;
}

function str(v: unknown, max = 128): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

type Json = Record<string, unknown>;

/** First capture of the first purchase unit, strictly parsed. */
export function readCapture(body: unknown): (CapturedPayment & { status: string; reason: string | null }) | null {
  const units = (body as Json | null)?.purchase_units;
  const unit = Array.isArray(units) ? (units[0] as Json | undefined) : undefined;
  const captures = (unit?.payments as Json | undefined)?.captures;
  const c = Array.isArray(captures) ? (captures[0] as Json | undefined) : undefined;
  if (!c) return null;
  const id = str(c.id, 64);
  const status = str(c.status, 40);
  const amount = c.amount as Json | undefined;
  const amountSatang = parseAmount(amount?.value);
  const currency = str(amount?.currency_code, 3);
  if (!id || !PAYPAL_ID_PATTERN.test(id) || !status || amountSatang === null || !currency) return null;
  return {
    captureId: id, status, amountSatang, currency, customId: str(c.custom_id, 127),
    reason: str((c.status_details as Json | undefined)?.reason, 60),
  };
}

function issueOf(body: unknown): string | null {
  const details = (body as Json | null)?.details;
  const first = Array.isArray(details) ? (details[0] as Json | undefined) : undefined;
  return str(first?.issue, 60) ?? str((body as Json | null)?.name, 60);
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

/** Tests: forget cached access tokens. */
export function resetPaypalTokens(): void {
  tokens.clear();
}

export class PaypalApi {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    readonly environment: PaypalEnvironment,
    fetchImpl?: FetchLike,
    private readonly timeoutMs = 15_000,
  ) {
    this.base = PAYPAL_BASE[environment];
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async call(path: string, init: RequestInit): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, { ...init, signal: controller.signal });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { ok: true, status: res.status, body };
    } catch {
      return { ok: false, error: controller.signal.aborted ? "PAYPAL_TIMEOUT" : "PAYPAL_UNREACHABLE" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * OAuth client-credentials token, cached per isolate until shortly before it expires. A refusal names why
   * (PAYPAL_AUTH_401_INVALID_CLIENT = wrong id / secret, or sandbox credentials against live PayPal or the reverse).
   */
  private async token(): Promise<{ token: string } | { error: string }> {
    const key = `${this.environment}:${this.clientId}`;
    const cached = tokens.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return { token: cached.token };
    const res = await this.call("/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return { error: res.error };
    const body = res.body as Json | null;
    const token = str(body?.access_token, 4096);
    if (res.status !== 200 || !token) {
      const reason = (str(body?.error, 60) ?? "").replace(/[^A-Za-z0-9_]+/g, "_").toUpperCase();
      return { error: `PAYPAL_AUTH_${res.status}${reason ? `_${reason}` : ""}` };
    }
    const expires = typeof body?.expires_in === "number" ? body.expires_in : 300;
    tokens.set(key, { token, expiresAt: Date.now() + expires * 1000 });
    return { token };
  }

  private async authed(path: string, method: "GET" | "POST", requestId: string | null, payload?: unknown) {
    const auth = await this.token();
    if ("error" in auth) return { ok: false as const, error: auth.error };
    const token = auth.token;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", Prefer: "return=representation" };
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await this.call(path, { method, headers, ...(method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}) });
    if (res.ok && res.status === 401) tokens.delete(`${this.environment}:${this.clientId}`);
    return res;
  }

  async createOrder(input: {
    requestId: string;
    bookingId: string;
    bookingCode: string;
    amountSatang: number;
    description: string;
    brandName: string | null;
    locale: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<CreateOrderResult> {
    const res = await this.authed("/v2/checkout/orders", "POST", input.requestId, {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: input.bookingCode,
        custom_id: input.bookingId,
        description: input.description.slice(0, 127),
        amount: { currency_code: "THB", value: formatAmount(input.amountSatang) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            ...(input.brandName ? { brand_name: input.brandName.slice(0, 127) } : {}),
            locale: input.locale,
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
          },
        },
      },
    });
    if (!res.ok) return { ok: false, error: res.error };
    const body = res.body as Json | null;
    if (res.status !== 200 && res.status !== 201) {
      const issue = issueOf(body)?.replace(/[^A-Za-z0-9_]+/g, "_").toUpperCase();
      return { ok: false, error: `PAYPAL_ORDER_${res.status}${issue ? `_${issue}` : ""}` };
    }
    const orderId = str(body?.id, 64);
    const links = Array.isArray(body?.links) ? (body!.links as Json[]) : [];
    const link = links.find((l) => l.rel === "payer-action") ?? links.find((l) => l.rel === "approve");
    const approveUrl = str(link?.href, 2048);
    if (!orderId || !PAYPAL_ID_PATTERN.test(orderId) || !approveUrl || !/^https:\/\/([a-z0-9-]+\.)*paypal\.com\//.test(approveUrl)) {
      return { ok: false, error: "UNEXPECTED_RESPONSE" };
    }
    return { ok: true, orderId, approveUrl };
  }

  /** Capture an approved order. The request id makes a repeat return the first answer instead of charging twice. */
  async capture(orderId: string): Promise<CaptureResult> {
    const res = await this.authed(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, "POST", `capture-${orderId}`, {});
    if (!res.ok) return { kind: "ERROR", code: res.error };
    const body = res.body;
    if (res.status === 200 || res.status === 201) {
      const c = readCapture(body);
      if (!c) return { kind: "ERROR", code: "UNEXPECTED_RESPONSE" };
      if (c.status === "COMPLETED") return { kind: "COMPLETED", captureId: c.captureId, amountSatang: c.amountSatang, currency: c.currency, customId: c.customId };
      if (c.status === "PENDING") return { kind: "PENDING", captureId: c.captureId, amountSatang: c.amountSatang, currency: c.currency, customId: c.customId, reason: c.reason };
      return { kind: "DECLINED", code: `CAPTURE_${c.status}`.slice(0, 60) };
    }
    const issue = issueOf(body) ?? `PAYPAL_HTTP_${res.status}`;
    if (issue === "ORDER_ALREADY_CAPTURED") return { kind: "ALREADY_CAPTURED" };
    if (res.status === 422 || res.status === 404) return { kind: "DECLINED", code: issue };
    return { kind: "ERROR", code: issue };
  }

  async getOrder(orderId: string): Promise<OrderLookup> {
    const res = await this.authed(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, "GET", null);
    if (!res.ok) return { kind: "ERROR", code: res.error };
    if (res.status === 404) return { kind: "NOT_FOUND" };
    if (res.status !== 200) return { kind: "ERROR", code: issueOf(res.body) ?? `PAYPAL_HTTP_${res.status}` };
    const status = str((res.body as Json | null)?.status, 40);
    if (!status) return { kind: "ERROR", code: "UNEXPECTED_RESPONSE" };
    const c = readCapture(res.body);
    return { kind: "OK", status, capture: c ? { captureId: c.captureId, amountSatang: c.amountSatang, currency: c.currency, customId: c.customId, status: c.status } : null };
  }
}

/** PayPal from configuration; null = not offered. Secrets live in Cloudflare Secrets. */
export function createPaypalApi(
  env: { PAYPAL_CLIENT_ID?: string; PAYPAL_CLIENT_SECRET?: string; PAYPAL_ENV?: string },
  fetchImpl?: FetchLike,
): PaypalApi | null {
  const id = env.PAYPAL_CLIENT_ID?.trim();
  const secret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  return new PaypalApi(id, secret, paypalEnvironment(env), fetchImpl);
}

/** Live PayPal unless PAYPAL_ENV = "sandbox" (testing with sandbox app credentials). */
export function paypalEnvironment(env: { PAYPAL_ENV?: string }): PaypalEnvironment {
  return env.PAYPAL_ENV?.trim().toLowerCase() === "sandbox" ? "sandbox" : "live";
}
