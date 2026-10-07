import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface Attribution {
  consentVersion: number;
  analytics: boolean;
  marketing: boolean;
  fbp: string | null;
  fbc: string | null;
  userAgent: string | null;
  ip: string | null;
  sourceUrl: string | null;
}

export interface MarketingEventRow {
  id: string;
  event_name: "Lead" | "Purchase" | "PageView";
  event_id: string;
  booking_id: string | null;
  event_time: string;
  is_test: number;
  status: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  skip_reason: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface EventContextRow {
  booking_code: string;
  total_satang: number;
  booking_status: string;
  item_type: string | null;
  slug: string | null;
  quantity: number | null;
  food_items: number;
  fbp: string | null;
  fbc: string | null;
  user_agent: string | null;
  ip_address: string | null;
  source_url: string | null;
  marketing_consent: number | null;
}

const COLUMNS = `id, event_name, event_id, booking_id, event_time, is_test, status, attempts, next_attempt_at, last_error, skip_reason, created_at, sent_at`;

/** Conversions API is on and has a Pixel ID (settings), as an SQL condition for the outbox inserts. */
const CAPI_ON = `EXISTS (SELECT 1 FROM marketing_settings s WHERE s.id = 1 AND s.meta_capi_enabled = 1)`;

/** Marketing attribution + the Meta Conversions API outbox (spec §45). Static SQL only. */
export class MarketingRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Consent (always) and browser ids (only with Marketing consent), in the booking's batch. */
  attributionStatement(bookingId: string, a: Attribution, now: string): D1PreparedStatementLike {
    const keep = (v: string | null, max: number) => (a.marketing && v && v.length <= max ? v : null);
    return this.db.prepare(
      `INSERT INTO booking_marketing (booking_id, consent_version, analytics_consent, marketing_consent, fbp, fbc, user_agent, ip_address,
                                      source_url, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(bookingId, a.consentVersion, a.analytics ? 1 : 0, a.marketing ? 1 : 0, keep(a.fbp, 100), keep(a.fbc, 300),
      a.marketing && a.userAgent ? a.userAgent.slice(0, 400) : null, keep(a.ip, 64), a.sourceUrl ? a.sourceUrl.slice(0, 500) : null, now);
  }

  /**
   * Lead: queued with the booking itself, only with Marketing consent and the Conversions API on.
   * `event_id` = lead-<Booking ID>, the same as the browser Pixel's eventID.
   */
  leadStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db.prepare(
      `INSERT OR IGNORE INTO marketing_events (id, event_name, event_id, booking_id, event_time, next_attempt_at, created_at)
       SELECT lower(hex(randomblob(16))), 'Lead', 'lead-' || b.booking_code, b.id, b.created_at, ?2, ?2
         FROM bookings b JOIN booking_marketing m ON m.booking_id = b.id AND m.marketing_consent = 1
        WHERE b.id = ?1 AND ${CAPI_ON}`,
    ).bind(bookingId, now);
  }

  /**
   * Purchase: only when this very batch confirmed the booking (marker confirmed_at = now) — the
   * "payment confirmed" state of spec §45 — and the guest gave Marketing consent.
   */
  purchaseStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db.prepare(
      `INSERT OR IGNORE INTO marketing_events (id, event_name, event_id, booking_id, event_time, next_attempt_at, created_at)
       SELECT lower(hex(randomblob(16))), 'Purchase', 'purchase-' || b.booking_code, b.id, b.confirmed_at, ?2, ?2
         FROM bookings b JOIN booking_marketing m ON m.booking_id = b.id AND m.marketing_consent = 1
        WHERE b.id = ?1 AND b.booking_status = 'CONFIRMED' AND b.confirmed_at = ?2 AND ${CAPI_ON}`,
    ).bind(bookingId, now);
  }

  insertTestStatement(id: string, eventId: string, now: string): D1PreparedStatementLike {
    return this.db.prepare(
      `INSERT INTO marketing_events (id, event_name, event_id, event_time, is_test, next_attempt_at, created_at)
       VALUES (?1, 'PageView', ?2, ?3, 1, ?3, ?3)`,
    ).bind(id, eventId, now);
  }

  /** Due events, claimed for 2 minutes each (compare-and-set): parallel cron runs never send one twice. */
  async claimDue(now: string, leaseUntil: string, limit: number): Promise<MarketingEventRow[]> {
    const { results } = await this.db.prepare(
      `SELECT ${COLUMNS} FROM marketing_events
        WHERE status = 'PENDING' AND next_attempt_at <= ?1 AND (lease_until IS NULL OR lease_until <= ?1)
        ORDER BY next_attempt_at LIMIT ?2`,
    ).bind(now, limit).all<MarketingEventRow>();
    const claimed: MarketingEventRow[] = [];
    for (const r of results) {
      const won = await this.db.prepare(
        `UPDATE marketing_events SET lease_until = ?3, attempts = attempts + 1
          WHERE id = ?1 AND status = 'PENDING' AND attempts = ?2 AND (lease_until IS NULL OR lease_until <= ?4)
        RETURNING attempts`,
      ).bind(r.id, r.attempts, leaseUntil, now).first<{ attempts: number }>();
      if (won) claimed.push({ ...r, attempts: won.attempts });
    }
    return claimed;
  }

  async byId(id: string): Promise<MarketingEventRow | null> {
    return this.db.prepare(`SELECT ${COLUMNS} FROM marketing_events WHERE id = ?1`).bind(id).first<MarketingEventRow>();
  }

  /** What the request is built from, read at send time (nothing personal is stored in the outbox). */
  async context(bookingId: string): Promise<EventContextRow | null> {
    return this.db.prepare(
      `SELECT b.booking_code, b.total_satang, b.booking_status, i.item_type, u.slug, i.quantity,
              (SELECT count(*) FROM booking_food_items f WHERE f.booking_id = b.id AND f.status = 'ACTIVE') AS food_items,
              m.fbp, m.fbc, m.user_agent, m.ip_address, m.source_url, m.marketing_consent
         FROM bookings b
         LEFT JOIN booking_items i ON i.booking_id = b.id AND i.item_type IN ('HOUSE', 'VIP_TENT', 'OWN_TENT')
         LEFT JOIN accommodation_units u ON u.id = i.unit_id
         LEFT JOIN booking_marketing m ON m.booking_id = b.id
        WHERE b.id = ?1 LIMIT 1`,
    ).bind(bookingId).first<EventContextRow>();
  }

  async markSent(id: string, now: string): Promise<void> {
    await this.db.prepare("UPDATE marketing_events SET status = 'SENT', sent_at = ?2, lease_until = NULL, last_error = NULL WHERE id = ?1")
      .bind(id, now).run();
  }

  async markRetry(id: string, next: string, error: string): Promise<void> {
    await this.db.prepare("UPDATE marketing_events SET next_attempt_at = ?2, lease_until = NULL, last_error = ?3 WHERE id = ?1 AND status = 'PENDING'")
      .bind(id, next, error.slice(0, 300)).run();
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.prepare("UPDATE marketing_events SET status = 'FAILED', lease_until = NULL, last_error = ?2 WHERE id = ?1 AND status = 'PENDING'")
      .bind(id, error.slice(0, 300)).run();
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    await this.db.prepare("UPDATE marketing_events SET status = 'SKIPPED', lease_until = NULL, skip_reason = ?2 WHERE id = ?1 AND status = 'PENDING'")
      .bind(id, reason.slice(0, 40)).run();
  }

  async list(limit: number): Promise<(MarketingEventRow & { booking_code: string | null })[]> {
    const { results } = await this.db.prepare(
      `SELECT e.id, e.event_name, e.event_id, e.booking_id, e.event_time, e.is_test, e.status, e.attempts, e.next_attempt_at, e.last_error,
              e.skip_reason, e.created_at, e.sent_at, b.booking_code
         FROM marketing_events e LEFT JOIN bookings b ON b.id = e.booking_id
        ORDER BY e.created_at DESC LIMIT ?1`,
    ).bind(limit).all<MarketingEventRow & { booking_code: string | null }>();
    return results;
  }

  /** Data minimisation: browser ids gone after 8 days, delivery log after 90. */
  retentionStatements(attributionBefore: string, eventsBefore: string, now: string): D1PreparedStatementLike[] {
    return [
      this.db.prepare(
        `UPDATE booking_marketing SET fbp = NULL, fbc = NULL, user_agent = NULL, ip_address = NULL, purged_at = ?2
          WHERE purged_at IS NULL AND created_at < ?1`,
      ).bind(attributionBefore, now),
      this.db.prepare("DELETE FROM marketing_events WHERE created_at < ?1 AND status <> 'PENDING'").bind(eventsBefore),
    ];
  }
}
