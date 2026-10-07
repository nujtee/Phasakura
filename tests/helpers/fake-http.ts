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
