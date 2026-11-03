import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AvailabilityDto, PublicUnitDto } from "../../src/shared/accommodation-types.ts";
import type { PricingRuleDto, PromotionPerkDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { discountedPrice } from "../../src/worker/services/quote.service.ts";
import { Harness } from "../helpers/harness.ts";

// Promotions on price rules (migration 0055): room discount (percent or baht), free extra beds / pets, free food the
// guest picks, and a text for guests. Harness clock: 2027-01-10 Bangkok. House 01 ฿3,500 / night.
let seq = 0;
const key = () => `promo-key-${String(++seq).padStart(10, "0")}`;

describe("promotion discount (pure)", () => {
  it("percent rounds to whole baht; an amount never goes below zero; no discount = the rule's price", () => {
    assert.equal(discountedPrice({ price_satang: 400_000, discount_kind: "PERCENT", discount_value: 15 }), 340_000);
    assert.equal(discountedPrice({ price_satang: 333_300, discount_kind: "PERCENT", discount_value: 10 }), 300_000, "฿2,999.70 → ฿3,000");
    assert.equal(discountedPrice({ price_satang: 400_000, discount_kind: "AMOUNT", discount_value: 50_000 }), 350_000);
    assert.equal(discountedPrice({ price_satang: 40_000, discount_kind: "AMOUNT", discount_value: 50_000 }), 0);
    assert.equal(discountedPrice({ price_satang: 400_000, discount_kind: null, discount_value: null }), 400_000);
  });
});

async function setup() {
  const h = new Harness({ seed: true });
  const admin = await h.login(await h.user({ id: `root_promo_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const rule = (body: Record<string, unknown>) => h.api<PricingRuleDto>("POST", "/api/admin/pricing-rules", {
    token: admin, body: { targetType: "UNIT", unitId: "dev_house_01", name: "Rainy deal", dateFrom: "2027-02-01", dateTo: "2027-02-28", priceSatang: 400_000, priority: 5, ...body },
  });
  const stays = (extra: Record<string, unknown> = {}) => [{ kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0, ...extra }];
  const quote = (over: Record<string, unknown> = {}) =>
    h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: { checkIn: "2027-02-05", checkOut: "2027-02-07", stays: stays(), food: [], lang: "th", ...over } });
  return { h, admin, rule, stays, quote };
}

describe("price rule promotions", () => {
  it("validates the fields; saves, lists and clears them; other edits keep them", async () => {
    const { h, admin, rule } = await setup();
    const bad = async (body: Record<string, unknown>) => (await rule(body)).error?.details;
    assert.equal((await bad({ discountKind: "PERCENT", discountValue: 95 }))?.discountValue, "PERCENT_RANGE");
    assert.equal((await bad({ discountKind: "AMOUNT", discountValue: 500_000 }))?.discountValue, "AMOUNT_RANGE", "more than the price");
    assert.equal((await bad({ discountKind: "AMOUNT", discountValue: 1_050 }))?.discountValue, "AMOUNT_RANGE", "whole baht");
    assert.equal((await bad({ discountKind: "PERCENT" }))?.discountValue, "REQUIRED");
    assert.equal((await bad({ discountValue: 10 }))?.discountValue, "KIND_REQUIRED");
    assert.equal((await bad({ discountKind: "HALF", discountValue: 10 }))?.discountKind, "INVALID_VALUE");
    assert.equal((await bad({ freePets: "yes" }))?.freePets, "INVALID_VALUE");
    assert.equal((await bad({ freeFoodOptionIds: ["nope_food"] }))?.freeFoodOptionIds, "UNKNOWN_FOOD");
    assert.equal((await bad({ promoText: "x".repeat(301) }))?.promoText !== undefined, true);
    // Several lines are fine (CR LF kept as one line break, extra empty lines folded); other control characters are not.
    const lines = await rule({ promoText: "เค้กวันพ่อ 1 ปอนด์\r\nหมูกระทะ 1 ชุด  \n\n\n\nไวน์ 1 ขวด" });
    assert.equal(lines.status, 201, JSON.stringify(lines.body));
    assert.equal(lines.data.promoText, "เค้กวันพ่อ 1 ปอนด์\nหมูกระทะ 1 ชุด\n\nไวน์ 1 ขวด");
    assert.equal((await bad({ promoText: "a\u0007b" }))?.promoText, "INVALID_CHARACTERS");

    const made = await rule({
      discountKind: "PERCENT", discountValue: 20, freeExtraBed: true, freePets: true,
      freeFoodOptionIds: ["dev_food_dinner_a"], promoText: "  ลดหน้าฝน 20% ฟรีอาหารเย็น  ",
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(
      [made.data.discountKind, made.data.discountValue, made.data.freeExtraBed, made.data.freePets, made.data.freeFoodOptionIds, made.data.promoText],
      ["PERCENT", 20, true, true, ["dev_food_dinner_a"], "ลดหน้าฝน 20% ฟรีอาหารเย็น"],
    );
    const listed = (await h.api<PricingRuleDto[]>("GET", "/api/admin/pricing-rules", { token: admin })).data.find((r) => r.id === made.data.id)!;
    assert.equal(listed.promoText, "ลดหน้าฝน 20% ฟรีอาหารเย็น");
    const renamed = await h.api<PricingRuleDto>("PATCH", `/api/admin/pricing-rules/${made.data.id}`, { token: admin, body: { name: "Rain" } });
    assert.equal(renamed.data.discountValue, 20, "kept");
    assert.deepEqual(renamed.data.freeFoodOptionIds, ["dev_food_dinner_a"]);
    const cleared = await h.api<PricingRuleDto>("PATCH", `/api/admin/pricing-rules/${made.data.id}`, {
      token: admin, body: { discountKind: null, discountValue: null, freeExtraBed: false, freePets: false, freeFoodOptionIds: [], promoText: "" },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual([cleared.data.discountKind, cleared.data.freeExtraBed, cleared.data.freeFoodOptionIds, cleared.data.promoText], [null, false, [], null]);
    assert.equal(h.db.all("SELECT * FROM pricing_rule_free_foods").length, 0);
  });

  it("room discount: the quote and search use the lower price, show the rule's price crossed out and what was saved", async () => {
    const { h, rule, quote } = await setup();
    await rule({ discountKind: "AMOUNT", discountValue: 50_000, promoText: "ลด 500 บาท/คืน" });
    const q = await quote();
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.data.items[0]!.nightly, [
      { date: "2027-02-05", priceSatang: 350_000, listPriceSatang: 400_000 },
      { date: "2027-02-06", priceSatang: 350_000, listPriceSatang: 400_000 },
    ]);
    assert.equal(q.data.accommodationSubtotalSatang, 700_000);
    const promo = q.data.items[0]!.promotions![0]!;
    assert.equal(promo.text, "ลด 500 บาท/คืน");
    assert.equal(promo.roomDiscountSatang, 100_000);
    assert.deepEqual(promo.discount, { kind: "AMOUNT", value: 50_000 });
    assert.equal(q.data.promotionSavingsSatang, 100_000);
    // Outside the rule's dates: no promotion.
    const plain = await quote({ checkIn: "2027-03-05", checkOut: "2027-03-06" });
    assert.equal(plain.data.items[0]!.promotions, undefined);
    assert.equal(plain.data.promotionSavingsSatang, undefined);

    // Search shows the same price, the crossed-out one and the promotion.
    const search = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-05&checkOut=2027-02-07");
    assert.equal(search.status, 200, JSON.stringify(search.body));
    const u = search.data.units.find((x) => x.unitId === "dev_house_01")!;
    assert.deepEqual(u.nightlyPricesSatang, [350_000, 350_000]);
    assert.deepEqual(u.listPricesSatang, [400_000, 400_000]);
    assert.equal(u.promotions?.[0]?.text, "ลด 500 บาท/คืน");
    assert.deepEqual([u.promotions?.[0]?.dateFrom, u.promotions?.[0]?.dateTo], ["2027-02-05", "2027-02-06"]);
    assert.equal(search.data.units.find((x) => x.unitId === "dev_house_02")!.promotions, undefined);

    // The house page lists the promotions to come.
    const slug = h.db.get<{ slug: string }>("SELECT slug FROM accommodation_units WHERE id = 'dev_house_01'")!.slug;
    const page = await h.api<PublicUnitDto>("GET", `/api/public/accommodations/${slug}?lang=th`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.data.promotions?.map((p) => [p.text, p.dateFrom, p.dateTo, p.discount?.value]), [["ลด 500 บาท/คืน", "2027-02-01", "2027-02-28", 50_000]]);
    const other = h.db.get<{ slug: string }>("SELECT slug FROM accommodation_units WHERE id = 'dev_house_02'")!.slug;
    assert.equal((await h.api<PublicUnitDto>("GET", `/api/public/accommodations/${other}?lang=th`)).data.promotions, undefined);
  });

  it("free extra beds and pets on the promotion's nights only; free food the guest picks, up to the guests", async () => {
    const { h, rule, stays, quote } = await setup();
    h.db.run("UPDATE extra_bed_settings SET is_enabled = 1, price_per_night_satang = 30000, max_per_unit = 2");
    h.db.run("UPDATE pet_settings SET is_enabled = 1, price_satang = 20000, charge_per = 'NIGHT', max_per_unit = 2");
    // Only the Saturday night (2027-02-06) is in the promotion.
    await rule({ dateFrom: "2027-02-06", dateTo: "2027-02-06", freeExtraBed: true, freePets: true, freeFoodOptionIds: ["dev_food_dinner_a"] });
    const q = await quote({
      stays: stays({ extraBeds: 1, pets: 1 }),
      food: [
        { optionId: "dev_food_dinner_a", serviceDate: "2027-02-05", adults: 2 },
        { optionId: "dev_food_dinner_a", serviceDate: "2027-02-06", adults: 2 },
      ],
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const it0 = q.data.items[0]!;
    assert.deepEqual(it0.extraBeds, { quantity: 1, pricePerNightSatang: 30_000, nights: 1, subtotalSatang: 30_000, freeNights: 1 });
    assert.equal(it0.pets?.subtotalSatang, 20_000);
    assert.equal(it0.pets?.freeUnits, 1);
    const [fri, sat] = ["2027-02-05", "2027-02-06"].map((d) => q.data.food.find((f) => f.serviceDate === d && f.optionId === "dev_food_dinner_a")!);
    assert.equal(fri!.subtotalSatang, 2 * 25_000, "not a promotion night");
    assert.equal(sat!.subtotalSatang, 0);
    assert.equal(sat!.promoFreeQuantity, 2);
    const p = it0.promotions![0]!;
    assert.deepEqual([p.extraBedFreeSatang, p.petsFreeSatang, p.foodFreeSatang], [30_000, 20_000, 50_000]);
    assert.equal(q.data.promotionSavingsSatang, 100_000);
    assert.equal(q.data.totalSatang, 350_000 + 400_000 + 30_000 + 20_000 + 50_000);

    // Booked: the bill keeps what the promotion gave, even after the rule changes.
    const booked = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: {
        checkIn: "2027-02-05", checkOut: "2027-02-07", stays: stays({ extraBeds: 1, pets: 1 }), lang: "th",
        food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-05", adults: 2 }, { optionId: "dev_food_dinner_a", serviceDate: "2027-02-06", adults: 2 }],
        customer: { name: "Guest", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key(),
      },
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.equal(booked.data.totalSatang, q.data.totalSatang);
    assert.equal(booked.data.promotionSavingsSatang, 100_000);
    h.db.run("UPDATE pricing_settings SET status = 'INACTIVE'");
    const lookup = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: booked.data.bookingCode, phone: "0812345678" } });
    assert.equal(lookup.data.items[0]!.promotions?.[0]?.foodFreeSatang, 50_000);
    assert.equal(lookup.data.promotionSavingsSatang, 100_000);
  });

  it("a group rule writes the promotion to every house", async () => {
    const { h, rule } = await setup();
    const g = await rule({ targetType: "UNITS", unitId: null, unitIds: ["dev_house_01", "dev_house_02"], discountKind: "PERCENT", discountValue: 10, promoText: "Group deal" });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    assert.equal(g.data.discountValue, 10);
    const rows = h.db.all<{ discount_value: number; promo_text: string }>("SELECT discount_value, promo_text FROM pricing_settings WHERE group_id IS NOT NULL");
    assert.deepEqual(rows.map((r) => [r.discount_value, r.promo_text]), [[10, "Group deal"], [10, "Group deal"]]);
  });

  it("extra perks: a shared list (add, rename, delete); a rule gives them; guests see them; the bill keeps their names", async () => {
    const { h, admin, rule, quote } = await setup();
    const perk = (method: string, path: string, body?: unknown) => h.api<PromotionPerkDto>(method, `/api/admin/promotion-perks${path}`, { token: admin, body });
    assert.equal((await perk("POST", "", { names: { en: "Water" } })).status, 422, "Thai name required");
    const water = await perk("POST", "", { names: { th: "น้ำดื่ม 4 ขวด", en: "4 bottles of water" } });
    assert.equal(water.status, 201, JSON.stringify(water.body));
    const wine = (await perk("POST", "", { names: { th: "ไวน์ผลไม้ 1 ขวด" } })).data;
    assert.equal((await rule({ perkIds: ["nope_perk"] })).error?.details?.perkIds, "UNKNOWN_PERK");
    const made = await rule({ perkIds: [water.data.id, wine.id], promoText: "พัก 2 คืน รับของแถม" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual([...made.data.perkIds!].sort(), [water.data.id, wine.id].sort());
    const list = (await h.api<PromotionPerkDto[]>("GET", "/api/admin/promotion-perks", { token: admin })).data;
    assert.deepEqual(list.map((p) => [p.names.th, p.ruleCount]), [["น้ำดื่ม 4 ขวด", 1], ["ไวน์ผลไม้ 1 ขวด", 1]]);

    const q = await quote();
    assert.deepEqual(q.data.items[0]!.promotions![0]!.perks!.map((p) => p.names.th), ["น้ำดื่ม 4 ขวด", "ไวน์ผลไม้ 1 ขวด"]);
    const search = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-05&checkOut=2027-02-07");
    assert.equal(search.data.units.find((u) => u.unitId === "dev_house_01")!.promotions![0]!.perks![0]!.names.en, "4 bottles of water");

    const booked = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { checkIn: "2027-02-05", checkOut: "2027-02-07", stays: [{ kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0 }], food: [], lang: "th",
        customer: { name: "Guest", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));

    // Renamed and deleted later: off the rule, out of the list; the booking keeps the names it was made with.
    assert.equal((await perk("PATCH", `/${water.data.id}`, { names: { th: "น้ำดื่ม 6 ขวด" } })).data.names.th, "น้ำดื่ม 6 ขวด");
    assert.equal((await perk("DELETE", `/${wine.id}`)).status, 200);
    const after = (await h.api<PricingRuleDto[]>("GET", "/api/admin/pricing-rules", { token: admin })).data.find((r) => r.id === made.data.id)!;
    assert.deepEqual(after.perkIds, [water.data.id]);
    assert.equal((await h.api<PromotionPerkDto[]>("GET", "/api/admin/promotion-perks", { token: admin })).data.length, 1);
    const lookup = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: booked.data.bookingCode, phone: "0812345678" } });
    assert.deepEqual(lookup.data.items[0]!.promotions![0]!.perks!.map((p) => p.names.th), ["น้ำดื่ม 4 ขวด", "ไวน์ผลไม้ 1 ขวด"]);
    assert.equal(h.audits("DELETE_PROMOTION_PERK").length, 1);

    // Staff who may only view prices cannot change the list.
    const viewer = await h.login(await h.user({ id: `perk_viewer_${seq}` }));
    h.grant(`perk_viewer_${seq}`, "accommodation.view");
    assert.equal((await h.api("POST", "/api/admin/promotion-perks", { token: viewer, body: { names: { th: "x" } } })).status, 403);
  });
});
