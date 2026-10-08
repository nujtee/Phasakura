import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AvailabilityDto, CampingIntegrityDto, CampingSettingsDto, PublicAccommodationsDto } from "../../src/shared/accommodation-types.ts";
import type { AdminBookingDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { mapInventoryError } from "../../src/worker/services/booking.service.ts";
import { Harness } from "../helpers/harness.ts";

// Camping add-on "tarp area": one per booking, price per area per night, its own nightly limit.
// Harness clock: 2027-01-10 10:00 Bangkok; seeded camping: ฿250 / adult / night, 30 tents.
let seq = 0;
const key = () => `tarp-key-${String(++seq).padStart(10, "0")}`;

function camp(tents: number, tarp: boolean, checkIn = "2027-02-01", checkOut = "2027-02-03", adults = 2, children = 1) {
  return { checkIn, checkOut, adults, children, stay: { kind: "CAMPING", tents, ...(tarp ? { tarp: true } : {}) }, food: [], lang: "th" };
}

async function book(h: Harness, body: ReturnType<typeof camp>) {
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  if (q.status !== 200) return q as unknown as Awaited<ReturnType<typeof h.api<PublicBookingDto>>>;
  return h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer: { name: "Camper", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
}

/** Tarp option on: ฿150 per area per night, `areas` per night. */
function offer(h: Harness, areas = 2, price = 15000) {
  h.db.run(`UPDATE camping_settings SET tarp_enabled = 1, tarp_price_per_night_satang = ${price}, max_tarps_per_night = ${areas}`);
}

const tarpNights = (h: Harness) =>
  h.db.all<{ stay_date: string; max_tarps: number; tarps_used: number }>("SELECT stay_date, max_tarps, tarps_used FROM camping_tarp_night_inventory ORDER BY stay_date").map((r) => ({ ...r }));

async function admin(h: Harness, perms: string[]) {
  const id = `staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

describe("camping tarp area — price and booking", () => {
  it("quote: tents per adult per night + tarp per night, children free; part of the accommodation subtotal", async () => {
    const h = new Harness({ seed: true });
    offer(h);
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: camp(2, true) });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.data.tarp, { quantity: 1, pricePerNightSatang: 15000, nights: 2, subtotalSatang: 30000 });
    assert.equal(q.data.item.subtotalSatang, 2 * 2 * 25000, "2 adults × 2 nights × ฿250; the child stays free");
    assert.equal(q.data.accommodationSubtotalSatang, 100000 + 30000);
    assert.equal(q.data.totalSatang, 130000);
    const without = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: camp(2, false) });
    assert.equal(without.data.tarp, null);
    assert.equal(without.data.totalSatang, 100000);
  });

  it("booking keeps an immutable snapshot, takes one area per night, shows it to the guest and in admin", async () => {
    const h = new Harness({ seed: true });
    offer(h);
    const res = await book(h, camp(2, true));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.data.tarp, { quantity: 1, pricePerNightSatang: 15000, nights: 2, subtotalSatang: 30000 });
    assert.equal(res.data.totalSatang, 130000);
    assert.deepEqual(tarpNights(h).map((n) => [n.stay_date, n.tarps_used, n.max_tarps]), [["2027-02-01", 1, 2], ["2027-02-02", 1, 2]]);
    const row = h.db.get<{ accommodation_subtotal_satang: number; total_satang: number }>("SELECT accommodation_subtotal_satang, total_satang FROM bookings")!;
    assert.deepEqual({ ...row }, { accommodation_subtotal_satang: 130000, total_satang: 130000 });

    // Price change later never touches the booking (snapshot), and the database refuses edits.
    offer(h, 2, 99900);
    const lookup = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: res.data.bookingCode, phone: "0812345678" } });
    assert.equal(lookup.data.tarp?.subtotalSatang, 30000);
    assert.throws(() => h.db.run("UPDATE booking_tarps SET subtotal_satang = 1"), /SNAPSHOT_IMMUTABLE/);
    assert.throws(() => h.db.run("DELETE FROM booking_tarps"), /SNAPSHOT_IMMUTABLE/);

    const staff = await admin(h, ["bookings.view"]);
    const detail = await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${res.data.bookingCode}`, { token: staff });
    assert.equal(detail.data.tarp?.subtotalSatang, 30000);
    const list = await h.api<{ items: { bookingCode: string; tarps: number }[] }>("GET", "/api/admin/bookings", { token: staff });
    assert.equal(list.data.items.find((b) => b.bookingCode === res.data.bookingCode)?.tarps, 1);
  });

  it("is refused when not offered, for houses, and with an invalid value", async () => {
    const h = new Harness({ seed: true });
    const off = await h.api("POST", "/api/public/bookings/quote", { body: camp(1, true) });
    assert.equal(off.status, 409);
    assert.equal(off.error?.code, "TARP_UNAVAILABLE");
    offer(h);
    const bad = await h.api("POST", "/api/public/bookings/quote", { body: { ...camp(1, false), stay: { kind: "CAMPING", tents: 1, tarp: "yes" } } });
    assert.equal(bad.status, 422);
    const unit = h.db.get<{ id: string }>("SELECT id FROM accommodation_units WHERE status = 'ACTIVE' LIMIT 1")!;
    const house = await h.api("POST", "/api/public/bookings/quote", { body: { ...camp(1, false), stay: { kind: "UNIT", unitId: unit.id, tarp: true } } });
    assert.equal(house.status, 422, "tarp is a camping option only");
  });
});

describe("camping tarp area — nightly limit", () => {
  it("availability shows areas left; the last area goes to one booking, the next is told which nights are full", async () => {
    const h = new Harness({ seed: true });
    offer(h, 1);
    const before = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-03&tents=1");
    assert.deepEqual(before.data.camping.tarp, { offered: true, remaining: 1, shortNights: [] });
    assert.equal((await book(h, camp(1, true))).status, 201);
    const after = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-02&checkOut=2027-02-04&tents=1");
    assert.deepEqual(after.data.camping.tarp, { offered: true, remaining: 0, shortNights: ["2027-02-02"] });
    const full = await book(h, camp(1, true, "2027-02-02", "2027-02-04"));
    assert.equal(full.status, 409);
    assert.equal(full.error?.code, "TARP_FULL");
    assert.equal((await book(h, camp(1, false, "2027-02-02", "2027-02-04"))).status, 201, "tents alone are still bookable");
  });

  it("two guests racing for the last area: exactly one wins (database CHECK), nothing half-written", async () => {
    const h = new Harness({ seed: true });
    offer(h, 1);
    const bodies = await Promise.all([camp(1, true), camp(1, true)].map(async (body) => {
      const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
      return { ...body, customer: { name: "Camper", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() };
    }));
    const results = await Promise.all(bodies.map((body) => h.api<PublicBookingDto>("POST", "/api/public/bookings", { body })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409)?.error?.code, "TARP_FULL");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 1);
    assert.deepEqual(tarpNights(h).map((n) => n.tarps_used), [1, 1]);
    assert.equal(h.db.get<{ t: number }>("SELECT tents_used AS t FROM camping_night_inventory WHERE stay_date = '2027-02-01'")!.t, 1, "the loser's tent was rolled back");
  });

  it("cancel and expiry give the area back; integrity check covers the tarp counters", async () => {
    const h = new Harness({ seed: true });
    offer(h, 1);
    const viewer = await admin(h, ["camping.view"]);
    const a = await book(h, camp(1, true));
    await book(h, camp(1, false, "2027-02-02", "2027-02-04"));
    assert.equal((await h.api<CampingIntegrityDto>("GET", "/api/admin/camping/integrity", { token: viewer })).data.consistent, true);
    const canceller = await admin(h, ["bookings.cancel"]);
    await h.api("POST", `/api/admin/bookings/${a.data.bookingCode}/cancel`, { token: canceller, body: { reason: "test cancel" } });
    assert.deepEqual(tarpNights(h).map((n) => n.tarps_used), [0, 0]);
    assert.equal(h.db.get<{ s: string }>("SELECT status AS s FROM booking_tarps")!.s, "CANCELLED");

    const b = await book(h, camp(1, true, "2027-02-05", "2027-02-06"));
    assert.equal(b.status, 201);
    h.advance(61 * 60_000);
    await h.app.scheduled(h.env);
    assert.ok(tarpNights(h).every((n) => n.tarps_used === 0), "expired hold released its area");
    const check = await h.api<CampingIntegrityDto>("GET", "/api/admin/camping/integrity", { token: viewer });
    assert.equal(check.data.consistent, true);
    assert.deepEqual(check.data.tarpDrift, []);

    // A drifted tarp counter is reported and recalculated with the tents.
    h.db.run("UPDATE camping_tarp_night_inventory SET tarps_used = 1 WHERE stay_date = '2027-02-05'");
    const drift = await h.api<CampingIntegrityDto>("GET", "/api/admin/camping/integrity", { token: viewer });
    assert.deepEqual(drift.data.tarpDrift.map((d) => [d.date, d.expected, d.actual]), [["2027-02-05", 0, 1]]);
    const editor = await admin(h, ["camping.view", "camping.edit"]);
    const fixed = await h.api<CampingIntegrityDto>("POST", "/api/admin/camping/recalculate", { token: editor, body: {} });
    assert.equal(fixed.data.consistent, true);
    assert.equal(tarpNights(h).find((n) => n.stay_date === "2027-02-05")!.tarps_used, 0);
  });

  it("database guards: tarp only with own-tent camping and only while offered; error mapping", () => {
    assert.equal((mapInventoryError(new Error("D1_ERROR: CHECK constraint failed: tarps_used <= max_tarps")) as { code: string }).code, "TARP_FULL");
    assert.equal((mapInventoryError(new Error("TARP_DISABLED")) as { code: string }).code, "TARP_UNAVAILABLE");
    const h = new Harness({ seed: true });
    const unit = h.db.get<{ id: string }>("SELECT id FROM accommodation_units WHERE status = 'ACTIVE' AND unit_type = 'HOUSE' LIMIT 1")!;
    h.db.run(`INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults, customer_name, customer_phone,
      customer_phone_normalized, accommodation_subtotal_satang, subtotal_satang, total_satang)
      VALUES ('b1', 'BK-20270201-AAAA', 'th', '2027-02-01', '2027-02-02', 1, 2, 'X', '0812345678', '0812345678', 100, 100, 100)`);
    h.db.run(`INSERT INTO booking_items (id, booking_id, item_type, unit_id, quantity, adults) VALUES ('i1', 'b1', 'HOUSE', '${unit.id}', 1, 2)`);
    offer(h);
    assert.throws(() => h.db.run(`INSERT INTO booking_tarps (id, booking_id, quantity, price_per_night_satang, number_of_nights, subtotal_satang)
      VALUES ('t1', 'b1', 1, 100, 1, 100)`), /TARP_NEEDS_CAMPING/);
    h.db.run("UPDATE camping_settings SET tarp_enabled = 0");
    h.db.run(`INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults, customer_name, customer_phone,
      customer_phone_normalized, accommodation_subtotal_satang, subtotal_satang, total_satang)
      VALUES ('b2', 'BK-20270201-BBBB', 'th', '2027-02-01', '2027-02-02', 1, 2, 'X', '0812345678', '0812345678', 100, 100, 100)`);
    h.db.run("INSERT INTO booking_items (id, booking_id, item_type, quantity, adults) VALUES ('i2', 'b2', 'OWN_TENT', 1, 2)");
    assert.throws(() => h.db.run(`INSERT INTO booking_tarps (id, booking_id, quantity, price_per_night_satang, number_of_nights, subtotal_satang)
      VALUES ('t2', 'b2', 1, 100, 1, 100)`), /TARP_DISABLED/);
  });
});

describe("camping tarp area — admin settings and public data", () => {
  it("camping.edit sets the option; price needs pricing.edit; limit below areas sold is refused", async () => {
    const h = new Harness({ seed: true });
    const editor = await admin(h, ["camping.view", "camping.edit"]);
    const current = (await h.api<CampingSettingsDto>("GET", "/api/admin/camping", { token: editor })).data;
    assert.equal(current.tarpEnabled, false);
    const base = { ...current, translations: undefined };
    delete (base as { translations?: unknown }).translations;

    const noCapacity = await h.api("PUT", "/api/admin/camping", { token: editor, body: { ...base, tarpEnabled: true, maxTarpsPerNight: 0 } });
    assert.equal(noCapacity.status, 422);
    assert.equal((noCapacity.error as { details?: Record<string, string> }).details?.maxTarpsPerNight, "TARP_CAPACITY_REQUIRED");

    const priced = await h.api("PUT", "/api/admin/camping", { token: editor, body: { ...base, tarpEnabled: true, maxTarpsPerNight: 3, tarpPricePerNightSatang: 10000 } });
    assert.equal(priced.status, 403, "changing a price needs pricing.edit");

    const ok = await h.api<CampingSettingsDto>("PUT", "/api/admin/camping", { token: editor, body: { ...base, tarpEnabled: true, maxTarpsPerNight: 3 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.data.tarpEnabled, true);
    assert.equal(ok.data.maxTarpsPerNight, 3);

    const pricing = await admin(h, ["camping.view", "camping.edit", "pricing.edit"]);
    const withPrice = await h.api<CampingSettingsDto>("PUT", "/api/admin/camping", { token: pricing, body: { ...base, tarpEnabled: true, maxTarpsPerNight: 3, tarpPricePerNightSatang: 12000 } });
    assert.equal(withPrice.data.tarpPricePerNightSatang, 12000);
    const pub = (await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=th")).data;
    assert.deepEqual(pub.camping.tarp, { pricePerNightSatang: 12000 });

    // Areas sold on a night → the per-night number cannot go below them (whole change refused).
    base.tarpPricePerNightSatang = 12000;
    assert.equal((await book(h, camp(1, true))).status, 201);
    assert.equal((await book(h, camp(1, true))).status, 201);
    const below = await h.api("PUT", "/api/admin/camping", { token: editor, body: { ...base, tarpEnabled: true, maxTarpsPerNight: 1 } });
    assert.equal(below.status, 409);
    assert.equal(below.error?.code, "BELOW_TARPS_SOLD");
    assert.deepEqual(tarpNights(h).map((n) => n.max_tarps), [3, 3], "nothing changed");
    const lowered = await h.api("PUT", "/api/admin/camping", { token: editor, body: { ...base, tarpEnabled: true, maxTarpsPerNight: 2 } });
    assert.equal(lowered.status, 200);
    assert.deepEqual(tarpNights(h).map((n) => n.max_tarps), [2, 2]);

    // An older admin page that does not send the tarp fields keeps them as they are.
    const legacy = await h.api<CampingSettingsDto>("PUT", "/api/admin/camping", {
      token: editor,
      body: { isEnabled: true, maxTentsPerNight: 30, pricePerAdultNightSatang: current.pricePerAdultNightSatang, childFreeUnderAge: 12, maxGuestsPerTent: current.maxGuestsPerTent, coverAssetId: current.coverAssetId },
    });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(legacy.data.tarpEnabled, true);
    assert.equal(legacy.data.maxTarpsPerNight, 2);
    assert.ok(h.audits("UPDATE_SETTINGS").length >= 3);
  });

  it("public camping data offers the tarp only when it is on and has areas", async () => {
    const h = new Harness({ seed: true });
    assert.equal((await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=en")).data.camping.tarp, null);
    offer(h, 0);
    assert.equal((await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=en")).data.camping.tarp, null);
    offer(h, 2, 5000);
    assert.deepEqual((await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=en")).data.camping.tarp, { pricePerNightSatang: 5000 });
  });
});
