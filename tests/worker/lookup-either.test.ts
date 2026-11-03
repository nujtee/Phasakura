import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskGuestName, type BookingFindDto, type PublicBookingDto, type QuoteDto } from "../../src/shared/booking-types.ts";
import { BOOKING_LIMITS } from "../../src/worker/services/booking.service.ts";
import { Harness } from "../helpers/harness.ts";

// Look-up with ONE of Booking ID / phone: status and dates only; both together open the booking.
let seq = 0;
const PHONE = "0812345678";

async function book(h: Harness, unitId: string) {
  const body = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, stay: { kind: "UNIT", unitId }, food: [], lang: "th" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer: { name: "Somchai Jaidee", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `either-${String(++seq).padStart(10, "0")}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

const find = (h: Harness, body: Record<string, string>) => h.api<BookingFindDto>("POST", "/api/public/bookings/find", { body });

describe("booking look-up with Booking ID or phone", () => {
  it("Booking ID alone: the booking's status and dates, masked name, no phone or money", async () => {
    const h = new Harness({ seed: true });
    const b = await book(h, "dev_house_01");
    const res = await find(h, { bookingCode: b.bookingCode.toLowerCase() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.by, "CODE");
    assert.deepEqual(res.data.bookings, [{
      bookingCode: b.bookingCode, bookingCodeMasked: b.bookingCode.slice(0, -4) + "••••", status: "PENDING", paymentStatus: "UNPAID",
      checkIn: "2027-02-01", checkOut: "2027-02-03", guestNameMasked: "S••• J•••",
    }]);
    const text = JSON.stringify(res.body);
    for (const secret of ["Somchai", "5678", "totalSatang", "paymentInstructions"]) assert.equal(text.includes(secret), false, secret);
  });

  it("phone alone: that number's upcoming bookings with the Booking ID masked", async () => {
    const h = new Harness({ seed: true });
    const a = await book(h, "dev_house_01");
    await book(h, "dev_house_02");
    const res = await find(h, { phone: "081-234-5678" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.by, "PHONE");
    assert.equal(res.data.bookings.length, 2);
    assert.ok(res.data.bookings.every((x) => x.bookingCode === null && x.bookingCodeMasked.endsWith("-••••")));
    assert.equal(JSON.stringify(res.body).includes(a.bookingCode), false, "the full Booking ID is never shown");
    const none = await find(h, { phone: "0899999999" });
    assert.equal(none.status, 200);
    assert.deepEqual(none.data, { by: "PHONE", bookings: [] });
    // The number is never stored in the log, only a hash.
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_events WHERE identifier LIKE '%5678%'")!.n, 0);
  });

  it("a wrong Booking ID is not found and counts toward the look-up throttle", async () => {
    const h = new Harness({ seed: true });
    for (let i = 0; i < BOOKING_LIMITS.lookupFailuresPerCode; i++) {
      assert.equal((await find(h, { bookingCode: "BK-20270110-ZZZZ" })).status, 404);
    }
    assert.equal((await find(h, { bookingCode: "BK-20270110-ZZZZ" })).status, 429);
  });

  it("phone look-ups are limited per hour; an empty request is refused", async () => {
    const h = new Harness({ seed: true });
    for (let i = 0; i < BOOKING_LIMITS.phoneFindsPerPhonePerHour; i++) assert.equal((await find(h, { phone: PHONE })).status, 200);
    assert.equal((await find(h, { phone: PHONE })).status, 429);
    assert.equal((await find(h, {})).status, 422);
    assert.equal((await find(h, { phone: "12" })).status, 422);
  });

  it("both together still open the full booking", async () => {
    const h = new Harness({ seed: true });
    const b = await book(h, "dev_house_01");
    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: PHONE } });
    assert.equal(res.status, 200);
    assert.equal(res.data.customerName, "Somchai Jaidee");
  });

  it("masks names letter by letter (Thai too)", () => {
    assert.equal(maskGuestName("สมชาย ใจดี"), "ส••• ใ•••");
    assert.equal(maskGuestName("  Ann  "), "A•••");
  });
});
