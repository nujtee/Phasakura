import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface ReceivingAccountRow {
  id: string;
  bank_name: string;
  account_name: string;
  account_number: string | null;
  promptpay_number: string | null;
  qr_asset_id: string | null;
  qr_key: string | null;
  status: "ACTIVE" | "INACTIVE" | "DELETED";
  is_primary: number;
  sort_order: number;
  updated_at: string;
}

export interface AccountSnapshotRow {
  receiving_account_id: string;
  bank_name_snapshot: string;
  account_name_snapshot: string;
  account_number_snapshot: string | null;
  promptpay_number_snapshot: string | null;
  payment_qr_snapshot: string | null;
  captured_at: string;
}

export interface PaymentRow {
  id: string;
  booking_id: string;
  amount_satang: number;
  method: "BANK_TRANSFER" | "PROMPTPAY" | "CASH" | "OTHER";
  status: "UNPAID" | "PENDING_VERIFICATION" | "VERIFIED" | "PAID" | "REJECTED" | "REFUNDED";
  reference: string | null;
  note: string | null;
  paid_at: string | null;
  submitted_at: string;
  verified_at: string | null;
  verified_by_name: string | null;
  refunded_at: string | null;
  refund_amount_satang: number | null;
  refund_reason: string | null;
  slip_asset_id: string | null;
}

export interface SlipPaymentRow {
  id: string;
  booking_id: string;
  booking_code: string;
  booking_status: string;
  booking_payment_status: string;
  booking_created_at: string;
  total_satang: number;
  customer_name: string;
  check_in: string;
  check_out: string;
  amount_satang: number;
  status: string;
  submitted_at: string;
  slip_key: string | null;
  slip_mime: string | null;
  slip_sha256: string | null;
}

export interface VerificationRow {
  id: string;
  payment_id: string;
  method: "MANUAL" | "AUTO";
  provider: string | null;
  result: "PASSED" | "FAILED" | "ERROR";
  failure_code: string | null;
  amount_satang: number | null;
  transferred_at: string | null;
  sender_bank: string | null;
  receiver_bank: string | null;
  receiver_account_masked: string | null;
  transaction_ref: string | null;
  verified_by_name: string | null;
  created_at: string;
}

const SLIP_PAYMENT_SELECT = `
  SELECT p.id, p.booking_id, b.booking_code, b.booking_status, b.payment_status AS booking_payment_status,
         b.created_at AS booking_created_at, b.total_satang, b.customer_name, b.check_in, b.check_out,
         p.amount_satang, p.status, p.submitted_at, m.object_key AS slip_key, m.mime_type AS slip_mime, p.slip_sha256
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    LEFT JOIN media_assets m ON m.id = p.slip_asset_id AND m.bucket = 'PRIVATE' AND m.purpose = 'PAYMENT_SLIP'`;

const ACCOUNT_SELECT = `
  SELECT a.id, a.bank_name, a.account_name, a.account_number, a.promptpay_number, a.qr_asset_id,
         m.object_key AS qr_key, a.status, a.is_primary, a.sort_order, a.updated_at
    FROM receiving_accounts a
    LEFT JOIN media_assets m ON m.id = a.qr_asset_id AND m.status = 'ACTIVE' AND m.bucket = 'PUBLIC'`;

/** Receiving accounts, account snapshots and payments. Statements are composed into atomic batches by services. */
export class PaymentRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  // ------------------------------------------------------------------ receiving accounts

  async listAccounts(): Promise<ReceivingAccountRow[]> {
    const { results } = await this.db
      .prepare(`${ACCOUNT_SELECT} WHERE a.status <> 'DELETED' ORDER BY a.is_primary DESC, a.sort_order, a.created_at`)
      .all<ReceivingAccountRow>();
    return results;
  }

  findAccount(id: string): Promise<ReceivingAccountRow | null> {
    return this.db.prepare(`${ACCOUNT_SELECT} WHERE a.id = ?1`).bind(id).first<ReceivingAccountRow>();
  }

  primaryAccount(): Promise<ReceivingAccountRow | null> {
    return this.db.prepare(`${ACCOUNT_SELECT} WHERE a.is_primary = 1 AND a.status = 'ACTIVE'`).first<ReceivingAccountRow>();
  }

  insertAccountStatement(a: {
    id: string; bankName: string; accountName: string; accountNumber: string | null; promptpayNumber: string | null;
    qrAssetId: string | null; status: string; sortOrder: number; createdBy: string; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO receiving_accounts (id, bank_name, account_name, account_number, promptpay_number, qr_asset_id, status,
           is_primary, sort_order, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?10)`,
      )
      .bind(a.id, a.bankName, a.accountName, a.accountNumber, a.promptpayNumber, a.qrAssetId, a.status, a.sortOrder, a.createdBy, a.now);
  }

  updateAccountStatement(a: {
    id: string; bankName: string; accountName: string; accountNumber: string | null; promptpayNumber: string | null;
    qrAssetId: string | null; status: string; sortOrder: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE receiving_accounts SET bank_name = ?2, account_name = ?3, account_number = ?4, promptpay_number = ?5,
           qr_asset_id = ?6, status = ?7, sort_order = ?8, updated_at = ?9
         WHERE id = ?1 AND status <> 'DELETED'`,
      )
      .bind(a.id, a.bankName, a.accountName, a.accountNumber, a.promptpayNumber, a.qrAssetId, a.status, a.sortOrder, a.now);
  }

  /** Two statements: clear the old primary, set the new one (single-primary UNIQUE index guards the result). */
  setPrimaryStatements(id: string, now: string): D1PreparedStatementLike[] {
    return [
      this.db.prepare("UPDATE receiving_accounts SET is_primary = 0, updated_at = ?2 WHERE is_primary = 1 AND id <> ?1").bind(id, now),
      this.db.prepare("UPDATE receiving_accounts SET is_primary = 1, updated_at = ?2 WHERE id = ?1 AND status = 'ACTIVE'").bind(id, now),
    ];
  }

  softDeleteAccountStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE receiving_accounts SET status = 'DELETED', updated_at = ?2 WHERE id = ?1 AND is_primary = 0")
      .bind(id, now);
  }

  // ------------------------------------------------------------------ snapshot (spec §25)

  /**
   * Copies the primary ACTIVE account onto the booking inside the booking batch.
   * If there is no such account, the second SELECT inserts a row with NULL ids, which
   * violates NOT NULL and rolls back the whole booking: a booking can never exist
   * without payment details, even if the primary account changes mid-flight.
   */
  insertSnapshotStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO payment_account_snapshots (booking_id, receiving_account_id, bank_name_snapshot, account_name_snapshot,
           account_number_snapshot, promptpay_number_snapshot, payment_qr_snapshot, captured_at)
         SELECT ?1, a.id, a.bank_name, a.account_name, a.account_number, a.promptpay_number, m.object_key, ?2
           FROM receiving_accounts a
           LEFT JOIN media_assets m ON m.id = a.qr_asset_id AND m.status = 'ACTIVE' AND m.bucket = 'PUBLIC'
          WHERE a.is_primary = 1 AND a.status = 'ACTIVE'
         UNION ALL
         SELECT ?1, NULL, NULL, NULL, NULL, NULL, NULL, ?2
          WHERE NOT EXISTS (SELECT 1 FROM receiving_accounts WHERE is_primary = 1 AND status = 'ACTIVE')`,
      )
      .bind(bookingId, now);
  }

  snapshot(bookingId: string): Promise<AccountSnapshotRow | null> {
    return this.db
      .prepare(
        `SELECT receiving_account_id, bank_name_snapshot, account_name_snapshot, account_number_snapshot,
                promptpay_number_snapshot, payment_qr_snapshot, captured_at
           FROM payment_account_snapshots WHERE booking_id = ?1`,
      )
      .bind(bookingId)
      .first<AccountSnapshotRow>();
  }

  // ------------------------------------------------------------------ payments

  async payments(bookingId: string): Promise<PaymentRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.id, p.booking_id, p.amount_satang, p.method, p.status, p.reference, p.note, p.paid_at, p.submitted_at,
                p.verified_at, u.display_name AS verified_by_name, p.refunded_at, p.refund_amount_satang, p.refund_reason,
                p.slip_asset_id
           FROM payments p LEFT JOIN users u ON u.id = p.verified_by
          WHERE p.booking_id = ?1 ORDER BY p.submitted_at, p.id`,
      )
      .bind(bookingId)
      .all<PaymentRow>();
    return results;
  }

  /** PENDING booking (unpaid, slip pending or rejected) → CONFIRMED + PAID. RETURNING says whether it happened. */
  confirmPaidStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE bookings SET booking_status = 'CONFIRMED', payment_status = 'PAID', confirmed_at = ?2, expires_at = NULL, updated_at = ?2
          WHERE id = ?1 AND booking_status = 'PENDING' AND payment_status IN ('UNPAID', 'REJECTED')
          RETURNING id`,
      )
      .bind(bookingId, now);
  }

  /** Only inserted when the confirm statement before it succeeded (same batch). */
  insertRecordedPaymentStatement(p: {
    id: string; bookingId: string; amount: number; method: string; reference: string | null; note: string | null;
    paidAt: string; by: string; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO payments (id, booking_id, amount_satang, method, status, reference, note, paid_at, submitted_at,
           verified_at, verified_by, updated_at)
         SELECT ?1, ?2, ?3, ?4, 'PAID', ?5, ?6, ?7, ?9, ?9, ?8, ?9
          WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?2 AND booking_status = 'CONFIRMED' AND payment_status = 'PAID' AND confirmed_at = ?9)`,
      )
      .bind(p.id, p.bookingId, p.amount, p.method, p.reference, p.note, p.paidAt, p.by, p.now);
  }

  refundStatement(paymentId: string, bookingId: string, amount: number, reason: string, by: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE payments SET status = 'REFUNDED', refunded_at = ?6, refunded_by = ?5, refund_amount_satang = ?3,
           refund_reason = ?4, updated_at = ?6
          WHERE id = ?1 AND booking_id = ?2 AND status IN ('PAID', 'VERIFIED')
          RETURNING id`,
      )
      .bind(paymentId, bookingId, amount, reason, by, now);
  }

  /** After a refund: the booking shows REFUNDED once no paid payment is left. */
  bookingRefundedStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE bookings SET payment_status = 'REFUNDED', updated_at = ?2
          WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM payments WHERE booking_id = ?1 AND status IN ('PAID', 'VERIFIED'))`,
      )
      .bind(bookingId, now);
  }

  // ------------------------------------------------------------------ slips (spec §27)

  async paymentsSince(bookingId: string, since: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM payments WHERE booking_id = ?1 AND submitted_at > ?2")
      .bind(bookingId, since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async liveSlipExists(sha256: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS x FROM payments WHERE slip_sha256 = ?1 AND status IN ('PENDING_VERIFICATION', 'VERIFIED', 'PAID')")
      .bind(sha256)
      .first();
    return row !== null;
  }

  async transactionRefUsed(ref: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS x FROM slip_verifications WHERE transaction_ref = ?1 AND result = 'PASSED'")
      .bind(ref)
      .first();
    return row !== null;
  }

  /**
   * Slip submission, step 1 of the batch: claim the booking (PENDING, unpaid or rejected,
   * hold not over). Steps 2–3 only insert if this claim happened (same `now` marker).
   */
  claimForSlipStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE bookings SET payment_status = 'PENDING_VERIFICATION', expires_at = NULL, updated_at = ?2
          WHERE id = ?1 AND booking_status = 'PENDING' AND payment_status IN ('UNPAID', 'REJECTED')
            AND (expires_at IS NULL OR expires_at > ?2)
          RETURNING id`,
      )
      .bind(bookingId, now);
  }

  insertSlipAssetStatement(a: { id: string; bookingId: string; key: string; mime: string; size: number; width: number; height: number; sha256: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, width, height, sha256, created_at)
         SELECT ?1, 'PRIVATE', ?3, 'PAYMENT_SLIP', ?4, ?5, ?6, ?7, ?8, ?9
          WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?2 AND payment_status = 'PENDING_VERIFICATION' AND updated_at = ?9)`,
      )
      .bind(a.id, a.bookingId, a.key, a.mime, a.size, a.width, a.height, a.sha256, a.now);
  }

  insertSlipPaymentStatement(p: { id: string; bookingId: string; amount: number; assetId: string; sha256: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO payments (id, booking_id, amount_satang, method, status, slip_asset_id, slip_sha256, submitted_at, updated_at)
         SELECT ?1, ?2, ?3, 'BANK_TRANSFER', 'PENDING_VERIFICATION', ?4, ?5, ?6, ?6
          WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?2 AND payment_status = 'PENDING_VERIFICATION' AND updated_at = ?6)`,
      )
      .bind(p.id, p.bookingId, p.amount, p.assetId, p.sha256, p.now);
  }

  findSlipPayment(paymentId: string): Promise<SlipPaymentRow | null> {
    return this.db.prepare(`${SLIP_PAYMENT_SELECT} WHERE p.id = ?1`).bind(paymentId).first<SlipPaymentRow>();
  }

  async slipQueue(status: string, limit: number, before: string | null): Promise<SlipPaymentRow[]> {
    const { results } = await this.db
      .prepare(
        `${SLIP_PAYMENT_SELECT}
          WHERE p.slip_asset_id IS NOT NULL AND p.status = ?1 AND (?3 IS NULL OR p.submitted_at < ?3)
          ORDER BY p.submitted_at ${status === "PENDING_VERIFICATION" ? "ASC" : "DESC"} LIMIT ?2`,
      )
      .bind(status, limit, before)
      .all<SlipPaymentRow>();
    return results;
  }

  async verifications(paymentIds: string[]): Promise<VerificationRow[]> {
    if (!paymentIds.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT v.id, v.payment_id, v.method, v.provider, v.result, v.failure_code, v.amount_satang, v.transferred_at,
                v.sender_bank, v.receiver_bank, v.receiver_account_masked, v.transaction_ref,
                u.display_name AS verified_by_name, v.created_at
           FROM slip_verifications v LEFT JOIN users u ON u.id = v.verified_by
          WHERE v.payment_id IN (SELECT value FROM json_each(?1))
          ORDER BY v.created_at, v.id`,
      )
      .bind(JSON.stringify(paymentIds))
      .all<VerificationRow>();
    return results;
  }

  insertVerificationStatement(v: {
    id: string; paymentId: string; method: "MANUAL" | "AUTO"; provider: string | null; result: "PASSED" | "FAILED" | "ERROR";
    failureCode: string | null; amount: number | null; transferredAt: string | null; senderBank: string | null;
    receiverBank: string | null; receiverMasked: string | null; transactionRef: string | null; redacted: unknown;
    verifiedBy: string | null; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO slip_verifications (id, payment_id, method, provider, result, failure_code, amount_satang, transferred_at,
           sender_bank, receiver_bank, receiver_account_masked, transaction_ref, provider_response_redacted, verified_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(v.id, v.paymentId, v.method, v.provider, v.result, v.failureCode, v.amount, v.transferredAt, v.senderBank,
        v.receiverBank, v.receiverMasked, v.transactionRef, v.redacted === null ? null : JSON.stringify(v.redacted), v.verifiedBy, v.now);
  }

  /** PENDING_VERIFICATION → VERIFIED. RETURNING tells whether this call made the change. */
  markVerifiedStatement(paymentId: string, paidAt: string | null, by: string | null, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE payments SET status = 'VERIFIED', verified_at = ?4, verified_by = ?3, paid_at = COALESCE(?2, paid_at), updated_at = ?4
          WHERE id = ?1 AND status = 'PENDING_VERIFICATION'
          RETURNING id`,
      )
      .bind(paymentId, paidAt, by, now);
  }

  /** The booking is confirmed once a slip is verified (only if it is still waiting). */
  confirmVerifiedStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE bookings SET booking_status = 'CONFIRMED', payment_status = 'VERIFIED', confirmed_at = ?2, expires_at = NULL, updated_at = ?2
          WHERE id = ?1 AND booking_status = 'PENDING' AND payment_status = 'PENDING_VERIFICATION'`,
      )
      .bind(bookingId, now);
  }

  markRejectedStatement(paymentId: string, reason: string, by: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE payments SET status = 'REJECTED', rejected_reason = ?2, verified_by = ?3, verified_at = ?4, updated_at = ?4
          WHERE id = ?1 AND status = 'PENDING_VERIFICATION'
          RETURNING id`,
      )
      .bind(paymentId, reason, by, now);
  }

  /** After a rejection the guest gets a fresh hold to pay or upload again (unless another slip is still pending). */
  bookingRejectedStatement(bookingId: string, holdUntil: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE bookings SET payment_status = 'REJECTED', expires_at = ?2, updated_at = ?3
          WHERE id = ?1 AND booking_status = 'PENDING' AND payment_status = 'PENDING_VERIFICATION'
            AND NOT EXISTS (SELECT 1 FROM payments WHERE booking_id = ?1 AND status = 'PENDING_VERIFICATION')`,
      )
      .bind(bookingId, holdUntil, now);
  }

  /** All payments, newest first (admin payments list). */
  async listAll(f: { status: string | null; method: string | null; code: string | null; from: string | null; to: string | null; before: string | null; limit: number }) {
    const { results } = await this.db
      .prepare(
        `SELECT p.id, b.booking_code, p.amount_satang, p.method, p.status, p.slip_asset_id, p.reference, p.submitted_at,
                p.paid_at, p.verified_at, p.refund_amount_satang, p.refunded_at
           FROM payments p JOIN bookings b ON b.id = p.booking_id
          WHERE (?1 IS NULL OR p.status = ?1) AND (?2 IS NULL OR p.method = ?2) AND (?3 IS NULL OR b.booking_code = ?3)
            AND (?4 IS NULL OR p.submitted_at >= ?4) AND (?5 IS NULL OR p.submitted_at < ?5) AND (?6 IS NULL OR p.submitted_at < ?6)
          ORDER BY p.submitted_at DESC, p.id DESC LIMIT ?7`,
      )
      .bind(f.status, f.method, f.code, f.from, f.to, f.before, f.limit)
      .all<{
        id: string; booking_code: string; amount_satang: number; method: string; status: string; slip_asset_id: string | null;
        reference: string | null; submitted_at: string; paid_at: string | null; verified_at: string | null;
        refund_amount_satang: number | null; refunded_at: string | null;
      }>();
    return results;
  }
}
