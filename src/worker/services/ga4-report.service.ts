import type { D1DatabaseLike } from "../env.ts";
import type { FetchLike } from "../line/line-api.ts";
import { fetchDashboardNumbers, parseServiceAccountKey, type Ga4Numbers } from "../marketing/ga4-data.ts";
import { iso, type Clock } from "./auth-context.ts";

/** Fresh for 3 hours; after a failure Google is not asked again for 15 minutes. */
const FRESH_MS = 3 * 60 * 60_000;
const RETRY_MS = 15 * 60_000;

export type Ga4Status = "OK" | "NOT_CONFIGURED" | "ERROR";

export interface Ga4DashboardResult {
  status: Ga4Status;
  /** When the numbers shown were fetched (may be older than the range when Google is unreachable). */
  fetchedAt: string | null;
  numbers: Ga4Numbers | null;
}

interface CacheRow { payload: string | null; error: string | null; fetched_at: string }
interface Payload { from: string; to: string; fetchedAt: string; numbers: Ga4Numbers }

/**
 * Dashboard web analytics from GA4 (spec §48). Numbers only — analytics never feed money figures.
 * Cached in D1 so most dashboard loads do not call Google; the hourly cron refreshes it.
 */
export class Ga4ReportService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly propertyId: () => Promise<string | null>,
    private readonly clock: Clock,
    private readonly config: { keyJson?: string | null; fetch?: FetchLike },
  ) {}

  /** Whether the service-account key secret is set and readable (never returns the key). */
  keyConfigured(): boolean {
    return parseServiceAccountKey(this.config.keyJson) !== null;
  }

  private async row(key: string): Promise<CacheRow | null> {
    try {
      return await this.db.prepare("SELECT payload, error, fetched_at FROM analytics_report_cache WHERE cache_key = ?1").bind(key).first<CacheRow>();
    } catch {
      return null; // table missing before migration 0019
    }
  }

  async dashboard(from: string, to: string, opts: { refresh?: boolean } = {}): Promise<Ga4DashboardResult> {
    const key = parseServiceAccountKey(this.config.keyJson);
    const propertyId = await this.propertyId();
    if (!key || !propertyId) return { status: "NOT_CONFIGURED", fetchedAt: null, numbers: null };

    const cacheKey = `ga4:dashboard:${propertyId}`;
    const now = this.clock();
    const row = await this.row(cacheKey);
    let payload: Payload | null = null;
    try {
      payload = row?.payload ? (JSON.parse(row.payload) as Payload) : null;
    } catch {
      payload = null;
    }
    const sameRange = payload?.from === from && payload.to === to;
    const fresh = sameRange && now.getTime() - new Date(payload!.fetchedAt).getTime() < FRESH_MS;
    const backingOff = !!row?.error && now.getTime() - new Date(row.fetched_at).getTime() < RETRY_MS;
    if (fresh && !opts.refresh) return { status: "OK", fetchedAt: payload!.fetchedAt, numbers: payload!.numbers };
    if (backingOff && !opts.refresh) return { status: "ERROR", fetchedAt: payload?.fetchedAt ?? null, numbers: payload?.numbers ?? null };

    const result = await fetchDashboardNumbers({ key, propertyId, startDate: from, endDate: to, fetch: this.config.fetch, nowSec: Math.floor(now.getTime() / 1000) });
    const at = iso(now);
    if (result.ok) {
      const next: Payload = { from, to, fetchedAt: at, numbers: result.data };
      await this.db.prepare(
        `INSERT INTO analytics_report_cache (cache_key, payload, error, fetched_at) VALUES (?1, ?2, NULL, ?3)
         ON CONFLICT (cache_key) DO UPDATE SET payload = excluded.payload, error = NULL, fetched_at = excluded.fetched_at`,
      ).bind(cacheKey, JSON.stringify(next), at).run().catch(() => undefined);
      return { status: "OK", fetchedAt: at, numbers: result.data };
    }
    await this.db.prepare(
      `INSERT INTO analytics_report_cache (cache_key, payload, error, fetched_at) VALUES (?1, NULL, ?2, ?3)
       ON CONFLICT (cache_key) DO UPDATE SET error = excluded.error, fetched_at = excluded.fetched_at`,
    ).bind(cacheKey, result.error.slice(0, 300), at).run().catch(() => undefined);
    console.warn(JSON.stringify({ level: "warn", event: "ga4_report_failed", error: result.error }));
    return { status: "ERROR", fetchedAt: payload?.fetchedAt ?? null, numbers: payload?.numbers ?? null };
  }

  /** The last error (for the admin page), without credentials. */
  async lastError(): Promise<string | null> {
    const propertyId = await this.propertyId();
    if (!propertyId) return null;
    return (await this.row(`ga4:dashboard:${propertyId}`))?.error ?? null;
  }
}
