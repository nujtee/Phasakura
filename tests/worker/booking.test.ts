import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FoodCatalogueDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { normalizePhone } from "../../src/shared/booking-types.ts";
import { childUnitPrice, nightPrice } from "../../src/worker/services/quote.service.ts";
import { generateBookingCode } from "../../src/worker/services/booking.service.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10T03:00Z = 10:00 in Bangkok. 2027-02-01 is a Monday.
const HOUSE = "dev_house_01"; // 3,500 THB, max 4 guests, breakfast A included for 2 persons/night

let keySeq = 0;
function key() {
  keySeq += 1;
  return `test-key-${String(keySeq).padStart(8, "0")}`;
}

function stayBody(over: Record<string, unknown> = {}) {
  return {
    checkIn: "2027-02-01",
    checkOut: "2027-02-03",
    adults: 2,
    children: 1,
    stay: { kind: "UNIT", unitId: HOUSE },
    food: [],
    lang: "en",
    ...over,
  };
}

async function quote(h: Harness, over: Record<string, unknown> = {}) {
  return h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: stayBody(over) });
}

async function book(h: Harness, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const q = await quote(h, over);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  return h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: {
      ...stayBody(over),
      customer: { name: "Somchai Guest", phone: "081-234-5678", email: "guest@example.test" },
      privacyAccepted: true,
      expectedTotalSatang: q.data.totalSatang,
      idempotencyKey: key(),
      ...extra,
    },
  });
}

async function admin(h: Harness, perms: string[]) {
  const id = `staff_${keySeq++}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

describe("pricing engine (pure)", () => {
  const rule = (o: Partial<Parameters<typeof nightPrice>[0][number]>) => ({
    id: "r", target_type: "UNIT_TYPE" as const, unit_id: null, unit_type: "HOUSE" as const, name: "x",
    date_from: "2027-01-01", date_to: "2027-12-31", days_of_week: "0123456", price_satang: 1, priority: 0,
    status: "ACTIVE" as const, created_at: "", updated_at: "2027-01-01", ...o,
  });

  it("falls back to the base price, honours weekdays, priority and specificity", () => {
    assert.equal(nightPrice([], "2027-02-05", 350000), 350000);
    const weekend = rule({ id: "w", days_of_week: "56", price_satang: 450000 });
    assert.equal(nightPrice([weekend], "2027-02-05", 350000), 450000); // Friday
    assert.equal(nightPrice([weekend], "2027-02-04", 350000), 350000); // Thursday
    const unitRule = rule({ id: "u", target_type: "UNIT", unit_id: "x", unit_type: null, price_satang: 400000 });
    assert.equal(nightPrice([weekend, unitRule], "2027-02-05", 1), 400000, "same priority → unit beats unit type");
    const promo = rule({ id: "p", priority: 10, price_satang: 300000 });
    assert.equal(nightPrice([weekend, unitRule, promo], "2027-02-05", 1), 300000, "higher priority wins");
    assert.equal(nightPrice([rule({ date_to: "2027-02-04", price_satang: 9 })], "2027-02-05", 7), 7, "outside range");
  });

  it("prices child portions", () => {
    assert.equal(childUnitPrice({ child_pricing: "FREE", price_satang: 15000, child_price_satang: null }), 0);
    assert.equal(childUnitPrice({ child_pricing: "HALF", price_satang: 15001, child_price_satang: null }), 7501);
    assert.equal(childUnitPrice({ child_pricing: "SPECIAL_PRICE", price_satang: 15000, child_price_satang: 5000 }), 5000);
    assert.equal(childUnitPrice({ child_pricing: "FULL", price_satang: 15000, child_price_satang: null }), null);
  });

  it("generates BK-YYYYMMDD-XXXX codes and normalises phones", () => {
    assert.match(generateBookingCode("2027-01-10"), /^BK-20270110-[A-Z0-9]{4}$/);
    assert.equal(normalizePhone("081-234-5678"), "0812345678");
    assert.equal(normalizePhone("+66 81 234 5678"), "0812345678");
    assert.equal(normalizePhone("+1 (415) 555-0100"), "+14155550100");
    assert.equal(normalizePhone("abc"), null);
    assert.equal(normalizePhone("12"), null);
  });
});

describe("quote", () => {
  it("prices a house stay with included breakfast (next morning) and extra food", async () => {
    const h = new Harness({ seed: true });
    const res = await quote(h, {
      food: [
        { optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 2, children: 1 },
        { optionId: "dev_food_breakfast_b", serviceDate: "2027-02-02", children: 1 },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const q = res.data;
    assert.equal(q.nights, 2);
    assert.deepEqual(q.item.nightly, [{ date: "2027-02-01", priceSatang: 350000 }, { date: "2027-02-02", priceSatang: 350000 }]);
    assert.equal(q.item.name, "House 01 — Sakura House");
    assert.deepEqual(q.includedMeals, [{ categoryCode: "BREAKFAST", name: "Breakfast A", personsPerNight: 2, nights: 2 }]);
    const included = q.food.filter((f) => f.includedQuantity > 0);
    assert.deepEqual(included.map((f) => [f.serviceDate, f.quantity, f.subtotalSatang]), [["2027-02-02", 2, 0], ["2027-02-03", 2, 0]]);
    const dinner = q.food.find((f) => f.optionId === "dev_food_dinner_a")!;
    assert.equal(dinner.subtotalSatang, 3 * 25000, "dinner: child pays full");
    const bb = q.food.find((f) => f.optionId === "dev_food_breakfast_b")!;
    assert.equal(bb.subtotalSatang, 9000, "breakfast: child pays half");
    assert.equal(q.accommodationSubtotalSatang, 700000);
    assert.equal(q.foodSubtotalSatang, 84000);
    assert.equal(q.totalSatang, 784000);
  });

  it("caps included meals at the number of guests", async () => {
    const h = new Harness({ seed: true });
    const res = await quote(h, { adults: 1, children: 0 });
    assert.equal(res.data.includedMeals[0]!.personsPerNight, 1);
  });

  it("applies pricing rules per night", async () => {
    const h = new Harness({ seed: true });
    h.db.run(`INSERT INTO pricing_settings (id, target_type, unit_type, name, date_from, date_to, days_of_week, price_satang)
              VALUES ('weekend', 'UNIT_TYPE', 'HOUSE', 'Weekend', '2027-01-01', '2027-12-31', '56', 450000)`);
    const res = await quote(h, { checkIn: "2027-02-04", checkOut: "2027-02-07" }); // Thu, Fri, Sat
    assert.deepEqual(res.data.item.nightly.map((n) => n.priceSatang), [350000, 450000, 450000]);
    assert.equal(res.data.accommodationSubtotalSatang, 1250000);
  });

  it("prices camping per adult per night; children are free", async () => {
    const h = new Harness({ seed: true });
    const res = await quote(h, { stay: { kind: "CAMPING", tents: 2 }, adults: 3, children: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.item.type, "OWN_TENT");
    assert.equal(res.data.item.quantity, 2);
    assert.equal(res.data.accommodationSubtotalSatang, 3 * 2 * 25000);
  });

  it("enforces guest limits, stay rules and tents per guests", async () => {
    const h = new Harness({ seed: true });
    assert.equal((await quote(h, { adults: 4, children: 1 })).error?.details?.guests, "EXCEEDS_MAX_GUESTS");
    assert.equal((await quote(h, { checkIn: "2027-01-09", checkOut: "2027-01-11" })).error?.details?.checkIn, "IN_THE_PAST");
    assert.equal((await quote(h, { checkOut: "2027-02-01" })).error?.details?.checkOut, "MUST_BE_AFTER_CHECK_IN");
    assert.equal((await quote(h, { adults: 0 })).error?.details?.adults, "OUT_OF_RANGE");
    h.db.run("UPDATE camping_settings SET max_guests_per_tent = 2");
    assert.equal((await quote(h, { stay: { kind: "CAMPING", tents: 1 }, adults: 3, children: 0 })).error?.details?.guests, "TOO_MANY_PER_TENT");
    assert.equal((await quote(h, { stay: { kind: "CAMPING", tents: 11 } })).error?.details?.tents, "OUT_OF_RANGE");
    assert.equal((await quote(h, { stay: { kind: "UNIT", unitId: "nope" } })).status, 404);
    h.db.run("UPDATE camping_settings SET is_enabled = 0");
    assert.equal((await quote(h, { stay: { kind: "CAMPING", tents: 1 } })).error?.code, "CAMPING_UNAVAILABLE");
  });

  it("rejects food outside the stay, past its deadline, duplicated, or for more people than booked", async () => {
    const h = new Harness({ seed: true });
    const err = async (food: unknown[], over: Record<string, unknown> = {}) =>
      (await quote(h, { ...over, food })).error?.details?.["food.0"];
    assert.equal(await err([{ optionId: "dev_food_breakfast_a", serviceDate: "2027-02-01", adults: 1 }]), "DATE_OUTSIDE_STAY", "no breakfast on arrival morning");
    assert.equal(await err([{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-03", adults: 1 }]), "DATE_OUTSIDE_STAY", "no dinner on check-out day");
    assert.equal(await err([{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 3 }]), "MORE_THAN_GUESTS");
    assert.equal(await err([{ optionId: "missing", serviceDate: "2027-02-01", adults: 1 }]), "OPTION_UNAVAILABLE");
    // Stay starting today: dinner needs 1 day notice.
    assert.equal(
      await err([{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-10", adults: 1 }], { checkIn: "2027-01-10", checkOut: "2027-01-11" }),
      "DEADLINE_PASSED",
    );
    const dup = await quote(h, { food: [
      { optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 1 },
      { optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 1 },
    ] });
    assert.equal(dup.error?.details?.["food.1"], "DUPLICATE");
  });

  it("food catalogue shows service dates, deadlines and remaining portions", async () => {
    const h = new Harness({ seed: true });
    // Breakfast for the night of 01-10 is served 01-11; the deadline is 01-10 18:00 (it is 10:00 now).
    const res = await h.api<FoodCatalogueDto>("GET", "/api/public/food-options?checkIn=2027-01-10&checkOut=2027-01-12&lang=th");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const breakfast = res.data.categories.find((c) => c.code === "BREAKFAST")!;
    assert.equal(breakfast.name, "อาหารเช้า");
    assert.deepEqual(breakfast.dates.map((d) => [d.date, d.orderable, d.remaining]), [["2027-01-11", true, 60], ["2027-01-12", true, 60]]);
    const dinner = res.data.categories.find((c) => c.code === "DINNER")!;
    assert.deepEqual(dinner.dates.map((d) => [d.date, d.orderable]), [["2027-01-10", false], ["2027-01-11", true]]);
    assert.equal(res.data.categories.some((c) => c.code === "OTHER"), false, "categories without options are hidden");
    h.advance(9 * 3600_000); // 19:00 Bangkok → breakfast for 01-11 closed
    const later = await h.api<FoodCatalogueDto>("GET", "/api/public/food-options?checkIn=2027-01-10&checkOut=2027-01-12");
    assert.equal(later.data.categories.find((c) => c.code === "BREAKFAST")!.dates[0]!.orderable, false);
  });
});

describe("booking creation", () => {
  it("creates a PENDING hold atomically with snapshots, night-locks and kitchen orders", async () => {
    const h = new Harness({ seed: true });
    const res = await book(h, { food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 2 }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const b = res.data;
    assert.match(b.bookingCode, /^BK-20270110-[A-Z0-9]{4}$/);
    assert.equal(b.status, "PENDING");
    assert.equal(b.paymentStatus, "UNPAID");
    assert.equal(b.customerPhoneMasked, "•••• 5678");
    assert.equal(b.expiresAt, "2027-01-10T04:00:00.000Z", "default 60-minute hold");
    assert.equal(b.totalSatang, 700000 + 50000);
    assert.equal(JSON.stringify(b).includes("guest@example.test"), false, "public DTO has no e-mail");
    assert.equal(res.headers.get("Cache-Control"), "no-store");

    const row = h.db.get<{ id: string; idempotency_key: string; privacy_accepted_at: string; customer_phone_normalized: string }>(
      "SELECT id, idempotency_key, privacy_accepted_at, customer_phone_normalized FROM bookings WHERE booking_code = ?", b.bookingCode)!;
    assert.equal(row.customer_phone_normalized, "0812345678");
    assert.ok(row.privacy_accepted_at);
    assert.deepEqual(h.db.all("SELECT stay_date FROM booking_unit_nights WHERE booking_id = ? ORDER BY stay_date", row.id).map((r) => ({ ...r })),
      [{ stay_date: "2027-02-01" }, { stay_date: "2027-02-02" }]);
    const snap = h.db.get<{ nightly_prices_json: string; subtotal_satang: number }>("SELECT nightly_prices_json, subtotal_satang FROM booking_price_snapshots WHERE booking_id = ?", row.id)!;
    assert.equal(snap.subtotal_satang, 700000);
    assert.equal(JSON.parse(snap.nightly_prices_json).length, 2);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_included_meals WHERE booking_id = ?", row.id)!.n, 1);
    const orders = h.db.all<{ service_date: string; total_persons: number; capacity_reserved: number }>(
      "SELECT o.service_date, o.total_persons, o.capacity_reserved FROM food_orders o WHERE booking_id = ? ORDER BY service_date, capacity_reserved", row.id).map((r) => ({ ...r }));
    assert.deepEqual(orders, [
      { service_date: "2027-02-01", total_persons: 2, capacity_reserved: 2 },
      { service_date: "2027-02-02", total_persons: 2, capacity_reserved: 0 },
      { service_date: "2027-02-03", total_persons: 2, capacity_reserved: 0 },
    ]);
    assert.equal(h.db.get<{ used_quantity: number }>("SELECT used_quantity FROM food_daily_capacity WHERE food_category_id = 'dev_food_dinner' AND service_date = '2027-02-01'")!.used_quantity, 2);
    assert.equal(h.db.get("SELECT 1 AS x FROM food_daily_capacity WHERE food_category_id = 'dev_food_breakfast'"), undefined, "included meals take no capacity");
    // Logs carry the code, not personal data.
    const ev = h.db.get<{ identifier: string; details_json: string | null }>("SELECT identifier, details_json FROM security_events WHERE event_type = 'BOOKING_CREATED'")!;
    assert.equal(ev.identifier, b.bookingCode);
    const audit = h.audits("CREATE_BOOKING")[0]!;
    assert.equal(/Somchai|5678|guest@/.test(audit.new_value ?? ""), false);
  });

  it("booking snapshots do not change when prices change later", async () => {
    const h = new Harness({ seed: true });
    const b = (await book(h, { food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 1 }] })).data;
    h.db.run("UPDATE accommodation_units SET base_price_satang = 999900 WHERE id = ?", HOUSE);
    h.db.run("UPDATE food_options SET price_satang = 99900 WHERE id = 'dev_food_dinner_a'");
    h.db.run("UPDATE food_option_translations SET name = 'Renamed' WHERE food_option_id = 'dev_food_dinner_a'");
    const again = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: "0812345678" } });
    assert.equal(again.data.totalSatang, b.totalSatang);
    assert.deepEqual(again.data.item.nightly, b.item.nightly);
    assert.equal(again.data.food.find((f) => f.optionId === "dev_food_dinner_a")!.name, "Dinner A");
  });

  it("refuses a changed price (the guest must re-confirm)", async () => {
    const h = new Harness({ seed: true });
    const res = await book(h, {}, { expectedTotalSatang: 1 });
    assert.equal(res.status, 409);
    assert.equal(res.error?.code, "PRICE_CHANGED");
    assert.equal(res.error?.details?.totalSatang, "700000");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 0);
  });

  it("is idempotent: the same key returns the same booking; a different phone is refused", async () => {
    const h = new Harness({ seed: true });
    const q = (await quote(h)).data;
    const body = {
      ...stayBody(), customer: { name: "A", phone: "0812345678" }, privacyAccepted: true,
      expectedTotalSatang: q.totalSatang, idempotencyKey: "same-key-1234567890",
    };
    const first = await h.api<PublicBookingDto>("POST", "/api/public/bookings", { body });
    const second = await h.api<PublicBookingDto>("POST", "/api/public/bookings", { body });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.data.bookingCode, first.data.bookingCode);
    const other = await h.api("POST", "/api/public/bookings", { body: { ...body, customer: { name: "B", phone: "0899999999" } } });
    assert.equal(other.status, 409);
    assert.equal(other.error?.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 1);
  });

  it("validates input strictly (privacy, unknown fields, customer)", async () => {
    const h = new Harness({ seed: true });
    const noPrivacy = await book(h, {}, { privacyAccepted: false });
    assert.equal(noPrivacy.error?.details?.privacyAccepted, "MUST_ACCEPT");
    const mass = await book(h, {}, { totalSatang: 1, status: "CONFIRMED" });
    assert.equal(mass.error?.details?.totalSatang, "UNKNOWN_FIELD");
    assert.equal(mass.error?.details?.status, "UNKNOWN_FIELD");
    const stayExtra = await book(h, {}, { stay: { kind: "UNIT", unitId: HOUSE, priceSatang: 1 } });
    assert.equal(stayExtra.error?.details?.stay, "INVALID_VALUE");
    const badPhone = await book(h, {}, { customer: { name: "A", phone: "call me" } });
    assert.equal(badPhone.error?.details?.["customer.phone"], "INVALID_PHONE");
    const custExtra = await book(h, {}, { customer: { name: "A", phone: "0812345678", role: "admin" } });
    assert.equal(custExtra.error?.details?.["customer.role"], "UNKNOWN_FIELD");
    const badKey = await book(h, {}, { idempotencyKey: "short" });
    assert.equal(badKey.error?.details?.idempotencyKey, "INVALID_FORMAT");
    const xss = await book(h, {}, { customer: { name: "<script>alert(1)</script>", phone: "0812345678" } });
    assert.equal(xss.status, 201, "stored as text; React escapes on render");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 1);
  });

  it("requires same-origin + X-Requested-With (CSRF)", async () => {
    const h = new Harness({ seed: true });
    const res = await h.api("POST", "/api/public/bookings", { body: {}, headers: { Origin: "https://evil.test" } });
    assert.equal(res.status, 403);
  });

  it("never double-books a unit, even for simultaneous requests", async () => {
    const h = new Harness({ seed: true });
    const results = await Promise.all([book(h), book(h), book(h, { checkIn: "2027-02-02", checkOut: "2027-02-04" })]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409], JSON.stringify(results.map((r) => r.error)));
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.error?.code === "UNIT_UNAVAILABLE"));
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 1, "the loser's batch rolled back completely");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_food_items")!.n, 2);
    // Back-to-back stays share no night: check-out day is free.
    assert.equal((await book(h, { checkIn: "2027-02-03", checkOut: "2027-02-04" })).status, 201);
  });

  it("never oversells camping tents, even for simultaneous requests", async () => {
    const h = new Harness({ seed: true });
    h.db.run("UPDATE camping_settings SET max_tents_per_night = 3");
    const camp = { stay: { kind: "CAMPING", tents: 2 }, adults: 2, children: 0 };
    const results = await Promise.all([book(h, camp), book(h, camp)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409)!.error?.code, "CAMPING_FULL");
    const nights = h.db.all<{ stay_date: string; tents_used: number }>("SELECT stay_date, tents_used FROM camping_night_inventory ORDER BY stay_date").map((r) => ({ ...r }));
    assert.deepEqual(nights, [{ stay_date: "2027-02-01", tents_used: 2 }, { stay_date: "2027-02-02", tents_used: 2 }]);
    assert.equal((await book(h, { ...camp, stay: { kind: "CAMPING", tents: 1 } })).status, 201);
  });

  it("never exceeds daily food capacity, even for simultaneous requests", async () => {
    const h = new Harness({ seed: true });
    h.db.run("UPDATE food_categories SET default_daily_capacity = 3 WHERE id = 'dev_food_bbq'");
    const bbq = (unitId: string) => ({ stay: { kind: "UNIT", unitId }, adults: 2, children: 0, food: [{ optionId: "dev_food_bbq_set", serviceDate: "2027-02-01", quantity: 2 }] });
    const results = await Promise.all([book(h, bbq("dev_house_01")), book(h, bbq("dev_house_02"))]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409)!.error?.code, "FOOD_CAPACITY_EXCEEDED");
    assert.equal(h.db.get<{ used_quantity: number }>("SELECT used_quantity FROM food_daily_capacity WHERE food_category_id = 'dev_food_bbq'")!.used_quantity, 2);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE unit_id = 'dev_house_02'")!.n, 0, "rollback released the house too");
  });

  it("rate-limits booking creation per IP", async () => {
    const h = new Harness({ seed: true });
    for (let i = 0; i < 20; i++) {
      h.db.run("INSERT INTO security_events (id, event_type, ip, created_at) VALUES (?, 'BOOKING_CREATED', ?, ?)", `e${i}`, h.ip, "2027-01-10T02:30:00.000Z");
    }
    const res = await book(h);
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("Retry-After"));
    h.ip = "198.51.100.7";
    assert.equal((await book(h)).status, 201);
  });
});

describe("booking lookup", () => {
  it("needs Booking ID + phone; answers identically for unknown code and wrong phone", async () => {
    const h = new Harness({ seed: true });
    const b = (await book(h)).data;
    const ok = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode.toLowerCase(), phone: "+66 81 234 5678" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.customerPhoneMasked, "•••• 5678");
    assert.equal("customerPhone" in ok.data, false);
    const wrongPhone = await h.api("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: "0899999999" } });
    const unknown = await h.api("POST", "/api/public/bookings/lookup", { body: { bookingCode: "BK-20270110-ZZZZ", phone: "0812345678" } });
    assert.equal(wrongPhone.status, 404);
    assert.deepEqual(wrongPhone.body, unknown.body);
    const get = await h.api("GET", "/api/public/bookings/lookup");
    assert.equal(get.status, 405, "phone never travels in a URL");
  });

  it("throttles guessing per booking code and per IP", async () => {
    const h = new Harness({ seed: true });
    const b = (await book(h)).data;
    for (let i = 0; i < 5; i++) {
      h.ip = `198.51.100.${i}`;
      assert.equal((await h.api("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: `08000000${i}0` } })).status, 404);
    }
    h.ip = "198.51.100.99";
    const blocked = await h.api("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: "0812345678" } });
    assert.equal(blocked.status, 429, "even the right phone waits once a code is under attack");
    h.advance(16 * 60_000);
    assert.equal((await h.api("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: "0812345678" } })).status, 200);

    h.ip = "203.0.113.200";
    for (let i = 0; i < 10; i++) {
      await h.api("POST", "/api/public/bookings/lookup", { body: { bookingCode: `BK-20270110-A${String(i).padStart(3, "0")}`, phone: "0812345678" } });
    }
    const ipBlocked = await h.api("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: "0812345678" } });
    assert.equal(ipBlocked.status, 429);
  });
});

describe("hold expiry", () => {
  it("expires unpaid holds and releases nights, tents and food exactly once", async () => {
    const h = new Harness({ seed: true });
    const house = (await book(h, { food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 2 }] })).data;
    const camp = (await book(h, { stay: { kind: "CAMPING", tents: 3 }, adults: 2, children: 0 })).data;
    assert.equal(h.db.get<{ tents_used: number }>("SELECT tents_used FROM camping_night_inventory WHERE stay_date = '2027-02-01'")!.tents_used, 3);

    h.advance(59 * 60_000);
    assert.equal(await h.app.scheduled(h.env), 0, "not yet");
    h.advance(2 * 60_000);
    assert.equal(await h.app.scheduled(h.env), 2);
    assert.equal(await h.app.scheduled(h.env), 0, "idempotent");

    const statuses = h.db.all<{ booking_status: string }>("SELECT booking_status FROM bookings").map((r) => r.booking_status);
    assert.deepEqual(statuses, ["EXPIRED", "EXPIRED"]);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights")!.n, 0);
    assert.deepEqual(h.db.all<{ tents_used: number }>("SELECT tents_used FROM camping_night_inventory").map((r) => r.tents_used), [0, 0]);
    assert.equal(h.db.get<{ used_quantity: number }>("SELECT used_quantity FROM food_daily_capacity WHERE food_category_id = 'dev_food_dinner'")!.used_quantity, 0);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM food_orders WHERE capacity_reserved > 0 OR status <> 'CANCELLED'")!.n, 0);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_items WHERE status = 'ACTIVE'")!.n, 0);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_price_snapshots")!.n, 2, "snapshots are kept");

    // Another guest can now take the house; the expired booking still reads as EXPIRED.
    assert.equal((await book(h)).status, 201);
    const lookup = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: house.bookingCode, phone: "0812345678" } });
    assert.equal(lookup.data.status, "EXPIRED");
    assert.equal(lookup.data.expiresAt, null);
    assert.ok(camp.bookingCode);
    // Releasing the old camping booking again must not free the new guest's tents.
    assert.equal((await book(h, { stay: { kind: "CAMPING", tents: 1 }, adults: 1, children: 0 })).status, 201);
    await h.app.scheduled(h.env);
    assert.equal(h.db.get<{ tents_used: number }>("SELECT tents_used FROM camping_night_inventory WHERE stay_date = '2027-02-01'")!.tents_used, 1);
  });

  it("a new booking frees overdue holds first (no waiting for the cron)", async () => {
    const h = new Harness({ seed: true });
    await book(h);
    h.advance(61 * 60_000);
    assert.equal((await book(h)).status, 201);
  });

  it("honours the configured hold time", async () => {
    const h = new Harness({ seed: true });
    h.db.run("UPDATE booking_settings SET hold_minutes = 15");
    assert.equal((await book(h)).data.expiresAt, "2027-01-10T03:15:00.000Z");
  });
});

describe("admin bookings", () => {
  it("lists, searches and shows bookings for bookings.view only", async () => {
    const h = new Harness({ seed: true });
    const b = (await book(h)).data;
    await book(h, { stay: { kind: "UNIT", unitId: "dev_vip_01" }, adults: 1, children: 0 });
    const none = await admin(h, []);
    assert.equal((await h.api("GET", "/api/admin/bookings", { token: none })).status, 403);
    assert.equal((await h.api("GET", "/api/admin/bookings")).status, 401);

    const viewer = await admin(h, ["bookings.view"]);
    const list = await h.api<{ items: { bookingCode: string; customerPhone: string; itemName: string }[] }>("GET", "/api/admin/bookings", { token: viewer });
    assert.equal(list.status, 200);
    assert.equal(list.data.items.length, 2);
    const byPhone = await h.api<{ items: { bookingCode: string }[] }>("GET", `/api/admin/bookings?q=${encodeURIComponent("+66812345678")}`, { token: viewer });
    assert.equal(byPhone.data.items.length, 2);
    const byCode = await h.api<{ items: { bookingCode: string }[] }>("GET", `/api/admin/bookings?q=${b.bookingCode}`, { token: viewer });
    assert.deepEqual(byCode.data.items.map((i) => i.bookingCode), [b.bookingCode]);
    const pct = await h.api<{ items: unknown[] }>("GET", "/api/admin/bookings?q=%25", { token: viewer });
    assert.equal(pct.data.items.length, 0, "LIKE wildcards are escaped");
    const page = await h.api<{ items: unknown[]; nextCursor: string | null }>("GET", "/api/admin/bookings?limit=1", { token: viewer });
    assert.equal(page.data.items.length, 1);
    assert.ok(page.data.nextCursor);

    const detail = await h.api<{ customerPhone: string; customerEmail: string }>("GET", `/api/admin/bookings/${b.bookingCode}`, { token: viewer });
    assert.equal(detail.data.customerPhone, "081-234-5678");
    assert.equal(detail.data.customerEmail, "guest@example.test");
    assert.equal((await h.api("GET", "/api/admin/bookings/not-a-code", { token: viewer })).status, 422);
  });

  it("cancels with bookings.cancel, releases inventory, audits, and cannot cancel twice", async () => {
    const h = new Harness({ seed: true });
    const b = (await book(h, { food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 2 }] })).data;
    const viewer = await admin(h, ["bookings.view"]);
    assert.equal((await h.api("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: viewer, body: { reason: "guest asked" } })).status, 403);

    const canceller = await admin(h, ["bookings.cancel"]);
    const res = await h.api<{ status: string; cancelReason: string }>("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: canceller, body: { reason: "guest asked" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.status, "CANCELLED");
    assert.equal(res.data.cancelReason, "guest asked");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights")!.n, 0);
    assert.equal(h.db.get<{ used_quantity: number }>("SELECT used_quantity FROM food_daily_capacity")!.used_quantity, 0);
    assert.equal(h.audits("CANCEL_BOOKING").length, 1);
    const again = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: canceller, body: { reason: "again" } });
    assert.equal(again.error?.code, "BOOKING_NOT_CANCELLABLE");
    assert.equal((await h.api("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: canceller, body: {} })).status, 422);
    assert.equal((await book(h)).status, 201, "dates are free again");
  });
});

describe("admin pricing rules", () => {
  it("create/update needs pricing.edit, validates, records history and changes future quotes only", async () => {
    const h = new Harness({ seed: true });
    const before = (await book(h)).data;
    const viewer = await admin(h, ["accommodation.view"]);
    const rule = { targetType: "UNIT", unitId: HOUSE, name: "Songkran", dateFrom: "2027-02-01", dateTo: "2027-02-28", priceSatang: 500000, priority: 5 };
    assert.equal((await h.api("POST", "/api/admin/pricing-rules", { token: viewer, body: rule })).status, 403);

    const editor = await admin(h, ["accommodation.view", "pricing.edit"]);
    const bad = await h.api("POST", "/api/admin/pricing-rules", { token: editor, body: { ...rule, dateTo: "2027-01-01" } });
    assert.equal(bad.error?.details?.dateTo, "BEFORE_START");
    assert.equal((await h.api("POST", "/api/admin/pricing-rules", { token: editor, body: { ...rule, unitId: "nope" } })).error?.details?.unitId, "UNKNOWN_UNIT");
    assert.equal((await h.api("POST", "/api/admin/pricing-rules", { token: editor, body: { ...rule, createdBy: "x" } })).error?.details?.createdBy, "UNKNOWN_FIELD");
    assert.equal((await h.api("POST", "/api/admin/pricing-rules", { token: editor, body: { ...rule, daysOfWeek: "7" } })).error?.details?.daysOfWeek, "INVALID_FORMAT");

    const created = await h.api<{ id: string; daysOfWeek: string; status: string }>("POST", "/api/admin/pricing-rules", { token: editor, body: rule });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.data.daysOfWeek, "0123456");
    assert.equal((await quote(h, { checkIn: "2027-02-10", checkOut: "2027-02-11" })).data.totalSatang, 500000);

    const list = await h.api<unknown[]>("GET", "/api/admin/pricing-rules?targetType=UNIT", { token: viewer });
    assert.equal(list.data.length, 1);

    const upd = await h.api<{ priceSatang: number; status: string }>("PATCH", `/api/admin/pricing-rules/${created.data.id}`, { token: editor, body: { priceSatang: 450000, status: "INACTIVE" } });
    assert.equal(upd.data.status, "INACTIVE");
    assert.equal((await quote(h, { checkIn: "2027-02-10", checkOut: "2027-02-11" })).data.totalSatang, 350000);
    const history = h.db.all<{ old_price_satang: number | null; new_price_satang: number }>(
      "SELECT old_price_satang, new_price_satang FROM price_history WHERE entity_type = 'PRICING_RULE' ORDER BY changed_at, old_price_satang").map((r) => ({ ...r }));
    assert.deepEqual(history, [{ old_price_satang: null, new_price_satang: 500000 }, { old_price_satang: 500000, new_price_satang: 450000 }]);
    assert.equal(h.audits("UPDATE_PRICING_RULE").length, 1);

    const snapshot = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: before.bookingCode, phone: "0812345678" } });
    assert.equal(snapshot.data.totalSatang, before.totalSatang, "existing booking unchanged");
  });
});
