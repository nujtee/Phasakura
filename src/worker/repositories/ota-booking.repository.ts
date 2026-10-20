import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { isMissingSchema } from "./inventory.repository.ts";

export type OtaBookingStatus = "ACTIVE" | "CANCELLED" | "CONFLICT" | "UNMAPPED" | "RESOLVED";

export interface OtaBookingRow {
  id: string;
  channex_booking_id: string;
  booking_id: string | null;
  booking_code: string | null;
  ota_name: string;
  ota_code: string | null;
  status: OtaBookingStatus;
  last_revision_id: string;
  arrival_date: string;
  departure_date: string;
  amount_minor: number;
  currency: string;
  payment_collect: "ota" | "property" | null;
  guest_name: string | null;
  problem: string | null;
  created_at: string;
  updated_at: string;
}

export interface OtaRowInput {
  id: string; channexBookingId: string; bookingId: string | null; otaName: string; otaCode: string | null; status: OtaBookingStatus;
  revisionId: string; arrival: string; departure: string; amountMinor: number; currency: string; paymentCollect: string | null;
  guestName: string | null; problem: string | null; now: string;
}

const COLUMNS = `o.id, o.channex_booking_id, o.booking_id, b.booking_code, o.ota_name, o.ota_code, o.status, o.last_revision_id,
  o.arrival_date, o.departure_date, o.amount_minor, o.currency, o.payment_collect, o.guest_name, o.problem, o.created_at, o.updated_at`;

/** Bookings that came from OTAs through Channex (migration 0036) and the booking rows written for them. */
export class OtaBookingRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async byChannexId(channexBookingId: string): Promise<OtaBookingRow | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM ota_bookings o LEFT JOIN bookings b ON b.id = o.booking_id WHERE o.channex_booking_id = ?1`)
      .bind(channexBookingId)
      .first<OtaBookingRow>();
  }

  async byId(id: string): Promise<OtaBookingRow | null> {
    return this.db.prepare(`SELECT ${COLUMNS} FROM ota_bookings o LEFT JOIN bookings b ON b.id = o.booking_id WHERE o.id = ?1`).bind(id).first<OtaBookingRow>();
  }

  /** Newest first; problems (CONFLICT / UNMAPPED) always listed. Empty before migration 0036. */
  async recent(limit: number): Promise<OtaBookingRow[]> {
    try {
      const { results } = await this.db
        .prepare(
          `SELECT ${COLUMNS} FROM ota_bookings o LEFT JOIN bookings b ON b.id = o.booking_id
            ORDER BY o.status IN ('CONFLICT', 'UNMAPPED') DESC, o.updated_at DESC LIMIT ?1`,
        )
        .bind(limit)
        .all<OtaBookingRow>();
      return results;
    } catch (error) {
      if (isMissingSchema(error)) return [];
      throw error;
    }
  }

  async problems(): Promise<number> {
    try {
      const row = await this.db.prepare("SELECT COUNT(*) AS n FROM ota_bookings WHERE status IN ('CONFLICT', 'UNMAPPED')").first<{ n: number }>();
      return row?.n ?? 0;
    } catch (error) {
      if (isMissingSchema(error)) return 0;
      throw error;
    }
  }

  upsertStatement(r: OtaRowInput): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO ota_bookings (id, channex_booking_id, booking_id, ota_name, ota_code, status, last_revision_id, arrival_date,
           departure_date, amount_minor, currency, payment_collect, guest_name, problem, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
         ON CONFLICT (channex_booking_id) DO UPDATE SET booking_id = excluded.booking_id, ota_name = excluded.ota_name,
           ota_code = excluded.ota_code, status = excluded.status, last_revision_id = excluded.last_revision_id,
           arrival_date = excluded.arrival_date, departure_date = excluded.departure_date, amount_minor = excluded.amount_minor,
           currency = excluded.currency, payment_collect = excluded.payment_collect, guest_name = excluded.guest_name,
           problem = excluded.problem, updated_at = excluded.updated_at`,
      )
      .bind(r.id, r.channexBookingId, r.bookingId, r.otaName, r.otaCode, r.status, r.revisionId, r.arrival, r.departure, r.amountMinor,
        r.currency, r.paymentCollect, r.guestName?.slice(0, 200) ?? null, r.problem?.slice(0, 300) ?? null, r.now);
  }

  resolveStatement(id: string, userId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE ota_bookings SET status = 'RESOLVED', resolved_by = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('CONFLICT', 'UNMAPPED')")
      .bind(id, userId, now);
  }

  /** The booking row for an OTA booking: confirmed at once (the OTA already confirmed it), no app fee, no hold. */
  insertBookingStatement(b: {
    id: string; code: string; lang: string; checkIn: string; checkOut: string; nights: number; adults: number; children: number;
    name: string; phone: string; phoneNormalized: string; email: string | null; note: string | null; adminNote: string;
    subtotal: number; currency: string; paid: boolean; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO bookings (id, booking_code, language_code, source, check_in, check_out, nights, adults, children,
           customer_name, customer_phone, customer_phone_normalized, customer_email, customer_note, admin_note,
           booking_status, payment_status, accommodation_subtotal_satang, food_subtotal_satang, subtotal_satang,
           discount_satang, total_satang, currency, confirmed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'ADMIN', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'CONFIRMED', ?15, ?16, 0, ?16, 0, ?16, ?17, ?18, ?18, ?18)`,
      )
      .bind(b.id, b.code, b.lang, b.checkIn, b.checkOut, b.nights, b.adults, b.children, b.name, b.phone, b.phoneNormalized,
        b.email, b.note, b.adminNote, b.paid ? "PAID" : "UNPAID", b.subtotal, b.currency, b.now);
  }

  /** Paid to the OTA: one payment row for the whole amount (method OTHER, reference = the OTA). */
  insertOtaPaymentStatement(p: { id: string; bookingId: string; amount: number; reference: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO payments (id, booking_id, amount_satang, method, status, paid_at, submitted_at, verified_at, updated_at, reference)
         VALUES (?1, ?2, ?3, 'OTHER', 'PAID', ?4, ?4, ?4, ?4, ?5)`,
      )
      .bind(p.id, p.bookingId, p.amount, p.now, p.reference.slice(0, 100));
  }

  /** The receiving account at booking time, when there is one (an OTA booking is never refused for lack of it). */
  insertAccountSnapshotStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO payment_account_snapshots (booking_id, receiving_account_id, bank_name_snapshot, account_name_snapshot,
           account_number_snapshot, promptpay_number_snapshot, payment_qr_snapshot, captured_at)
         SELECT ?1, a.id, a.bank_name, a.account_name, a.account_number, a.promptpay_number, m.object_key, ?2
           FROM receiving_accounts a
           LEFT JOIN media_assets m ON m.id = a.qr_asset_id AND m.status = 'ACTIVE' AND m.bucket = 'PUBLIC'
          WHERE a.is_primary = 1 AND a.status = 'ACTIVE'`,
      )
      .bind(bookingId, now);
  }

  async unitNames(unitIds: string[]): Promise<Map<string, string>> {
    if (!unitIds.length) return new Map();
    const { results } = await this.db
      .prepare(
        `SELECT u.id, COALESCE((SELECT name FROM accommodation_translations t WHERE t.unit_id = u.id AND t.language_code = 'th'), u.unit_code) AS name
           FROM accommodation_units u WHERE u.id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(unitIds))
      .all<{ id: string; name: string }>();
    return new Map(results.map((r) => [r.id, r.name]));
  }
}
