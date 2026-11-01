import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminUnitDto, CampingSettingsDto } from "../../src/shared/accommodation-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { depositDue, payLaterOf, payLaterOfNights, payNowPercentOf, storedDepositPercent, storedPaymentMode } from "../../src/shared/booking-rules.ts";
import { Harness } from "../helpers/harness.ts";

// Deposit of 60 % / 70 % as well as 50 % (migration 0054). House 01: ฿3,500 / night.

describe("deposit percentage (shared)", () => {
  it("keeps the rest of the stay for check-in, whole baht down; 50 % unchanged", () => {
    assert.deepEqual([payNowPercentOf("FULL"), payNowPercentOf("DEPOSIT_50"), payNowPercentOf("DEPOSIT_60"), payNowPercentOf("DEPOSIT_70")], [100, 50, 60, 70]);
    assert.equal(payLaterOf("FULL", 700_000), 0);
    assert.equal(payLaterOf("DEPOSIT_50", 350_050), 175_000, "as before");
    assert.equal(payLaterOf("DEPOSIT_60", 700_000), 280_000);
    assert.equal(payLaterOf("DEPOSIT_70", 700_000), 210_000);
    assert.equal(payLaterOf("DEPOSIT_70", 333_333), 99_900, "฿999.99 → ฿999");
    assert.equal(depositDue("DEPOSIT_70", 700_000, 760_000), 550_000, "฿7,000 stay + ฿600 food → ฿5,500 now, ฿2,100 later");
    assert.equal(payLaterOfNights("DEPOSIT_60", [{ priceSatang: 350_000 }, { priceSatang: 350_000, payNowPercent: 100 }], 1, 0), 140_000,
      "night without a rule: the stay's 60 %; the rule's night: all now");
    assert.deepEqual(["FULL", "DEPOSIT_50", "DEPOSIT_60", "DEPOSIT_70"].map((m) => [storedPaymentMode(m as "FULL"), storedDepositPercent(m as "FULL")]),
      [["FULL", null], ["DEPOSIT_50", null], ["DEPOSIT_50", 60], ["DEPOSIT_50", 70]]);
  });
});

describe("deposit percentage (admin + booking)", () => {
  it("a house set to 70 % asks 70 % of the stay now; switching back clears the percentage", async () => {
    const h = new Harness({ seed: true });
    const admin = await h.login(await h.user({ id: "root_dep", roles: ["SUPER_ADMIN"] }));
    const setMode = (paymentMode: string) => h.api<AdminUnitDto>("PATCH", "/api/admin/accommodations/dev_house_01", { token: admin, body: { paymentMode } });
    const stored = () => ({ ...h.db.get<{ payment_mode: string; deposit_percent: number | null }>(
      "SELECT payment_mode, deposit_percent FROM accommodation_units WHERE id = 'dev_house_01'") });

    const set = await setMode("DEPOSIT_70");
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.data.paymentMode, "DEPOSIT_70");
    assert.deepEqual(stored(), { payment_mode: "DEPOSIT_50", deposit_percent: 70 });
    assert.equal(h.audits("UPDATE").at(-1)!.new_value!.includes("DEPOSIT_70"), true);

    const body = { checkIn: "2027-01-10", checkOut: "2027-01-12", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th" };
    const q = (await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body })).data;
    assert.equal(q.totalSatang, 700_000);
    assert.equal(q.depositSatang, 490_000, "70 % of ฿7,000");
    const b = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Guest", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.totalSatang, idempotencyKey: "dep-percent-0001" },
    });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.data.depositSatang, 490_000);

    assert.equal((await setMode("DEPOSIT_60")).data.paymentMode, "DEPOSIT_60");
    assert.deepEqual(stored(), { payment_mode: "DEPOSIT_50", deposit_percent: 60 });
    assert.equal((await setMode("DEPOSIT_50")).data.paymentMode, "DEPOSIT_50");
    assert.deepEqual(stored(), { payment_mode: "DEPOSIT_50", deposit_percent: null });
    await setMode("DEPOSIT_70");
    assert.equal((await setMode("FULL")).data.paymentMode, "FULL");
    assert.deepEqual(stored(), { payment_mode: "FULL", deposit_percent: null });
    assert.equal((await setMode("DEPOSIT_80")).status, 422);

    // The deposit of a booking is fixed when it is made.
    assert.equal(h.db.get<{ deposit_satang: number }>("SELECT deposit_satang FROM bookings WHERE booking_code = ?", b.data.bookingCode)!.deposit_satang, 490_000);
  });

  it("a new house can start with a 60 % deposit; camping too", async () => {
    const h = new Harness({ seed: true });
    const admin = await h.login(await h.user({ id: "root_dep2", roles: ["SUPER_ADMIN"] }));
    const made = await h.api<AdminUnitDto>("POST", "/api/admin/accommodations", {
      token: admin,
      body: { unitCode: "HOUSE-77", unitType: "HOUSE", slug: "house-77", basePriceSatang: 200_000, paymentMode: "DEPOSIT_60", standardGuests: 2, maxGuests: 4 },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.data.paymentMode, "DEPOSIT_60");

    const current = (await h.api<CampingSettingsDto>("GET", "/api/admin/camping", { token: admin })).data;
    const { depositBookings: _d, ...rest } = current as CampingSettingsDto & { depositBookings?: unknown };
    const saved = await h.api<CampingSettingsDto>("PUT", "/api/admin/camping", { token: admin, body: { ...rest, paymentMode: "DEPOSIT_70" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.data.paymentMode, "DEPOSIT_70");
    assert.deepEqual({ ...h.db.get<Record<string, unknown>>("SELECT payment_mode, deposit_percent FROM camping_settings WHERE id = 1") }, { payment_mode: "DEPOSIT_50", deposit_percent: 70 });
  });
});
