import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminUnitDto } from "../../src/shared/accommodation-types.ts";
import type { PricingRuleDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { payLaterOf, payLaterOfNights } from "../../src/shared/booking-rules.ts";
import { Harness } from "../helpers/harness.ts";

// Pay-now percentage per price rule (migration 0049). Harness clock: 2027-01-10 Bangkok. House 01 ฿3,500 / night.
let seq = 0;
const key = () => `rule-dep-${String(++seq).padStart(10, "0")}`;

describe("pay-now percentage of price rules (shared)", () => {
  it("each night at its rule's percentage, extras at the same share, whole baht down; no percentage = the old plan", () => {
    const n = (priceSatang: number, payNowPercent: number | null = null) => ({ priceSatang, payNowPercent });
    assert.equal(payLaterOfNights("DEPOSIT_50", [n(350_000), n(350_000)], 1, 60_000), payLaterOf("DEPOSIT_50", 760_000), "identical without rule percentages");
    assert.equal(payLaterOfNights("FULL", [n(350_000), n(350_000)], 1, 0), 0);
    // 30 % now on both nights: 70 % of ฿7,000 later, and 70 % of the ฿600 extras.
    assert.equal(payLaterOfNights("FULL", [n(350_000, 30), n(350_000, 30)], 1, 60_000), 532_000);
    // Mixed: one rule night at 20 %, one plain night on a FULL house (100 %): ฿2,800 later.
    assert.equal(payLaterOfNights("FULL", [n(350_000, 20), n(350_000)], 1, 0), 280_000);
    // Mixed on a DEPOSIT_50 house: ฿2,800 + ฿1,750.
    assert.equal(payLaterOfNights("DEPOSIT_50", [n(350_000, 20), n(350_000)], 1, 0), 455_000);
    // 100 % on a deposit house: nothing later for those nights.
    assert.equal(payLaterOfNights("DEPOSIT_50", [n(350_000, 100)], 1, 0), 0);
    // Camping: per adult (factor) and whole baht down.
    assert.equal(payLaterOfNights("FULL", [n(25_050, 10)], 3, 0), 67_600, "90 % of ฿751.50 = ฿676.35 → ฿676");
  });
});

describe("price rule with a pay-now percentage", () => {
  async function setup() {
    const h = new Harness({ seed: true });
    const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
    const rule = (body: Record<string, unknown>) => h.api<PricingRuleDto>("POST", "/api/admin/pricing-rules", {
      token: admin, body: { targetType: "UNIT", unitId: "dev_house_01", name: "High season", dateFrom: "2027-02-01", dateTo: "2027-02-28", priceSatang: 400_000, priority: 5, ...body },
    });
    const body = { checkIn: "2027-02-05", checkOut: "2027-02-07", stays: [{ kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0 }], food: [], lang: "th" };
    const quote = () => h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    return { h, admin, rule, quote, body };
  }

  it("is saved, listed, validated and changed; the quote and the booking ask that share now, the rest at check-in", async () => {
    const { h, admin, rule, quote, body } = await setup();
    for (const bad of [5, 0, 110, "30", 33]) {
      assert.equal((await rule({ payNowPercent: bad })).error?.details?.payNowPercent, "INVALID_VALUE", String(bad));
    }
    const created = await rule({ payNowPercent: 30 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.data.payNowPercent, 30);
    const list = await h.api<PricingRuleDto[]>("GET", "/api/admin/pricing-rules", { token: admin });
    assert.equal(list.data.find((r) => r.id === created.data.id)?.payNowPercent, 30);

    // 2 nights × ฿4,000 at 30 % now: ฿5,600 left for check-in, ฿2,400 now.
    const q = await quote();
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.data.accommodationSubtotalSatang, 800_000);
    assert.equal(q.data.items[0]!.payLaterSatang, 560_000);
    assert.equal(q.data.depositSatang, q.data.totalSatang - 560_000);
    const booked = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Guest", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.equal(booked.data.depositSatang, q.data.depositSatang);
    assert.equal(booked.data.paymentInstructions?.amountDueSatang, q.data.depositSatang, "the guest is asked for 30 %");

    // Changed to 100 %: future quotes pay in full; the booking keeps its deposit. Then back to the unit's plan.
    const full = await h.api<PricingRuleDto>("PATCH", `/api/admin/pricing-rules/${created.data.id}`, { token: admin, body: { payNowPercent: 100 } });
    assert.equal(full.data.payNowPercent, 100);
    const lookup = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: booked.data.bookingCode, phone: "0812345678" } });
    assert.equal(lookup.data.depositSatang, q.data.depositSatang);
    const plan = await h.api<PricingRuleDto>("PATCH", `/api/admin/pricing-rules/${created.data.id}`, { token: admin, body: { payNowPercent: null } });
    assert.equal(plan.data.payNowPercent, null);
    // Other edits keep the percentage.
    await h.api("PATCH", `/api/admin/pricing-rules/${created.data.id}`, { token: admin, body: { payNowPercent: 50 } });
    const renamed = await h.api<PricingRuleDto>("PATCH", `/api/admin/pricing-rules/${created.data.id}`, { token: admin, body: { name: "Peak" } });
    assert.equal(renamed.data.payNowPercent, 50);
    assert.equal(h.audits("UPDATE_PRICING_RULE").length, 4);
  });

  it("a deposit house: nights of the rule at its percentage, other nights at 50 %", async () => {
    const { h, admin, rule } = await setup();
    const unit = await h.api<AdminUnitDto>("PATCH", "/api/admin/accommodations/dev_house_01", { token: admin, body: { paymentMode: "DEPOSIT_50" } });
    assert.equal(unit.status, 200, JSON.stringify(unit.body));
    await rule({ dateFrom: "2027-02-06", dateTo: "2027-02-06", payNowPercent: 20 });
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", {
      body: { checkIn: "2027-02-05", checkOut: "2027-02-07", stays: [{ kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0 }], food: [], lang: "th" },
    });
    // 5 Feb ฿3,500 at 50 % → ฿1,750 later; 6 Feb ฿4,000 at 20 % → ฿3,200 later.
    assert.equal(q.data.items[0]!.payLaterSatang, 175_000 + 320_000);
  });
});
