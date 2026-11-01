import type { ReportKind, ReportStatus } from "../../shared/ai-marketing-types.ts";
import type { D1DatabaseLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";

/**
 * AI marketing report (migration 0053): settings, reports, and the read-only numbers a report is computed from.
 * Static SQL only. Reads of the booking tables never select a guest's name, phone, e-mail, note or booking code.
 */
export interface SettingsRow {
  is_enabled: number;
  ai_enabled: number;
  provider: string;
  model: string | null;
  monthly_budget_satang: number;
  notify_email: number;
  notify_line: number;
  updated_at: string | null;
}

export interface ReportRow {
  id: string;
  period_kind: ReportKind;
  period_start: string;
  period_end: string;
  status: ReportStatus;
  metrics_json: string;
  insights_json: string;
  ai_summary: string | null;
  ai_model: string | null;
  ai_error: string | null;
  trigger: "CRON" | "USER";
  created_at: string;
}

export interface TotalsRow {
  bookings: number;
  confirmed: number;
  cancelled: number;
  expired: number;
  revenue: number;
  avg_lead: number | null;
  avg_nights: number | null;
  with_food: number;
  with_extra_bed: number;
  with_massage: number;
}

export interface AdrRow {
  acc_satang: number;
  unit_nights: number;
}

export interface UnitNightsRow {
  unit_id: string;
  unit_type: "HOUSE" | "VIP_TENT";
  name: string;
  sold: number;
  ota: number;
  blocked: number;
}

export interface DateNightsRow {
  stay_date: string;
  sold: number;
  ota: number;
  blocked: number;
}

export const DEFAULT_SETTINGS: SettingsRow = {
  is_enabled: 0, ai_enabled: 0, provider: "ANTHROPIC", model: null, monthly_budget_satang: 30000, notify_email: 0, notify_line: 0, updated_at: null,
};

const REPORT_COLUMNS = `id, period_kind, period_start, period_end, status, metrics_json, insights_json, ai_summary, ai_model, ai_error, trigger, created_at`;

export class AiMarketingRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  // ------------------------------------------------------------------ settings

  /** Off (defaults) before migration 0053 or before the first save. */
  settings(): Promise<SettingsRow> {
    return withFallback(
      async () => (await this.db
        .prepare(`SELECT is_enabled, ai_enabled, provider, model, monthly_budget_satang, notify_email, notify_line, updated_at
                    FROM ai_marketing_settings WHERE id = 1`)
        .first<SettingsRow>()) ?? DEFAULT_SETTINGS,
      async () => DEFAULT_SETTINGS,
    );
  }

  async saveSettings(s: Omit<SettingsRow, "updated_at" | "provider" | "model">, userId: string, now: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ai_marketing_settings (id, is_enabled, ai_enabled, monthly_budget_satang, notify_email, notify_line, updated_by, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET is_enabled = excluded.is_enabled, ai_enabled = excluded.ai_enabled,
           monthly_budget_satang = excluded.monthly_budget_satang, notify_email = excluded.notify_email, notify_line = excluded.notify_line,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(s.is_enabled, s.ai_enabled, s.monthly_budget_satang, s.notify_email, s.notify_line, userId, now)
      .run();
  }

  // ------------------------------------------------------------------ reports

  list(limit: number): Promise<ReportRow[]> {
    return withFallback(
      async () => (await this.db
        .prepare(`SELECT ${REPORT_COLUMNS} FROM marketing_reports ORDER BY period_start DESC, period_kind DESC LIMIT ?1`)
        .bind(limit)
        .all<ReportRow>()).results,
      async () => [],
    );
  }

  find(id: string): Promise<ReportRow | null> {
    return this.db.prepare(`SELECT ${REPORT_COLUMNS} FROM marketing_reports WHERE id = ?1`).bind(id).first<ReportRow>();
  }

  findPeriod(kind: ReportKind, periodStart: string): Promise<ReportRow | null> {
    return withFallback(
      () => this.db.prepare(`SELECT ${REPORT_COLUMNS} FROM marketing_reports WHERE period_kind = ?1 AND period_start = ?2`)
        .bind(kind, periodStart).first<ReportRow>(),
      async () => null,
    );
  }

  /** Writes (or rewrites) the report of a period. */
  async upsert(r: {
    id: string; kind: ReportKind; periodStart: string; periodEnd: string; status: ReportStatus; metricsJson: string; insightsJson: string;
    aiSummary: string | null; aiModel: string | null; aiError: string | null; trigger: "CRON" | "USER"; userId: string | null; now: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO marketing_reports (id, period_kind, period_start, period_end, status, metrics_json, insights_json, ai_summary, ai_model,
                                        ai_error, trigger, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
         ON CONFLICT (period_kind, period_start) DO UPDATE SET period_end = excluded.period_end, status = excluded.status,
           metrics_json = excluded.metrics_json, insights_json = excluded.insights_json, ai_summary = excluded.ai_summary,
           ai_model = excluded.ai_model, ai_error = excluded.ai_error, trigger = excluded.trigger, created_by = excluded.created_by,
           updated_at = excluded.updated_at`,
      )
      .bind(r.id, r.kind, r.periodStart, r.periodEnd, r.status, r.metricsJson, r.insightsJson, r.aiSummary, r.aiModel, r.aiError, r.trigger,
        r.userId, r.now)
      .run();
  }

  // ------------------------------------------------------------------ numbers (read only)

  /** Bookings made between two dates (property time zone via `offset`), revenue by the day it was confirmed. */
  async totals(from: string, to: string, offset: string): Promise<TotalsRow> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM bookings WHERE date(created_at, ?3) BETWEEN ?1 AND ?2) AS bookings,
           (SELECT COUNT(*) FROM bookings WHERE date(created_at, ?3) BETWEEN ?1 AND ?2 AND confirmed_at IS NOT NULL) AS confirmed,
           (SELECT COUNT(*) FROM bookings WHERE date(created_at, ?3) BETWEEN ?1 AND ?2 AND booking_status = 'CANCELLED') AS cancelled,
           (SELECT COUNT(*) FROM bookings WHERE date(created_at, ?3) BETWEEN ?1 AND ?2 AND booking_status = 'EXPIRED') AS expired,
           (SELECT COALESCE(SUM(total_satang), 0) FROM bookings
             WHERE confirmed_at IS NOT NULL AND date(confirmed_at, ?3) BETWEEN ?1 AND ?2
               AND booking_status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW') AND payment_status IN ('PAID', 'VERIFIED')) AS revenue,
           (SELECT AVG(julianday(check_in) - julianday(date(created_at, ?3))) FROM bookings
             WHERE date(created_at, ?3) BETWEEN ?1 AND ?2 AND booking_status <> 'EXPIRED') AS avg_lead,
           (SELECT AVG(nights) FROM bookings WHERE date(created_at, ?3) BETWEEN ?1 AND ?2 AND booking_status <> 'EXPIRED') AS avg_nights,
           (SELECT COUNT(DISTINCT f.booking_id) FROM food_orders f JOIN bookings b ON b.id = f.booking_id
             WHERE f.status <> 'CANCELLED' AND date(b.created_at, ?3) BETWEEN ?1 AND ?2) AS with_food,
           (SELECT COUNT(DISTINCT e.booking_id) FROM booking_extra_beds e JOIN bookings b ON b.id = e.booking_id
             WHERE date(b.created_at, ?3) BETWEEN ?1 AND ?2) AS with_extra_bed,
           (SELECT COUNT(DISTINCT m.booking_id) FROM booking_massages m JOIN bookings b ON b.id = m.booking_id
             WHERE date(b.created_at, ?3) BETWEEN ?1 AND ?2) AS with_massage`,
      )
      .bind(from, to, offset)
      .first<TotalsRow>();
    return row!;
  }

  /** Accommodation price and unit-nights of sold stays checking in between two dates (for the average night price). */
  async adr(from: string, to: string): Promise<AdrRow> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(b.accommodation_subtotal_satang), 0) AS acc_satang,
                COALESCE(SUM((SELECT COUNT(*) FROM booking_unit_nights n WHERE n.booking_id = b.id)), 0) AS unit_nights
           FROM bookings b
          WHERE b.check_in BETWEEN ?1 AND ?2 AND b.booking_status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW')
            AND EXISTS (SELECT 1 FROM booking_unit_nights n WHERE n.booking_id = b.id)`,
      )
      .bind(from, to)
      .first<AdrRow>();
    return row!;
  }

  /** Per active house / VIP tent: nights sold (web), held by an OTA calendar, blocked — between two stay dates. */
  async unitNights(from: string, to: string): Promise<UnitNightsRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT u.id AS unit_id, u.unit_type,
                COALESCE((SELECT t.name FROM accommodation_translations t WHERE t.unit_id = u.id AND t.language_code = 'th'), u.unit_code) AS name,
                COALESCE(SUM(CASE WHEN n.booking_id IS NOT NULL AND b.booking_status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW') THEN 1 ELSE 0 END), 0) AS sold,
                COALESCE(SUM(CASE WHEN n.booking_id IS NULL AND n.ical_feed_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS ota,
                COALESCE(SUM(CASE WHEN n.unit_id IS NOT NULL AND n.booking_id IS NULL AND n.ical_feed_id IS NULL THEN 1 ELSE 0 END), 0) AS blocked
           FROM accommodation_units u
           LEFT JOIN booking_unit_nights n ON n.unit_id = u.id AND n.stay_date BETWEEN ?1 AND ?2
           LEFT JOIN bookings b ON b.id = n.booking_id
          WHERE u.status = 'ACTIVE'
          GROUP BY u.id
          ORDER BY u.unit_type, u.sort_order, u.unit_code`,
      )
      .bind(from, to)
      .all<UnitNightsRow>();
    return results;
  }

  /** Per stay date (active units only): nights sold, OTA-held, blocked. Dates without any row are left out. */
  async dateNights(from: string, to: string): Promise<DateNightsRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT n.stay_date,
                SUM(CASE WHEN n.booking_id IS NOT NULL AND b.booking_status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW') THEN 1 ELSE 0 END) AS sold,
                SUM(CASE WHEN n.booking_id IS NULL AND n.ical_feed_id IS NOT NULL THEN 1 ELSE 0 END) AS ota,
                SUM(CASE WHEN n.booking_id IS NULL AND n.ical_feed_id IS NULL THEN 1 ELSE 0 END) AS blocked
           FROM booking_unit_nights n
           JOIN accommodation_units u ON u.id = n.unit_id AND u.status = 'ACTIVE'
           LEFT JOIN bookings b ON b.id = n.booking_id
          WHERE n.stay_date BETWEEN ?1 AND ?2
          GROUP BY n.stay_date
          ORDER BY n.stay_date`,
      )
      .bind(from, to)
      .all<DateNightsRow>();
    return results;
  }

  /** Accepted payments between two dates by channel (method when no channel). */
  async paymentChannels(from: string, to: string, offset: string): Promise<{ name: string; value: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT COALESCE(channel, method) AS name, COUNT(*) AS value
           FROM payments
          WHERE status IN ('PAID', 'VERIFIED') AND date(COALESCE(verified_at, paid_at, submitted_at, updated_at), ?3) BETWEEN ?1 AND ?2
          GROUP BY COALESCE(channel, method)
          ORDER BY value DESC, name`,
      )
      .bind(from, to, offset)
      .all<{ name: string; value: number }>();
    return results;
  }
}
