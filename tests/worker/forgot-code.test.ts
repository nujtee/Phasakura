import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { BOOKING_LIMITS } from "../../src/worker/services/booking.service.ts";
import { Harness } from "../helpers/harness.ts";

// "Forgot Booking ID" on the lookup page: the code is e-mailed to the booking's own address, never shown.
let seq = 0;
const PHONE = "0812345678";

async function book(h: Harness, unitId: string, email: string | null) {
  const body = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, stay: { kind: "UNIT", unitId }, food: [], lang: "th" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  const customer = { name: "Guest Forgot", phone: PHONE, ...(email ? { email } : {}) };
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `forgot-${String(++seq).padStart(10, "0")}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function setup() {
  const h = new Harness({ seed: true });
  const owner = await h.login(await h.user({ id: `root_forgot_${++seq}`, roles: ["SUPER_ADMIN"] }));
  h.emailKey();
  const e = await h.api("PUT", "/api/admin/email/settings", { token: owner, body: { enabled: true, guestEnabled: true, fromEmail: "booking@phasakura.test" } });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  return h;
}

const codeMails = (h: Harness) => h.db.all<{ booking_id: string; recipient: string }>(
  "SELECT booking_id, recipient FROM email_logs WHERE notification_type = 'GUEST_BOOKING_CODE'");

describe("forgot Booking ID", () => {
  it("e-mails the Booking ID to the booking's address; the page gets the same answer either way", async () => {
    const h = await setup();
    const b = await book(h, "dev_house_01", "guest@example.test");
    await book(h, "dev_house_02", null); // no e-mail: nothing to send
    h.db.run("DELETE FROM email_logs");

    const res = await h.api<{ ok: boolean }>("POST", "/api/public/bookings/forgot-code", { body: { phone: "081-234-5678" } });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.deepEqual(res.data, { ok: true });
    assert.equal(JSON.stringify(res.body).includes(b.bookingCode), false, "never on the page");
    assert.equal(codeMails(h).length, 1);

    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));
    const mail = h.resend.requests.find((r) => String(r.json!.subject).includes(b.bookingCode))!;
    assert.ok(mail, "sent");
    assert.equal((mail.json!.to as string[])[0], "guest@example.test");
    assert.match(String(mail.json!.text), new RegExp(b.bookingCode));

    // Same answer for a number with no booking; nothing queued.
    const none = await h.api<{ ok: boolean }>("POST", "/api/public/bookings/forgot-code", { body: { phone: "0899999999" } });
    assert.equal(none.status, 202);
    assert.deepEqual(none.data, { ok: true });
    assert.equal(codeMails(h).length, 1);

    // Asking again within the hour does not send a second e-mail.
    await h.api("POST", "/api/public/bookings/forgot-code", { body: { phone: PHONE } });
    assert.equal(codeMails(h).length, 1);
    // The phone is logged only as a hash.
    const ev = h.db.all<{ identifier: string }>("SELECT identifier FROM security_events WHERE event_type = 'BOOKING_CODE_REQUESTED'");
    assert.ok(ev.length >= 3 && ev.every((x) => /^phone:[0-9a-f]{16}$/.test(x.identifier)));
  });

  it("expired bookings are not sent; bad input and repeated requests are refused", async () => {
    const h = await setup();
    const b = await book(h, "dev_house_01", "guest@example.test");
    h.db.run("UPDATE bookings SET booking_status = 'EXPIRED' WHERE booking_code = ?", b.bookingCode);
    h.db.run("DELETE FROM email_logs");
    await h.api("POST", "/api/public/bookings/forgot-code", { body: { phone: PHONE } });
    assert.equal(codeMails(h).length, 0);

    assert.equal((await h.api("POST", "/api/public/bookings/forgot-code", { body: {} })).status, 422);
    assert.equal((await h.api("POST", "/api/public/bookings/forgot-code", { body: { phone: "abc" } })).error?.details?.phone, "INVALID_FORMAT");

    for (let i = 1; i < BOOKING_LIMITS.codeRequestsPerPhonePerHour; i++) {
      assert.equal((await h.api("POST", "/api/public/bookings/forgot-code", { body: { phone: PHONE } })).status, 202);
    }
    assert.equal((await h.api("POST", "/api/public/bookings/forgot-code", { body: { phone: PHONE } })).status, 429, "per phone");
    for (let i = 0; i < BOOKING_LIMITS.codeRequestsPerIpPerHour; i++) {
      await h.api("POST", "/api/public/bookings/forgot-code", { body: { phone: `08000000${i}0` } });
    }
    assert.equal((await h.api("POST", "/api/public/bookings/forgot-code", { body: { phone: "0811111111" } })).status, 429, "per IP");
  });
});
