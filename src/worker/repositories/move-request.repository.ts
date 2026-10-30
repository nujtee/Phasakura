import type { MoveRequestDto, MoveRequestStatus, MoveRoomDto } from "../../shared/booking-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";

/** Move settings (migration 0045): one row. */
export interface MoveSettingsRow {
  is_enabled: number;
  fee_satang: number;
  min_days_before: number;
  max_moves: number;
  pay_minutes: number;
  updated_at: string | null;
}

export interface MoveRequestRow {
  id: string;
  booking_id: string;
  status: MoveRequestStatus;
  from_check_in: string;
  from_check_out: string;
  to_check_in: string;
  to_check_out: string;
  rooms_json: string;
  fee_satang: number;
  diff_satang: number;
  amount_satang: number;
  expires_at: string;
  reason: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

const OFF: MoveSettingsRow = { is_enabled: 0, fee_satang: 0, min_days_before: 3, max_moves: 1, pay_minutes: 60, updated_at: null };
const COLUMNS = `id, booking_id, status, from_check_in, from_check_out, to_check_in, to_check_out, rooms_json, fee_satang, diff_satang,
  amount_satang, expires_at, reason, decided_at, created_at, updated_at`;

/** The block reason that holds a night for a move request (booking_unit_nights, booking_id NULL). */
export const moveHold = (requestId: string) => `MOVE_HOLD:${requestId}`;

export function toMoveRequestDto(r: MoveRequestRow): MoveRequestDto {
  return {
    id: r.id, status: r.status, fromCheckIn: r.from_check_in, fromCheckOut: r.from_check_out, toCheckIn: r.to_check_in, toCheckOut: r.to_check_out,
    rooms: JSON.parse(r.rooms_json) as MoveRoomDto[], feeSatang: r.fee_satang, diffSatang: r.diff_satang, amountSatang: r.amount_satang,
    expiresAt: r.expires_at, reason: r.reason, createdAt: r.created_at, decidedAt: r.decided_at,
  };
}

/** Guests moving their own stay (migration 0045): settings, requests and the nights they hold. */
export class MoveRequestRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  settings(): Promise<MoveSettingsRow> {
    return withFallback(
      async () => (await this.db
        .prepare("SELECT is_enabled, fee_satang, min_days_before, max_moves, pay_minutes, updated_at FROM move_settings WHERE id = 1")
        .first<MoveSettingsRow>()) ?? OFF,
      async () => OFF,
    );
  }

  saveSettingsStatement(s: { enabled: boolean; feeSatang: number; minDaysBefore: number; maxMoves: number; payMinutes: number; userId: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO move_settings (id, is_enabled, fee_satang, min_days_before, max_moves, pay_minutes, updated_by, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET is_enabled = excluded.is_enabled, fee_satang = excluded.fee_satang, min_days_before = excluded.min_days_before,
           max_moves = excluded.max_moves, pay_minutes = excluded.pay_minutes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(s.enabled ? 1 : 0, s.feeSatang, s.minDaysBefore, s.maxMoves, s.payMinutes, s.userId, s.now);
  }

  /** Requests of a booking, newest first (none before migration 0045). */
  forBooking(bookingId: string): Promise<MoveRequestRow[]> {
    return withFallback(
      async () => (await this.db
        .prepare(`SELECT ${COLUMNS} FROM booking_move_requests WHERE booking_id = ?1 ORDER BY created_at DESC, rowid DESC`)
        .bind(bookingId)
        .all<MoveRequestRow>()).results,
      async () => [],
    );
  }

  find(id: string): Promise<MoveRequestRow | null> {
    return this.db.prepare(`SELECT ${COLUMNS} FROM booking_move_requests WHERE id = ?1`).bind(id).first<MoveRequestRow>();
  }

  insertStatement(r: Omit<MoveRequestRow, "reason" | "decided_at" | "updated_at" | "status">): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_move_requests (id, booking_id, status, from_check_in, from_check_out, to_check_in, to_check_out, rooms_json,
           fee_satang, diff_satang, amount_satang, expires_at, created_at, updated_at)
         VALUES (?1, ?2, 'AWAITING_PAYMENT', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
      )
      .bind(r.id, r.booking_id, r.from_check_in, r.from_check_out, r.to_check_in, r.to_check_out, r.rooms_json,
        r.fee_satang, r.diff_satang, r.amount_satang, r.expires_at, r.created_at);
  }

  /** Holds one night of a room for the request (PRIMARY KEY: fails when someone else has it). */
  holdStatement(requestId: string, unitId: string, night: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_unit_nights (unit_id, stay_date, booking_id, booking_item_id, block_reason, created_at)
         SELECT ?2, ?3, NULL, NULL, ?4, ?5 WHERE EXISTS (SELECT 1 FROM booking_move_requests WHERE id = ?1 AND created_at = ?5)`,
      )
      .bind(requestId, unitId, night, moveHold(requestId), now);
  }

  releaseStatement(requestId: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM booking_unit_nights WHERE booking_id IS NULL AND block_reason = ?1").bind(moveHold(requestId));
  }

  /** Guarded status change; RETURNING id says whether it happened. */
  statusStatement(requestId: string, from: MoveRequestStatus[], to: MoveRequestStatus, now: string, extra: { reason?: string | null; decidedBy?: string | null; notExpiredAt?: string } = {}): D1PreparedStatementLike {
    const decided = to === "AWAITING_PAYMENT" || to === "REVIEWING" ? "decided_at" : "?3";
    return this.db
      .prepare(
        `UPDATE booking_move_requests SET status = ?2, updated_at = ?3, decided_at = ${decided}, reason = COALESCE(?5, reason), decided_by = COALESCE(?6, decided_by)
          WHERE id = ?1 AND status IN (SELECT value FROM json_each(?4)) AND (?7 IS NULL OR expires_at > ?7)
          RETURNING id`,
      )
      .bind(requestId, to, now, JSON.stringify(from), extra.reason ?? null, extra.decidedBy ?? null, extra.notExpiredAt ?? null);
  }

  /** Requests waiting for a transfer past their time, or open on a booking that is no longer confirmed. */
  async ended(now: string): Promise<{ id: string; status: MoveRequestStatus; why: "EXPIRED" | "CANCELLED" }[]> {
    return withFallback(async () => (await this.db
      .prepare(
        `SELECT r.id, r.status, CASE WHEN b.booking_status <> 'CONFIRMED' THEN 'CANCELLED' ELSE 'EXPIRED' END AS why
           FROM booking_move_requests r JOIN bookings b ON b.id = r.booking_id
          WHERE (r.status = 'AWAITING_PAYMENT' AND r.expires_at <= ?1)
             OR (r.status IN ('AWAITING_PAYMENT', 'REVIEWING') AND b.booking_status <> 'CONFIRMED')
          LIMIT 50`,
      )
      .bind(now)
      .all<{ id: string; status: MoveRequestStatus; why: "EXPIRED" | "CANCELLED" }>()).results, async () => []);
  }

  /** The booking money after an approved move: fee + higher price join the accommodation (same batch, guarded by `moved`). */
  chargeStatement(bookingId: string, newCheckIn: string, amount: number, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE bookings SET accommodation_subtotal_satang = accommodation_subtotal_satang + ?4, subtotal_satang = subtotal_satang + ?4,
           total_satang = total_satang + ?4, updated_at = ?3
          WHERE id = ?1 AND check_in = ?2 AND updated_at = ?3`,
      )
      .bind(bookingId, newCheckIn, now, amount);
  }

  /** APPROVED once the stay moved in this batch (the booking starts on the new day, updated now). */
  approvedStatement(requestId: string, bookingId: string, newCheckIn: string, now: string, decidedBy: string | null): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE booking_move_requests SET status = 'APPROVED', decided_at = ?4, decided_by = ?5, updated_at = ?4
          WHERE id = ?1 AND status IN ('AWAITING_PAYMENT', 'REVIEWING')
            AND EXISTS (SELECT 1 FROM bookings WHERE id = ?2 AND check_in = ?3 AND updated_at = ?4)`,
      )
      .bind(requestId, bookingId, newCheckIn, now, decidedBy);
  }
}
