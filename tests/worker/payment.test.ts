import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { PaymentDto, ReceivingAccountDto } from "../../src/shared/payment-types.ts";
import { PaymentRepository } from "../../src/worker/repositories/payment.repository.ts";
import { mapInventoryError } from "../../src/worker/services/booking.service.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

// Harness clock: 2027-01-10T03:00Z. Seed: dev_account_01 is the primary ACTIVE account.
let seq = 0;
const key = () => `pay-key-${String(++seq).padStart(10, "0")}`;
const STAY = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th" };

async function book(h: Harness, over: Record<string, unknown> = {}) {
  const body = { ...STAY, ...over };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  return h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer: { name: "Guest", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data?.totalSatang ?? 0, idempotencyKey: key() },
  });
}

async function admin(h: Harness, perms: string[]) {
  const id = `staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

const lookup = (h: Harness, code: string) =>
  h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: code, phone: "0812345678" } });

const record = (h: Harness, token: string, code: string, over: Record<string, unknown> = {}) =>
  h.api<PaymentDto[]>("POST", `/api/admin/bookings/${code}/payments`, {
    token, body: { amountSatang: 700000, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:55:00Z", reference: "TXN-123", ...over },
  });

const ACCOUNT = { bankName: "Kasikorn", accountName: "Phasakura Co., Ltd.", accountNumber: "123-4-56789-0", promptpayNumber: "081-234-5678" };

describe("receiving accounts (spec §25)", () => {
  it("view vs edit permissions, validation, PromptPay normalisation", async () => {
    const h = new Harness({ seed: true });
    const viewer = await admin(h, ["receiving_accounts.view"]);
    const list = await h.api<ReceivingAccountDto[]>("GET", "/api/admin/receiving-accounts", { token: viewer });
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.map((a) => [a.id, a.isPrimary]), [["dev_account_01", true]]);
    assert.equal((await h.api("POST", "/api/admin/receiving-accounts", { token: viewer, body: ACCOUNT })).status, 403);

    const editor = await admin(h, ["receiving_accounts.view", "receiving_accounts.edit"]);
    const none = await h.api("POST", "/api/admin/receiving-accounts", { token: editor, body: { bankName: "X", accountName: "Y" } });
    assert.equal(none.error?.details?.accountNumber, "ACCOUNT_OR_PROMPTPAY_REQUIRED");
    const badPp = await h.api("POST", "/api/admin/receiving-accounts", { token: editor, body: { ...ACCOUNT, promptpayNumber: "12345" } });
    assert.equal(badPp.error?.details?.promptpayNumber, "INVALID_FORMAT");
    const badAcc = await h.api("POST", "/api/admin/receiving-accounts", { token: editor, body: { ...ACCOUNT, accountNumber: "12<script>" } });
    assert.equal(badAcc.error?.details?.accountNumber, "INVALID_FORMAT");
    const mass = await h.api("POST", "/api/admin/receiving-accounts", { token: editor, body: { ...ACCOUNT, isPrimary: true } });
    assert.equal(mass.error?.details?.isPrimary, "UNKNOWN_FIELD");

    const created = await h.api<ReceivingAccountDto>("POST", "/api/admin/receiving-accounts", { token: editor, body: ACCOUNT });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.data.promptpayNumber, "0812345678");
    assert.equal(created.data.isPrimary, false, "an existing primary stays primary");
    assert.equal(h.audits("CREATE_RECEIVING_ACCOUNT").length, 1);
  });

  it("QR must be an uploaded PAYMENT_QR image", async () => {
    const h = new Harness({ seed: true });
    const editor = await admin(h, ["receiving_accounts.edit", "accommodation.edit"]);
    const qr = await h.upload<{ id: string }>(editor, { bytes: pngBytes(400, 400), name: "qr.png", type: "image/png" }, "PAYMENT_QR");
    assert.equal(qr.status, 201, JSON.stringify(qr.error));
    const other = await h.upload<{ id: string }>(editor, { bytes: pngBytes(), name: "room.png", type: "image/png" }, "ACCOMMODATION");
    const wrong = await h.api("PATCH", "/api/admin/receiving-accounts/dev_account_01", { token: editor, body: { qrAssetId: other.data.id } });
    assert.equal(wrong.error?.details?.qrAssetId, "INVALID_IMAGE");
    const ok = await h.api<ReceivingAccountDto>("PATCH", "/api/admin/receiving-accounts/dev_account_01", { token: editor, body: { qrAssetId: qr.data.id } });
    assert.match(ok.data.qrUrl ?? "", /^\/media\/payment/);
  });

  it("one primary at a time; the primary can be neither deactivated nor deleted", async () => {
    const h = new Harness({ seed: true });
    const editor = await admin(h, ["receiving_accounts.view", "receiving_accounts.edit"]);
    const b = await h.api<ReceivingAccountDto>("POST", "/api/admin/receiving-accounts", { token: editor, body: ACCOUNT });
    assert.equal((await h.api("PATCH", "/api/admin/receiving-accounts/dev_account_01", { token: editor, body: { status: "INACTIVE" } })).error?.code, "PRIMARY_MUST_BE_ACTIVE");
    assert.equal((await h.api("DELETE", "/api/admin/receiving-accounts/dev_account_01", { token: editor })).error?.code, "PRIMARY_ACCOUNT_LOCKED");
    const switched = await h.api<ReceivingAccountDto[]>("POST", `/api/admin/receiving-accounts/${b.data.id}/primary`, { token: editor });
    assert.deepEqual(switched.data.filter((a) => a.isPrimary).map((a) => a.id), [b.data.id]);
    assert.equal((await h.api("DELETE", "/api/admin/receiving-accounts/dev_account_01", { token: editor })).status, 200);
    const list = await h.api<ReceivingAccountDto[]>("GET", "/api/admin/receiving-accounts", { token: editor });
    assert.deepEqual(list.data.map((a) => a.id), [b.data.id], "deleted accounts are hidden (soft delete)");
    assert.equal(h.db.get<{ status: string }>("SELECT status FROM receiving_accounts WHERE id = 'dev_account_01'")!.status, "DELETED");
  });
});

describe("payment account snapshot", () => {
  it("each booking keeps the account it was made with; later edits only affect new bookings", async () => {
    const h = new Harness({ seed: true });
    const first = (await book(h)).data;
    assert.deepEqual(first.paymentInstructions, {
      bankName: "DEV BANK (ตัวอย่าง)", accountName: "DEV SAMPLE ACCOUNT", accountNumber: "000-0-00000-0",
      promptpayNumber: "0000000000", qrUrl: null, amountDueSatang: 700000,
      // Owner's channels × what this account has (no QR image, PayPal not configured); Thai QR with the amount.
      channels: ["PROMPTPAY", "BANK_TRANSFER"],
      promptpayPayload: "00020101021229370016A000000677010111011300660000000005802TH530376454077000.0063043C6C",
    });
    const editor = await admin(h, ["receiving_accounts.edit"]);
    await h.api("PATCH", "/api/admin/receiving-accounts/dev_account_01", { token: editor, body: { bankName: "Renamed Bank", accountNumber: "999-9-99999-9" } });
    const b = await h.api<ReceivingAccountDto>("POST", "/api/admin/receiving-accounts", { token: editor, body: ACCOUNT });
    await h.api("POST", `/api/admin/receiving-accounts/${b.data.id}/primary`, { token: editor });

    const again = (await lookup(h, first.bookingCode)).data;
    assert.equal(again.paymentInstructions?.bankName, "DEV BANK (ตัวอย่าง)");
    assert.equal(again.paymentInstructions?.accountNumber, "000-0-00000-0");
    const second = (await book(h, { stay: { kind: "UNIT", unitId: "dev_house_02" } })).data;
    assert.equal(second.paymentInstructions?.bankName, "Kasikorn");
    assert.throws(() => h.db.run("UPDATE payment_account_snapshots SET bank_name_snapshot = 'x'"), /SNAPSHOT_IMMUTABLE/);
  });

  it("no active primary account → no booking (an unpayable hold is never created)", async () => {
    const h = new Harness({ seed: true });
    h.db.run("UPDATE receiving_accounts SET is_primary = 0");
    const res = await book(h);
    assert.equal(res.status, 409);
    assert.equal(res.error?.code, "PAYMENT_NOT_CONFIGURED");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 0);

    // Airtight inside the batch too: the snapshot statement aborts if the primary vanished mid-flight.
    const repo = new PaymentRepository(h.db);
    await assert.rejects(() => h.db.batch([repo.insertSnapshotStatement("nope", "2027-01-10T03:00:00.000Z")]), (err: unknown) => {
      assert.equal((mapInventoryError(err) as { code: string }).code, "PAYMENT_NOT_CONFIGURED");
      return true;
    });
  });
});

describe("payment status (spec §26)", () => {
  it("recording the full amount confirms the booking; instructions disappear; the hold no longer expires", async () => {
    const h = new Harness({ seed: true });
    const b = (await book(h)).data;
    const viewer = await admin(h, ["bookings.view"]);
    assert.equal((await record(h, viewer, b.bookingCode)).status, 403);

    const finance = await admin(h, ["payments.verify", "bookings.view"]);
    assert.equal((await record(h, finance, b.bookingCode, { amountSatang: 100 })).error?.details?.amountSatang, "MUST_EQUAL_TOTAL");
    assert.equal((await record(h, finance, b.bookingCode, { paidAt: "2027-02-01T00:00:00Z" })).error?.details?.paidAt, "IN_THE_FUTURE");
    assert.equal((await record(h, finance, b.bookingCode, { status: "PAID" })).error?.details?.status, "UNKNOWN_FIELD");
    assert.equal((await record(h, finance, b.bookingCode, { method: "CRYPTO" })).error?.details?.method, "INVALID_VALUE");

    const res = await record(h, finance, b.bookingCode);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]!.status, "PAID");
    assert.match(res.data[0]!.verifiedByName ?? "", /User staff_/);

    const detail = await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${b.bookingCode}`, { token: finance });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.data.paymentAccount?.bankName, "DEV BANK (ตัวอย่าง)");
    assert.equal(detail.data.payments[0]!.reference, "TXN-123");
    const after = (await lookup(h, b.bookingCode)).data;
    assert.equal(after.status, "CONFIRMED");
    assert.equal(after.paymentStatus, "PAID");
    assert.equal(after.expiresAt, null);
    assert.equal(after.paymentInstructions, null);
    h.advance(3 * 60 * 60_000);
    await h.app.scheduled(h.env);
    assert.equal((await lookup(h, b.bookingCode)).data.status, "CONFIRMED", "paid bookings never expire");
    assert.equal(h.audits("RECORD_PAYMENT").length, 1);

  });

  it("two staff recording at once → exactly one payment", async () => {
    const h = new Harness({ seed: true });
    const b = (await book(h)).data;
    const a = await admin(h, ["payments.verify"]);
    const c = await admin(h, ["payments.verify"]);
    const results = await Promise.all([record(h, a, b.bookingCode), record(h, c, b.bookingCode)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payments")!.n, 1);
  });

  it("refuses payment for expired or cancelled bookings (inventory is already released)", async () => {
    const h = new Harness({ seed: true });
    const finance = await admin(h, ["payments.verify", "bookings.cancel"]);
    const expired = (await book(h)).data;
    h.advance(61 * 60_000);
    assert.equal((await record(h, finance, expired.bookingCode)).error?.code, "BOOKING_NOT_PAYABLE", "past its hold, even before the cron");
    const cancelled = (await book(h)).data;
    await h.api("POST", `/api/admin/bookings/${cancelled.bookingCode}/cancel`, { token: finance, body: { reason: "guest asked" } });
    assert.equal((await record(h, finance, cancelled.bookingCode)).error?.code, "BOOKING_NOT_PAYABLE");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payments")!.n, 0);
    assert.throws(() => h.db.run(`INSERT INTO payments (id, booking_id, amount_satang, method) SELECT 'p', id, 1, 'CASH' FROM bookings WHERE booking_status = 'CANCELLED'`), /BOOKING_NOT_PAYABLE/);
  });

  it("refund: only after cancelling, never more than paid, final and audited", async () => {
    const h = new Harness({ seed: true });
    const b = (await book(h)).data;
    const staff = await admin(h, ["payments.verify", "bookings.cancel", "bookings.view"]);
    const paid = await record(h, staff, b.bookingCode);
    const paymentId = paid.data[0]!.id;
    const refundUrl = `/api/admin/bookings/${b.bookingCode}/payments/${paymentId}/refund`;
    assert.equal((await h.api("POST", refundUrl, { token: staff, body: { amountSatang: 700000, reason: "cancelled" } })).status, 403);

    const finance = await admin(h, ["payments.refund"]);
    assert.equal((await h.api("POST", refundUrl, { token: finance, body: { amountSatang: 700000, reason: "cancelled" } })).error?.code, "CANCEL_BEFORE_REFUND");
    const cancel = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: staff, body: { reason: "guest asked" } });
    assert.equal(cancel.data.status, "CANCELLED");
    assert.equal(cancel.data.paymentStatus, "PAID", "cancelling does not pretend the money was returned");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights")!.n, 0);

    assert.equal((await h.api("POST", refundUrl, { token: finance, body: { amountSatang: 700001, reason: "cancelled" } })).error?.details?.amountSatang, "MORE_THAN_PAID");
    const refunded = await h.api<PaymentDto[]>("POST", refundUrl, { token: finance, body: { amountSatang: 350000, reason: "50% policy" } });
    assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
    assert.equal(refunded.data[0]!.status, "REFUNDED");
    assert.equal(refunded.data[0]!.refundAmountSatang, 350000);
    assert.equal(h.db.get<{ payment_status: string }>("SELECT payment_status FROM bookings")!.payment_status, "REFUNDED");
    assert.equal((await h.api("POST", refundUrl, { token: finance, body: { amountSatang: 1, reason: "again" } })).error?.code, "PAYMENT_NOT_REFUNDABLE");
    assert.equal(h.audits("REFUND_PAYMENT").length, 1);
    assert.throws(() => h.db.run("UPDATE payments SET status = 'PAID'"), /PAYMENT_ALREADY_REFUNDED/);
    assert.throws(() => h.db.run("UPDATE payments SET amount_satang = 1"), /PAYMENT_IMMUTABLE/);
    assert.throws(() => h.db.run("DELETE FROM payments"), /PAYMENT_DELETE_FORBIDDEN/);
  });

  it("admin list filters by payment status", async () => {
    const h = new Harness({ seed: true });
    const a = (await book(h)).data;
    await book(h, { stay: { kind: "UNIT", unitId: "dev_house_02" } });
    const staff = await admin(h, ["payments.verify", "bookings.view"]);
    await record(h, staff, a.bookingCode);
    const unpaid = await h.api<{ items: { bookingCode: string }[] }>("GET", "/api/admin/bookings?payment=UNPAID", { token: staff });
    assert.equal(unpaid.data.items.length, 1);
    assert.notEqual(unpaid.data.items[0]!.bookingCode, a.bookingCode);
    assert.equal((await h.api("GET", "/api/admin/bookings?payment=FREE", { token: staff })).status, 422);
  });
});
