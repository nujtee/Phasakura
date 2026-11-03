import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DashboardDto } from "../../src/shared/dashboard-types.ts";
import { icalStays } from "../../src/worker/services/dashboard.service.ts";
import { Harness } from "../helpers/harness.ts";

// Dashboard: OTA bookings tile + table (iCal calendar nights joined into stays, and Channex bookings).
// Harness clock: 2027-01-10 Bangkok.

describe("iCal nights → stays (pure)", () => {
  it("joins consecutive nights of one unit from one OTA; a gap or another OTA starts a new stay", () => {
    const n = (unit: string, channel: string, date: string) => ({ unit_id: unit, unit_code: unit.toUpperCase(), unit_name: null, channel, label: null, stay_date: date });
    const stays = icalStays([
      n("h1", "AGODA", "2027-01-10"), n("h1", "AGODA", "2027-01-11"), n("h1", "AGODA", "2027-01-13"),
      n("h1", "BOOKING", "2027-01-14"), n("h2", "AGODA", "2027-01-11"),
    ]);
    assert.deepEqual(stays.map((s) => [s.units, s.channel, s.checkIn, s.checkOut, s.nights]), [
      ["H1", "AGODA", "2027-01-10", "2027-01-12", 2], ["H1", "AGODA", "2027-01-13", "2027-01-14", 1],
      ["H1", "BOOKING", "2027-01-14", "2027-01-15", 1], ["H2", "AGODA", "2027-01-11", "2027-01-12", 1],
    ]);
  });
});

describe("dashboard OTA bookings", () => {
  it("lists iCal and Channex stays not over yet, counts tonight's, and is only for staff who see bookings", async () => {
    const h = new Harness({ seed: true });
    const root = await h.login(await h.user({ id: "root_ota", roles: ["SUPER_ADMIN"] }));
    const now = "2027-01-10T00:00:00.000Z";
    h.db.run(`INSERT INTO ical_feeds (id, unit_id, channel, label, export_token, import_url, created_at, updated_at)
              VALUES ('feed_ag', 'dev_house_01', 'AGODA', NULL, '${"a".repeat(43)}', 'https://agoda.example/ical', ?, ?)`, now, now);
    for (const d of ["2027-01-05", "2027-01-09", "2027-01-10", "2027-01-11", "2027-01-20"]) {
      h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason, created_at, ical_feed_id) VALUES ('dev_house_01', ?, 'Agoda', ?, 'feed_ag')", d, now);
    }
    h.db.run(`INSERT INTO ota_bookings (id, channex_booking_id, booking_id, ota_name, ota_code, status, last_revision_id, arrival_date, departure_date,
                amount_minor, currency, payment_collect, guest_name, problem, created_at, updated_at)
              VALUES ('ota1', '${"1".repeat(36)}', NULL, 'Booking.com', 'BDC-1', 'CONFLICT', '${"2".repeat(36)}', '2027-01-15', '2027-01-17',
                      700000, 'THB', 'ota', 'Jane Guest', 'nights taken', ?, ?)`, now, now);
    h.db.run(`INSERT INTO ota_bookings (id, channex_booking_id, booking_id, ota_name, ota_code, status, last_revision_id, arrival_date, departure_date,
                amount_minor, currency, payment_collect, guest_name, problem, created_at, updated_at)
              VALUES ('ota2', '${"3".repeat(36)}', NULL, 'Agoda', 'AG-2', 'CANCELLED', '${"4".repeat(36)}', '2027-01-15', '2027-01-17',
                      0, 'THB', 'ota', 'Gone', NULL, ?, ?)`, now, now);

    const dash = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: root })).data;
    assert.deepEqual(dash.ota!.stays.map((s) => [s.source, s.channel, s.checkIn, s.checkOut, s.nights, s.status]), [
      ["ICAL", "AGODA", "2027-01-09", "2027-01-12", 3, "ACTIVE"],
      ["CHANNEX", "Booking.com", "2027-01-15", "2027-01-17", 2, "CONFLICT"],
      ["ICAL", "AGODA", "2027-01-20", "2027-01-21", 1, "ACTIVE"],
    ], "the stay of 5 Jan is over; the cancelled Channex booking is left out");
    assert.equal(dash.ota!.tonight, 1);
    assert.equal(dash.ota!.stays[1]!.guestName, "Jane Guest");
    assert.match(dash.ota!.stays[0]!.units, /^HOUSE-01/);

    const viewer = await h.user({ id: "dash_only" });
    h.grant("dash_only", "dashboard.view");
    assert.equal((await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: await h.login(viewer) })).data.ota, null);
  });
});
