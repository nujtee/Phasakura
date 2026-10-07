import type { FetchLike } from "../line/line-api.ts";

/**
 * Google Analytics Data API (GA4) client for the dashboard (spec §48): visitors, page views and
 * funnel event counts. Authenticates as a service account (JWT RS256 → OAuth access token) whose
 * JSON key is the Cloudflare Secret GA4_SERVICE_ACCOUNT_KEY. Read-only scope. The key, the signed
 * assertion and the access token are never logged, stored or returned.
 */

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
}

export interface Ga4Numbers {
  visitors: number;
  pageViews: number;
  /** eventCount per funnel event name. */
  events: Record<string, number>;
}

export type Ga4Result = { ok: true; data: Ga4Numbers } | { ok: false; error: string };

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const FUNNEL_EVENTS = ["view_accommodation", "begin_booking", "begin_checkout", "search", "add_food"] as const;
const PROPERTY_ID = /^\d{5,20}$/;

export function parseServiceAccountKey(raw: string | null | undefined): ServiceAccountKey | null {
  if (!raw?.trim()) return null;
  try {
    const k = JSON.parse(raw) as Record<string, unknown>;
    if (typeof k.client_email !== "string" || typeof k.private_key !== "string") return null;
    if (!/-----BEGIN PRIVATE KEY-----/.test(k.private_key)) return null;
    return { clientEmail: k.client_email, privateKey: k.private_key };
  } catch {
    return null;
  }
}

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** Signed JWT assertion for the OAuth 2.0 JWT bearer grant (valid 1 hour). */
export async function signAssertion(key: ServiceAccountKey, nowSec: number): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importPrivateKey(key.privateKey), new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(new Uint8Array(signature))}`;
}

/** The dashboard never waits more than 8 seconds for Google. */
const timeout = (): AbortSignal | undefined => (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(8000) : undefined);

/** Access token cache per isolate (tokens last an hour; refreshed 5 minutes early). */
let cached: { email: string; token: string; exp: number } | null = null;
export function resetGa4TokenCache(): void {
  cached = null;
}

/** Google's error text without anything that could be a credential. */
function scrub(text: string): string {
  return text.replace(/ya29\.[A-Za-z0-9._-]+/g, "[token]").replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[jwt]").replace(/\s+/g, " ").slice(0, 200);
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } | string; error_description?: string };
    const e = typeof body.error === "string" ? `${body.error}${body.error_description ? `: ${body.error_description}` : ""}` : body.error?.message ?? body.error?.status;
    return scrub(`HTTP ${res.status}${e ? ` ${e}` : ""}`);
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function accessToken(key: ServiceAccountKey, fetch: FetchLike, nowSec: number): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (cached && cached.email === key.clientEmail && cached.exp - 300 > nowSec) return { ok: true, token: cached.token };
  let assertion: string;
  try {
    assertion = await signAssertion(key, nowSec);
  } catch {
    return { ok: false, error: "INVALID_SERVICE_ACCOUNT_KEY" };
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    signal: timeout(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) return { ok: false, error: await errorText(res) };
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return { ok: false, error: "NO_ACCESS_TOKEN" };
  cached = { email: key.clientEmail, token: body.access_token, exp: nowSec + (body.expires_in ?? 3600) };
  return { ok: true, token: body.access_token };
}

interface ReportRow { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }
interface BatchResponse { reports?: { rows?: ReportRow[] }[] }

const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};

/** Users, page views and funnel event counts between two dates (YYYY-MM-DD, property time zone). */
export async function fetchDashboardNumbers(opts: {
  key: ServiceAccountKey;
  propertyId: string;
  startDate: string;
  endDate: string;
  fetch?: FetchLike;
  nowSec: number;
}): Promise<Ga4Result> {
  if (!PROPERTY_ID.test(opts.propertyId)) return { ok: false, error: "INVALID_PROPERTY_ID" };
  const f = opts.fetch ?? ((input, init) => fetch(input, init));
  try {
    const auth = await accessToken(opts.key, f, opts.nowSec);
    if (!auth.ok) return auth;
    const dateRanges = [{ startDate: opts.startDate, endDate: opts.endDate }];
    const res = await f(`${DATA_API}/properties/${opts.propertyId}:batchRunReports`, {
      method: "POST",
      signal: timeout(),
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          { dateRanges, metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }] },
          {
            dateRanges,
            dimensions: [{ name: "eventName" }],
            metrics: [{ name: "eventCount" }],
            dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: [...FUNNEL_EVENTS] } } },
          },
        ],
      }),
    });
    if (res.status === 401) cached = null;
    if (!res.ok) return { ok: false, error: await errorText(res) };
    const body = (await res.json()) as BatchResponse;
    const totals = body.reports?.[0]?.rows?.[0]?.metricValues ?? [];
    const events: Record<string, number> = Object.fromEntries(FUNNEL_EVENTS.map((e) => [e, 0]));
    for (const row of body.reports?.[1]?.rows ?? []) {
      const name = row.dimensionValues?.[0]?.value;
      if (name && name in events) events[name] = num(row.metricValues?.[0]?.value);
    }
    return { ok: true, data: { visitors: num(totals[0]?.value), pageViews: num(totals[1]?.value), events } };
  } catch (e) {
    return { ok: false, error: scrub(e instanceof Error ? `NETWORK ${e.message}` : "NETWORK") };
  }
}
