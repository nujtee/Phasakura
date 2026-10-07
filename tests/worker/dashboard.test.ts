import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { AdminPaymentListItemDto, BookingSettingsDto, CalendarDto, DashboardDto } from "../../src/shared/dashboard-types.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10T03:00Z = 10:00 in Bangkok → today is 2027-01-10.
let seq = 0;
const key = () => `dash-key-${String(++seq).padStart(10, "0")}`;

async function staff(h: Harness, perms: string[]) {
  const id = `dash_staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

async function book(h: Harness, body: Record<string, unknown>, phone = "0812345678") {
  const full = { adults: 2, children: 0, food: [], lang: "th", ...body };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: full });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...full, customer: { name: "Guest Name", phone }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function pay(h: Harness, token: string, b: PublicBookingDto) {
  const res = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, {
    token, body: { amountSatang: b.totalSatang, method: "CASH", paidAt: "2027-01-10T02:00:00Z" },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

const house = (unitId: string, checkIn: string, checkOut: string) => ({ checkIn, checkOut, stay: { kind: "UNIT", unitId } });

describe("admin dashboard (spec §48)", () => {
  it("counts today's arrivals, tonight's inventory and confirmed revenue from D1", async () => {
    const h = new Harness({ seed: true });
    const admin = await staff(h, ["dashboard.view", "bookings.view", "payments.view", "payments.verify"]);

    const paid = await book(h, house("dev_house_01", "2027-01-10", "2027-01-12"));
    await pay(h, admin, paid);
    const pending = await book(h, house("dev_vip_01", "2027-01-10", "2027-01-11"), "0899999999");
    const camping = await book(h, { checkIn: "2027-01-10", checkOut: "2027-01-11", adults: 3, stay: { kind: "CAMPING", tents: 3 } }, "0877777777");
    await pay(h, admin, camping);
    await book(h, house("dev_house_02", "2027-02-01", "2027-02-02"), "0866666666");

    const res = await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: admin });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.data;
    assert.equal(d.date, "2027-01-10");
    assert.equal(d.monthStart, "2027-01-01");
    assert.equal(d.counts.checkInsToday, 3);
    assert.equal(d.counts.bookingsCreatedToday, 4);
    assert.equal(d.counts.pendingPayment, 2);
    assert.equal(d.inventory.houses.available, d.inventory.houses.total - 1);
    assert.equal(d.inventory.vip.available, d.inventory.vip.total - 1);
    assert.deepEqual(d.inventory.camping, { enabled: true, max: 30, used: 3, remaining: 27 });
    assert.deepEqual(d.arrivals?.map((a) => a.bookingCode).sort(), [paid.bookingCode, pending.bookingCode, camping.bookingCode].sort());

    const expected = paid.totalSatang + camping.totalSatang;
    assert.equal(d.money?.month.totalSatang, expected, "only paid + confirmed bookings count as revenue");
    assert.equal(d.money?.month.bookings, 2);
    assert.equal(d.money?.today.totalSatang, expected);
    assert.equal(d.money!.month.accommodationSatang + d.money!.month.foodSatang, expected);
    assert.equal(d.money?.pendingPaymentSatang, pending.totalSatang + (await bookingTotal(h, admin, "0866666666")));
    assert.equal(d.money?.trend.length, 14);
    assert.equal(d.money?.trend.at(-1)?.date, "2027-01-10");
    assert.equal(d.money?.trend.at(-1)?.bookings, 4);
    assert.equal(d.analytics.confirmedBookings, 2);
    assert.equal(d.analytics.visitors, null, "web analytics come from GA4, not D1");
  });

  it("hides customer names and money from users without those permissions", async () => {
    const h = new Harness({ seed: true });
    await book(h, house("dev_house_01", "2027-01-10", "2027-01-11"));
    const content = await staff(h, ["dashboard.view"]);
    const d = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: content })).data;
    assert.equal(d.counts.checkInsToday, 1);
    assert.equal(d.arrivals, null);
    assert.equal(d.departures, null);
    assert.equal(d.money, null);
    assert.equal(d.analytics.revenueSatang, null);
    assert.equal(JSON.stringify(d).includes("Guest Name"), false);

    const nobody = await staff(h, []);
    assert.equal((await h.api("GET", "/api/admin/dashboard", { token: nobody })).status, 403);
    assert.equal((await h.api("GET", "/api/admin/dashboard")).status, 401);
  });
});

async function bookingTotal(h: Harness, _token: string, phone: string): Promise<number> {
  const row = h.db.get<{ total_satang: number }>("SELECT total_satang FROM bookings WHERE customer_phone_normalized = ?", phone);
  return row?.total_satang ?? 0;
}

describe("booking calendar (spec §49)", () => {
  it("shows every stay night of multi-night bookings, blocks and camping per night", async () => {
    const h = new Harness({ seed: true });
    const viewer = await staff(h, ["calendar.view", "bookings.view"]);
    const b = await book(h, house("dev_house_01", "2027-01-11", "2027-01-14"));
    await book(h, { checkIn: "2027-01-12", checkOut: "2027-01-13", adults: 2, stay: { kind: "CAMPING", tents: 2 } }, "0877777777");

    const res = await h.api<CalendarDto>("GET", "/api/admin/calendar?from=2027-01-10&to=2027-01-17", { token: viewer });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const c = res.data;
    assert.equal(c.dates.length, 7);
    const nights = c.nights.filter((n) => n.bookingCode === b.bookingCode).map((n) => n.date);
    assert.deepEqual(nights, ["2027-01-11", "2027-01-12", "2027-01-13"], "check-out day is not a night");
    const cal = c.bookings.find((x) => x.bookingCode === b.bookingCode)!;
    assert.equal(cal.customerName, "Guest Name");
    assert.equal(cal.nights, 3);
    assert.equal(c.camping.nights.find((n) => n.date === "2027-01-12")?.used, 2);
    assert.equal(c.camping.nights.find((n) => n.date === "2027-01-13")?.used, 0);
    assert.ok(c.units.some((u) => u.id === "dev_house_01" && u.names.th));

    const calOnly = await staff(h, ["calendar.view"]);
    const limited = (await h.api<CalendarDto>("GET", "/api/admin/calendar?from=2027-01-10&to=2027-01-17", { token: calOnly })).data;
    assert.equal(limited.bookings[0]?.customerName, null);
    assert.equal(limited.bookings[0]?.totalSatang, null);

    const tooLong = await h.api("GET", "/api/admin/calendar?from=2027-01-01&to=2027-06-01", { token: viewer });
    assert.equal(tooLong.error?.details?.to, "RANGE_TOO_LONG");
    const bad = await h.api("GET", "/api/admin/calendar?from=2027-02-30&to=2027-03-02", { token: viewer });
    assert.equal(bad.error?.details?.from, "INVALID_DATE");
  });
});

describe("stay lifecycle: check-in / check-out / no-show", () => {
  it("moves only along the allowed path; the database refuses anything else", async () => {
    const h = new Harness({ seed: true });
    const admin = await staff(h, ["bookings.view", "bookings.edit", "payments.verify"]);
    const today = await book(h, house("dev_house_01", "2027-01-10", "2027-01-12"));
    const pending = await book(h, house("dev_vip_01", "2027-01-10", "2027-01-11"), "0899999999");
    const future = await book(h, house("dev_house_02", "2027-01-20", "2027-01-21"), "0866666666");
    await pay(h, admin, today);
    await pay(h, admin, future);

    const notPaid = await h.api("POST", `/api/admin/bookings/${pending.bookingCode}/stay/check-in`, { token: admin });
    assert.equal(notPaid.error?.code, "BOOKING_STATUS_INVALID");
    const early = await h.api("POST", `/api/admin/bookings/${future.bookingCode}/stay/check-in`, { token: admin });
    assert.equal(early.error?.code, "STAY_NOT_STARTED");
    const earlyNoShow = await h.api("POST", `/api/admin/bookings/${future.bookingCode}/stay/no-show`, { token: admin });
    assert.equal(earlyNoShow.error?.code, "STAY_NOT_STARTED");

    const viewer = await staff(h, ["bookings.view"]);
    assert.equal((await h.api("POST", `/api/admin/bookings/${today.bookingCode}/stay/check-in`, { token: viewer })).status, 403);

    const inRes = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${today.bookingCode}/stay/check-in`, { token: admin });
    assert.equal(inRes.status, 200, JSON.stringify(inRes.body));
    assert.equal(inRes.data.status, "CHECKED_IN");
    const again = await h.api("POST", `/api/admin/bookings/${today.bookingCode}/stay/check-in`, { token: admin });
    assert.equal(again.error?.code, "BOOKING_STATUS_INVALID");
    const outRes = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${today.bookingCode}/stay/check-out`, { token: admin });
    assert.equal(outRes.data.status, "CHECKED_OUT");
    assert.equal(h.audits("CHECK_IN").length, 1);
    assert.equal(h.audits("CHECK_OUT").length, 1);
    assert.equal((await h.api("POST", `/api/admin/bookings/${today.bookingCode}/stay/teleport`, { token: admin })).status, 404);

    // DB-level guard (migration 0015): no way back from a final state, even with direct SQL.
    assert.throws(() => h.db.run("UPDATE bookings SET booking_status = 'CONFIRMED' WHERE booking_code = ?", today.bookingCode), /BOOKING_STATUS_TRANSITION/);
    assert.throws(() => h.db.run("UPDATE bookings SET booking_status = 'CHECKED_IN' WHERE booking_code = ?", pending.bookingCode), /BOOKING_STATUS_TRANSITION/);
    // Cancelling a checked-out stay is refused (service + trigger).
    const cancel = await h.api("POST", `/api/admin/bookings/${today.bookingCode}/cancel`, { token: admin, body: { reason: "test reason" } });
    assert.equal(cancel.status, 403, "bookings.cancel not granted");
  });
});

describe("payments list and booking settings", () => {
  it("lists payments with filters and keeps booking settings editable only with settings.website", async () => {
    const h = new Harness({ seed: true });
    const admin = await staff(h, ["payments.view", "payments.verify", "bookings.view"]);
    const b1 = await book(h, house("dev_house_01", "2027-01-15", "2027-01-16"));
    const b2 = await book(h, house("dev_house_02", "2027-01-15", "2027-01-16"), "0899999999");
    await pay(h, admin, b1);
    await pay(h, admin, b2);
    const all = await h.api<{ items: AdminPaymentListItemDto[] }>("GET", "/api/admin/payments", { token: admin });
    assert.equal(all.data.items.length, 2);
    const one = await h.api<{ items: AdminPaymentListItemDto[] }>("GET", `/api/admin/payments?code=${b1.bookingCode}`, { token: admin });
    assert.deepEqual(one.data.items.map((p) => p.bookingCode), [b1.bookingCode]);
    const paged = await h.api<{ items: AdminPaymentListItemDto[]; nextCursor: string }>("GET", "/api/admin/payments?limit=1", { token: admin });
    assert.equal(paged.data.items.length, 1);
    assert.ok(paged.data.nextCursor);
    assert.equal((await h.api("GET", "/api/admin/payments?status=NOPE", { token: admin })).status, 422);
    assert.equal((await h.api("GET", "/api/admin/payments?evil=1", { token: admin })).error?.details?.evil, "UNKNOWN_FIELD");

    const settings = await h.api<BookingSettingsDto>("GET", "/api/admin/booking-settings", { token: admin });
    assert.equal(settings.data.holdMinutes, 60);
    const denied = await h.api("PUT", "/api/admin/booking-settings", { token: admin, body: { holdMinutes: 30, maxNights: 30, maxAdvanceDays: 365, maxTentsPerBooking: 10 } });
    assert.equal(denied.status, 403);

    const web = await staff(h, ["settings.website"]);
    const bad = await h.api("PUT", "/api/admin/booking-settings", { token: web, body: { holdMinutes: 1, maxNights: 30, maxAdvanceDays: 365, maxTentsPerBooking: 10 } });
    assert.equal(bad.error?.details?.holdMinutes, "OUT_OF_RANGE");
    const ok = await h.api<BookingSettingsDto>("PUT", "/api/admin/booking-settings", { token: web, body: { holdMinutes: 30, maxNights: 14, maxAdvanceDays: 200, maxTentsPerBooking: 5 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.data.holdMinutes, 30);
    assert.equal(h.audits("UPDATE_BOOKING_SETTINGS").length, 1);

    // New holds use the new time.
    const b3 = await book(h, house("dev_vip_02", "2027-01-15", "2027-01-16"), "0855555555");
    assert.equal(b3.expiresAt, "2027-01-10T03:30:00.000Z");
  });
});
