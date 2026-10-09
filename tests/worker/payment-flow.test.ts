import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { EmailLogDto, EmailRecipientDto, EmailSettingsDto } from "../../src/shared/email-types.ts";
import type {
  PaymentSettingsDto, PaypalCaptureDto, PaypalOrderDto, SlipQueueDto, SlipQueueItemDto, SlipUploadResultDto,
} from "../../src/shared/payment-types.ts";
import { promptpayPayload } from "../../src/shared/promptpay.ts";
import { encodeQr } from "../../src/shared/qr.ts";
import { renderEmail } from "../../src/worker/email/email-templates.ts";
import { formatAmount, parseAmount } from "../../src/worker/paypal/paypal-api.ts";
import type { ProviderResult, SlipVerifier, VerifiedSlip } from "../../src/worker/slip/slip-verifier.ts";
import { Harness, ORIGIN } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

// Harness clock: 2027-01-10T03:00Z. Seed primary account: 000-0-00000-0 / PromptPay 0000000000. House 01: ฿3,500/night.
let seq = 0;
const key = () => `flow-key-${String(++seq).padStart(10, "0")}`;
const PHONE = "0812345678";
const GROUP = `C${"a".repeat(32)}`;
const GUEST_LINE = `U${"b".repeat(32)}`;
const slipImage = (n: number) => ({ bytes: pngBytes(700 + n, 900), name: `slip${n}.png`, type: "image/png" });

async function book(h: Harness, opts: { unitId?: string; email?: string | null; name?: string } = {}) {
  const body = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, stay: { kind: "UNIT", unitId: opts.unitId ?? "dev_house_01" }, food: [], lang: "th" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  const customer = { name: opts.name ?? "Guest Payer", phone: PHONE, ...(opts.email === null ? {} : { email: opts.email ?? "guest@example.test" }) };
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function staff(h: Harness, perms: string[]) {
  const id = `staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

async function root(h: Harness) {
  return h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
}

const goodSlip = (over: Partial<VerifiedSlip> = {}): VerifiedSlip => ({
  transactionRef: `TXN${++seq}`, amountSatang: 700000, transferredAt: "2027-01-10T02:58:00.000Z", senderBank: "KBANK",
  receiverBank: "DEV", receiverAccountMasked: "xxx-x-x0000-x", receiverProxyMasked: null, ...over,
});

const verifier = (answer: () => ProviderResult): SlipVerifier => ({ provider: "easyslip", verify: async () => answer() });

async function setSettings(h: Harness, token: string, body: { approvalMode: "AUTO" | "MANUAL"; channels?: Partial<Record<string, boolean>> }) {
  const res = await h.api<PaymentSettingsDto>("PUT", "/api/admin/payment-settings", {
    token, body: { approvalMode: body.approvalMode, channels: { PROMPTPAY: true, BANK_TRANSFER: true, QR_CODE: true, PAYPAL: false, ...body.channels } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.data;
}

const bookingRow = (h: Harness, code: string) =>
  h.db.get<{ id: string; booking_status: string; payment_status: string; expires_at: string | null; cancel_reason: string | null }>(
    "SELECT id, booking_status, payment_status, expires_at, cancel_reason FROM bookings WHERE booking_code = ?", code)!;

// =============================================================================== pure helpers

describe("PromptPay QR and money helpers (pure)", () => {
  it("Thai QR payload: dynamic with the amount, CRC per the standard", () => {
    // Reference vector (dtinth/promptpay-qr): 000-000-0000, ฿4.22.
    assert.equal(promptpayPayload("000-000-0000", 422), "00020101021229370016A000000677010111011300660000000005802TH530376454044.226304E469");
    assert.match(promptpayPayload("1234567890123", 130000)!, /^000201010212.*0213123456789012358.*54071300\.006304[0-9A-F]{4}$/);
    assert.equal(promptpayPayload("12345", 100), null, "not a PromptPay id");
    assert.equal(promptpayPayload("0812345678", 0), null, "no zero amount");
  });

  it("the QR encoder makes a standard symbol (size by version, finder patterns, a dark module)", () => {
    const m = encodeQr(promptpayPayload("0812345678", 700000)!, "M");
    assert.equal(m.length % 4, 1);
    assert.ok(m.length >= 25 && m.length <= 57);
    for (const [x, y] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]] as [number, number][]) {
      assert.ok(m[y]![x] && m[y + 6]![x + 6] && !m[y + 1]![x + 1] && m[y + 3]![x + 3], "finder pattern");
    }
    assert.equal(m[m.length - 8]![8], true, "dark module");
    assert.throws(() => encodeQr("x".repeat(400)), /QR_TOO_LONG/);
  });

  it("PayPal amounts: satang ↔ '1300.00', strict parsing", () => {
    assert.equal(formatAmount(130000), "1300.00");
    assert.equal(formatAmount(5), "0.05");
    assert.equal(parseAmount("1300.00"), 130000);
    assert.equal(parseAmount("7000.5"), 700050);
    assert.equal(parseAmount("-1"), null);
    assert.equal(parseAmount("1e3"), null);
  });

  it("e-mail HTML escapes everything a guest typed", () => {
    const mail = renderEmail({ lang: "en", subject: "x", title: "<b>Hi</b>", body: "Name: <script>alert(1)</script>\n\nok", button: { label: "Go", url: "javascript:alert(1)" }, siteName: null });
    assert.doesNotMatch(mail.html, /<script>|<b>Hi/);
    assert.match(mail.html, /&lt;script&gt;/);
    assert.doesNotMatch(mail.html, /javascript:/, "only https buttons");
    assert.match(mail.text, /Name: <script>/, "plain text stays plain");
  });
});

// =============================================================================== settings + channels

describe("payment settings: channels and approval mode", () => {
  it("defaults, permissions, validation, audit; the guest sees only offered + possible channels", async () => {
    const h = new Harness({ seed: true });
    const viewer = await staff(h, ["receiving_accounts.view"]);
    const nobody = await staff(h, []);
    const editor = await staff(h, ["receiving_accounts.view", "receiving_accounts.edit"]);
    const s = await h.api<PaymentSettingsDto>("GET", "/api/admin/payment-settings", { token: viewer });
    assert.equal(s.status, 200);
    assert.equal(s.data.approvalMode, "AUTO");
    assert.deepEqual(s.data.channels, { PROMPTPAY: true, BANK_TRANSFER: true, QR_CODE: true, PAYPAL: false });
    assert.deepEqual(s.data.account, { promptpay: true, bankAccount: true, qr: false });
    assert.deepEqual(s.data.paypal, { configured: false, environment: "live" }, "live PayPal unless PAYPAL_ENV=sandbox");
    assert.equal((await h.api("GET", "/api/admin/payment-settings", { token: nobody })).status, 403);
    assert.equal((await h.api("PUT", "/api/admin/payment-settings", { token: viewer, body: { approvalMode: "MANUAL", channels: s.data.channels } })).status, 403);

    const none = await h.api("PUT", "/api/admin/payment-settings", { token: editor, body: { approvalMode: "AUTO", channels: { PROMPTPAY: false, BANK_TRANSFER: false, QR_CODE: false, PAYPAL: false } } });
    assert.equal(none.status, 422);
    assert.equal(none.error?.details?.channels, "AT_LEAST_ONE");
    const paypal = await h.api("PUT", "/api/admin/payment-settings", { token: editor, body: { approvalMode: "AUTO", channels: { ...s.data.channels, PAYPAL: true } } });
    assert.equal(paypal.error?.details?.["channels.PAYPAL"], "PAYPAL_NOT_CONFIGURED");
    assert.equal((await h.api("PUT", "/api/admin/payment-settings", { token: editor, body: { approvalMode: "SOMETIMES", channels: s.data.channels } })).status, 422);

    const saved = await setSettings(h, editor, { approvalMode: "MANUAL", channels: { PROMPTPAY: false } });
    assert.equal(saved.approvalMode, "MANUAL");
    assert.equal(h.audits("UPDATE_PAYMENT_SETTINGS").length, 1);

    const b = await book(h);
    assert.deepEqual(b.paymentInstructions?.channels, ["BANK_TRANSFER"]);
    assert.ok(b.paymentInstructions?.promptpayPayload, "the QR is still made (the snapshot has the number)");

    // Owner turns off everything this account can do: the booking still shows a way to pay.
    await setSettings(h, editor, { approvalMode: "MANUAL", channels: { PROMPTPAY: false, BANK_TRANSFER: false, QR_CODE: true } });
    const again = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: PHONE } });
    assert.deepEqual(again.data.paymentInstructions?.channels, ["PROMPTPAY", "BANK_TRANSFER"]);
  });

  it("the slip remembers the channel the guest chose; the method follows from it", async () => {
    const h = new Harness({ seed: true });
    const a = await book(h);
    assert.equal((await h.slip(a.bookingCode, PHONE, slipImage(1), "PROMPTPAY")).status, 201);
    const b = await book(h, { unitId: "dev_house_02" });
    assert.equal((await h.slip(b.bookingCode, PHONE, slipImage(2), "QR_CODE")).status, 201);
    const c = await book(h, { unitId: "dev_vip_01" });
    assert.equal((await h.slip(c.bookingCode, PHONE, slipImage(3), "PAYPAL")).status, 422, "PayPal is never a slip");
    assert.deepEqual(h.db.all<{ method: string; channel: string }>("SELECT method, channel FROM payments ORDER BY channel").map((r) => ({ ...r })), [
      { method: "PROMPTPAY", channel: "PROMPTPAY" }, { method: "BANK_TRANSFER", channel: "QR_CODE" },
    ]);
    assert.throws(() => h.db.run("UPDATE payments SET channel = 'PAYPAL'"), /PAYMENT_IMMUTABLE/);
  });
});

// =============================================================================== approval modes

describe("slip approval: Auto vs Manual", () => {
  it("AUTO: a slip the service proves correct confirms the booking", async () => {
    const h = new Harness({ seed: true });
    h.verifier(verifier(() => ({ kind: "OK", slip: goodSlip() })));
    const b = await book(h);
    const res = await h.slip<{ booking: PublicBookingDto } & SlipUploadResultDto>(b.bookingCode, PHONE, slipImage(1), "BANK_TRANSFER");
    assert.equal(res.data.outcome, "VERIFIED");
    assert.equal(res.data.booking.status, "CONFIRMED");
  });

  it("MANUAL: correct slip waits for staff; approving with the same bank reference is not a duplicate", async () => {
    const h = new Harness({ seed: true });
    const owner = await root(h);
    await setSettings(h, owner, { approvalMode: "MANUAL" });
    h.verifier(verifier(() => ({ kind: "OK", slip: goodSlip({ transactionRef: "KB-555" }) })));
    const b = await book(h);
    const res = await h.slip<{ booking: PublicBookingDto } & SlipUploadResultDto>(b.bookingCode, PHONE, slipImage(1));
    assert.equal(res.data.outcome, "PENDING_REVIEW");
    assert.equal(res.data.booking.paymentStatus, "PENDING_VERIFICATION");

    const queue = await h.api<SlipQueueDto>("GET", "/api/admin/slips", { token: owner });
    assert.equal(queue.data.approvalMode, "MANUAL");
    assert.equal(queue.data.verifierConfigured, true);
    const item = queue.data.items[0]!;
    assert.deepEqual(item.verifications.map((v) => [v.method, v.result, v.transactionRef]), [["AUTO", "PASSED", "KB-555"]]);

    const ok = await h.api<SlipQueueItemDto>("POST", `/api/admin/payments/${item.paymentId}/verify`, { token: owner, body: { transactionRef: "KB-555" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(bookingRow(h, b.bookingCode).booking_status, "CONFIRMED");

    // …but that reference cannot back another booking.
    const c = await book(h, { unitId: "dev_house_02" });
    await h.slip(c.bookingCode, PHONE, slipImage(2));
    const other = (await h.api<SlipQueueDto>("GET", "/api/admin/slips", { token: owner })).data.items[0]!;
    assert.equal(other.verifications[0]?.failureCode, "DUPLICATE_TRANSACTION");
    assert.equal((await h.api("POST", `/api/admin/payments/${other.paymentId}/verify`, { token: owner, body: { transactionRef: "KB-555" } })).error?.code, "DUPLICATE_TRANSACTION");
  });

  it("AUTO but the check fails: staff are notified (LINE) with the reason; the booking waits", async () => {
    const h = new Harness({ seed: true });
    const owner = await root(h);
    h.lineSecrets();
    h.db.run("UPDATE line_settings SET enabled = 1");
    await h.api("POST", "/api/admin/line/recipients", { token: owner, body: { targetId: GROUP, name: "Owners", language: "th", notifyPayment: true, notifyBooking: false } });
    h.verifier(verifier(() => ({ kind: "OK", slip: goodSlip({ amountSatang: 1000 }) })));
    const b = await book(h);
    const res = await h.slip<SlipUploadResultDto>(b.bookingCode, PHONE, slipImage(1));
    assert.equal(res.data.outcome, "PENDING_REVIEW");
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:05:00Z"));
    h.advance(5 * 60_000);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:06:00Z"));
    const push = h.line.pushes.find((p) => p.texts[0]!.includes("สลิปรอตรวจสอบ"));
    assert.ok(push, JSON.stringify(h.line.pushes));
    assert.match(push.texts[0]!, /ตรวจสลิปอัตโนมัติไม่ผ่าน: ยอดเงินไม่ตรง/);
  });
});

// =============================================================================== decline with a reason

describe("declining a payment: the guest is told why", () => {
  async function setup() {
    const h = new Harness({ seed: true });
    const owner = await root(h);
    h.lineSecrets();
    h.emailKey();
    h.db.run("UPDATE line_settings SET enabled = 1, guest_enabled = 1, bot_basic_id = '@phasakura'");
    const e = await h.api<EmailSettingsDto>("PUT", "/api/admin/email/settings", { token: owner, body: { enabled: true, guestEnabled: true, fromName: "Phasakura", fromEmail: "booking@phasakura.test" } });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    return { h, owner };
  }

  it("decline + pay again: reason on the booking page, LINE (linked guest) and e-mail; fresh hold", async () => {
    const { h, owner } = await setup();
    const b = await book(h);
    h.db.run("INSERT INTO booking_line_links (booking_id, line_user_id, linked_at) VALUES (?, ?, ?)", bookingRow(h, b.bookingCode).id, GUEST_LINE, "2027-01-10T03:00:00Z");
    await h.slip(b.bookingCode, PHONE, slipImage(1));
    const pid = h.db.get<{ id: string }>("SELECT id FROM payments")!.id;
    const declined = await h.api<SlipQueueItemDto>("POST", `/api/admin/payments/${pid}/reject`, { token: owner, body: { reason: "ยอดโอนไม่ครบ ขาด 200 บาท", cancelBooking: false } });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(declined.data.rejectedReason, "ยอดโอนไม่ครบ ขาด 200 บาท");
    const row = bookingRow(h, b.bookingCode);
    assert.equal(row.booking_status, "PENDING");
    assert.equal(row.payment_status, "REJECTED");

    const look = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: PHONE } });
    assert.equal(look.data.paymentRejectedReason, "ยอดโอนไม่ครบ ขาด 200 บาท");

    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));
    const toGuest = h.line.pushes.find((p) => p.to === GUEST_LINE)!;
    assert.match(toGuest.texts[0]!, /ยังไม่ผ่านการตรวจสอบ/);
    assert.match(toGuest.texts[0]!, /เหตุผล: ยอดโอนไม่ครบ ขาด 200 บาท/);
    const mails = h.resend.requests.map((r) => r.json!);
    const rejectedMail = mails.find((m) => String(m.subject).includes("ยังไม่ผ่านการตรวจสอบ"))!;
    assert.deepEqual(rejectedMail.to, ["guest@example.test"]);
    assert.equal(rejectedMail.from, "Phasakura <booking@phasakura.test>");
    assert.match(String(rejectedMail.text), /ยอดโอนไม่ครบ ขาด 200 บาท/);
    assert.match(h.resend.requests.at(-1)!.headers.get("Idempotency-Key")!, /^phasakura-email\//);
    assert.equal(h.resend.requests.at(-1)!.headers.get("Authorization"), "Bearer re_test_key");
    // No address in the outbox rows: references only.
    assert.equal(h.db.all("SELECT recipient FROM email_logs WHERE recipient LIKE '%@%'").length, 0);
  });

  it("decline + cancel booking: released, guest told (LINE + e-mail); needs bookings.cancel", async () => {
    const { h, owner } = await setup();
    const b = await book(h);
    h.db.run("INSERT INTO booking_line_links (booking_id, line_user_id, linked_at) VALUES (?, ?, ?)", bookingRow(h, b.bookingCode).id, GUEST_LINE, "2027-01-10T03:00:00Z");
    await h.slip(b.bookingCode, PHONE, slipImage(1));
    const pid = h.db.get<{ id: string }>("SELECT id FROM payments")!.id;
    const finance = await staff(h, ["payments.verify", "slips.view"]);
    assert.equal((await h.api("POST", `/api/admin/payments/${pid}/reject`, { token: finance, body: { reason: "ไม่พบยอดเงินเข้า", cancelBooking: true } })).status, 403);
    assert.equal((await h.api("POST", `/api/admin/payments/${pid}/reject`, { token: owner, body: { reason: "no", cancelBooking: true } })).status, 422, "reason too short");

    const res = await h.api<SlipQueueItemDto>("POST", `/api/admin/payments/${pid}/reject`, { token: owner, body: { reason: "ไม่พบยอดเงินเข้า", cancelBooking: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = bookingRow(h, b.bookingCode);
    assert.equal(row.booking_status, "CANCELLED");
    assert.equal(row.cancel_reason, "ไม่พบยอดเงินเข้า");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE booking_id = ?", row.id)!.n, 0, "nights released");
    assert.equal(h.audits("REJECT_SLIP_CANCEL_BOOKING").length, 1);
    const look = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: PHONE } });
    assert.equal(look.data.cancelReason, "ไม่พบยอดเงินเข้า");

    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));
    assert.match(h.line.pushes.find((p) => p.to === GUEST_LINE)!.texts[0]!, /การจองถูกยกเลิก[\s\S]*เหตุผล: ไม่พบยอดเงินเข้า/);
    assert.ok(h.resend.requests.some((r) => String(r.json!.subject).includes("ถูกยกเลิก") && (r.json!.to as string[])[0] === "guest@example.test"));
    // The same room can be booked again.
    await book(h);
  });

  it("an admin cancel from the booking page also tells the guest", async () => {
    const { h, owner } = await setup();
    const b = await book(h);
    const res = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: owner, body: { reason: "ที่พักปิดปรับปรุง" } });
    assert.equal(res.status, 200);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));
    const mail = h.resend.requests.find((r) => String(r.json!.subject).includes("ถูกยกเลิก"))!;
    assert.match(String(mail.json!.text), /ที่พักปิดปรับปรุง/);
  });
});

// =============================================================================== new booking notices

describe("every new booking notifies staff (LINE + e-mail)", () => {
  it("LINE chats with 'new booking', staff e-mails, and the guest's 'booking received' e-mail", async () => {
    const h = new Harness({ seed: true });
    const owner = await root(h);
    h.lineSecrets();
    h.emailKey();
    h.db.run("UPDATE line_settings SET enabled = 1");
    await h.api("POST", "/api/admin/line/recipients", { token: owner, body: { targetId: GROUP, name: "Front desk", language: "th", notifyBooking: true } });
    await h.api("PUT", "/api/admin/email/settings", { token: owner, body: { enabled: true, guestEnabled: true, fromEmail: "booking@phasakura.test" } });
    const r = await h.api<EmailRecipientDto>("POST", "/api/admin/email/recipients", { token: owner, body: { email: "Owner@Phasakura.test", name: "Owner", language: "en", notifyBooking: true, notifyPayment: false } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.email, "owner@phasakura.test", "stored lower-case");
    assert.equal((await h.api("POST", "/api/admin/email/recipients", { token: owner, body: { email: "owner@phasakura.test", name: "Again", language: "th" } })).error?.code, "EMAIL_RECIPIENT_EXISTS");

    h.env.APP_BASE_URL = ORIGIN;
    const b = await book(h, { name: "<b>Somchai</b>" });
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));

    const line = h.line.pushes.find((p) => p.to === GROUP)!;
    assert.match(line.texts[0]!, /การจองใหม่ — รอชำระเงิน/);
    assert.match(line.texts[0]!, new RegExp(b.bookingCode));
    assert.match(line.texts[0]!, /ชำระภายใน/);
    // Who booked, with half of the phone / e-mail hidden, and the booking in the admin (the chat's language).
    assert.match(line.texts[0]!, /ผู้จอง: <b>Somchai<\/b>\nโทร: 081\*{5}78\nอีเมล: gu\*{3}@example\.test\n/);
    assert.doesNotMatch(line.texts[0]!, /0812345678|guest@example\.test/, "the full contact never goes to LINE");
    assert.ok(line.texts[0]!.endsWith(`เปิดในระบบหลังบ้าน:\n${ORIGIN}/th/admin/bookings/${b.bookingCode}`), line.texts[0]!);

    const staffMail = h.resend.requests.find((x) => (x.json!.to as string[])[0] === "owner@phasakura.test")!;
    assert.match(String(staffMail.json!.subject), new RegExp(`New booking ${b.bookingCode}`));
    assert.doesNotMatch(String(staffMail.json!.html), /<b>Somchai/, "names are escaped in HTML");
    const guestMail = h.resend.requests.find((x) => (x.json!.to as string[])[0] === "guest@example.test")!;
    assert.match(String(guestMail.json!.subject), /ได้รับการจอง .* กรุณาชำระเงิน/);
    assert.match(String(guestMail.json!.text), /฿7,000/);

    // A guest without an e-mail: staff still hear about it.
    h.resend.reset();
    await book(h, { unitId: "dev_house_02", email: null });
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:02:00Z"));
    assert.deepEqual(h.resend.requests.map((x) => (x.json!.to as string[])[0]), ["owner@phasakura.test"]);
  });

  it("e-mail settings: needs the Resend key and a sender; test message; log; retry", async () => {
    const h = new Harness({ seed: true });
    const owner = await root(h);
    const noKey = await h.api("PUT", "/api/admin/email/settings", { token: owner, body: { enabled: true, fromEmail: "booking@phasakura.test" } });
    assert.equal(noKey.error?.details?.enabled, "EMAIL_KEY_MISSING");
    h.emailKey();
    const noFrom = await h.api("PUT", "/api/admin/email/settings", { token: owner, body: { enabled: true } });
    assert.equal(noFrom.error?.details?.fromEmail, "REQUIRED");
    const bad = await h.api("PUT", "/api/admin/email/settings", { token: owner, body: { enabled: true, fromEmail: "not-an-email" } });
    assert.equal(bad.error?.details?.fromEmail, "INVALID_EMAIL");
    const ok = await h.api<EmailSettingsDto>("PUT", "/api/admin/email/settings", { token: owner, body: { enabled: false, fromEmail: "booking@phasakura.test" } });
    assert.equal(ok.data.providerConfigured, true);
    assert.equal(JSON.stringify(ok.data).includes("re_test_key"), false, "the key is never returned");

    const r = await h.api<EmailRecipientDto>("POST", "/api/admin/email/recipients", { token: owner, body: { email: "staff@phasakura.test", name: "Staff", language: "th" } });
    h.resend.next.push(new Response(JSON.stringify({ name: "validation_error", message: "The staff@phasakura.test domain is not verified" }), { status: 403 }));
    const failed = await h.api<EmailLogDto>("POST", `/api/admin/email/recipients/${r.data.id}/test`, { token: owner, body: {} });
    assert.equal(failed.data.status, "FAILED");
    assert.equal(failed.data.lastError, "RESEND_403_VALIDATION_ERROR", "no address echoed in the log");
    const sent = await h.api<EmailLogDto>("POST", `/api/admin/email/recipients/${r.data.id}/test`, { token: owner, body: {} });
    assert.equal(sent.data.status, "SENT", JSON.stringify(sent.body));

    const retry = await h.api<EmailLogDto>("POST", `/api/admin/email/logs/${failed.data.id}/retry`, { token: owner, body: {} });
    assert.equal(retry.data.status, "PENDING");
    const logs = await h.api<{ items: EmailLogDto[] }>("GET", "/api/admin/email/logs", { token: owner });
    assert.equal(logs.data.items.length, 2);
    const viewer = await staff(h, ["notifications.view"]);
    assert.equal((await h.api("GET", "/api/admin/email/logs", { token: viewer })).status, 200);
    assert.equal((await h.api("GET", "/api/admin/email/settings", { token: viewer })).status, 403);
  });

  it("temporary Resend failures are retried with backoff; the same message is sent once", async () => {
    const h = new Harness({ seed: true });
    const owner = await root(h);
    h.emailKey();
    await h.api("PUT", "/api/admin/email/settings", { token: owner, body: { enabled: true, guestEnabled: false, fromEmail: "booking@phasakura.test" } });
    await h.api("POST", "/api/admin/email/recipients", { token: owner, body: { email: "staff@phasakura.test", name: "Staff", language: "th" } });
    await book(h);
    h.resend.next.push(new Response("{}", { status: 503 }));
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));
    let row = { ...h.db.get<{ status: string; attempts: number; last_error: string }>("SELECT status, attempts, last_error FROM email_logs")! };
    assert.deepEqual(row, { status: "PENDING", attempts: 1, last_error: "RESEND_503" });
    h.advance(2 * 60_000);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:03:00Z"));
    row = h.db.get("SELECT status, attempts, last_error FROM email_logs")!;
    assert.equal(row.status, "SENT");
    assert.equal(new Set(h.resend.requests.map((r) => r.headers.get("Idempotency-Key"))).size, 1, "same key on the retry");
  });
});

// =============================================================================== PayPal Checkout

describe("PayPal Checkout", () => {
  async function setup(opts: { mode?: "AUTO" | "MANUAL" } = {}) {
    const h = new Harness({ seed: true });
    h.paypalSecrets();
    const owner = await root(h);
    await setSettings(h, owner, { approvalMode: opts.mode ?? "AUTO", channels: { PAYPAL: true } });
    return { h, owner };
  }

  async function startPaypal(h: Harness, code: string) {
    const res = await h.api<PaypalOrderDto>("POST", "/api/public/bookings/paypal/order", { body: { bookingCode: code, phone: PHONE } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.data;
  }

  const capture = (h: Harness, orderId: string) => h.api<PaypalCaptureDto>("POST", "/api/public/bookings/paypal/capture", { body: { orderId } });

  it("is offered only when configured and switched on; the order carries the exact amount and our ids", async () => {
    const h = new Harness({ seed: true });
    const owner = await root(h);
    const b = await book(h);
    assert.equal((await h.api("POST", "/api/public/bookings/paypal/order", { body: { bookingCode: b.bookingCode, phone: PHONE } })).error?.code, "PAYPAL_NOT_CONFIGURED");
    h.paypalSecrets();
    assert.equal((await h.api("POST", "/api/public/bookings/paypal/order", { body: { bookingCode: b.bookingCode, phone: PHONE } })).error?.code, "PAYPAL_NOT_OFFERED");
    await setSettings(h, owner, { approvalMode: "AUTO", channels: { PAYPAL: true } });
    const look = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: PHONE } });
    assert.deepEqual(look.data.paymentInstructions?.channels, ["PROMPTPAY", "BANK_TRANSFER", "PAYPAL"]);
    assert.equal((await h.api("POST", "/api/public/bookings/paypal/order", { body: { bookingCode: b.bookingCode, phone: "0899999999" } })).status, 404, "Booking ID + phone");

    const order = await startPaypal(h, b.bookingCode);
    assert.match(order.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
    const create = h.paypal.requests.find((r) => r.url === "https://api-m.sandbox.paypal.com/v2/checkout/orders")!;
    const unit = (create.json!.purchase_units as Record<string, unknown>[])[0]!;
    assert.deepEqual(unit.amount, { currency_code: "THB", value: "7000.00" });
    assert.equal(unit.reference_id, b.bookingCode);
    assert.equal(unit.custom_id, bookingRow(h, b.bookingCode).id);
    const ctx = (create.json!.payment_source as { paypal: { experience_context: Record<string, string> } }).paypal.experience_context;
    assert.equal(ctx.return_url, `https://phasakura.test/th/booking/lookup?paypal=return&code=${b.bookingCode}`);
    assert.equal(ctx.shipping_preference, "NO_SHIPPING");
    assert.match(create.headers.get("PayPal-Request-Id")!, /^order-/);
  });

  it("capture completed → booking confirmed, PayPal payment recorded once; a repeat answers the same", async () => {
    const { h, owner } = await setup();
    const b = await book(h);
    const order = await startPaypal(h, b.bookingCode);
    const res = await capture(h, order.orderId);
    assert.deepEqual(res.data, { outcome: "PAID", bookingCode: b.bookingCode });
    const row = bookingRow(h, b.bookingCode);
    assert.deepEqual([row.booking_status, row.payment_status, row.expires_at], ["CONFIRMED", "PAID", null]);
    assert.deepEqual(h.db.all("SELECT method, channel, status, amount_satang FROM payments").map((r) => ({ ...r })), [{ method: "OTHER", channel: "PAYPAL", status: "PAID", amount_satang: 700000 }]);
    assert.equal(h.paypal.captures[0]!.headers.get("PayPal-Request-Id"), `capture-${order.orderId}`);

    assert.equal((await capture(h, order.orderId)).data.outcome, "PAID");
    assert.equal(h.paypal.captures.length, 1, "PayPal is not asked twice");
    assert.equal(h.db.all("SELECT id FROM payments").length, 1);
    const detail = await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${b.bookingCode}`, { token: owner });
    assert.equal(detail.data.payments[0]?.channel, "PAYPAL");
    assert.match(detail.data.payments[0]?.reference ?? "", /^3C67902/);
    // No PayPal order without a booking that waits for money.
    assert.equal((await h.api("POST", "/api/public/bookings/paypal/order", { body: { bookingCode: b.bookingCode, phone: PHONE } })).error?.code, "BOOKING_NOT_PAYABLE");
  });

  it("declined → nothing taken, the booking waits again (hold kept, at least 15 minutes)", async () => {
    const { h } = await setup();
    const b = await book(h);
    const order = await startPaypal(h, b.bookingCode);
    h.paypal.captureMode = "DECLINED";
    assert.equal((await capture(h, order.orderId)).data.outcome, "DECLINED");
    const row = bookingRow(h, b.bookingCode);
    assert.deepEqual([row.booking_status, row.payment_status], ["PENDING", "UNPAID"]);
    assert.equal(row.expires_at, b.expiresAt, "original hold given back");
    assert.equal(h.db.all("SELECT id FROM payments").length, 0);
    // The guest can try again with a new order, or send a slip.
    h.paypal.captureMode = "COMPLETED";
    const again = await startPaypal(h, b.bookingCode);
    assert.equal((await capture(h, again.orderId)).data.outcome, "PAID");
  });

  it("an expired booking is never charged", async () => {
    const { h } = await setup();
    const b = await book(h);
    const order = await startPaypal(h, b.bookingCode);
    h.advance(2 * 60 * 60_000); // hold (60 min) is over while the guest was at PayPal
    assert.equal((await capture(h, order.orderId)).data.outcome, "NOT_PAYABLE");
    assert.equal(h.paypal.captures.length, 0);
    assert.equal(h.db.get<{ status: string }>("SELECT status FROM paypal_orders")!.status, "CANCELLED");
  });

  it("answer lost → PROCESSING; the cron asks PayPal and finishes the booking", async () => {
    const { h } = await setup();
    const b = await book(h);
    const order = await startPaypal(h, b.bookingCode);
    h.paypal.captureMode = "LOST";
    assert.equal((await capture(h, order.orderId)).data.outcome, "PAID", "a lost answer is recovered at once by reading the order");

    // Truly unknown (PayPal unreachable): the claim stays, the cron settles it.
    const c = await book(h, { unitId: "dev_house_02" });
    const o2 = await startPaypal(h, c.bookingCode);
    h.paypal.captureMode = "COMPLETED";
    h.paypal.next.push("network", "network");
    assert.equal((await capture(h, o2.orderId)).data.outcome, "PROCESSING");
    assert.equal(bookingRow(h, c.bookingCode).payment_status, "PENDING_VERIFICATION", "claimed: no expiry, no slip meanwhile");
    h.advance(2 * 60_000);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:03:00Z"));
    assert.equal(bookingRow(h, c.bookingCode).booking_status, "CONFIRMED");
    assert.equal((await capture(h, o2.orderId)).data.outcome, "PAID");
  });

  it("PayPal holds the payment (PENDING) or the amount differs → staff review in the slip queue", async () => {
    const { h, owner } = await setup();
    const b = await book(h);
    const order = await startPaypal(h, b.bookingCode);
    h.paypal.captureMode = "PENDING";
    assert.equal((await capture(h, order.orderId)).data.outcome, "PENDING_REVIEW");
    const queue = await h.api<SlipQueueDto>("GET", "/api/admin/slips", { token: owner });
    const item = queue.data.items[0]!;
    assert.equal(item.channel, "PAYPAL");
    assert.equal(item.slipUrl, null);
    assert.match(item.reference ?? "", /^3C67902/);
    assert.equal((await h.api("POST", `/api/admin/payments/${item.paymentId}/verify`, { token: owner, body: {} })).status, 200);
    assert.equal(bookingRow(h, b.bookingCode).booking_status, "CONFIRMED");

    const c = await book(h, { unitId: "dev_house_02" });
    const o2 = await startPaypal(h, c.bookingCode);
    h.paypal.captureMode = "WRONG_AMOUNT";
    assert.equal((await capture(h, o2.orderId)).data.outcome, "PENDING_REVIEW");
    assert.equal(h.db.get<{ failure_code: string }>("SELECT failure_code FROM paypal_orders WHERE id = ?", o2.orderId)!.failure_code, "AMOUNT_MISMATCH");
    assert.equal(bookingRow(h, c.bookingCode).booking_status, "PENDING");
  });

  it("cancel at PayPal closes the order; unknown or malformed order ids are refused", async () => {
    const { h } = await setup();
    const b = await book(h);
    const order = await startPaypal(h, b.bookingCode);
    const cancelled = await h.api<{ bookingCode: string | null }>("POST", "/api/public/bookings/paypal/cancel", { body: { orderId: order.orderId } });
    assert.equal(cancelled.data.bookingCode, b.bookingCode);
    assert.equal((await capture(h, order.orderId)).data.outcome, "NOT_PAYABLE");
    assert.equal(h.paypal.captures.length, 0);
    assert.equal((await capture(h, "NOPE123456789")).status, 404);
    assert.equal((await capture(h, "../../x")).status, 422);
  });
});
