import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AvailabilityDto, CampingIntegrityDto } from "../../src/shared/accommodation-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { CalendarDto, CalendarLockResultDto } from "../../src/shared/dashboard-types.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10 10:00 Bangkok. Stay dates in February 2027.
let seq = 0;
const key = () => `lock-key-${String(++seq).padStart(10, "0")}`;

async function staff(h: Harness, perms: string[]) {
  const id = `staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

function camp(tents: number, checkIn = "2027-02-01", checkOut = "2027-02-03") {
  return { checkIn, checkOut, adults: 2, children: 0, stay: { kind: "CAMPING", tents }, food: [], lang: "th" };
}

async function bookCamp(h: Harness, body: ReturnType<typeof camp>) {
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  if (q.status !== 200) return q as unknown as Awaited<ReturnType<typeof h.api<PublicBookingDto>>>;
  return h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer: { name: "Camper", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
}

function bookUnit(h: Harness, unitId: string, date: string, code: string) {
  const bookingId = `b-${code}`;
  h.db.run(
    `INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults, customer_name,
       customer_phone, customer_phone_normalized, accommodation_subtotal_satang, subtotal_satang, total_satang, booking_status)
     VALUES (?, ?, 'th', ?, date(?, '+1 day'), 1, 2, 'Guest', '0812345678', '0812345678', 1, 1, 1, 'CONFIRMED')`,
    bookingId, code, date, date,
  );
  const type = h.db.get<{ unit_type: string }>("SELECT unit_type FROM accommodation_units WHERE id = ?", unitId)!.unit_type;
  h.db.run("INSERT INTO booking_items (id, booking_id, item_type, unit_id, adults) VALUES (?, ?, ?, ?, 2)", `i-${code}`, bookingId, type, unitId);
  h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, booking_id, booking_item_id) VALUES (?, ?, ?, ?)", unitId, date, bookingId, `i-${code}`);
}

const locks = (h: Harness, token: string, body: unknown) => h.api<CalendarLockResultDto>("POST", "/api/admin/calendar/locks", { token, body });
const blocks = (h: Harness) =>
  h.db.all<{ unit_id: string; stay_date: string; block_reason: string }>(
    "SELECT unit_id, stay_date, block_reason FROM booking_unit_nights WHERE booking_id IS NULL ORDER BY unit_id, stay_date",
  ).map((r) => `${r.unit_id}:${r.stay_date}:${r.block_reason}`);

describe("calendar locks — houses and VIP tents", () => {
  it("locks many cells across units and dates in one go (audited once), then unlocks them", async () => {
    const h = new Harness({ seed: true });
    const token = await staff(h, ["accommodation.block", "accommodation.view"]);
    const res = await locks(h, token, {
      action: "LOCK", reason: "Maintenance",
      cells: ["dev_house_01:2027-02-01", "dev_house_01:2027-02-02", "dev_house_02:2027-02-01"],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.data, { action: "LOCK", units: 3, camping: 0, skipped: 0 });
    assert.deepEqual(blocks(h), ["dev_house_01:2027-02-01:Maintenance", "dev_house_01:2027-02-02:Maintenance", "dev_house_02:2027-02-01:Maintenance"]);
    assert.equal(h.audits("CALENDAR_LOCK").length, 1);

    const pub = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-02");
    assert.equal(pub.data.units.find((u) => u.unitId === "dev_house_02")!.available, false);

    const again = await locks(h, token, { action: "LOCK", reason: "Again", cells: ["dev_house_01:2027-02-01", "dev_house_01:2027-02-03"] });
    assert.deepEqual(again.data, { action: "LOCK", units: 1, camping: 0, skipped: 1 }, "an existing lock is left as it was");

    const off = await locks(h, token, { action: "UNLOCK", cells: ["dev_house_01:2027-02-01", "dev_house_02:2027-02-01", "dev_house_02:2027-02-05"] });
    assert.deepEqual(off.data, { action: "UNLOCK", units: 2, camping: 0, skipped: 1 });
    assert.deepEqual(blocks(h), ["dev_house_01:2027-02-02:Maintenance", "dev_house_01:2027-02-03:Again"]);
    assert.equal(h.audits("CALENDAR_UNLOCK").length, 1);
  });

  it("never touches a booked night: locking it is refused (nothing changes), unlocking skips it", async () => {
    const h = new Harness({ seed: true });
    const token = await staff(h, ["accommodation.block"]);
    bookUnit(h, "dev_house_01", "2027-02-02", "BK-20270202-AAAA");
    const res = await locks(h, token, { action: "LOCK", reason: "x", cells: ["dev_house_01:2027-02-01", "dev_house_01:2027-02-02"] });
    assert.equal(res.status, 409);
    assert.equal(res.error?.code, "DATES_UNAVAILABLE");
    assert.deepEqual(blocks(h), [], "all or nothing");

    const off = await locks(h, token, { action: "UNLOCK", cells: ["dev_house_01:2027-02-02"] });
    assert.deepEqual(off.data, { action: "UNLOCK", units: 0, camping: 0, skipped: 1 });
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE booking_id IS NOT NULL")!.n, 1);
    assert.equal(h.audits("CALENDAR_UNLOCK").length, 0, "nothing changed, nothing audited");
  });

  it("checks permission, reason, past dates, unknown units and input shape", async () => {
    const h = new Harness({ seed: true });
    const viewer = await staff(h, ["accommodation.view"]);
    const token = await staff(h, ["accommodation.block"]);
    const cell = ["dev_house_01:2027-02-01"];
    assert.equal((await h.api("POST", "/api/admin/calendar/locks", { body: { action: "LOCK", reason: "x", cells: cell } })).status, 401);
    assert.equal((await locks(h, viewer, { action: "LOCK", reason: "x", cells: cell })).status, 403);
    assert.equal((await locks(h, token, { action: "LOCK", cells: cell })).error?.details?.reason, "REQUIRED");
    assert.equal((await locks(h, token, { action: "LOCK", reason: "x", cells: ["dev_house_01:2027-01-09"] })).error?.details?.dates, "IN_THE_PAST");
    assert.equal((await locks(h, token, { action: "LOCK", reason: "x", cells: ["nope:2027-02-01"] })).error?.code, "ACCOMMODATION_NOT_FOUND");
    assert.equal((await locks(h, token, { action: "LOCK", reason: "x", cells: ["dev_house_01:2027-02-30"] })).error?.details?.dates, "INVALID_DATE");
    assert.equal((await locks(h, token, { action: "LOCK", reason: "x", cells: ["dev house:2027-02-01"] })).error?.details?.cells, "INVALID_FORMAT");
    assert.equal((await locks(h, token, { action: "FREEZE", cells: cell })).error?.details?.action, "INVALID_VALUE");
    assert.equal((await locks(h, token, { action: "LOCK", reason: "x" })).error?.details?.cells, "REQUIRED");
    assert.equal((await locks(h, token, { action: "LOCK", reason: "x", cells: cell, extra: 1 })).status, 422);
    assert.equal((await locks(h, token, { action: "LOCK", reason: "x", campingDates: ["2027-02-01"] })).status, 403, "camping needs camping.edit");
    assert.deepEqual(blocks(h), []);

    // A lock that is already in the past can still be lifted.
    h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason, created_by, created_at) SELECT 'dev_house_01', '2027-01-05', 'old', id, 'x' FROM users LIMIT 1");
    assert.deepEqual((await locks(h, token, { action: "UNLOCK", cells: ["dev_house_01:2027-01-05"] })).data.units, 1);
  });
});

describe("calendar locks — camping nights", () => {
  it("a locked night takes no new tents; booked tents stay; a cancellation does not re-open it; unlock re-opens", async () => {
    const h = new Harness({ seed: true });
    const editor = await staff(h, ["camping.edit", "camping.view"]);
    const first = await bookCamp(h, camp(2));
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const res = await locks(h, editor, { action: "LOCK", campingDates: ["2027-02-02", "2027-02-04"] });
    assert.deepEqual(res.data, { action: "LOCK", units: 0, camping: 2, skipped: 0 });
    assert.deepEqual(h.db.all<{ stay_date: string; tents_used: number; closed: number }>(
      "SELECT stay_date, tents_used, closed FROM camping_night_inventory ORDER BY stay_date").map((r) => [r.stay_date, r.tents_used, r.closed]),
    [["2027-02-01", 2, 0], ["2027-02-02", 2, 1], ["2027-02-04", 0, 1]], "booked tents stay; capacity untouched");

    const pub = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-03&tents=1");
    assert.deepEqual(pub.data.camping.nights.map((n) => n.remaining), [28, 0]);
    assert.equal((await bookCamp(h, camp(1))).error?.code, "CAMPING_FULL", "quote refuses");
    assert.equal((await bookCamp(h, camp(1, "2027-02-01", "2027-02-02"))).status, 201, "the night before is open");

    // The database refuses too (a quote taken before the lock, or a race).
    assert.throws(() => h.db.run("UPDATE camping_night_inventory SET tents_used = tents_used + 1 WHERE stay_date = '2027-02-02'"), /camping night closed/);

    const canceller = await staff(h, ["bookings.cancel"]);
    await h.api("POST", `/api/admin/bookings/${first.data.bookingCode}/cancel`, { token: canceller, body: { reason: "test cancel" } });
    assert.equal(h.db.get<{ tents_used: number; closed: number }>("SELECT tents_used, closed FROM camping_night_inventory WHERE stay_date = '2027-02-02'")!.closed, 1);
    assert.equal((await bookCamp(h, camp(1, "2027-02-02", "2027-02-03"))).error?.code, "CAMPING_FULL", "still locked after the cancellation");

    const cal = await h.api<CalendarDto>("GET", "/api/admin/calendar?from=2027-02-01&to=2027-02-05", { token: await staff(h, ["calendar.view"]) });
    assert.equal(cal.status, 200, JSON.stringify(cal.body));
    assert.deepEqual(cal.data.camping.nights.map((n) => n.closed), [false, true, false, true]);

    const off = await locks(h, editor, { action: "UNLOCK", campingDates: ["2027-02-02", "2027-02-03"] });
    assert.deepEqual(off.data, { action: "UNLOCK", units: 0, camping: 1, skipped: 1 });
    assert.equal((await bookCamp(h, camp(1, "2027-02-02", "2027-02-03"))).status, 201);
    assert.equal(h.audits("CALENDAR_LOCK").length + h.audits("CALENDAR_UNLOCK").length, 2);
  });

  it("the integrity repair can still raise a drifted-low counter on a locked night, and keeps the lock", async () => {
    const h = new Harness({ seed: true });
    const editor = await staff(h, ["camping.edit", "camping.view"]);
    assert.equal((await bookCamp(h, camp(2))).status, 201);
    await locks(h, editor, { action: "LOCK", campingDates: ["2027-02-01"] });
    h.db.run("UPDATE camping_night_inventory SET tents_used = 0 WHERE stay_date = '2027-02-01'"); // drifted low
    const fixed = await h.api<CampingIntegrityDto>("POST", "/api/admin/camping/recalculate", { token: editor, body: {} });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(fixed.data.consistent, true);
    assert.deepEqual({ ...h.db.get<{ tents_used: number; closed: number }>("SELECT tents_used, closed FROM camping_night_inventory WHERE stay_date = '2027-02-01'") }, { tents_used: 2, closed: 1 });
  });

  it("houses and camping together in one request; each needs its own permission", async () => {
    const h = new Harness({ seed: true });
    const both = await staff(h, ["accommodation.block", "camping.edit"]);
    const res = await locks(h, both, { action: "LOCK", reason: "Festival", cells: ["dev_house_01:2027-02-14"], campingDates: ["2027-02-14"] });
    assert.deepEqual(res.data, { action: "LOCK", units: 1, camping: 1, skipped: 0 });
    const campOnly = await staff(h, ["camping.edit"]);
    assert.equal((await locks(h, campOnly, { action: "UNLOCK", cells: ["dev_house_01:2027-02-14"], campingDates: ["2027-02-14"] })).status, 403);
    assert.deepEqual((await locks(h, campOnly, { action: "UNLOCK", campingDates: ["2027-02-14"] })).data.camping, 1, "camping alone needs no reason");
  });
});

describe("calendar — tents per camping night", () => {
  const night = (h: Harness, date: string) =>
    ({ ...h.db.get<{ max_tents: number; tents_used: number; is_override: number }>(
      "SELECT max_tents, tents_used, is_override FROM camping_night_inventory WHERE stay_date = ?", date) });

  it("lowers many nights at once (30 → 23), shows them on the calendar and in public availability, then back to default", async () => {
    const h = new Harness({ seed: true });
    const editor = await staff(h, ["camping.edit"]);
    const res = await locks(h, editor, { action: "TENTS", maxTents: 23, campingDates: ["2027-02-01", "2027-02-02"] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.data, { action: "TENTS", units: 0, camping: 2, skipped: 0 });
    assert.deepEqual(night(h, "2027-02-01"), { max_tents: 23, tents_used: 0, is_override: 1 });
    assert.equal(h.audits("CALENDAR_TENTS").length, 1);

    const pub = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-04&tents=1");
    assert.deepEqual(pub.data.camping.nights.map((n) => n.remaining), [23, 23, 30]);
    const cal = await h.api<CalendarDto>("GET", "/api/admin/calendar?from=2027-02-01&to=2027-02-04", { token: await staff(h, ["calendar.view"]) });
    assert.equal(cal.data.camping.defaultMax, 30);
    assert.deepEqual(cal.data.camping.nights.map((n) => [n.max, n.override]), [[23, true], [23, true], [30, false]]);

    // The same value again changes nothing.
    assert.deepEqual((await locks(h, editor, { action: "TENTS", maxTents: 23, campingDates: ["2027-02-01"] })).data.skipped, 1);
    const back = await locks(h, editor, { action: "TENTS", maxTents: null, campingDates: ["2027-02-01", "2027-02-02", "2027-02-03"] });
    assert.deepEqual(back.data, { action: "TENTS", units: 0, camping: 2, skipped: 1 });
    assert.deepEqual(night(h, "2027-02-02"), { max_tents: 30, tents_used: 0, is_override: 0 });
  });

  it("never below the tents already booked (all or nothing); permission, past dates and input shape", async () => {
    const h = new Harness({ seed: true });
    const editor = await staff(h, ["camping.edit"]);
    assert.equal((await bookCamp(h, camp(5, "2027-02-02", "2027-02-03"))).status, 201);
    const low = await locks(h, editor, { action: "TENTS", maxTents: 4, campingDates: ["2027-02-01", "2027-02-02"] });
    assert.equal(low.status, 409);
    assert.equal(low.error?.code, "BELOW_TENTS_SOLD");
    assert.match(low.error?.message ?? "", /2027-02-02/);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM camping_night_inventory WHERE is_override = 1")!.n, 0, "nothing changed");
    assert.equal((await locks(h, editor, { action: "TENTS", maxTents: 5, campingDates: ["2027-02-02"] })).status, 200, "equal to booked is fine");
    assert.equal((await bookCamp(h, camp(1, "2027-02-02", "2027-02-03"))).error?.code, "CAMPING_FULL");

    const blocker = await staff(h, ["accommodation.block"]);
    assert.equal((await locks(h, blocker, { action: "TENTS", maxTents: 3, campingDates: ["2027-02-05"] })).status, 403);
    assert.equal((await locks(h, editor, { action: "TENTS", maxTents: 3, campingDates: ["2027-01-09"] })).error?.details?.dates, "IN_THE_PAST");
    assert.equal((await locks(h, editor, { action: "TENTS", campingDates: ["2027-02-05"] })).error?.details?.maxTents, "REQUIRED");
    assert.equal((await locks(h, editor, { action: "TENTS", maxTents: -1, campingDates: ["2027-02-05"] })).error?.details?.maxTents, "OUT_OF_RANGE");
    assert.equal((await locks(h, editor, { action: "TENTS", maxTents: 2.5, campingDates: ["2027-02-05"] })).error?.details?.maxTents, "OUT_OF_RANGE");
    assert.equal((await locks(h, editor, { action: "LOCK", maxTents: 3, campingDates: ["2027-02-05"] })).error?.details?.maxTents, "NOT_ALLOWED");
    assert.equal((await locks(h, await staff(h, ["camping.edit", "accommodation.block"]), {
      action: "TENTS", maxTents: 3, cells: ["dev_house_01:2027-02-05"], campingDates: ["2027-02-05"] })).error?.details?.cells, "NOT_ALLOWED");
  });
});
