import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AvailabilityDto, CampingIntegrityDto } from "../../src/shared/accommodation-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { BookingRepository } from "../../src/worker/repositories/booking.repository.ts";
import { mapInventoryError } from "../../src/worker/services/booking.service.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10 10:00 Bangkok. Stay dates in February 2027.
let seq = 0;
const key = () => `camp-key-${String(++seq).padStart(10, "0")}`;

function camp(tents: number, checkIn = "2027-02-01", checkOut = "2027-02-03", adults = 2, children = 0) {
  return { checkIn, checkOut, adults, children, stay: { kind: "CAMPING", tents }, food: [], lang: "th" };
}

async function book(h: Harness, body: ReturnType<typeof camp>) {
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  if (q.status !== 200) return q as unknown as Awaited<ReturnType<typeof h.api<PublicBookingDto>>>;
  return h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer: { name: "Camper", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
}

/** Creates the booking request bodies first, then fires all creates at once (true race on the batch). */
async function race(h: Harness, bodies: ReturnType<typeof camp>[]) {
  const prepared = await Promise.all(bodies.map(async (body) => {
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    return { ...body, customer: { name: "Camper", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() };
  }));
  return Promise.all(prepared.map((body) => h.api<PublicBookingDto>("POST", "/api/public/bookings", { body })));
}

const nights = (h: Harness) =>
  h.db.all<{ stay_date: string; max_tents: number; tents_used: number }>("SELECT stay_date, max_tents, tents_used FROM camping_night_inventory ORDER BY stay_date").map((r) => ({ ...r }));

async function admin(h: Harness, perms: string[]) {
  const id = `staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

async function integrity(h: Harness, token: string) {
  return h.api<CampingIntegrityDto>("GET", "/api/admin/camping/integrity", { token });
}

describe("camping capacity — spec examples", () => {
  it("§18: 2 tents, 5 adults, 2 children, 2 nights × ฿250 = ฿2,500; tents drive capacity", async () => {
    const h = new Harness({ seed: true });
    const res = await book(h, camp(2, "2027-02-01", "2027-02-03", 5, 2));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.data.totalSatang, 250000);
    assert.deepEqual(nights(h).map((n) => n.tents_used), [2, 2], "2 tents on each night, regardless of 7 guests");
  });

  it("§3: shared capacity 30, A=3 + B=5 → 22 left, checked every night", async () => {
    const h = new Harness({ seed: true });
    assert.equal((await book(h, camp(3))).status, 201);
    assert.equal((await book(h, camp(5, "2027-02-02", "2027-02-04"))).status, 201);
    const a = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-04&tents=1");
    assert.deepEqual(a.data.camping.nights, [
      { date: "2027-02-01", remaining: 27 }, { date: "2027-02-02", remaining: 22 }, { date: "2027-02-03", remaining: 25 },
    ]);
    assert.equal(a.data.camping.remaining, 22);
  });
});

describe("camping capacity — race protection", () => {
  it("10 simultaneous bookings for 7 tents: exactly 7 succeed, never oversold", async () => {
    const h = new Harness({ seed: true });
    h.db.run("UPDATE camping_settings SET max_tents_per_night = 7");
    const results = await race(h, Array.from({ length: 10 }, () => camp(1)));
    const ok = results.filter((r) => r.status === 201).length;
    assert.equal(ok, 7, results.map((r) => r.status).join(","));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.error?.code === "CAMPING_FULL"));
    assert.deepEqual(nights(h).map((n) => n.tents_used), [7, 7]);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 7, "losers left no rows behind");
  });

  it("overlapping multi-night stays racing: every night stays within capacity", async () => {
    const h = new Harness({ seed: true });
    h.db.run("UPDATE camping_settings SET max_tents_per_night = 5");
    // A: 1–3 Feb (3 tents), B: 2–4 Feb (3 tents), C: 3 Feb (2 tents). A and B cannot both fit on 2 Feb.
    const results = await race(h, [camp(3, "2027-02-01", "2027-02-03"), camp(3, "2027-02-02", "2027-02-04"), camp(2, "2027-02-03", "2027-02-04")]);
    const [a, b, c] = results.map((r) => r.status);
    assert.equal([a, b].filter((s) => s === 201).length, 1, "exactly one of A/B");
    assert.equal(c, 201, "C fits whichever of A/B won");
    for (const n of nights(h)) assert.ok(n.tents_used <= n.max_tents, JSON.stringify(n));
    const token = await admin(h, ["camping.view"]);
    assert.equal((await integrity(h, token)).data.consistent, true);
  });

  it("owner lowering a night's capacity while a booking lands: one of them wins, never both", async () => {
    const h = new Harness({ seed: true });
    h.db.run("UPDATE camping_settings SET max_tents_per_night = 5");
    const token = await admin(h, ["camping.edit"]);
    const body = camp(3);
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    const [bookingRes, capRes] = await Promise.all([
      h.api("POST", "/api/public/bookings", { body: { ...body, customer: { name: "C", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() } }),
      h.api("PUT", "/api/admin/camping/nights/2027-02-01", { token, body: { maxTents: 2 } }),
    ]);
    const outcome = `${bookingRes.status}/${capRes.status}`;
    assert.ok(outcome === "201/409" || outcome === "409/200", outcome);
    if (bookingRes.status === 201) assert.equal(capRes.error?.code, "BELOW_TENTS_SOLD");
    else assert.equal(bookingRes.error?.code, "CAMPING_FULL");
    for (const n of nights(h)) assert.ok(n.tents_used <= n.max_tents);
  });

  it("a night row created by a booking uses the capacity in force at that moment", async () => {
    const h = new Harness({ seed: true });
    const repo = new BookingRepository(h.db);
    h.db.run("UPDATE camping_settings SET max_tents_per_night = 4");
    await h.db.batch(repo.reserveTentsStatements("2027-03-01", 1, "2027-01-10T03:00:00.000Z"));
    assert.deepEqual(nights(h), [{ stay_date: "2027-03-01", max_tents: 4, tents_used: 1 }]);
  });

  it("database refuses own-tent items while camping is closed, and units that are not ACTIVE", async () => {
    const h = new Harness({ seed: true });
    h.db.run(`INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults, customer_name, customer_phone,
      customer_phone_normalized, accommodation_subtotal_satang, subtotal_satang, total_satang)
      VALUES ('bx', 'BK-20270110-XXXX', 'th', '2027-02-01', '2027-02-02', 1, 1, 'X', '0812345678', '0812345678', 0, 0, 0)`);
    h.db.run("UPDATE camping_settings SET is_enabled = 0");
    assert.throws(() => h.db.run("INSERT INTO booking_items (id, booking_id, item_type, quantity, adults) VALUES ('i1', 'bx', 'OWN_TENT', 1, 1)"), /CAMPING_DISABLED/);
    h.db.run("UPDATE accommodation_units SET status = 'MAINTENANCE' WHERE id = 'dev_house_01'");
    assert.throws(() => h.db.run("INSERT INTO booking_items (id, booking_id, item_type, unit_id, adults) VALUES ('i2', 'bx', 'HOUSE', 'dev_house_01', 1)"), /UNIT_NOT_BOOKABLE/);
    assert.equal((mapInventoryError(new Error("CAMPING_DISABLED")) as { code: string }).code, "CAMPING_UNAVAILABLE");
    assert.equal((mapInventoryError(new Error("UNIT_NOT_BOOKABLE")) as { code: string }).code, "ACCOMMODATION_NOT_FOUND");
  });
});

describe("camping capacity — tent quantity in availability", () => {
  it("tells the guest how many tents they need, the per-booking limit, and which night is short", async () => {
    const h = new Harness({ seed: true });
    h.db.run("UPDATE camping_settings SET max_guests_per_tent = 2");
    const few = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-03&guests=5&tents=2");
    assert.equal(few.data.camping.fitsTents, false);
    assert.equal(few.data.camping.reason, "TOO_FEW_TENTS");
    assert.equal(few.data.camping.minTents, 3);
    const enough = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-03&guests=5&tents=3");
    assert.equal(enough.data.camping.fitsTents, true);
    assert.equal(enough.data.camping.reason, null);
    const many = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-03&guests=2&tents=11");
    assert.equal(many.data.camping.reason, "TOO_MANY_TENTS");
    assert.equal(many.data.camping.maxTentsPerBooking, 10);
    h.db.run("INSERT INTO camping_night_inventory (stay_date, max_tents, tents_used) VALUES ('2027-02-02', 30, 29)");
    const short = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-03&guests=2&tents=2");
    assert.equal(short.data.camping.reason, "FULL");
    assert.deepEqual(short.data.camping.shortNights, ["2027-02-02"]);
  });

  it("expired unpaid holds stop blocking space as soon as someone searches", async () => {
    const h = new Harness({ seed: true });
    h.db.run("UPDATE camping_settings SET max_tents_per_night = 3");
    assert.equal((await book(h, camp(3))).status, 201);
    const full = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-03&tents=1");
    assert.equal(full.data.camping.remaining, 0);
    h.advance(61 * 60_000); // hold expired, cron not yet run
    const free = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-03&tents=1");
    assert.equal(free.data.camping.remaining, 3);
  });
});

describe("camping capacity — integrity check", () => {
  it("stays consistent through booking, cancel and expiry", async () => {
    const h = new Harness({ seed: true });
    const viewer = await admin(h, ["camping.view"]);
    const a = await book(h, camp(2));
    await book(h, camp(4, "2027-02-02", "2027-02-05"));
    assert.equal((await integrity(h, viewer)).data.consistent, true);
    const canceller = await admin(h, ["bookings.cancel"]);
    await h.api("POST", `/api/admin/bookings/${a.data.bookingCode}/cancel`, { token: canceller, body: { reason: "test cancel" } });
    assert.equal((await integrity(h, viewer)).data.consistent, true);
    h.advance(61 * 60_000);
    await h.app.scheduled(h.env);
    const after = await integrity(h, viewer);
    assert.equal(after.data.consistent, true);
    assert.ok(nights(h).every((n) => n.tents_used === 0));
  });

  it("detects a drifted counter, alerts once, and recalculates with camping.edit (audited)", async () => {
    const h = new Harness({ seed: true });
    await book(h, camp(2));
    h.db.run("UPDATE camping_night_inventory SET tents_used = tents_used + 3 WHERE stay_date = '2027-02-02'"); // simulated bug / manual edit
    h.db.run("INSERT INTO camping_night_inventory (stay_date, max_tents, tents_used) VALUES ('2027-02-10', 30, 1)"); // phantom tent

    const viewer = await admin(h, ["camping.view"]);
    const res = await integrity(h, viewer);
    assert.equal(res.data.consistent, false);
    assert.deepEqual(res.data.drift.map((d) => [d.date, d.expected, d.actual]), [["2027-02-02", 2, 5], ["2027-02-10", 0, 1]]);
    assert.equal((await h.api("GET", "/api/admin/camping/integrity")).status, 401);
    assert.equal((await h.api("POST", "/api/admin/camping/recalculate", { token: viewer, body: {} })).status, 403);

    await h.app.scheduled(h.env);
    await h.app.scheduled(h.env);
    const alerts = h.db.all<{ severity: string }>("SELECT severity FROM security_events WHERE event_type = 'CAMPING_INVENTORY_DRIFT'");
    assert.equal(alerts.length, 1, "one alert per interval, not every 5 minutes");
    assert.equal(alerts[0]!.severity, "CRITICAL");
    assert.equal(nights(h).find((n) => n.stay_date === "2027-02-02")!.tents_used, 5, "the cron never changes data by itself");

    const editor = await admin(h, ["camping.view", "camping.edit"]);
    const fixed = await h.api<CampingIntegrityDto>("POST", "/api/admin/camping/recalculate", { token: editor, body: {} });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(fixed.data.consistent, true);
    assert.deepEqual(nights(h).map((n) => [n.stay_date, n.tents_used]), [["2027-02-01", 2], ["2027-02-02", 2], ["2027-02-10", 0]]);
    assert.equal(h.audits("RECALCULATE_CAMPING").length, 1);
    assert.equal((await h.api("POST", "/api/admin/camping/recalculate", { token: editor, body: { force: true } })).status, 422, "no parameters accepted");
  });

  it("re-creates a missing night row and refuses to 'fix' a truly oversold night", async () => {
    const h = new Harness({ seed: true });
    await book(h, camp(3));
    h.db.run("DELETE FROM camping_night_inventory WHERE stay_date = '2027-02-01'");
    const editor = await admin(h, ["camping.view", "camping.edit"]);
    const drift = await integrity(h, editor);
    assert.deepEqual(drift.data.drift.map((d) => [d.date, d.expected, d.actual]), [["2027-02-01", 3, 0]]);
    const fixed = await h.api<CampingIntegrityDto>("POST", "/api/admin/camping/recalculate", { token: editor, body: {} });
    assert.equal(fixed.data.consistent, true);
    assert.equal(nights(h)[0]!.tents_used, 3);

    // Oversold: bookings hold 3 tents but the counter says 0 and capacity is 1.
    h.db.run("UPDATE camping_night_inventory SET tents_used = 0, max_tents = 1 WHERE stay_date = '2027-02-02'");
    const refused = await h.api("POST", "/api/admin/camping/recalculate", { token: editor, body: {} });
    assert.equal(refused.status, 409);
    assert.equal(refused.error?.code, "OVERSOLD_NIGHTS");
    assert.equal(nights(h).find((n) => n.stay_date === "2027-02-02")!.tents_used, 0, "nothing changed");
  });
});
