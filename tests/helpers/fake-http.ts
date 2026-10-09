/**
 * Fake third-party HTTP endpoint (Meta Graph API, Google OAuth / GA4 Data API) for tests and the
 * e2e server: records every request; `respond` decides the answer (default 200 with `defaultBody`).
 */
export interface FakeRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  json: Record<string, unknown> | null;
}

export class FakeHttp {
  readonly requests: FakeRequest[] = [];
  /** Answers for the next calls in order (then `respond`). "network" throws like a dropped connection. */
  readonly next: (Response | "network")[] = [];
  respond: (req: FakeRequest) => Response;

  constructor(private readonly hosts: string[], defaultBody: (req: FakeRequest) => unknown) {
    this.respond = (req) => new Response(JSON.stringify(defaultBody(req)), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  reset(): void {
    this.requests.length = 0;
    this.next.length = 0;
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (!this.hosts.includes(url.hostname)) throw new Error(`unexpected host ${url.hostname}`);
    const body = typeof init.body === "string" ? init.body : "";
    let json: Record<string, unknown> | null = null;
    try { json = body ? (JSON.parse(body) as Record<string, unknown>) : null; } catch { json = null; }
    const req: FakeRequest = { url: input, method: init.method ?? "GET", headers: new Headers(init.headers), body, json };
    this.requests.push(req);
    const queued = this.next.shift();
    if (queued === "network") throw new TypeError("fetch failed");
    return queued ?? this.respond(req);
  };
}

export const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Meta Graph API: accepts every event. */
export const fakeMeta = () => new FakeHttp(["graph.facebook.com"], (req) => ({ events_received: ((req.json?.data as unknown[]) ?? []).length, fbtrace_id: "trace" }));

/** Google OAuth token endpoint + GA4 Data API batchRunReports with fixed numbers. */
export function fakeGoogle(numbers = { users: 321, views: 1234, events: { view_accommodation: 210, begin_booking: 40, begin_checkout: 25, search: 77, add_food: 12 } }) {
  return new FakeHttp(["oauth2.googleapis.com", "analyticsdata.googleapis.com"], (req) => {
    if (req.url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "ya29.fake-access-token", expires_in: 3600, token_type: "Bearer" };
    return {
      reports: [
        { rows: [{ metricValues: [{ value: String(numbers.users) }, { value: String(numbers.views) }] }] },
        { rows: Object.entries(numbers.events).map(([name, n]) => ({ dimensionValues: [{ value: name }], metricValues: [{ value: String(n) }] })) },
      ],
    };
  });
}

/** Resend e-mail API: accepts every message (id per message). */
export const fakeResend = () => {
  let n = 0;
  return new FakeHttp(["api.resend.com"], () => ({ id: `re_fake_${++n}` }));
};

/**
 * Zoho Mail (US data centre): refresh token → access token, GET /api/accounts, POST …/messages — answering the
 * way Zoho does (token errors with HTTP 200, {status:{code}} in bodies). Access tokens stay valid until
 * `expireTokens()`; `tokenMode` makes the accounts server refuse.
 */
export class FakeZoho extends FakeHttp {
  readonly mailbox = { accountId: "2560636000000008002", primary: "booking@phasakura.test", aliases: ["info@phasakura.test"] };
  tokenMode: "OK" | "INVALID_CLIENT" | "RATE_LIMITED" = "OK";
  /** Zoho answers every message with this instead of sending it (e.g. an hourly-limit error). */
  messageError: { status: number; errorCode: string } | null = null;
  readonly valid = new Set<string>();
  private seq = 0;

  constructor() {
    super(["accounts.zoho.com", "mail.zoho.com"], () => ({}));
    this.respond = (req) => this.answer(req);
  }

  /** Messages Zoho accepted (request bodies). */
  get sent(): Record<string, unknown>[] {
    return this.requests
      .filter((r) => r.method === "POST" && /\/messages$/.test(new URL(r.url).pathname) && this.accepted.has(r))
      .map((r) => r.json!);
  }

  private readonly accepted = new Set<FakeRequest>();

  get tokenRequests(): FakeRequest[] {
    return this.requests.filter((r) => new URL(r.url).pathname === "/oauth/v2/token");
  }

  expireTokens(): void {
    this.valid.clear();
  }

  private answer(req: FakeRequest): Response {
    const url = new URL(req.url);
    if (url.hostname === "accounts.zoho.com" && url.pathname === "/oauth/v2/token" && req.method === "POST") {
      const form = new URLSearchParams(req.body);
      if (this.tokenMode === "RATE_LIMITED") {
        return jsonResponse({ error_description: "You have made too many requests continuously. Please try again after some time.", error: "Access Denied", status: "failure" }, 400);
      }
      if (this.tokenMode === "INVALID_CLIENT" || form.get("grant_type") !== "refresh_token" || !form.get("refresh_token") || !form.get("client_secret")) {
        return jsonResponse({ error: "invalid_client" });
      }
      const token = `1000.fakeaccess${++this.seq}`;
      this.valid.add(token);
      return jsonResponse({ access_token: token, api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.hostname !== "mail.zoho.com") return jsonResponse({ status: { code: 404, description: "not found" } }, 404);
    const token = (req.headers.get("Authorization") ?? "").replace(/^Zoho-oauthtoken /, "");
    if (!this.valid.has(token)) return jsonResponse({ data: { errorCode: "INVALID_OAUTHTOKEN" }, status: { code: 401, description: "Invalid Input" } }, 401);
    const addresses = [this.mailbox.primary, ...this.mailbox.aliases];
    if (req.method === "GET" && url.pathname === "/api/accounts") {
      return jsonResponse({
        status: { code: 200, description: "success" },
        data: [{
          accountId: this.mailbox.accountId, primaryEmailAddress: this.mailbox.primary, displayName: "Phasakura",
          sendMailDetails: addresses.map((a, i) => ({ sendMailId: `${i + 1}`, displayName: "Phasakura", fromAddress: a, status: true })),
          emailAddress: addresses.map((a, i) => ({ isAlias: i > 0, isPrimary: i === 0, mailId: a })),
        }],
      });
    }
    const m = /^\/api\/accounts\/(\d+)\/messages$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      if (m[1] !== this.mailbox.accountId) return jsonResponse({ data: { errorCode: "INVALID_ACCOUNT" }, status: { code: 404, description: "Invalid Input" } }, 404);
      if (!addresses.includes(String(req.json?.fromAddress ?? ""))) {
        return jsonResponse({ data: { errorCode: "INVALID_FROM_ADDRESS", moreInfo: `${String(req.json?.fromAddress)} not allowed` }, status: { code: 400, description: "Invalid Input" } }, 400);
      }
      if (this.messageError) {
        return jsonResponse({ data: { errorCode: this.messageError.errorCode }, status: { code: this.messageError.status, description: "Error" } }, this.messageError.status);
      }
      this.accepted.add(req);
      return jsonResponse({
        status: { code: 200, description: "success" },
        data: { messageId: String(1700000000000 + ++this.seq), fromAddress: req.json?.fromAddress, toAddress: req.json?.toAddress, subject: req.json?.subject },
      });
    }
    return jsonResponse({ status: { code: 404, description: "not found" } }, 404);
  }
}

/**
 * PayPal REST (sandbox host): OAuth token, create order, capture, get order — with a little state so a
 * capture can be repeated, lost or refused like the real API.
 *   captureMode: COMPLETED | PENDING | DECLINED | LOST (taken, but the answer is lost: 500) | WRONG_AMOUNT
 */
export class FakePaypal extends FakeHttp {
  readonly orders = new Map<string, { value: string; customId: string | null; captured: null | { id: string; status: string; value: string } }>();
  captureMode: "COMPLETED" | "PENDING" | "DECLINED" | "LOST" | "WRONG_AMOUNT" = "COMPLETED";
  private seq = 0;

  constructor() {
    super(["api-m.sandbox.paypal.com", "api-m.paypal.com"], () => ({}));
    this.respond = (req) => this.answer(req);
  }

  get captures(): FakeRequest[] {
    return this.requests.filter((r) => r.url.endsWith("/capture"));
  }

  private captureBody(id: string, c: { id: string; status: string; value: string }, customId: string | null) {
    return {
      id, status: c.status === "COMPLETED" ? "COMPLETED" : "COMPLETED",
      purchase_units: [{ payments: { captures: [{
        id: c.id, status: c.status, amount: { currency_code: "THB", value: c.value }, custom_id: customId,
        ...(c.status === "PENDING" ? { status_details: { reason: "PENDING_REVIEW" } } : {}),
      }] } }],
    };
  }

  private answer(req: FakeRequest): Response {
    const path = new URL(req.url).pathname;
    if (path === "/v1/oauth2/token") return jsonResponse({ access_token: "A21AA-fake-token", token_type: "Bearer", expires_in: 32400 });
    if (path === "/v2/checkout/orders" && req.method === "POST") {
      const unit = (req.json?.purchase_units as { amount: { value: string }; custom_id?: string }[])[0]!;
      const id = `5O190127TN36471${String(++this.seq).padStart(2, "0")}`;
      this.orders.set(id, { value: unit.amount.value, customId: unit.custom_id ?? null, captured: null });
      return jsonResponse({ id, status: "PAYER_ACTION_REQUIRED", links: [
        { href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
        { href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" },
      ] });
    }
    const m = /^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/.exec(path);
    const order = m ? this.orders.get(m[1]!) : undefined;
    if (!m || !order) return jsonResponse({ name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] }, 404);
    if (!m[2]) {
      return jsonResponse(order.captured ? this.captureBody(m[1]!, order.captured, order.customId) : { id: m[1], status: "APPROVED", purchase_units: [{}] });
    }
    if (order.captured) return jsonResponse({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] }, 422);
    if (this.captureMode === "DECLINED") return jsonResponse({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] }, 422);
    order.captured = {
      id: `3C67902${String(this.seq).padStart(2, "0")}${m[1]!.slice(-4)}`,
      status: this.captureMode === "PENDING" ? "PENDING" : "COMPLETED",
      value: this.captureMode === "WRONG_AMOUNT" ? "1.00" : order.value,
    };
    if (this.captureMode === "LOST") return new Response("upstream error", { status: 500 });
    return jsonResponse(this.captureBody(m[1]!, order.captured, order.customId), 201);
  }
}
