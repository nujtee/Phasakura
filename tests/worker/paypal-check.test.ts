import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { getNotifyMessages } from "../../src/shared/i18n/admin-notify-messages.ts";
import type { PaymentSettingsDto, PaypalCheckDto } from "../../src/shared/payment-types.ts";
import { paypalCheckText } from "../../src/client/admin/payments/PaymentSettingsPage.tsx";
import { jsonResponse } from "../helpers/fake-http.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10T03:00Z. FakePaypal answers like the sandbox REST API.
let seq = 0;
const PHONE = "0812345678";
const token = () => jsonResponse({ access_token: "A21AA-queued-token", token_type: "Bearer", expires_in: 32400 });
const refused = () => jsonResponse({ error: "invalid_client", error_description: "Client Authentication failed" }, 401);

async function setup(opts: { paypal?: boolean } = {}) {
  const h = new Harness({ seed: true });
  if (opts.paypal !== false) h.paypalSecrets();
  const owner = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const check = (as = owner) => h.api<PaypalCheckDto>("POST", "/api/admin/payment-settings/paypal-check", { token: as, body: {} });
  return { h, owner, check };
}

describe("Payment settings → Check PayPal connection", () => {
  it("works: a token and a ฿100 test order that nobody approves — no booking, no payment, an audit trail", async () => {
    const { h, check } = await setup();
    const r = await check();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.ok, true);
    assert.equal(r.data.environment, "sandbox");
    assert.equal(r.data.error, null);
    const order = h.paypal.requests.find((x) => x.url.endsWith("/v2/checkout/orders"))!;
    const unit = (order.json!.purchase_units as { amount: { value: string; currency_code: string } }[])[0]!;
    assert.deepEqual(unit.amount, { currency_code: "THB", value: "100.00" });
    assert.equal(h.paypal.captures.length, 0, "never captured");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM paypal_orders")!.n, 0);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payments")!.n, 0);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_events WHERE event_type = 'PAYPAL_CHECK'")!.n, 1);
    assert.equal(/paypal-client-secret/.test(JSON.stringify(r.body)), false);
  });

  it("names the problem: refused credentials, an account PayPal will not pay into, no secrets", async () => {
    const { h, check } = await setup();
    h.paypal.next.push(refused());
    assert.equal((await check()).data.error, "PAYPAL_AUTH_401_INVALID_CLIENT");

    h.paypal.next.push(token(), jsonResponse({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYEE_ACCOUNT_RESTRICTED" }] }, 422));
    const r = (await check()).data;
    assert.deepEqual([r.ok, r.error], [false, "PAYPAL_ORDER_422_PAYEE_ACCOUNT_RESTRICTED"]);
    const ev = h.db.get<{ severity: string; details_json: string }>("SELECT severity, details_json FROM security_events WHERE event_type = 'PAYPAL_CHECK' ORDER BY created_at DESC, rowid DESC LIMIT 1")!;
    assert.equal(ev.severity, "WARNING");
    assert.match(ev.details_json, /PAYEE_ACCOUNT_RESTRICTED/);

    h.paypal.next.push("network");
    assert.equal((await check()).data.error, "PAYPAL_UNREACHABLE");

    const none = await setup({ paypal: false });
    assert.deepEqual({ ...(await none.check()).data, checkedAt: "" }, { ok: false, environment: null, error: "PAYPAL_NOT_CONFIGURED", checkedAt: "" });
  });

  it("needs receiving_accounts.edit", async () => {
    const { h, check } = await setup();
    const id = `viewer_${++seq}`;
    const email = await h.user({ id });
    h.grant(id, "receiving_accounts.view");
    assert.equal((await check(await h.login(email))).status, 403);
    assert.equal(h.paypal.requests.length, 0);
  });

  it("a guest's failed PayPal start: generic message for the guest, PayPal's reason in the owner's error log", async () => {
    const { h, owner } = await setup();
    const s = await h.api<PaymentSettingsDto>("PUT", "/api/admin/payment-settings", {
      token: owner, body: { approvalMode: "AUTO", channels: { PROMPTPAY: true, BANK_TRANSFER: true, QR_CODE: true, PAYPAL: true } },
    });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const body = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th" };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    const b = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `pp-check-${String(++seq).padStart(8, "0")}` },
    });
    assert.equal(b.status, 201, JSON.stringify(b.body));

    h.paypal.next.push(refused());
    const res = await h.api("POST", "/api/public/bookings/paypal/order", { body: { bookingCode: b.data.bookingCode, phone: PHONE } });
    assert.equal(res.status, 502);
    assert.equal(res.error?.code, "PAYPAL_UNAVAILABLE");
    assert.equal(JSON.stringify(res.body).includes("INVALID_CLIENT"), false, "the reason is not shown to guests");
    const logged = h.db.get<{ message: string }>("SELECT message FROM error_events WHERE path = '/api/public/bookings/paypal/order'")!;
    assert.match(logged.message, /\[sandbox: PAYPAL_AUTH_401_INVALID_CLIENT\]$/);
  });
});

describe("the check result in words", () => {
  const n = getNotifyMessages("th").payment;
  const errors = getNotifyMessages("th").errors as Record<string, string>;
  const r = (over: Partial<PaypalCheckDto>): PaypalCheckDto => ({ ok: false, environment: "live", error: null, checkedAt: "", ...over });

  it("says what to fix, and keeps PayPal's code", () => {
    assert.match(paypalCheckText(n, errors, r({ ok: true })), /ใช้งานจริง.*สำเร็จ/);
    assert.match(paypalCheckText(n, errors, r({ error: "PAYPAL_AUTH_401_INVALID_CLIENT" })), /Sandbox.*Live.*\(PAYPAL_AUTH_401_INVALID_CLIENT\)$/);
    assert.match(paypalCheckText(n, errors, r({ environment: "sandbox", error: "PAYPAL_AUTH_401_INVALID_CLIENT" })), /ลบ PAYPAL_ENV/);
    assert.match(paypalCheckText(n, errors, r({ error: "PAYPAL_ORDER_422_PAYEE_ACCOUNT_RESTRICTED" })), /PayPal Business.*THB.*\(PAYPAL_ORDER_422_PAYEE_ACCOUNT_RESTRICTED\)$/);
    assert.match(paypalCheckText(n, errors, r({ error: "PAYPAL_TIMEOUT" })), /ติดต่อ PayPal ไม่ได้/);
    assert.equal(paypalCheckText(n, errors, r({ environment: null, error: "PAYPAL_NOT_CONFIGURED" })), errors.PAYPAL_NOT_CONFIGURED);
  });
});
