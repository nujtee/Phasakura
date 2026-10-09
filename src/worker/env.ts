/**
 * Worker bindings.
 *
 * The D1/R2 shapes below are the minimal structural subset this codebase uses.
 * They are compatible with `@cloudflare/workers-types` (run `npm run cf-typegen`
 * to generate the full `worker-configuration.d.ts`), and they keep repositories
 * easy to fake in tests.
 */

export interface D1Result<T> {
  results: T[];
  success: boolean;
  /** Rows changed by a write (D1 reports it; RETURNING statements report rows instead). */
  meta?: { changes?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1Result<unknown>[]>;
}

export interface R2ObjectBodyLike {
  body: ReadableStream;
  size: number;
}

export interface R2BucketLike {
  head(key: string): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string }; sha256?: string },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** Cloudflare Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

export type AppEnvironment = "development" | "staging" | "production";

export interface Env {
  /** D1 — source of truth. */
  DB: D1DatabaseLike;
  /** R2 public media (logos, gallery, …). */
  MEDIA_PUBLIC: R2BucketLike;
  /** R2 private files (payment slips). Never served without authorization. */
  MEDIA_PRIVATE: R2BucketLike;
  /** Static assets (built React app). */
  ASSETS: AssetsFetcher;
  APP_ENV: AppEnvironment;
  /** Canonical public origin (https://your-domain) used in reset/invite links. */
  APP_BASE_URL?: string;
  /** Optional public base URL of the R2 public bucket (custom domain). */
  PUBLIC_MEDIA_BASE_URL?: string;
  /** Slip verification service name ("easyslip"); empty = manual verification only. Not a secret. */
  SLIP_VERIFY_PROVIDER?: string;
  /** Slip verification API key — Cloudflare Secret only (`wrangler secret put SLIP_VERIFICATION_API_KEY`). */
  SLIP_VERIFICATION_API_KEY?: string;
  /** Meta Conversions API token — Cloudflare Secret only. Never stored in D1, never returned by the API. */
  META_CAPI_ACCESS_TOKEN?: string;
  /** Meta test event code — Cloudflare Secret. When set, CAPI events go to Events Manager → Test events. */
  META_TEST_EVENT_CODE?: string;
  /** Optional Cloudflare Secret: Pixel ID for CAPI (otherwise the Pixel ID from Marketing settings is used). */
  META_PIXEL_ID?: string;
  /** GA4 Data API: JSON key of a service account with Viewer access to the GA4 property (secret). */
  GA4_SERVICE_ACCOUNT_KEY?: string;
  /** Graph API version for CAPI (plain var, e.g. "v23.0"). */
  META_GRAPH_API_VERSION?: string;
  /** Workers Rate Limiting bindings (Phase 14). Missing in local dev / tests unless configured. */
  RL_PUBLIC?: RateLimitBinding;
  RL_WRITE?: RateLimitBinding;
  RL_AUTH?: RateLimitBinding;
  RL_ADMIN?: RateLimitBinding;
  /** LINE Messaging API channel access token (long-lived) — Cloudflare Secret only. */
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  /** LINE channel secret (webhook signature) — Cloudflare Secret only. */
  LINE_CHANNEL_SECRET?: string;
  /**
   * E-mail notifications from the Zoho Mail mailbox: Zoho API Console "Self Client" with the scopes
   * ZohoMail.messages.CREATE,ZohoMail.accounts.READ — Cloudflare Secrets only. Used when all three are set.
   */
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_REFRESH_TOKEN?: string;
  /** Zoho data centre: com (US, default), eu, in, com.au, jp, ca, sa — the domain of your Zoho Mail login. */
  ZOHO_REGION?: string;
  /** Resend API key for e-mail notifications (used when Zoho Mail is not set up) — Cloudflare Secret only. */
  RESEND_API_KEY?: string;
  /** PayPal REST app (Checkout) — Cloudflare Secrets only. */
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  /** "sandbox" while testing with sandbox app credentials; anything else / unset = live PayPal. */
  PAYPAL_ENV?: string;
}
