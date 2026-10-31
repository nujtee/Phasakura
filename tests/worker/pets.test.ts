import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, FoodCatalogueDto, PetSettingsDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { mapInventoryError } from "../../src/worker/services/booking.service.ts";
import { Harness } from "../helpers/harness.ts";

// Pets (migration 0044). Harness clock: 2027-01-10 10:00 Bangkok. House 01 ฿3,500 / night, House 02 ฿3,200.
let seq = 0;
const key = () => `pets-key-${String(++seq).padStart(10, "0")}`;
const PHONE = "0812345678";

type Stay = Record<string, unknown>;
const house1 = (more: Stay = {}): Stay => ({ kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0, ...more });
const house2 = (more: Stay = {}): Stay => ({ kind: "UNIT", unitId: "dev_house_02", adults: 2, children: 0, ...more });
const body = (stays: Stay[]) => ({ checkIn: "2027-02-01", checkOut: "2027-02-04", stays, food: [], lang: "en" });

async function setup() {
  const h = new Harness({ seed: true });
  const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const settings = (b: Partial<PetSettingsDto>, token = admin) =>
    h.api<PetSettingsDto>("PUT", "/api/admin/pets", { token, body: { enabled: true, priceSatang: 20_000, chargePer: "NIGHT", maxWeightKg: 15, maxPerUnit: 2, ...b } });
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

describe("pets — settings", () => {
  it("off until switched on, apart from extra beds; price, per night / per stay, weight limit, pets per unit; audited", async () => {
    const { h, admin, settings } = await setup();
    const first = await h.api<PetSettingsDto>("GET", "/api/admin/pets", { token: admin });
    assert.deepEqual({ ...first.data, updatedAt: null }, { enabled: false, priceSatang: 0, chargePer: "NIGHT", maxWeightKg: 10, maxPerUnit: 2, updatedAt: null });
    const menu = async () => (await h.api<FoodCatalogueDto>("GET", "/api/public/food-options?checkIn=2027-02-01&checkOut=2027-02-04&lang=th")).data;
    assert.equal((await menu()).pet, null);

    const saved = await settings({});
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual((await menu()).pet, { priceSatang: 20_000, chargePer: "NIGHT", maxWeightKg: 15, maxPerUnit: 2 });
    assert.equal((await menu()).extraBed, null, "extra beds stay off: a separate switch");
    assert.equal(h.audits("UPDATE_PETS").length, 1);

    for (const bad of [{ maxWeightKg: 0 }, { maxWeightKg: 201 }, { maxPerUnit: 0 }, { maxPerUnit: 11 }, { chargePer: "WEEK" }, { priceSatang: -1 }]) {
      assert.equal((await settings(bad as Partial<PetSettingsDto>)).status, 422, JSON.stringify(bad));
    }
    const editorId = `editor_${++seq}`;
    const editor = await h.login(await h.user({ id: editorId }));
    h.grant(editorId, "accommodation.edit");
    assert.equal((await settings({ maxWeightKg: 20 }, editor)).status, 200, "weight / count: no pricing.edit needed");
    assert.equal((await settings({ maxWeightKg: 20, chargePer: "STAY" }, editor)).status, 403, "how it is charged is pricing");
    assert.equal((await settings({ maxWeightKg: 20, priceSatang: 1 }, editor)).status, 403);
  });
});

describe("pets — price and booking", () => {
  it("per night: pets × price × nights; per stay: once; part of the accommodation and of the stay's deposit", async () => {
    const { h, settings, quote } = await setup();
    await settings({});
    const q = await quote([house1({ pets: 2 }), house2()]);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.data.items[0]!.pets, { quantity: 2, priceSatang: 20_000, chargePer: "NIGHT", chargedUnits: 3, maxWeightKg: 15, subtotalSatang: 120_000 });
    assert.equal(q.data.items[1]!.pets, undefined);
    assert.equal(q.data.accommodationSubtotalSatang, 3 * 350_000 + 120_000 + 3 * 320_000);

    await settings({ chargePer: "STAY" });
    const stay = await quote([house1({ pets: 2, })]);
    assert.equal(stay.data.items[0]!.pets?.subtotalSatang, 40_000, "once per stay");

    // With extra beds too, on a deposit plan: half of room + beds + pets is left for check-in.
    h.db.run("UPDATE extra_bed_settings SET is_enabled = 1, price_per_night_satang = 10000, max_per_unit = 1");
    h.db.run("UPDATE accommodation_units SET payment_mode = 'DEPOSIT_50' WHERE id = 'dev_house_01'");
    const d = await quote([house1({ pets: 1, extraBeds: 1 })]);
    assert.equal(d.data.items[0]!.payLaterSatang, (3 * 350_000 + 30_000 + 20_000) / 2);
  });

  it("refused when off, above the limit, for camping, or with a bad value", async () => {
    const { settings, quote } = await setup();
    const off = await quote([house1({ pets: 1 })]);
    assert.equal(off.status, 409);
    assert.equal(off.error?.code, "PET_UNAVAILABLE");
    await settings({ maxPerUnit: 1 });
    const many = await quote([house1({ pets: 2 })]);
    assert.equal(many.status, 422);
    assert.equal(many.error?.details?.["stays.0.pets"], "PETS_TOO_MANY");
    assert.equal((await quote([house1({ pets: "one" })])).status, 422);
    assert.equal((await quote([{ kind: "CAMPING", tents: 1, adults: 2, children: 0, pets: 1 }])).status, 422);
    assert.equal((mapInventoryError(new Error("D1_ERROR: PET_UNAVAILABLE")) as { code: string }).code, "PET_UNAVAILABLE");
  });

  it("booking keeps an immutable snapshot (with the weight limit), shown to the guest and in admin; cancelling a stay takes its pets off", async () => {
    const { h, admin, settings, book } = await setup();
    await settings({});
    const b = await book([house1({ pets: 1 }), house2({ pets: 2 })]);
    assert.deepEqual(b.items.map((i) => [i.pets?.quantity, i.pets?.maxWeightKg]), [[1, 15], [2, 15]]);
    await settings({ priceSatang: 99_900, maxWeightKg: 5 });
    const lookup = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: PHONE } });
    assert.deepEqual(lookup.data.items.map((i) => [i.pets?.subtotalSatang, i.pets?.maxWeightKg]), [[60_000, 15], [120_000, 15]]);
    assert.throws(() => h.db.run("UPDATE booking_pets SET subtotal_satang = 1"), /SNAPSHOT_IMMUTABLE/);
    assert.throws(() => h.db.run("DELETE FROM booking_pets"), /SNAPSHOT_IMMUTABLE/);

    const detail = (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${b.bookingCode}`, { token: admin })).data;
    const res = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${b.bookingCode}/stays/${detail.items[1]!.id}/cancel`, { token: admin, body: { reason: "Fewer people" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.accommodationSubtotalSatang, 3 * 350_000 + 60_000);
  });
});
