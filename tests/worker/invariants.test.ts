import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { Harness } from "../helpers/harness.ts";

/**
 * Phase 15 — business invariants under load (spec §62): random bookings, cancellations, payments,
 * hold expiries and capacity changes, sent in concurrent bursts from many IPs. After every step the
 * database must satisfy, from first principles (not from the counters it maintains):
 *   - no unit is held twice for a night; nights belong only to live bookings; every live unit
 *     booking holds exactly its nights (double booking, multi-night)
 *   - camping: tents counter = Σ live own-tent items for that night, never above the night's limit
 *   - food: daily counter = Σ portions reserved by live kitchen orders, never above the limit
 *   - money: totals add up; a confirmed booking is paid in full; snapshots exist for every booking
 */

/** Small deterministic PRNG (mulberry32) so a failure can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

const UNITS = ["dev_house_01", "dev_house_02", "dev_vip_01", "dev_vip_02", "dev_vip_03"] as const;
const LIVE = "('PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW')";
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function checkInvariants(h: Harness, label: string) {
  const db = h.db;
  // 1. Units: nights only for live bookings, exactly their nights, one booking per unit-night (PK).
  const orphan = db.all(
    `SELECT n.unit_id, n.stay_date, b.booking_status FROM booking_unit_nights n JOIN bookings b ON b.id = n.booking_id
      WHERE b.booking_status NOT IN ${LIVE}`,
  );
  assert.deepEqual(orphan, [], `${label}: nights held by dead bookings`);
  const wrongCount = db.all(
    `SELECT b.booking_code, b.nights, (SELECT count(*) FROM booking_unit_nights n WHERE n.booking_item_id = i.id) AS held
       FROM bookings b JOIN booking_items i ON i.booking_id = b.id AND i.unit_id IS NOT NULL
      WHERE b.booking_status IN ${LIVE} AND held <> b.nights`,
  );
  assert.deepEqual(wrongCount, [], `${label}: live unit bookings must hold every night`);
  const overlap = db.all(
    `SELECT i1.unit_id, b1.booking_code AS a, b2.booking_code AS b FROM booking_items i1 JOIN bookings b1 ON b1.id = i1.booking_id
       JOIN booking_items i2 ON i2.unit_id = i1.unit_id AND i2.id > i1.id JOIN bookings b2 ON b2.id = i2.booking_id
      WHERE b1.booking_status IN ${LIVE} AND b2.booking_status IN ${LIVE} AND b1.check_in < b2.check_out AND b2.check_in < b1.check_out`,
  );
  assert.deepEqual(overlap, [], `${label}: DOUBLE BOOKING`);
  const itemState = db.all(
    `SELECT b.booking_code, b.booking_status, i.status FROM booking_items i JOIN bookings b ON b.id = i.booking_id
      WHERE (b.booking_status IN ${LIVE}) <> (i.status = 'ACTIVE')`,
  );
  assert.deepEqual(itemState, [], `${label}: item status follows booking status`);

  // 2. Camping: counter = truth, within the limit.
  const camping = db.all<{ stay_date: string; max_tents: number; tents_used: number; truth: number }>(
    `WITH RECURSIVE held(qty, d, co) AS (
       SELECT i.quantity, b.check_in, b.check_out FROM booking_items i JOIN bookings b ON b.id = i.booking_id
        WHERE i.item_type = 'OWN_TENT' AND i.status = 'ACTIVE'
       UNION ALL SELECT qty, date(d, '+1 day'), co FROM held WHERE date(d, '+1 day') < co)
     SELECT c.stay_date, c.max_tents, c.tents_used, COALESCE((SELECT SUM(qty) FROM held WHERE d = c.stay_date), 0) AS truth
       FROM camping_night_inventory c`,
  );
  for (const n of camping) {
    assert.equal(n.tents_used, n.truth, `${label}: camping counter drift on ${n.stay_date}`);
    assert.ok(n.truth <= n.max_tents, `${label}: camping OVERSOLD on ${n.stay_date} (${n.truth} > ${n.max_tents})`);
  }
  const uncounted = db.all(
    `WITH RECURSIVE held(d, co) AS (
       SELECT b.check_in, b.check_out FROM booking_items i JOIN bookings b ON b.id = i.booking_id WHERE i.item_type = 'OWN_TENT' AND i.status = 'ACTIVE'
       UNION ALL SELECT date(d, '+1 day'), co FROM held WHERE date(d, '+1 day') < co)
     SELECT DISTINCT d FROM held WHERE d NOT IN (SELECT stay_date FROM camping_night_inventory)`,
  );
  assert.deepEqual(uncounted, [], `${label}: a held camping night has no inventory row`);

  // 3. Food: counter = Σ reserved portions of live orders, within the limit.
  const food = db.all<{ food_category_id: string; service_date: string; max_quantity: number; used_quantity: number; truth: number }>(
    `SELECT c.food_category_id, c.service_date, c.max_quantity, c.used_quantity,
            COALESCE((SELECT SUM(o.capacity_reserved) FROM food_orders o JOIN bookings b ON b.id = o.booking_id
                       WHERE o.food_category_id = c.food_category_id AND o.service_date = c.service_date AND b.booking_status IN ${LIVE}), 0) AS truth
       FROM food_daily_capacity c`,
  );
  for (const f of food) {
    assert.equal(f.used_quantity, f.truth, `${label}: food counter drift ${f.food_category_id} ${f.service_date}`);
    assert.ok(f.truth <= f.max_quantity, `${label}: food OVERSOLD ${f.food_category_id} ${f.service_date}`);
  }
  const deadOrders = db.all(
    `SELECT o.id FROM food_orders o JOIN bookings b ON b.id = o.booking_id WHERE b.booking_status IN ('CANCELLED', 'EXPIRED') AND (o.capacity_reserved > 0 OR o.status <> 'CANCELLED')`,
  );
  assert.deepEqual(deadOrders, [], `${label}: dead bookings keep kitchen portions`);

  // 4. Money and snapshots.
  const money = db.all(
    `SELECT b.booking_code FROM bookings b
      WHERE b.accommodation_subtotal_satang <> (SELECT COALESCE(SUM(s.total_satang), 0) FROM booking_price_snapshots s WHERE s.booking_id = b.id)
         OR b.food_subtotal_satang <> (SELECT COALESCE(SUM(f.subtotal_satang), 0) FROM booking_food_items f WHERE f.booking_id = b.id)`,
  );
  assert.deepEqual(money, [], `${label}: booking totals differ from their line snapshots`);
  const unpaid = db.all(
    `SELECT b.booking_code, b.payment_status, (SELECT COALESCE(SUM(p.amount_satang), 0) FROM payments p WHERE p.booking_id = b.id AND p.status IN ('PAID', 'VERIFIED')) AS paid, b.total_satang
       FROM bookings b WHERE b.booking_status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT') AND (b.payment_status NOT IN ('PAID', 'VERIFIED') OR paid < b.total_satang)`,
  );
  assert.deepEqual(unpaid, [], `${label}: confirmed but not paid in full`);
  const noSnapshot = db.all(
    `SELECT b.booking_code FROM bookings b WHERE NOT EXISTS (SELECT 1 FROM payment_account_snapshots s WHERE s.booking_id = b.id)
        OR NOT EXISTS (SELECT 1 FROM booking_price_snapshots s WHERE s.booking_id = b.id)`,
  );
  assert.deepEqual(noSnapshot, [], `${label}: booking without price / payment-account snapshot`);
}

async function simulate(seed: number, steps: number) {
  const r = rng(seed);
  const h = new Harness({ seed: true });
  // Scarce inventory so requests really compete.
  h.db.run("UPDATE camping_settings SET max_tents_per_night = 6");
  h.db.run("UPDATE food_categories SET default_daily_capacity = 4 WHERE id = 'dev_food_bbq'");
  h.db.run("UPDATE food_categories SET default_daily_capacity = 9 WHERE id = 'dev_food_dinner'");
  await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
  let root = await h.login("root@example.test");
  const today = h.now.toISOString().slice(0, 10);
  const stats = { attempts: 0, created: 0, refused: 0, cancelled: 0, paid: 0, expired: 0, capacityChanges: 0 };
  const refusals = new Map<string, number>();
  let ipSeq = 0;
  let keySeq = 0;

  const request = () => {
    const checkIn = addDays(today, r.int(2, 9));
    const nights = r.int(1, 3);
    const checkOut = addDays(checkIn, nights);
    const camping = r.next() < 0.35;
    const adults = r.int(1, camping ? 6 : 2);
    const food: Record<string, unknown>[] = [];
    if (r.next() < 0.5) food.push({ optionId: "dev_food_dinner_a", serviceDate: checkIn, adults, children: 0 });
    if (r.next() < 0.4) food.push({ optionId: "dev_food_bbq_set", serviceDate: addDays(checkIn, r.int(0, nights - 1)), quantity: r.int(1, 2) });
    return {
      checkIn, checkOut, adults, children: 0, lang: "th", food,
      stay: camping ? { kind: "CAMPING", tents: r.int(1, 3) } : { kind: "UNIT", unitId: r.pick(UNITS) },
    };
  };

  const book = async () => {
    const body = request();
    const ip = `198.51.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`;
    stats.attempts++;
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body, headers: { "CF-Connecting-IP": ip } });
    if (q.status !== 200) { stats.refused++; refusals.set(q.error?.code ?? String(q.status), (refusals.get(q.error?.code ?? "") ?? 0) + 1); return; }
    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      headers: { "CF-Connecting-IP": ip },
      body: { ...body, customer: { name: `Sim ${ipSeq}`, phone: `08${String(10_000_000 + ipSeq).slice(-8)}` }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `sim-${seed}-${String(++keySeq).padStart(12, "0")}` },
    });
    if (res.status === 201) stats.created++;
    else {
      assert.ok(res.status < 500, `booking → ${res.status} ${JSON.stringify(res.body)}`);
      stats.refused++;
      refusals.set(res.error?.code ?? String(res.status), (refusals.get(res.error?.code ?? String(res.status)) ?? 0) + 1);
    }
  };

  const live = (status: string) => h.db.all<{ booking_code: string; total_satang: number }>("SELECT booking_code, total_satang FROM bookings WHERE booking_status = ?", status);

  for (let step = 0; step < steps; step++) {
    const roll = r.next();
    if (roll < 0.45) {
      // A burst of simultaneous bookings (the race the night locks and counters must survive).
      await Promise.all(Array.from({ length: r.int(2, 6) }, () => book()));
    } else if (roll < 0.58) {
      const pending = live("PENDING");
      if (pending.length) {
        const b = r.pick(pending);
        // Two staff record the same payment at once: exactly one wins.
        const pay = () => h.api("POST", `/api/admin/bookings/${b.booking_code}/payments`, {
          token: root, body: { amountSatang: b.total_satang, method: "CASH", paidAt: h.now.toISOString() },
        });
        const results = await Promise.all([pay(), pay()]);
        assert.ok(results.every((x) => x.status < 500));
        if (results.some((x) => x.status === 200)) stats.paid++;
      }
    } else if (roll < 0.7) {
      const any = h.db.all<{ booking_code: string }>("SELECT booking_code FROM bookings WHERE booking_status IN ('PENDING', 'CONFIRMED')");
      if (any.length) {
        const b = r.pick(any);
        const res = await h.api("POST", `/api/admin/bookings/${b.booking_code}/cancel`, { token: root, body: { reason: "simulation cancel" } });
        assert.ok(res.status < 500);
        if (res.status === 200) stats.cancelled++;
      }
    } else if (roll < 0.85) {
      const before = live("EXPIRED").length;
      h.advance(r.int(5, 70) * 60_000);
      await h.app.scheduled(h.env, h.now.getTime());
      stats.expired += live("EXPIRED").length - before;
      root = await h.login("root@example.test"); // sessions idle out as the clock moves
    } else if (roll < 0.93) {
      const date = addDays(today, r.int(2, 11));
      const res = await h.api("PUT", `/api/admin/camping/nights/${date}`, { token: root, body: { maxTents: r.int(0, 8) } });
      assert.ok(res.status < 500);
      if (res.status === 200) stats.capacityChanges++;
    } else {
      const date = addDays(today, r.int(2, 11));
      const res = await h.api("PUT", `/api/admin/food/capacity/dev_food_bbq/${date}`, { token: root, body: { maxQuantity: r.int(0, 6) } });
      assert.ok(res.status < 500);
      if (res.status === 200) stats.capacityChanges++;
    }
    checkInvariants(h, `seed ${seed} step ${step}`);
  }
  return { h, stats, refusals };
}

describe("business invariants under concurrent load (model-based simulation)", () => {
  for (const seed of [15, 2027, 31337]) {
    it(`seed ${seed}: 120 random steps keep every invariant`, async (t) => {
      const { stats, refusals } = await simulate(seed, 120);
      t.diagnostic(`${JSON.stringify(stats)} refusals ${JSON.stringify(Object.fromEntries(refusals))}`);
      // The run must actually exercise the system, including refusals at full capacity.
      assert.ok(stats.created >= 25, `created ${stats.created}`);
      assert.ok(stats.refused >= 5, `refused ${stats.refused}`);
      assert.ok(stats.paid >= 3 && stats.cancelled >= 3, JSON.stringify(stats));
      const capacityCodes = [...refusals.keys()].filter((c) => /UNAVAILABLE|FULL|CAPACITY/.test(c));
      assert.ok(capacityCodes.length > 0, `no capacity refusal seen: ${JSON.stringify([...refusals])}`);
    });
  }
});

describe("snapshots never change after booking (spec §62)", () => {
  it("price, nightly prices, included meals, food prices and the payment account stay as booked", async () => {
    const h = new Harness({ seed: true });
    await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
    const root = await h.login("root@example.test");
    const body = {
      checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, lang: "th", stay: { kind: "UNIT", unitId: "dev_house_01" },
      food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 2, children: 0 }],
    };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    const created = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Snapshot Guest", phone: "0811111111" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: "snapshot-key-00000001" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const code = created.data.bookingCode;
    const tables = ["bookings", "booking_items", "booking_price_snapshots", "booking_included_meals", "booking_food_items", "payment_account_snapshots"];
    const dump = () => Object.fromEntries(tables.map((t) => [t, h.db.all(`SELECT * FROM ${t} WHERE ${t === "bookings" ? "id" : "booking_id"} = (SELECT id FROM bookings WHERE booking_code = ?)`, code)
      .map((row) => { const { updated_at: _u, ...rest } = row as Record<string, unknown>; return rest; })]));
    const before = dump();
    const adminBefore = (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${code}`, { token: root })).data;
    const lookupBefore = (await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: code, phone: "0811111111" } })).data;
    assert.ok((before.booking_included_meals ?? []).length > 0, "the house includes breakfast");

    // The owner changes everything a booking was priced from.
    const changes = [
      await h.api("PATCH", "/api/admin/accommodations/dev_house_01", { token: root, body: { basePriceSatang: 990_000 } }),
      await h.api("POST", "/api/admin/pricing-rules", { token: root, body: { targetType: "UNIT", unitId: "dev_house_01", name: "Peak", dateFrom: "2027-01-15", dateTo: "2027-03-31", daysOfWeek: "0123456", priceSatang: 777_700, priority: 50, status: "ACTIVE" } }),
      await h.api("PATCH", "/api/admin/cms/foodOption/dev_food_dinner_a", { token: root, body: { priceSatang: 88_800 } }),
      await h.api("PATCH", "/api/admin/cms/includedMeal/dev_incl_sakura_breakfast", { token: root, body: { personsPerNight: 4 } }),
      await h.api("PATCH", "/api/admin/receiving-accounts/dev_account_01", { token: root, body: { bankName: "ธนาคารใหม่", accountName: "ชื่อบัญชีใหม่", accountNumber: "999-9-99999-9" } }),
      await h.api("PUT", "/api/admin/accommodations/dev_house_01/translations", { token: root, body: { translations: { th: { name: "ชื่อบ้านใหม่หมด" } } } }),
    ];
    for (const c of changes) assert.equal(c.status < 300, true, JSON.stringify(c.body).slice(0, 300));

    assert.deepEqual(dump(), before, "stored snapshots unchanged");
    const adminAfter = (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${code}`, { token: root })).data;
    const lookupAfter = (await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: code, phone: "0811111111" } })).data;
    const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (["updatedAt", "audit", "history", "events", "timeline", "notifications"].includes(k) ? undefined : v)));
    assert.deepEqual(strip(lookupAfter), strip(lookupBefore), "what the guest sees is unchanged (price, items, meals, payment account)");
    assert.equal(adminAfter.totalSatang, adminBefore.totalSatang);
    assert.deepEqual(adminAfter.item, adminBefore.item);
    assert.deepEqual(adminAfter.food, adminBefore.food);
    assert.deepEqual(adminAfter.includedMeals, adminBefore.includedMeals);

    // …while a new quote uses the new prices.
    const fresh = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: { ...body, checkIn: "2027-02-08", checkOut: "2027-02-10", food: [] } });
    assert.ok(fresh.data.accommodationSubtotalSatang > q.data.accommodationSubtotalSatang, "new bookings use the new price");
    assert.throws(() => h.db.run("UPDATE payment_account_snapshots SET bank_name_snapshot = 'x'"), /SNAPSHOT_IMMUTABLE/);
    assert.throws(() => h.db.run("UPDATE booking_included_meals SET persons_per_night_snapshot = 9"), /IMMUTABLE/);
  });
});
