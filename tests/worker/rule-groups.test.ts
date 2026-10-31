import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PricingRuleDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { Harness } from "../helpers/harness.ts";

// One price rule for several chosen houses (migration 0051). Harness clock: 2027-01-10. House 01 ฿3,500, House 02 ฿3,200.
let seq = 0;

describe("price rule for a group of houses", () => {
  async function setup() {
    const h = new Harness({ seed: true });
    const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
    const rule = { targetType: "UNITS", unitIds: ["dev_house_01", "dev_house_02"], name: "Long weekend", dateFrom: "2027-02-01", dateTo: "2027-02-28", priceSatang: 500_000, priority: 5, payNowPercent: 30 };
    const price = async (unitId: string) => (await h.api<QuoteDto>("POST", "/api/public/bookings/quote", {
      body: { checkIn: "2027-02-05", checkOut: "2027-02-06", stays: [{ kind: "UNIT", unitId, adults: 2, children: 0 }], food: [], lang: "th" },
    })).data.items[0]!;
    const list = async () => (await h.api<PricingRuleDto[]>("GET", "/api/admin/pricing-rules", { token: admin })).data;
    return { h, admin, rule, price, list };
  }

  it("is one rule in admin, prices every chosen house (not the others), and is edited as one", async () => {
    const { h, admin, rule, price, list } = await setup();
    const vip = h.db.get<{ id: string }>("SELECT id FROM accommodation_units WHERE unit_type = 'VIP_TENT' LIMIT 1")!.id;
    const vipBefore = (await price(vip)).subtotalSatang;

    const made = await h.api<PricingRuleDto>("POST", "/api/admin/pricing-rules", { token: admin, body: rule });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.data.targetType, "UNITS");
    assert.deepEqual(made.data.unitIds, ["dev_house_01", "dev_house_02"]);
    assert.equal(made.data.payNowPercent, 30);
    assert.equal((await list()).filter((r) => r.name === "Long weekend").length, 1, "listed once");
    assert.equal(h.db.all("SELECT 1 FROM pricing_settings WHERE group_id = ?", made.data.id).length, 2, "one UNIT rule per house");

    assert.equal((await price("dev_house_01")).subtotalSatang, 500_000);
    assert.equal((await price("dev_house_02")).subtotalSatang, 500_000);
    assert.equal((await price("dev_house_02")).payLaterSatang, 350_000, "the group's pay-now percentage");
    assert.equal((await price(vip)).subtotalSatang, vipBefore, "a house not chosen keeps its price");

    // Edit the group: new price, VIP tent added, House 02 taken out (its rule switched off, kept, out of the group).
    const edited = await h.api<PricingRuleDto>("PATCH", `/api/admin/pricing-rules/${made.data.id}`, {
      token: admin, body: { priceSatang: 450_000, unitIds: ["dev_house_01", vip] },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual([...edited.data.unitIds!].sort(), ["dev_house_01", vip].sort());
    assert.equal(edited.data.priceSatang, 450_000);
    assert.equal((await price("dev_house_01")).subtotalSatang, 450_000);
    assert.equal((await price(vip)).subtotalSatang, 450_000);
    assert.equal((await price("dev_house_02")).subtotalSatang, 320_000, "back to its own price");
    const out = (await list()).find((r) => r.targetType === "UNIT" && r.unitId === "dev_house_02" && r.name === "Long weekend");
    assert.equal(out?.status, "INACTIVE", "kept as an inactive rule of its own");
    assert.ok(h.db.all("SELECT 1 FROM price_history WHERE entity_type = 'PRICING_RULE'").length >= 4, "2 created, 1 price change, 1 house added");

    // Switch the whole group off.
    await h.api("PATCH", `/api/admin/pricing-rules/${made.data.id}`, { token: admin, body: { status: "INACTIVE" } });
    assert.equal((await price("dev_house_01")).subtotalSatang, 350_000);
  });

  it("validates the houses; a member is edited through its group; single and group rules keep their kind", async () => {
    const { h, admin, rule } = await setup();
    const post = (body: Record<string, unknown>) => h.api("POST", "/api/admin/pricing-rules", { token: admin, body });
    assert.equal((await post({ ...rule, unitIds: [] })).error?.details?.unitIds, "REQUIRED");
    assert.equal((await post({ ...rule, unitIds: ["nope"] })).error?.details?.unitIds, "UNKNOWN_UNIT");
    assert.equal((await post({ ...rule, unitIds: "dev_house_01" })).error?.details?.unitIds, "INVALID_VALUE");
    const group = (await post(rule)).data as PricingRuleDto;
    const member = h.db.get<{ id: string }>("SELECT id FROM pricing_settings WHERE group_id = ? LIMIT 1", group.id)!.id;
    assert.equal((await h.api("PATCH", `/api/admin/pricing-rules/${member}`, { token: admin, body: { priceSatang: 1 } })).error?.details?.id, "PART_OF_GROUP");
    assert.equal((await h.api("PATCH", `/api/admin/pricing-rules/${group.id}`, { token: admin, body: { targetType: "UNIT_TYPE", unitType: "HOUSE" } })).error?.details?.targetType, "GROUP_STAYS_GROUP");
    const single = (await post({ ...rule, targetType: "UNIT", unitId: "dev_house_01", unitIds: undefined })).data as PricingRuleDto;
    assert.equal((await h.api("PATCH", `/api/admin/pricing-rules/${single.id}`, { token: admin, body: { targetType: "UNITS", unitIds: ["dev_house_02"] } })).error?.details?.targetType, "CANNOT_BECOME_GROUP");
  });
});
