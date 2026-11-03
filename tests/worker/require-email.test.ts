import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicAccommodationsDto } from "../../src/shared/accommodation-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { BookingSettingsDto } from "../../src/shared/dashboard-types.ts";
import { Harness } from "../helpers/harness.ts";

// E-mail required on website bookings (migration 0058): on for real sites, switchable in booking rules.
// (The dev seed switches it off so sample bookings need no address.)
let seq = 0;

describe("e-mail required when booking", () => {
  it("on: a booking without e-mail is refused (customer.email REQUIRED), with one it goes through; off: optional again", async () => {
    const h = new Harness({ seed: true });
    const root = await h.login(await h.user({ id: "root_mail_req", roles: ["SUPER_ADMIN"] }));
    const base = { holdMinutes: 60, maxNights: 30, maxAdvanceDays: 365, maxTentsPerBooking: 10 };
    assert.equal((await h.api<BookingSettingsDto>("GET", "/api/admin/booking-settings", { token: root })).data.requireEmail, false, "dev seed: off");
    const on = await h.api<BookingSettingsDto>("PUT", "/api/admin/booking-settings", { token: root, body: { ...base, requireEmail: true } });
    assert.equal(on.data.requireEmail, true);
    assert.equal((await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=th")).data.requireEmail, true, "the form is told");

    const stay = { checkIn: "2027-02-01", checkOut: "2027-02-02", stays: [{ kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0 }], food: [], lang: "th" };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: stay });
    const book = (customer: Record<string, unknown>, unitId = "dev_house_01") => h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...stay, stays: [{ kind: "UNIT", unitId, adults: 2, children: 0 }], customer, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `mail-req-${String(++seq).padStart(10, "0")}` },
    });
    const refused = await book({ name: "Guest", phone: "0812345678" });
    assert.equal(refused.status, 422);
    assert.equal(refused.error?.details?.["customer.email"], "REQUIRED");
    assert.equal((await book({ name: "Guest", phone: "0812345678", email: "not-an-email" })).error?.details?.["customer.email"], "INVALID_EMAIL");
    assert.equal((await book({ name: "Guest", phone: "0812345678", email: "guest@example.test" })).status, 201);

    await h.api("PUT", "/api/admin/booking-settings", { token: root, body: { ...base, requireEmail: false } });
    const q2 = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: { ...stay, stays: [{ kind: "UNIT", unitId: "dev_house_02", adults: 2, children: 0 }] } });
    const off = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...stay, stays: [{ kind: "UNIT", unitId: "dev_house_02", adults: 2, children: 0 }], customer: { name: "Guest 2", phone: "0812345679" },
        privacyAccepted: true, expectedTotalSatang: q2.data.totalSatang, idempotencyKey: "mail-req-off-000001" },
    });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    assert.equal((await h.api("PUT", "/api/admin/booking-settings", { token: root, body: { ...base, requireEmail: "yes" } })).status, 422);
  });

  it("a fresh site (migrations only, no dev seed) asks for it", async () => {
    const h = new Harness();
    const row = h.db.get<{ require_email: number }>("SELECT require_email FROM booking_settings WHERE id = 1")!;
    assert.equal(row.require_email, 1);
  });
});
