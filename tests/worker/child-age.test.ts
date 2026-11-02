import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicAccommodationsDto, PublicUnitDto } from "../../src/shared/accommodation-types.ts";
import type { BookingSettingsDto } from "../../src/shared/dashboard-types.ts";
import { Harness } from "../helpers/harness.ts";

// Child age set in Admin booking rules (migration 0057): shown on the booking and unit pages.

describe("child age (booking rules)", () => {
  it("not set: the camping age; set: that age everywhere; cleared: back to the camping age; validated; audited", async () => {
    const h = new Harness({ seed: true });
    const root = await h.login(await h.user({ id: "root_child", roles: ["SUPER_ADMIN"] }));
    const camping = h.db.get<{ a: number }>("SELECT child_free_under_age AS a FROM camping_settings")!.a;
    const pub = async () => (await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=th")).data.childUnderAge;
    const slug = h.db.get<{ slug: string }>("SELECT slug FROM accommodation_units WHERE id = 'dev_house_01'")!.slug;
    const unit = async () => (await h.api<PublicUnitDto>("GET", `/api/public/accommodations/${slug}?lang=th`)).data.childUnderAge;

    const before = await h.api<BookingSettingsDto>("GET", "/api/admin/booking-settings", { token: root });
    assert.equal(before.data.childUnderAge, null, "migrated, not set");
    assert.equal(await pub(), camping);

    const base = { holdMinutes: 60, maxNights: 30, maxAdvanceDays: 365, maxTentsPerBooking: 10 };
    const saved = await h.api<BookingSettingsDto>("PUT", "/api/admin/booking-settings", { token: root, body: { ...base, childUnderAge: 7 } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.data.childUnderAge, 7);
    assert.equal(await pub(), 7);
    assert.equal(await unit(), 7);

    for (const bad of [0, 19, "7", 7.5]) {
      assert.equal((await h.api("PUT", "/api/admin/booking-settings", { token: root, body: { ...base, childUnderAge: bad } })).status, 422, String(bad));
    }
    // Saving without the field keeps it.
    await h.api("PUT", "/api/admin/booking-settings", { token: root, body: { ...base, holdMinutes: 90 } });
    assert.equal(await pub(), 7);
    await h.api("PUT", "/api/admin/booking-settings", { token: root, body: { ...base, childUnderAge: null } });
    assert.equal(await pub(), camping);
    assert.ok(h.audits("UPDATE_BOOKING_SETTINGS").length >= 3);
  });
});
