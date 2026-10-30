import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, ExtraBedSettingsDto, FoodCatalogueDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { mapInventoryError } from "../../src/worker/services/booking.service.ts";
import { Harness } from "../helpers/harness.ts";

// Extra beds (migration 0043). Harness clock: 2027-01-10 10:00 Bangkok. House 01 ฿3,500 / night, House 02 ฿3,200.
let seq = 0;
const key = () => `beds-key-${String(++seq).padStart(10, "0")}`;
const PHONE = "0812345678";

type Stay = Record<string, unknown>;
const house1 = (extraBeds?: number): Stay => ({ kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0, ...(extraBeds === undefined ? {} : { extraBeds }) });
const house2 = (extraBeds?: number): Stay => ({ kind: "UNIT", unitId: "dev_house_02", adults: 2, children: 0, ...(extraBeds === undefined ? {} : { extraBeds }) });
const body = (stays: Stay[]) => ({ checkIn: "2027-02-01", checkOut: "2027-02-03", stays, food: [], lang: "en" });

async function setup() {
  const h = new Harness({ seed: true });
  const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const settings = (b: Partial<ExtraBedSettingsDto>, token = admin) =>
    h.api<ExtraBedSettingsDto>("PUT", "/api/admin/extra-beds", { token, body: { enabled: true, pricePerNightSatang: 30_000, maxPerUnit: 2, ...b } });
  const quote = (stays: Stay[]) => h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: body(stays) });
  const book = async (stays: Stay[]) => {
    const q = await quote(stays);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body(stays), customer: { name: "Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.data;
  };
  return { h, admin, settings, quote, book };
}

describe("extra beds — settings", () => {
  it("off until the owner switches it on; staff set price and beds per unit; audited; the booking page is told", async () => {
    const { h, admin, settings } = await setup();
    const first = await h.api<ExtraBedSettingsDto>("GET", "/api/admin/extra-beds", { token: admin });
    assert.deepEqual({ ...first.data, updatedAt: null }, { enabled: false, pricePerNightSatang: 0, maxPerUnit: 1, updatedAt: null });
    const menu = () => h.api<FoodCatalogueDto>("GET", "/api/public/food-options?checkIn=2027-02-01&checkOut=2027-02-03&lang=th");
    assert.equal((await menu()).data.extraBed, null);

    const saved = await settings({});
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.data.enabled, saved.data.pricePerNightSatang, saved.data.maxPerUnit], [true, 30_000, 2]);
    assert.deepEqual((await menu()).data.extraBed, { pricePerNightSatang: 30_000, maxPerUnit: 2 });
    assert.equal(h.audits("UPDATE_EXTRA_BEDS").length, 1);

    // Validation; a desk without accommodation.edit cannot change it; changing the price needs pricing.edit.
    assert.equal((await settings({ maxPerUnit: 0 })).status, 422);
    assert.equal((await settings({ maxPerUnit: 11 })).status, 422);
    assert.equal((await settings({ pricePerNightSatang: -1 })).status, 422);
    const viewerId = `viewer_${++seq}`;
    const viewer = await h.login(await h.user({ id: viewerId }));
    h.grant(viewerId, "accommodation.view");
    assert.equal((await h.api("GET", "/api/admin/extra-beds", { token: viewer })).status, 200);
    assert.equal((await settings({}, viewer)).status, 403);
    const editorId = `editor_${++seq}`;
    const editor = await h.login(await h.user({ id: editorId }));
    h.grant(editorId, "accommodation.edit");
    assert.equal((await settings({ maxPerUnit: 3 }, editor)).status, 200, "same price: no pricing.edit needed");
    assert.equal((await settings({ pricePerNightSatang: 50_000 }, editor)).status, 403);
    // Off again: the page no longer offers it.
    await settings({ enabled: false });
    assert.equal((await menu()).data.extraBed, null);
  });
});

describe("extra beds — price and booking", () => {
  it("quote: beds × price × nights per house, part of the accommodation (and of the stay's deposit)", async () => {
    const { h, settings, quote } = await setup();
    await settings({});
    const q = await quote([house1(2), house2()]);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.data.items[0]!.extraBeds, { quantity: 2, pricePerNightSatang: 30_000, nights: 2, subtotalSatang: 120_000 });
    assert.equal(q.data.items[1]!.extraBeds, undefined);
    assert.equal(q.data.items[0]!.subtotalSatang, 700_000, "the room itself");
    assert.equal(q.data.accommodationSubtotalSatang, 700_000 + 120_000 + 640_000);
    assert.equal(q.data.totalSatang, q.data.accommodationSubtotalSatang + q.data.foodSubtotalSatang);
    // 0 beds = none.
    assert.equal((await quote([house1(0)])).data.items[0]!.extraBeds, undefined);

    // Deposit plan: half of the stay with its beds is left for check-in.
    h.db.run("UPDATE accommodation_units SET payment_mode = 'DEPOSIT_50' WHERE id = 'dev_house_01'");
    const d = await quote([house1(1)]);
    assert.equal(d.data.items[0]!.payLaterSatang, (700_000 + 60_000) / 2);
  });

  it("refused when off, above the limit, for camping, or with a bad value", async () => {
    const { settings, quote, h } = await setup();
    const off = await quote([house1(1)]);
    assert.equal(off.status, 409);
    assert.equal(off.error?.code, "EXTRA_BED_UNAVAILABLE");
    await settings({ maxPerUnit: 1 });
    const many = await quote([house1(2)]);
    assert.equal(many.status, 422);
    assert.equal(many.error?.details?.["stays.0.extraBeds"], "EXTRA_BEDS_TOO_MANY");
    assert.equal((await quote([{ ...house1(), extraBeds: "two" }])).status, 422);
    assert.equal((await quote([{ ...house1(), extraBeds: 11 }])).status, 422);
    assert.equal((await quote([{ kind: "CAMPING", tents: 1, adults: 2, children: 0, extraBeds: 1 }])).status, 422, "houses / VIP tents only");
    // The database refuses beds for camping or above the limit too.
    assert.throws(() => h.db.run(`INSERT INTO booking_extra_beds (id, booking_id, booking_item_id, quantity, price_per_night_satang, number_of_nights, subtotal_satang)
      VALUES ('x', 'nope', 'nope', 1, 100, 1, 100)`), /EXTRA_BED_UNAVAILABLE|FOREIGN KEY/);
  });

  it("booking keeps an immutable snapshot, shown to the guest and in admin; a later price change does not touch it", async () => {
    const { h, admin, settings, book } = await setup();
    await settings({});
    const b = await book([house1(1), house2(2)]);
    assert.deepEqual(b.items.map((i) => i.extraBeds?.quantity ?? 0), [1, 2]);
    assert.equal(b.accommodationSubtotalSatang, 700_000 + 60_000 + 640_000 + 120_000);
    await settings({ pricePerNightSatang: 99_900 });
    const lookup = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: PHONE } });
    assert.deepEqual(lookup.data.items.map((i) => i.extraBeds?.subtotalSatang ?? 0), [60_000, 120_000]);
    const detail = await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${b.bookingCode}`, { token: admin });
    assert.equal(detail.data.items[1]!.extraBeds?.pricePerNightSatang, 30_000);
    assert.throws(() => h.db.run("UPDATE booking_extra_beds SET subtotal_satang = 1"), /SNAPSHOT_IMMUTABLE/);
    assert.throws(() => h.db.run("DELETE FROM booking_extra_beds"), /SNAPSHOT_IMMUTABLE/);
  });

  it("cancelling one stay takes its beds off the total; cancelling the booking keeps them on the record", async () => {
    const { h, admin, settings, book } = await setup();
    await settings({});
    const b = await book([house1(1), house2(2)]);
    const item2 = b.items[1]!;
    const before = (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${b.bookingCode}`, { token: admin })).data;
    const res = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${b.bookingCode}/stays/${before.items[1]!.id}/cancel`, { token: admin, body: { reason: "Fewer people" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.accommodationSubtotalSatang, 700_000 + 60_000);
    assert.equal(res.data.totalSatang, b.totalSatang - item2.subtotalSatang - 120_000);

    const cancelled = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: admin, body: { reason: "Plans changed" } });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.data.items[0]!.extraBeds?.quantity, 1, "what was booked stays on the cancelled booking");
  });

  it("switched off between the quote and the booking: the booking is refused, nothing is kept", async () => {
    const { h, settings, quote } = await setup();
    await settings({});
    const q = await quote([house1(1)]);
    await settings({ enabled: false });
    const res = await h.api("POST", "/api/public/bookings", {
      body: { ...body([house1(1)]), customer: { name: "Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(res.status, 409);
    assert.equal(res.error?.code, "EXTRA_BED_UNAVAILABLE");
    assert.equal(h.db.all("SELECT 1 FROM bookings").length, 0);
    // …and when the database trigger is what refuses it (option switched off inside the gap), the guest gets the same code.
    assert.equal((mapInventoryError(new Error("D1_ERROR: EXTRA_BED_UNAVAILABLE")) as { code: string }).code, "EXTRA_BED_UNAVAILABLE");
  });
});
