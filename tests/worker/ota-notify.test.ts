import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nightRuns, renderOtaNotice } from "../../src/worker/channels/ota-notice.ts";
import { Harness } from "../helpers/harness.ts";

// "Booking from an OTA" notices: LINE + e-mail to staff who want booking news, from iCal calendar reads (and Channex).
// Harness clock: 2027-01-10 10:00 Bangkok.

const AGODA_URL = "https://ycs.agoda.com/en-us/api/ical/export/xyz.ics";
const GROUP = `C${"7a".repeat(16)}`;
const ics = (...events: { start: string; end: string; summary?: string }[]) => [
  "BEGIN:VCALENDAR", "VERSION:2.0",
  ...events.flatMap((e, i) => ["BEGIN:VEVENT", `UID:ev-${i}@ota`, `DTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}`,
    `DTEND;VALUE=DATE:${e.end.replace(/-/g, "")}`, `SUMMARY:${e.summary ?? "Reserved"}`, "END:VEVENT"]),
  "END:VCALENDAR",
].join("\r\n");

describe("OTA notice (pure)", () => {
  it("runs of nights; Thai text with unit, dates, nights; Channex adds guest, amount and the booking link", () => {
    assert.deepEqual(nightRuns(["2027-02-03", "2027-02-01", "2027-02-02", "2027-02-10"]),
      [{ checkIn: "2027-02-01", checkOut: "2027-02-04", nights: 3 }, { checkIn: "2027-02-10", checkOut: "2027-02-11", nights: 1 }]);
    const n = renderOtaNotice({ event: "NEW", source: "ICAL", channel: "Agoda", units: "HOUSE-01 · บ้านซากุระ", checkIn: "2027-02-01", checkOut: "2027-02-04", nights: 3 }, "th");
    assert.ok(!("skip" in n));
    if ("skip" in n) return;
    assert.match(n.title, /การจองใหม่จาก Agoda/);
    assert.match(n.body, /ที่พัก: HOUSE-01 · บ้านซากุระ/);
    assert.match(n.body, /\(3 คืน\)/);
    assert.equal(n.path, "channels");
    const c = renderOtaNotice({ event: "NEW", source: "CHANNEX", channel: "Booking.com", units: "HOUSE-02", checkIn: "2027-02-01", checkOut: "2027-02-02",
      nights: 1, guestName: "Jane", amountMinor: 350000, currency: "THB", bookingCode: "BK-20270110-ABCD" }, "en");
    if ("skip" in c) assert.fail("skipped");
    assert.match(c.body, /Guest: Jane/);
    assert.match(c.body, /Amount: ฿3,500/);
    assert.equal(c.path, "bookings/BK-20270110-ABCD");
    assert.deepEqual(renderOtaNotice({}, "th"), { skip: "NOT_RELEVANT" });
  });
});

describe("OTA notices from iCal calendar reads", () => {
  it("first read: nothing (the nights were already there); later reads: new nights and nights given back → LINE + e-mail", async () => {
    const h = new Harness({ seed: true });
    h.env.APP_BASE_URL = "https://phasakura.test";
    const root = await h.login(await h.user({ id: "root_ota_n", roles: ["SUPER_ADMIN"] }));
    await h.api("PUT", "/api/admin/channels/settings", { token: root, body: { ical: true } });
    h.lineSecrets();
    h.db.run("UPDATE line_settings SET enabled = 1");
    assert.equal((await h.api("POST", "/api/admin/line/recipients", { token: root,
      body: { targetId: GROUP, name: "Owners", language: "th", notifyBooking: true } })).status, 201);
    h.emailKey();
    await h.api("PUT", "/api/admin/email/settings", { token: root, body: { enabled: true, guestEnabled: false, fromEmail: "booking@phasakura.test" } });
    assert.equal((await h.api("POST", "/api/admin/email/recipients", { token: root, body: { email: "owner@phasakura.test", name: "Owner", language: "th" } })).status, 201);
    const notices = (table: "notification_logs" | "email_logs") =>
      h.db.all<{ payload_json: string }>(`SELECT payload_json FROM ${table} WHERE notification_type = 'OTA_BOOKING' ORDER BY created_at, idempotency_key`)
        .map((r) => JSON.parse(r.payload_json) as { event: string; checkIn: string; checkOut: string; nights: number; channel: string });

    h.icalFiles.set(AGODA_URL, ics({ start: "2027-02-01", end: "2027-02-03" }));
    assert.equal((await h.api("PUT", "/api/admin/channels/ical/dev_house_01/agoda", { token: root, body: { importUrl: AGODA_URL } })).status, 200);
    h.advance(6 * 60_000);
    await h.app.scheduled(h.env);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE ical_feed_id IS NOT NULL")!.n, 2);
    assert.equal(notices("notification_logs").length, 0, "first read: no notice for nights that were already there");

    // A new Agoda booking and the old one gone.
    h.icalFiles.set(AGODA_URL, ics({ start: "2027-02-10", end: "2027-02-13", summary: "Reserved - Agoda" }));
    h.advance(6 * 60_000);
    await h.app.scheduled(h.env);
    const line = notices("notification_logs");
    assert.deepEqual(line.map((p) => [p.event, p.channel, p.checkIn, p.checkOut, p.nights]).sort(), [
      ["CANCELLED", "Agoda", "2027-02-01", "2027-02-03", 2], ["NEW", "Agoda", "2027-02-10", "2027-02-13", 3],
    ]);
    assert.equal(notices("email_logs").length, 2);

    // Delivered (the next cron runs send them).
    h.advance(2 * 60_000);
    await h.app.scheduled(h.env);
    const pushed = JSON.stringify(h.line.pushes);
    assert.match(pushed, /การจองใหม่จาก Agoda/);
    assert.match(pushed, /Agoda ยกเลิก/);
    assert.ok(pushed.includes("https://phasakura.test/th/admin/channels"), "link to OTA channels");
    const mail = h.resend.requests.find((r) => /การจองใหม่จาก Agoda/.test(String(r.json!.subject)));
    assert.ok(mail, h.resend.requests.map((r) => r.json!.subject).join(" | "));
    assert.match(String(mail!.json!.text), /HOUSE-01/);

    // Same calendar again: nothing new.
    h.advance(6 * 60_000);
    await h.app.scheduled(h.env);
    assert.equal(notices("notification_logs").length, 2);
  });
});
