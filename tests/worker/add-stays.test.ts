import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

// "จองเพิ่ม" before paying: new stays join the same booking (same Booking ID, guest details and dates).
let seq = 0;
const key = () => `add-key-${String(++seq).padStart(10, "0")}`;
const PHONE = "0812345678";
type Stay = Record<string, unknown>;
const house1: Stay = { kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0 };
const house2: Stay = { kind: "UNIT", unitId: "dev_house_02", adults: 2, children: 1 };
const vip1: Stay = { kind: "UNIT", unitId: "dev_vip_01", adults: 2, children: 0 };
const camp2: Stay = { kind: "CAMPING", tents: 2, adults: 3, children: 0 };
const DATES = { checkIn: "2027-02-01", checkOut: "2027-02-03" };

function setup() {
  const h = new Harness({ seed: true });
  const body = (stays: Stay[], over: Record<string, unknown> = {}) => ({ ...DATES, stays, food: [], lang: "th", ...over });
  const quote = async (stays: Stay[], over: Record<string, unknown> = {}) => {
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: body(stays, over) });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    return q.data;
  };
  const book = async (stays: Stay[], phone = PHONE) => {
    const q = await quote(stays);
    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body(stays), customer: { name: "Somchai Jaidee", phone, email: "somchai@example.test" }, privacyAccepted: true, expectedTotalSatang: q.totalSatang, idempotencyKey: key() },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.data;
  };
  const add = async (b: PublicBookingDto, stays: Stay[], over: Record<string, unknown> = {}, idem = key()) => {
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: body(stays, over) });
    return h.api<PublicBookingDto>("POST", "/api/public/bookings/add-stays", {
      body: { ...body(stays, over), bookingCode: b.bookingCode, phone: PHONE, expectedTotalSatang: q.data?.totalSatang ?? 0, idempotencyKey: idem },
    });
  };
  return { h, quote, book, add };
}

describe("guest adds stays to an unpaid booking", () => {
  it("the new stay joins the same booking: one Booking ID, the guest's details, the new total", async () => {
    const { h, quote, book, add } = setup();
    const b = await book([house1]);
    const extra = await quote([house2]);
    const res = await add(b, [house2]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const after = res.data;
    assert.equal(after.bookingCode, b.bookingCode);
    assert.equal(after.customerName, "Somchai Jaidee");
    assert.equal(after.status, "PENDING");
    assert.equal(after.totalSatang, b.totalSatang + extra.totalSatang);
    assert.deepEqual(after.items.map((i) => i.unitId), ["dev_house_01", "dev_house_02"]);
    assert.equal(after.adults, 4);
    assert.equal(after.children, 1);
    assert.equal(after.paymentInstructions?.amountDueSatang, after.totalSatang, "the guest pays the new total");
    assert.equal(after.expiresAt, b.expiresAt, "the same time to pay");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 1, "no second booking");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE unit_id = 'dev_house_02' AND booking_id IS NOT NULL")!.n, 2, "nights held");
    // The booking's own record adds up (database CHECKs held).
    const row = h.db.get<{ s: number; t: number; a: number; f: number }>("SELECT subtotal_satang AS s, total_satang AS t, accommodation_subtotal_satang AS a, food_subtotal_satang AS f FROM bookings")!;
    assert.equal(row.t, after.totalSatang);
    assert.equal(row.s, row.a + row.f);
  });

  it("camping and a VIP tent can be added too; the same house or a second camping cannot", async () => {
    const { book, add } = setup();
    const b = await book([house1]);
    assert.equal((await add(b, [vip1, camp2])).status, 201);
    assert.equal((await add(b, [camp2])).error?.code, "CAMPING_ALREADY_BOOKED");
    assert.equal((await add(b, [house1])).error?.code, "UNIT_ALREADY_BOOKED");
  });

  it("food for the added stay joins the same kitchen order; a deposit is worked out again", async () => {
    const { h, add, quote } = setup();
    h.db.run("UPDATE accommodation_units SET payment_mode = 'DEPOSIT_50' WHERE id = 'dev_house_02'");
    const dinner = (adults: number) => [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults }];
    const q1 = await quote([house1], { food: dinner(2) });
    const b = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...DATES, stays: [house1], food: dinner(2), lang: "th", customer: { name: "Somchai Jaidee", phone: PHONE, email: "s@example.test" }, privacyAccepted: true, expectedTotalSatang: q1.totalSatang, idempotencyKey: key() },
    });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.data.depositSatang, null, "house 01 is paid in full");
    const res = await add(b.data, [house2], { food: dinner(2) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const orders = h.db.all<{ total_persons: number }>(
      "SELECT o.total_persons FROM food_orders o WHERE o.service_date = '2027-02-01' AND o.food_category_id = (SELECT food_category_id FROM food_options WHERE id = 'dev_food_dinner_a')");
    assert.deepEqual(orders.map((o) => o.total_persons), [4], "one dinner order: 2 + 2 people");
    // Every kitchen order is still one per meal and day (UNIQUE held).
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) - COUNT(DISTINCT food_category_id || service_date) AS n FROM food_orders")!.n, 0);
    assert.ok(res.data.depositSatang !== null && res.data.depositSatang < res.data.totalSatang, "half of house 02 is left for check-in");
    assert.equal(res.data.paymentInstructions?.amountDueSatang, res.data.depositSatang);
  });

  it("only on the booking's own dates", async () => {
    const { book, add } = setup();
    const b = await book([house1]);
    const res = await add(b, [house2], { checkIn: "2027-02-05", checkOut: "2027-02-06" });
    assert.equal(res.status, 422);
    assert.equal(res.error?.details?.checkIn, "SAME_DATES_ONLY");
  });

  it("a double click adds the stays once", async () => {
    const { h, book, add } = setup();
    const b = await book([house1]);
    const idem = key();
    const first = await add(b, [house2], {}, idem);
    const again = await add(b, [house2], {}, idem);
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.data.totalSatang, first.data.totalSatang);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_items")!.n, 2);
  });

  it("taken by someone else meanwhile: refused, the booking stays as it was", async () => {
    const { h, book, add } = setup();
    const b = await book([house1]);
    await book([house2], "0899999999");
    const res = await add(b, [house2]);
    assert.equal(res.status, 409);
    assert.equal(res.error?.code, "UNIT_UNAVAILABLE");
    assert.equal(h.db.get<{ t: number }>("SELECT total_satang AS t FROM bookings WHERE booking_code = ?", b.bookingCode)!.t, b.totalSatang);
  });

  it("not once a slip was sent, nor after the time to pay ran out, nor with the wrong phone", async () => {
    const { h, book, add } = setup();
    const b = await book([house1]);
    const slip = await h.slip(b.bookingCode, PHONE, { bytes: pngBytes(600, 900), name: "slip.png", type: "image/png" });
    assert.equal(slip.status, 201, JSON.stringify(slip.error ?? null));
    assert.equal((await add(b, [house2])).error?.code, "BOOKING_NOT_ADDABLE");

    const c = await book([vip1], "0811111111");
    h.advance(2 * 60 * 60_000); // past the hold
    const late = await h.api("POST", "/api/public/bookings/add-stays", {
      body: { ...DATES, stays: [house2], food: [], lang: "th", bookingCode: c.bookingCode, phone: "0811111111", expectedTotalSatang: 1, idempotencyKey: key() },
    });
    assert.equal(late.error?.code, "BOOKING_NOT_ADDABLE");
    const wrong = await h.api("POST", "/api/public/bookings/add-stays", {
      body: { ...DATES, stays: [house2], food: [], lang: "th", bookingCode: b.bookingCode, phone: "0899999999", expectedTotalSatang: 1, idempotencyKey: key() },
    });
    assert.equal(wrong.status, 404);
  });

  it("a changed price is told before anything is added", async () => {
    const { h, book } = setup();
    const b = await book([house1]);
    const res = await h.api("POST", "/api/public/bookings/add-stays", {
      body: { ...DATES, stays: [house2], food: [], lang: "th", bookingCode: b.bookingCode, phone: PHONE, expectedTotalSatang: 1, idempotencyKey: key() },
    });
    assert.equal(res.error?.code, "PRICE_CHANGED");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_items")!.n, 1);
  });

  it("the batch stops if the booking changed between reading it and adding (guard)", async () => {
    const { h, book } = setup();
    const b = await book([house1]);
    const id = h.db.get<{ id: string }>("SELECT id FROM bookings")!.id;
    await assert.rejects(
      h.env.DB.prepare("INSERT INTO batch_guards (reason) SELECT 'X' WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE id = ?1 AND updated_at = 'old')").bind(id).run(),
      /BATCH_GUARD/,
    );
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM batch_guards")!.n, 0);
    void b;
  });

  it("staff (LINE + e-mail) and the guest (e-mail) hear about the added stays, once", async () => {
    const { h, book, add } = setup();
    h.env.APP_BASE_URL = "https://phasakura.test";
    const root = await h.login(await h.user({ id: "root_add_n", roles: ["SUPER_ADMIN"] }));
    h.lineSecrets();
    h.db.run("UPDATE line_settings SET enabled = 1");
    assert.equal((await h.api("POST", "/api/admin/line/recipients", { token: root,
      body: { targetId: `C${"7a".repeat(16)}`, name: "Owners", language: "th", notifyBooking: true } })).status, 201);
    h.emailKey();
    await h.api("PUT", "/api/admin/email/settings", { token: root, body: { enabled: true, guestEnabled: true, fromEmail: "booking@phasakura.test" } });
    assert.equal((await h.api("POST", "/api/admin/email/recipients", { token: root, body: { email: "owner@phasakura.test", name: "Owner", language: "th" } })).status, 201);

    const b = await book([house1]);
    const idem = key();
    const res = await add(b, [house2], {}, idem);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await add(b, [house2], {}, idem)).status, 200, "replayed");
    const count = (table: string, type: string) => h.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE notification_type = ?`, type)!.n;
    assert.equal(count("notification_logs", "STAYS_ADDED"), 1);
    assert.equal(count("email_logs", "STAYS_ADDED"), 1);
    assert.equal(count("email_logs", "GUEST_STAYS_ADDED"), 1);

    h.advance(2 * 60_000);
    await h.app.scheduled(h.env);
    const pushed = JSON.stringify(h.line.pushes);
    assert.match(pushed, /ลูกค้าเพิ่มที่พักในการจอง/);
    assert.match(pushed, /House 02/);
    assert.ok(pushed.includes(b.bookingCode));
    const staffMail = h.resend.requests.find((r) => /ลูกค้าเพิ่มที่พักในการจอง/.test(String(r.json!.subject)));
    assert.ok(staffMail, h.resend.requests.map((r) => r.json!.subject).join(" | "));
    const guestMail = h.resend.requests.find((r) => /เพิ่มที่พักในการจอง .* แล้ว/.test(String(r.json!.subject)));
    assert.ok(guestMail, h.resend.requests.map((r) => r.json!.subject).join(" | "));
    assert.equal((guestMail!.json!.to as string[])[0], "somchai@example.test");
    const text = String(guestMail!.json!.text);
    assert.match(text, /House 01/);
    assert.match(text, /House 02/);
    assert.ok(text.includes((res.data.totalSatang / 100).toLocaleString("en-US")), "the new amount");
  });

  it("a refused addition sends nothing", async () => {
    const { h, book, add } = setup();
    const root = await h.login(await h.user({ id: "root_add_x", roles: ["SUPER_ADMIN"] }));
    h.emailKey();
    await h.api("PUT", "/api/admin/email/settings", { token: root, body: { enabled: true, guestEnabled: true, fromEmail: "booking@phasakura.test" } });
    const b = await book([house1]);
    await book([house2], "0899999999");
    assert.equal((await add(b, [house2])).status, 409);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_logs WHERE notification_type LIKE '%STAYS_ADDED'")!.n, 0);
  });
});
