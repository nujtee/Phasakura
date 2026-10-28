import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AvailabilityDto } from "../../src/shared/accommodation-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import {
  emptyLandscape, type LandscapeDocument, type LandscapeLayoutDto, type LandscapeObject, type LandscapeVersionDto, type PublicLandscapeDto,
} from "../../src/shared/landscape-types.ts";
import { Harness } from "../helpers/harness.ts";

/**
 * Landscape acceptance (phase L5) — brief "Phase 7", the server side:
 *   5. publishing (and everything else done to a plan) never touches a confirmed booking;
 *   6. concurrent bookings started from the map cannot exceed what is free;
 *   7. permissions are enforced on the server, for every landscape endpoint.
 * The other criteria are covered where they live (docs/LANDSCAPE.md → "Acceptance tests" lists every test).
 * Harness clock: 2027-01-10 10:00 Bangkok; stays in February 2027.
 */
let seq = 0;
const key = () => `land-acc-${String(++seq).padStart(10, "0")}`;

const obj = (over: Partial<LandscapeObject>): LandscapeObject => ({
  id: `o${++seq}`, layerId: "stays", kind: "HOUSE", shape: { type: "rect", x: 10, y: 10, w: 12, h: 8 }, rotation: 0,
  style: { fill: "#c9a66b", stroke: "#333333", opacity: 1 }, label: null, link: null, groupId: null, locked: false, imageAssetId: null, ...over,
});

async function setup() {
  const h = new Harness({ seed: true });
  const root = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  assert.equal((await h.api("PUT", "/api/admin/landscape/settings", { token: root, body: { enabled: true } })).status, 200);
  const made = await h.api<LandscapeLayoutDto>("POST", "/api/admin/landscape/layouts", { token: root, body: { name: "Site", backgroundKind: "BLANK" } });
  let layout = made.data;
  /** Saves `doc` as the draft and publishes it (public). */
  const publish = async (doc: LandscapeDocument) => {
    const saved = await h.api<LandscapeLayoutDto>("PUT", `/api/admin/landscape/layouts/${layout.id}/draft`, { token: root, body: { baseRevision: layout.draftRevision, document: doc } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const pub = await h.api<LandscapeLayoutDto>("POST", `/api/admin/landscape/layouts/${layout.id}/publish`, { token: root, body: { revision: saved.data.draftRevision, makePublic: true } });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    layout = pub.data;
    return pub.data;
  };
  return { h, root, publish, layoutId: () => layout.id };
}

async function bookUnit(h: Harness, unitId: string, checkIn = "2027-02-10", checkOut = "2027-02-12") {
  const body = { checkIn, checkOut, adults: 2, children: 0, stay: { kind: "UNIT", unitId }, food: [], lang: "th" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  if (q.status !== 200) return { status: q.status, error: q.error, data: null as unknown as PublicBookingDto };
  return h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer: { name: "Guest", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
}

/** Everything stored about one booking: the booking, its items, price snapshots and the nights it holds. */
function bookingState(h: Harness, code: string) {
  const b = h.db.get<{ id: string }>("SELECT id FROM bookings WHERE booking_code = ?", code)!;
  return JSON.stringify({
    booking: h.db.all("SELECT * FROM bookings WHERE id = ?", b.id),
    items: h.db.all("SELECT * FROM booking_items WHERE booking_id = ? ORDER BY id", b.id),
    prices: h.db.all("SELECT * FROM booking_price_snapshots WHERE booking_item_id IN (SELECT id FROM booking_items WHERE booking_id = ?) ORDER BY id", b.id),
    nights: h.db.all("SELECT * FROM booking_unit_nights WHERE booking_id = ? ORDER BY stay_date", b.id),
  });
}

describe("landscape acceptance (server)", () => {
  it("5 · a confirmed booking is never changed by publishing, re-linking, rolling back or archiving a plan", async () => {
    const { h, root, publish, layoutId } = await setup();
    const sakura = obj({ label: "Sakura", link: { type: "UNIT", unitId: "dev_house_01" } });
    await publish({ ...emptyLandscape("BLANK"), objects: [sakura] });

    const b = await bookUnit(h, "dev_house_01");
    assert.equal(b.status, 201, JSON.stringify(b));
    const paid = await h.api("POST", `/api/admin/bookings/${b.data.bookingCode}/payments`, {
      token: root, body: { amountSatang: b.data.totalSatang, method: "CASH", paidAt: "2027-01-10T03:00:00Z" },
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(h.db.get<{ s: string }>("SELECT booking_status AS s FROM bookings WHERE booking_code = ?", b.data.bookingCode)!.s, "CONFIRMED");
    const before = bookingState(h, b.data.bookingCode);

    // The house moves to another object, then goes off the plan; a price change happens meanwhile.
    await publish({ ...emptyLandscape("BLANK"), objects: [obj({ label: "Renamed", link: { type: "UNIT", unitId: "dev_house_01" }, shape: { type: "circle", cx: 50, cy: 50, r: 6 } })] });
    await publish({ ...emptyLandscape("BLANK"), objects: [obj({ label: "Decor only" })] });
    h.db.run("UPDATE accommodation_units SET base_price_satang = base_price_satang + 50000 WHERE id = 'dev_house_01'");
    const versions = (await h.api<LandscapeVersionDto[]>("GET", `/api/admin/landscape/layouts/${layoutId()}/versions`, { token: root })).data;
    const first = versions.find((v) => v.versionNo === 1)!;
    assert.equal((await h.api("POST", `/api/admin/landscape/layouts/${layoutId()}/versions/${first.id}/republish`, { token: root })).status, 200, "rollback");
    assert.equal((await h.api("DELETE", `/api/admin/landscape/layouts/${layoutId()}`, { token: root })).status, 200, "archive");

    assert.equal(bookingState(h, b.data.bookingCode), before, "booking, items, price snapshot and nights unchanged");
    // The map never frees a booked house: the booking API still says taken, and a second booking is refused.
    const params = new URLSearchParams({ checkIn: "2027-02-10", checkOut: "2027-02-12", adults: "2", children: "0" });
    const avail = await h.api<AvailabilityDto>("GET", `/api/public/availability?${params}`);
    assert.equal(avail.data.units.find((u) => u.unitId === "dev_house_01")?.available, false);
    const again = await bookUnit(h, "dev_house_01");
    assert.equal(again.status, 409);
    assert.equal(again.error?.code, "UNIT_UNAVAILABLE");
  });

  it("6 · guests choosing the same house on the map at the same time: exactly one booking; camping never over capacity", async () => {
    const { h, publish } = await setup();
    await publish({
      ...emptyLandscape("BLANK"),
      objects: [
        obj({ link: { type: "UNIT", unitId: "dev_house_02" } }),
        obj({ kind: "CAMPING_AREA", layerId: "ground", link: { type: "CAMPING" }, shape: { type: "polygon", points: [[80, 10], [120, 10], [120, 50]] } }),
      ],
    });
    // Same house, same dates, six requests fired together (quotes first, so every create is a real race).
    const body = { checkIn: "2027-02-20", checkOut: "2027-02-22", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [], lang: "th" };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    const results = await Promise.all(Array.from({ length: 6 }, () => h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Racer", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    })));
    assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(","));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.error?.code === "UNIT_UNAVAILABLE"));
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE unit_id = 'dev_house_02' AND stay_date IN ('2027-02-20', '2027-02-21')")!.n, 2);

    // Camping: more tents asked for at once than the ground holds.
    const params = new URLSearchParams({ checkIn: "2027-02-25", checkOut: "2027-02-26", adults: "2", children: "0", tents: "1" });
    const free = (await h.api<AvailabilityDto>("GET", `/api/public/availability?${params}`)).data.camping.remaining;
    assert.ok(free > 0);
    const camp = { checkIn: "2027-02-25", checkOut: "2027-02-26", adults: 2, children: 0, stay: { kind: "CAMPING", tents: 1 }, food: [], lang: "th" };
    const cq = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: camp });
    const camps = await Promise.all(Array.from({ length: free + 3 }, () => h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...camp, customer: { name: "Camper", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: cq.data.totalSatang, idempotencyKey: key() },
    })));
    assert.equal(camps.filter((r) => r.status === 201).length, free, camps.map((r) => r.status).join(","));
    assert.ok(camps.filter((r) => r.status !== 201).every((r) => r.error?.code === "CAMPING_FULL"));
    for (const n of h.db.all<{ tents_used: number; max_tents: number }>("SELECT tents_used, max_tents FROM camping_night_inventory")) {
      assert.ok(n.tents_used <= n.max_tents, JSON.stringify(n));
    }
  });

  it("7 · every landscape endpoint checks permission on the server (signed out, a role without it, a role with it)", async () => {
    const { h, root, layoutId } = await setup();
    const id = layoutId();
    const doc = emptyLandscape("BLANK");
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/admin/landscape"],
      ["PUT", "/api/admin/landscape/settings", { enabled: true }],
      ["PUT", "/api/admin/landscape/public", { layoutId: id }],
      ["GET", "/api/admin/landscape/templates"],
      ["POST", "/api/admin/landscape/templates", { name: "T", object: { kind: "TREE", shape: { type: "symbol", x: 0.5, y: 0.5, size: 1 }, rotation: 0, style: { fill: null, stroke: null, opacity: 1 }, label: null, locked: false, imageAssetId: null } }],
      ["POST", "/api/admin/landscape/layouts", { name: "X", backgroundKind: "BLANK" }],
      ["GET", `/api/admin/landscape/layouts/${id}`],
      ["PUT", `/api/admin/landscape/layouts/${id}/draft`, { baseRevision: 1, document: doc }],
      ["POST", `/api/admin/landscape/layouts/${id}/publish`, { revision: 1 }],
      ["GET", `/api/admin/landscape/layouts/${id}/versions`],
      ["DELETE", `/api/admin/landscape/layouts/${id}`],
    ];
    for (const [method, path, body] of calls) {
      const res = await h.api(method, path, { body });
      assert.equal(res.status, 401, `${method} ${path} signed out → ${res.status}`);
    }
    // A role without landscape permissions (front desk / kitchen): refused on every one.
    const kitchen = await h.login(await h.user({ id: `kitchen_${++seq}`, roles: [] }));
    for (const [method, path, body] of calls) {
      const res = await h.api(method, path, { token: kitchen, body });
      assert.equal(res.status, 403, `${method} ${path} without permission → ${res.status}`);
    }
    // Booking staff may look but not change; content staff may edit but not publish or switch the feature.
    const booking = await h.login(await h.user({ id: `booking_${++seq}`, roles: ["BOOKING_ADMIN"] }));
    assert.equal((await h.api("GET", `/api/admin/landscape/layouts/${id}`, { token: booking })).status, 200);
    assert.equal((await h.api("PUT", `/api/admin/landscape/layouts/${id}/draft`, { token: booking, body: { baseRevision: 1, document: doc } })).status, 403);
    const content = await h.login(await h.user({ id: `content_${++seq}`, roles: ["CONTENT_ADMIN"] }));
    assert.equal((await h.api("PUT", `/api/admin/landscape/layouts/${id}/draft`, { token: content, body: { baseRevision: 1, document: doc } })).status, 200);
    assert.equal((await h.api("POST", `/api/admin/landscape/layouts/${id}/publish`, { token: content, body: { revision: 2 } })).status, 403);
    assert.equal((await h.api("PUT", "/api/admin/landscape/settings", { token: content, body: { enabled: false } })).status, 403);
    assert.equal((await h.api("PUT", "/api/admin/landscape/settings", { token: root, body: { enabled: true } })).status, 200);
    // The public plan carries no admin data.
    const pub = await h.api<PublicLandscapeDto>("GET", "/api/public/landscape");
    assert.equal(pub.status, 200);
    assert.ok(!/root_|content_|booking_|draft|revision/i.test(JSON.stringify(pub.data)), JSON.stringify(pub.data).slice(0, 200));
  });
});
