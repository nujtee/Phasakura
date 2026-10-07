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
  /** Meta test event code — Cloudflare Secret (used in Phase 14 while testing CAPI). */
  META_TEST_EVENT_CODE?: string;
  /** LINE Messaging API channel access token (long-lived) — Cloudflare Secret only. */
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  /** LINE channel secret (webhook signature) — Cloudflare Secret only. */
  LINE_CHANNEL_SECRET?: string;
}
