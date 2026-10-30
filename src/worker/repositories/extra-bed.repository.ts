import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";

/** Extra beds settings (migration 0043): one row. */
export interface ExtraBedSettingsRow {
  is_enabled: number;
  price_per_night_satang: number;
  max_per_unit: number;
  updated_at: string | null;
}

/** Extra beds of one stay of a booking (price snapshot). */
export interface BookingExtraBedRow {
  booking_item_id: string;
  quantity: number;
  price_per_night_satang: number;
  number_of_nights: number;
  subtotal_satang: number;
}

/** Before migration 0043: the option does not exist (off). */
const OFF: ExtraBedSettingsRow = { is_enabled: 0, price_per_night_satang: 0, max_per_unit: 1, updated_at: null };

export class ExtraBedRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  settings(): Promise<ExtraBedSettingsRow> {
    return withFallback(
      async () => (await this.db
        .prepare("SELECT is_enabled, price_per_night_satang, max_per_unit, updated_at FROM extra_bed_settings WHERE id = 1")
        .first<ExtraBedSettingsRow>()) ?? OFF,
      async () => OFF,
    );
  }

  saveStatement(s: { enabled: boolean; pricePerNightSatang: number; maxPerUnit: number; userId: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO extra_bed_settings (id, is_enabled, price_per_night_satang, max_per_unit, updated_by, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET is_enabled = excluded.is_enabled, price_per_night_satang = excluded.price_per_night_satang,
           max_per_unit = excluded.max_per_unit, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(s.enabled ? 1 : 0, s.pricePerNightSatang, s.maxPerUnit, s.userId, s.now);
  }

  /** Extra beds of a booking, per stay (none before migration 0043). */
  forBooking(bookingId: string): Promise<BookingExtraBedRow[]> {
    return withFallback(
      async () => (await this.db
        .prepare(
          `SELECT booking_item_id, quantity, price_per_night_satang, number_of_nights, subtotal_satang
             FROM booking_extra_beds WHERE booking_id = ?1`,
        )
        .bind(bookingId)
        .all<BookingExtraBedRow>()).results,
      async () => [],
    );
  }

  /** Price snapshot (immutable; the trigger checks the stay is a house / VIP tent and the option is offered). */
  insertStatement(e: {
    id: string; bookingId: string; itemId: string; quantity: number; pricePerNight: number; nights: number; subtotal: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_extra_beds (id, booking_id, booking_item_id, quantity, price_per_night_satang, number_of_nights, subtotal_satang, captured_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(e.id, e.bookingId, e.itemId, e.quantity, e.pricePerNight, e.nights, e.subtotal, e.now);
  }
}
