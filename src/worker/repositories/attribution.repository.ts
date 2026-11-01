import type { CampaignDto, ClickKind } from "../../shared/campaign.ts";
import type { D1DatabaseLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";

export interface SourceGroupRow {
  utm_source: string | null;
  utm_medium: string | null;
  referrer_host: string | null;
  click_kind: ClickKind | null;
  bookings: number;
  confirmed: number;
  revenue: number;
}

/** Where bookings came from (migration 0052). Static SQL only. */
export class AttributionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /**
   * Stores the source of a booking that has just committed. Best effort: a failure (or the table missing before
   * migration 0052) only loses the source, never the booking. Returns whether it was written.
   */
  async save(bookingId: string, c: CampaignDto, now: string): Promise<boolean> {
    try {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO booking_attribution (booking_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
                                                      referrer_host, landing_path, click_kind, first_seen_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        .bind(bookingId, c.utmSource, c.utmMedium, c.utmCampaign, c.utmTerm, c.utmContent, c.referrerHost, c.landingPath,
          c.clickKind, c.firstSeenAt, now)
        .run();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bookings made since `fromDate` (property time zone via `offset`), grouped by what decides their source / medium;
   * bookings without a row count as one group of NULLs (direct / unknown). Revenue = paid & confirmed bookings only.
   */
  sourceGroups(fromDate: string, offset: string): Promise<SourceGroupRow[]> {
    return withFallback(
      async () => (await this.db
        .prepare(
          `SELECT a.utm_source, a.utm_medium, a.referrer_host, a.click_kind,
                  COUNT(*) AS bookings,
                  SUM(CASE WHEN b.confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed,
                  COALESCE(SUM(CASE WHEN b.confirmed_at IS NOT NULL
                                     AND b.booking_status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW')
                                     AND b.payment_status IN ('PAID', 'VERIFIED') THEN b.total_satang ELSE 0 END), 0) AS revenue
             FROM bookings b LEFT JOIN booking_attribution a ON a.booking_id = b.id
            WHERE date(b.created_at, ?2) >= ?1
            GROUP BY a.utm_source, a.utm_medium, a.referrer_host, a.click_kind`,
        )
        .bind(fromDate, offset)
        .all<SourceGroupRow>()).results,
      async () => [],
    );
  }
}
