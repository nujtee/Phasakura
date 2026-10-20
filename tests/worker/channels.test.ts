import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelsDto, IcalFeedDto } from "../../src/shared/channel-types.ts";
import type { CalendarDto, CalendarLockResultDto } from "../../src/shared/dashboard-types.ts";
import type { AvailabilityDto } from "../../src/shared/accommodation-types.ts";
import { buildIcs, nightsOf, parseIcs, rangesOf } from "../../src/worker/services/ical.ts";
import { validImportUrl } from "../../src/worker/services/channel.service.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10 10:00 Bangkok.
const BOOKING_URL = "https://admin.booking.com/hotel/hoteladmin/ical.html?t=abc";
const AGODA_URL = "https://ycs.agoda.com/en-us/api/ical/export/xyz.ics";
const AIRBNB_URL = "https://www.airbnb.com/calendar/ical/123456.ics?s=secret";

function ics(...events: { start: string; end?: string; uid?: string; summary?: string; status?: string; dateTime?: boolean }[]): string {
  const d = (x: string) => x.replace(/-/g, "");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OTA//EN",
    ...events.flatMap((e, i) => [
      "BEGIN:VEVENT",
      `UID:${e.uid ?? `ev-${i}@ota`}`,
      e.dateTime ? `DTSTART:${d(e.start)}T140000Z` : `DTSTART;VALUE=DATE:${d(e.start)}`,
      ...(e.end ? [e.dateTime ? `DTEND:${d(e.end)}T120000Z` : `DTEND;VALUE=DATE:${d(e.end)}`] : []),
      `SUMMARY:${e.summary ?? "CLOSED - Not available"}`,
      ...(e.status ? [`STATUS:${e.status}`] : []),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
}

let seq = 0;
async function staff(h: Harness, roles: string[], perms: string[] = []) {
  const id = `ch_${++seq}`;
  const email = await h.user({ id, roles });
  for (const p of perms) h.grant(id, p);
  return { id, token: await h.login(email) };
}

async function setup(opts: { on?: boolean } = { on: true }) {
  const h = new Harness({ seed: true });
  const owner = await staff(h, ["SUPER_ADMIN"]);
  if (opts.on) assert.equal((await h.api("PUT", "/api/admin/channels/settings", { token: owner.token, body: { ical: true } })).status, 200);
  const overview = async (token = owner.token) => (await h.api<ChannelsDto>("GET", "/api/admin/channels", { token })).data;
  const feed = async (unitId: string, channel: "BOOKING" | "AGODA" | "AIRBNB" | "VRBO" | "OTHER", token = owner.token) =>
    (await overview(token)).ical.feeds.find((f) => f.unitId === unitId && f.channel === channel)!;
  const link = (unitId: string, channel: "BOOKING" | "AGODA" | "AIRBNB" | "VRBO" | "OTHER", importUrl: string | null, token = owner.token) =>
    h.api<IcalFeedDto>("PUT", `/api/admin/channels/ical/${unitId}/${channel.toLowerCase()}`, { token, body: { importUrl } });
  const imported = (unitId: string) =>
    h.db.all<{ stay_date: string; block_reason: string }>("SELECT stay_date, block_reason FROM booking_unit_nights WHERE unit_id = ? AND ical_feed_id IS NOT NULL ORDER BY stay_date", unitId)
      .map((r) => `${r.stay_date} ${r.block_reason}`);
  const publicIcs = async (url: string) => {
    const path = new URL(url).pathname;
    const res = await h.app.fetch(new Request(`https://phasakura.test${path}`, { headers: { "CF-Connecting-IP": "198.51.100.20" } }), h.env);
    return { status: res.status, type: res.headers.get("Content-Type"), text: await res.text() };
  };
  return { h, owner, overview, feed, link, imported, publicIcs };
}

function bookUnit(h: Harness, unitId: string, checkIn: string, nights: number, code: string) {
  const id = `b-${code}`;
  h.db.run(
    `INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults, customer_name,
       customer_phone, customer_phone_normalized, accommodation_subtotal_satang, subtotal_satang, total_satang, booking_status)
     VALUES (?, ?, 'th', ?, date(?, '+' || ? || ' days'), ?, 2, 'Private Guest', '0812345678', '0812345678', 1, 1, 1, 'CONFIRMED')`,
    id, code, checkIn, checkIn, nights, nights,
  );
  h.db.run("INSERT INTO booking_items (id, booking_id, item_type, unit_id, adults) SELECT ?, ?, unit_type, id, 2 FROM accommodation_units WHERE id = ?", `i-${code}`, id, unitId);
  for (let i = 0; i < nights; i++) {
    h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, booking_id, booking_item_id) VALUES (?, date(?, '+' || ? || ' days'), ?, ?)", unitId, checkIn, i, id, `i-${code}`);
  }
  return id;
}

describe("iCal files", () => {
  it("reads all-day and date-time events, folded lines, no DTEND, DURATION; skips cancelled and junk", () => {
    const text = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a", "DTSTART;VALUE=DATE:20270201", "DTEND;VALUE=DATE:20270204", "SUMMARY:Reserved - Mr",
      " . Long Name", "END:VEVENT",
      "BEGIN:VEVENT", "UID:b", "DTSTART:20270210T140000Z", "DTEND:20270211T110000Z", "END:VEVENT",
      "BEGIN:VEVENT", "UID:c", "DTSTART;VALUE=DATE:20270220", "END:VEVENT",
      "BEGIN:VEVENT", "UID:d", "DTSTART;VALUE=DATE:20270301", "DURATION:P2D", "END:VEVENT",
      "BEGIN:VEVENT", "UID:e", "DTSTART;VALUE=DATE:20270305", "DTEND;VALUE=DATE:20270306", "STATUS:CANCELLED", "END:VEVENT",
      "BEGIN:VEVENT", "UID:f", "DTSTART:garbage", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const events = parseIcs(text);
    assert.deepEqual(events.map((e) => [e.uid, e.start, e.end]), [
      ["a", "2027-02-01", "2027-02-04"], ["b", "2027-02-10", "2027-02-11"], ["c", "2027-02-20", "2027-02-21"], ["d", "2027-03-01", "2027-03-03"],
    ]);
    assert.equal(events[0]!.summary, "Reserved - Mr. Long Name");
    assert.deepEqual([...nightsOf(events, "2027-02-02", "2027-02-11")].sort(), ["2027-02-02", "2027-02-03", "2027-02-10"]);
    assert.throws(() => parseIcs("<html>login</html>"), /NOT_A_CALENDAR/);
  });

  it("writes one all-day event per run of nights, CRLF, folded, no guest data", () => {
    assert.deepEqual(rangesOf(["2027-02-03", "2027-02-01", "2027-02-02", "2027-02-05"]), [
      { start: "2027-02-01", end: "2027-02-04" }, { start: "2027-02-05", end: "2027-02-06" },
    ]);
    const out = buildIcs({ name: "HOUSE-01", uidPrefix: "u1-booking", host: "phasakura.com", ranges: rangesOf(["2027-02-01", "2027-02-02"]), now: new Date("2027-01-10T03:00:00Z") });
    assert.match(out, /^BEGIN:VCALENDAR\r\n/);
    assert.match(out, /DTSTART;VALUE=DATE:20270201\r\nDTEND;VALUE=DATE:20270203\r\nSUMMARY:Not available/);
    assert.ok(out.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75));
    assert.deepEqual(parseIcs(out).map((e) => [e.start, e.end]), [["2027-02-01", "2027-02-03"]], "round trip");
  });

  it("accepts only public https calendar links", () => {
    assert.equal(validImportUrl(` ${BOOKING_URL} `), BOOKING_URL);
    for (const bad of ["http://admin.booking.com/x.ics", "https://localhost/x", "https://127.0.0.1/x.ics", "https://user:pw@ota.com/x",
      "https://ota.com:8443/x", "https://intranet/x", "ftp://ota.com/x", "not a url", `https://ota.com/${"a".repeat(2000)}`]) {
      assert.throws(() => validImportUrl(bad), /Validation/, bad);
    }
  });
});

describe("OTA channels — on / off switch", () => {
  it("off by default; only SUPER_ADMIN switches (audited); others see the page; Channex needs its key", async () => {
    const { h, owner, overview } = await setup({ on: false });
    const manager = await staff(h, ["MANAGER"]);
    const viewer = await staff(h, ["VIEWER"]);
    const before = await overview();
    assert.equal(before.ical.enabled, false);
    assert.deepEqual([before.channex.enabled, before.channex.available], [false, false], "no CHANNEX_API_KEY on this site");
    assert.equal(before.canToggle, true);
    assert.equal((await overview(manager.token)).canToggle, false);
    assert.equal((await h.api("GET", "/api/admin/channels", { token: viewer.token })).status, 403);
    assert.equal((await h.api("PUT", "/api/admin/channels/settings", { token: manager.token, body: { ical: true } })).status, 403);
    assert.equal((await h.api("PUT", "/api/admin/channels/settings", { token: owner.token, body: { ical: "yes" } })).status, 422);
    const on = await h.api<ChannelsDto>("PUT", "/api/admin/channels/settings", { token: owner.token, body: { ical: true } });
    assert.equal(on.data.ical.enabled, true);
    assert.equal(h.audits("CHANNEL_ICAL_ON").length, 1);
    // channels.toggle is never handed to another role or one user.
    assert.throws(() => h.grant(manager.id, "channels.toggle"), /CHANNELS_TOGGLE_SUPER_ADMIN_ONLY/);
    assert.throws(() => h.db.run("INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_manager', 'perm_channels_toggle')"), /SUPER_ADMIN_ONLY/);
  });

  it("while off: links answer 404, nothing is read, nothing can be linked", async () => {
    const { h, owner, feed, link, publicIcs } = await setup();
    const exportUrl = (await feed("dev_house_01", "BOOKING")).exportUrl!;
    assert.equal((await publicIcs(exportUrl)).status, 200);
    h.icalFiles.set(BOOKING_URL, ics({ start: "2027-02-01", end: "2027-02-03" }));
    assert.equal((await link("dev_house_01", "BOOKING", BOOKING_URL)).status, 200);
    await h.api("PUT", "/api/admin/channels/settings", { token: owner.token, body: { ical: false } });
    assert.equal((await publicIcs(exportUrl)).status, 404);
    assert.equal((await link("dev_house_01", "AGODA", AGODA_URL)).error?.code, "ICAL_DISABLED");
    const reads = h.icalReads.length;
    h.advance(60 * 60_000);
    await h.app.scheduled(h.env);
    assert.equal(h.icalReads.length, reads, "the cron reads nothing while off");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE ical_feed_id IS NOT NULL")!.n, 2, "imported nights stay closed");
  });
});

describe("OTA channels — iCal export", () => {
  it("every unavailable night of the unit, without the nights imported from the same OTA, no guest data", async () => {
    const { h, owner, feed, link, publicIcs } = await setup();
    bookUnit(h, "dev_house_01", "2027-02-01", 2, "BK-20270201-AAAA");
    h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason, created_by) VALUES ('dev_house_01', '2027-02-05', 'Repair', ?)", owner.id);
    bookUnit(h, "dev_house_02", "2027-02-01", 1, "BK-20270201-BBBB");
    h.icalFiles.set(BOOKING_URL, ics({ start: "2027-03-01", end: "2027-03-03" }));
    h.icalFiles.set(AGODA_URL, ics({ start: "2027-04-01", end: "2027-04-02" }));
    await link("dev_house_01", "BOOKING", BOOKING_URL);
    await link("dev_house_01", "AGODA", AGODA_URL);

    const forBooking = await publicIcs((await feed("dev_house_01", "BOOKING")).exportUrl!);
    assert.equal(forBooking.status, 200);
    assert.equal(forBooking.type, "text/calendar; charset=utf-8");
    assert.deepEqual(parseIcs(forBooking.text).map((e) => [e.start, e.end]), [
      ["2027-02-01", "2027-02-03"], ["2027-02-05", "2027-02-06"], ["2027-04-01", "2027-04-02"],
    ], "Agoda's night goes to Booking.com; Booking.com's own nights do not come back to it");
    assert.doesNotMatch(forBooking.text, /Private Guest|BK-2027|Repair/);
    const forAgoda = parseIcs((await publicIcs((await feed("dev_house_01", "AGODA")).exportUrl!)).text).map((e) => e.start);
    assert.deepEqual(forAgoda, ["2027-02-01", "2027-02-05", "2027-03-01"]);
    // Airbnb: its own nights stay out of its calendar; both other OTAs' nights go in.
    h.icalFiles.set(AIRBNB_URL, ics({ start: "2027-05-01", end: "2027-05-03" }));
    const air = await link("dev_house_01", "AIRBNB", AIRBNB_URL);
    assert.equal(air.data.importedNights, 2);
    assert.equal(air.data.lastImportStatus, "OK");
    const forAirbnb = parseIcs((await publicIcs((await feed("dev_house_01", "AIRBNB")).exportUrl!)).text).map((e) => e.start);
    assert.deepEqual(forAirbnb, ["2027-02-01", "2027-02-05", "2027-03-01", "2027-04-01"]);
    assert.ok(parseIcs((await publicIcs((await feed("dev_house_01", "BOOKING")).exportUrl!)).text).some((e) => e.start === "2027-05-01"));
    assert.ok((await feed("dev_house_01", "BOOKING")).lastExportAt, "the OTA's last read is shown");

    // A wrong / renewed link is 404.
    const old = (await feed("dev_house_01", "BOOKING")).exportUrl!;
    assert.equal((await publicIcs(old.replace(/[A-Za-z0-9_-]{43}\.ics$/, `${"x".repeat(43)}.ics`))).status, 404);
    const renewed = await h.api<IcalFeedDto>("POST", "/api/admin/channels/ical/dev_house_01/booking/rotate", { token: owner.token, body: {} });
    assert.notEqual(renewed.data.exportUrl, old);
    assert.equal((await publicIcs(old)).status, 404);
    assert.equal((await publicIcs(renewed.data.exportUrl!)).status, 200);
    assert.equal(h.audits("ICAL_EXPORT_LINK_RENEWED").length, 1);
  });

  it("links are shown only to channels.edit; a viewer with channels.view sees status only", async () => {
    const { h, overview } = await setup();
    await overview();
    const bookingAdmin = await staff(h, ["BOOKING_ADMIN"]);
    const seen = await overview(bookingAdmin.token);
    assert.equal(seen.ical.feeds.length, 25, "5 units × Booking.com, Agoda, Airbnb, Vrbo, Other");
    assert.ok(seen.ical.feeds.every((f) => f.exportUrl === null && f.importUrl === null));
    assert.equal((await h.api("POST", "/api/admin/channels/ical/dev_house_01/booking/rotate", { token: bookingAdmin.token, body: {} })).status, 403);
  });
});

describe("OTA channels — iCal import", () => {
  it("OTA nights become blocks (shown on the calendar, not bookable, not unlockable by hand); removed nights free up", async () => {
    const { h, owner, link, imported, feed } = await setup();
    h.icalFiles.set(BOOKING_URL, ics({ start: "2027-02-01", end: "2027-02-03" }, { start: "2027-01-05", end: "2027-01-08", summary: "past" }));
    const res = await link("dev_house_01", "BOOKING", BOOKING_URL);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.lastImportStatus, "OK");
    assert.equal(res.data.importedNights, 2);
    assert.deepEqual(imported("dev_house_01"), ["2027-02-01 iCal · Booking.com", "2027-02-02 iCal · Booking.com"], "past nights are ignored");
    assert.equal(h.audits("ICAL_IMPORT_SET").length, 1);
    assert.doesNotMatch(JSON.stringify(h.audits("ICAL_IMPORT_SET")), /t=abc/, "the secret part of the OTA link is not logged");

    const pub = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-02&checkOut=2027-02-03");
    assert.equal(pub.data.units.find((u) => u.unitId === "dev_house_01")!.available, false);
    const cal = await h.api<CalendarDto>("GET", "/api/admin/calendar?from=2027-02-01&to=2027-02-03", { token: owner.token });
    assert.deepEqual(cal.data.nights.filter((n) => n.unitId === "dev_house_01").map((n) => [n.blockReason, n.icalChannel]),
      [["iCal · Booking.com", "BOOKING"], ["iCal · Booking.com", "BOOKING"]]);
    const unlock = await h.api<CalendarLockResultDto>("POST", "/api/admin/calendar/locks", { token: owner.token, body: { action: "UNLOCK", cells: ["dev_house_01:2027-02-01"] } });
    assert.deepEqual(unlock.data, { action: "UNLOCK", units: 0, camping: 0, skipped: 1 });
    await h.api("DELETE", "/api/admin/accommodations/dev_house_01/blocks?startDate=2027-02-01&endDate=2027-02-02", { token: owner.token });
    assert.equal(imported("dev_house_01").length, 2, "the old unblock endpoint leaves OTA nights alone too");

    // The OTA frees one night and adds another; read again after 15 minutes by the cron.
    h.icalFiles.set(BOOKING_URL, ics({ start: "2027-02-02", end: "2027-02-03" }, { start: "2027-02-10", end: "2027-02-11" }));
    h.advance(5 * 60_000);
    await h.app.scheduled(h.env);
    assert.equal(imported("dev_house_01").length, 2, "not due yet");
    h.advance(11 * 60_000);
    await h.app.scheduled(h.env);
    assert.deepEqual(imported("dev_house_01"), ["2027-02-02 iCal · Booking.com", "2027-02-10 iCal · Booking.com"]);
    assert.equal((await feed("dev_house_01", "BOOKING")).importedNights, 2);

    // Unlinking frees the OTA's nights.
    const off = await link("dev_house_01", "BOOKING", null);
    assert.equal(off.data.importSet, false);
    assert.deepEqual(imported("dev_house_01"), []);
  });

  it("a night already blocked by staff or the other OTA is left as it is; once that block goes, the OTA holds it", async () => {
    const { h, owner, link, imported } = await setup();
    h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason, created_by) VALUES ('dev_house_01', '2027-02-01', 'Repair', ?)", owner.id);
    h.icalFiles.set(BOOKING_URL, ics({ start: "2027-02-01", end: "2027-02-02" }));
    await link("dev_house_01", "BOOKING", BOOKING_URL);
    assert.deepEqual(imported("dev_house_01"), []);
    await h.api("POST", "/api/admin/calendar/locks", { token: owner.token, body: { action: "UNLOCK", cells: ["dev_house_01:2027-02-01"] } });
    await h.api("POST", "/api/admin/channels/ical/dev_house_01/booking/sync", { token: owner.token, body: {} });
    assert.deepEqual(imported("dev_house_01"), ["2027-02-01 iCal · Booking.com"]);
  });

  it("a night sold on the OTA that is booked here is a double booking: listed, CRITICAL event once, clears itself", async () => {
    const { h, owner, link, overview } = await setup();
    const bookingId = bookUnit(h, "dev_house_01", "2027-02-01", 1, "BK-20270201-CCCC");
    h.icalFiles.set(BOOKING_URL, ics({ start: "2027-02-01", end: "2027-02-03", summary: "Reserved" }));
    await link("dev_house_01", "BOOKING", BOOKING_URL);
    const o = await overview();
    assert.deepEqual(o.ical.conflicts.map((c) => [c.unitCode, c.channel, c.date, c.bookingCode]), [["HOUSE-01", "BOOKING", "2027-02-01", "BK-20270201-CCCC"]]);
    assert.equal(h.events("ICAL_DOUBLE_BOOKING").length, 1);
    await h.api("POST", "/api/admin/channels/ical/dev_house_01/booking/sync", { token: owner.token, body: {} });
    assert.equal(h.events("ICAL_DOUBLE_BOOKING").length, 1, "raised once, not on every read");

    // Our booking is cancelled (its night-lock goes): the OTA now holds the night and the conflict clears.
    h.db.run("DELETE FROM booking_unit_nights WHERE booking_id = ?", bookingId);
    await h.api("POST", "/api/admin/channels/ical/dev_house_01/booking/sync", { token: owner.token, body: {} });
    assert.deepEqual((await overview()).ical.conflicts, []);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE unit_id = 'dev_house_01' AND ical_feed_id IS NOT NULL")!.n, 2);
  });

  it("an unreadable calendar is an error on the feed and changes nothing", async () => {
    const { h, owner, link, imported } = await setup();
    h.icalFiles.set(BOOKING_URL, ics({ start: "2027-02-01", end: "2027-02-03" }));
    await link("dev_house_01", "BOOKING", BOOKING_URL);
    for (const [answer, code] of [
      [() => new Response("<html>Sign in</html>", { status: 200 }), "NOT_A_CALENDAR"],
      [() => new Response("gone", { status: 410 }), "HTTP_410"],
      [() => { throw new Error("network"); }, "UNREACHABLE"],
      [() => new Response("x".repeat(1_000_001)), "TOO_LARGE"],
    ] as const) {
      h.icalFiles.set(BOOKING_URL, answer as () => Response);
      const r = await h.api<IcalFeedDto>("POST", "/api/admin/channels/ical/dev_house_01/booking/sync", { token: owner.token, body: {} });
      assert.equal(r.data.lastImportStatus, "ERROR");
      assert.equal(r.data.lastImportError, code);
      assert.equal(imported("dev_house_01").length, 2, `${code}: the nights stay as they were`);
    }
  });

  it("checks permission, link and unit", async () => {
    const { h, link } = await setup();
    const manager = await staff(h, ["MANAGER"]);
    const bookingAdmin = await staff(h, ["BOOKING_ADMIN"]);
    h.icalFiles.set(BOOKING_URL, ics());
    assert.equal((await link("dev_house_01", "BOOKING", BOOKING_URL, manager.token)).status, 200, "MANAGER manages the links");
    assert.equal((await link("dev_house_01", "BOOKING", BOOKING_URL, bookingAdmin.token)).status, 403);
    assert.equal((await link("dev_house_01", "BOOKING", "http://insecure.example.com/x.ics")).error?.details?.importUrl, "INVALID_URL");
    assert.equal((await link("nope", "BOOKING", BOOKING_URL)).error?.code, "ACCOMMODATION_NOT_FOUND");
    assert.equal((await h.api("PUT", "/api/admin/channels/ical/dev_house_01/expedia", { token: manager.token, body: { importUrl: BOOKING_URL } })).error?.details?.channel, "INVALID_VALUE");
    assert.equal((await h.api("POST", "/api/admin/channels/ical/dev_house_02/agoda/sync", { token: manager.token, body: {} })).error?.details?.importUrl, "REQUIRED");
  });
});

describe("OTA channels — Vrbo and a named other OTA", () => {
  it("Vrbo works like the others; OTHER takes a name (only OTHER), shown on its nights and renamed with them", async () => {
    const { h, link, imported, feed } = await setup();
    const VRBO_URL = "https://www.vrbo.com/icalendar/abc.ics";
    const OTHER_URL = "https://ical.example-ota.com/u/1.ics";
    h.icalFiles.set(VRBO_URL, ics({ start: "2027-02-01", end: "2027-02-02" }));
    h.icalFiles.set(OTHER_URL, ics({ start: "2027-02-05", end: "2027-02-06" }));
    assert.equal((await link("dev_vip_01", "VRBO", VRBO_URL)).data.importedNights, 1);
    const other = await link("dev_vip_01", "OTHER", OTHER_URL);
    assert.equal(other.data.importedNights, 1);
    assert.deepEqual(imported("dev_vip_01"), ["2027-02-01 iCal · Vrbo", "2027-02-05 iCal · Other OTA"]);

    const owner = await staff(h, ["SUPER_ADMIN"]);
    const named = await h.api<IcalFeedDto>("PUT", "/api/admin/channels/ical/dev_vip_01/other", { token: owner.token, body: { label: "  Hostel Hub " } });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.equal(named.data.label, "Hostel Hub");
    assert.equal(named.data.importUrl, OTHER_URL, "a name alone leaves the link as it is");
    assert.deepEqual(imported("dev_vip_01"), ["2027-02-01 iCal · Vrbo", "2027-02-05 iCal · Hostel Hub"]);
    assert.equal(h.audits("ICAL_FEED_RENAMED").length, 1);
    assert.equal((await feed("dev_vip_01", "OTHER")).label, "Hostel Hub");
    assert.equal((await h.api("PUT", "/api/admin/channels/ical/dev_vip_01/vrbo", { token: owner.token, body: { label: "x" } })).error?.details?.label, "NOT_ALLOWED");
    assert.equal((await h.api("PUT", "/api/admin/channels/ical/dev_vip_01/other", { token: owner.token, body: { label: "x".repeat(41) } })).error?.details?.label, "TOO_LONG");
    assert.equal((await h.api("PUT", "/api/admin/channels/ical/dev_vip_01/other", { token: owner.token, body: {} })).error?.details?.importUrl, "REQUIRED");
    assert.throws(() => h.db.run("UPDATE ical_feeds SET channel = 'EXPEDIA' WHERE channel = 'OTHER'"), /CHECK/);
  });
});
