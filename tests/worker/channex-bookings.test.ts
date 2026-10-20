import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AvailabilityDto } from "../../src/shared/accommodation-types.ts";
import type { OtaBookingsDto } from "../../src/shared/channel-types.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10 10:00 Bangkok.
const PROPERTY = "11111111-1111-4111-8111-111111111111";
const ROOM_H1 = "aaaaaaaa-0000-4000-8000-000000000001";
const ROOM_H2 = "aaaaaaaa-0000-4000-8000-000000000002";
const PLAN_H1 = "bbbbbbbb-0000-4000-8000-000000000001";
let n = 0;
const uuid = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, "0")}`;

interface Rev { id: string; booking_id: string; status: string; [k: string]: unknown }

function revision(over: Partial<Rev> & { booking_id: string; status: string; rooms?: unknown[] }): Rev {
  return {
    id: uuid(), property_id: PROPERTY, ota_name: "Booking.com", ota_reservation_code: "9996013801",
    arrival_date: "2027-02-01", departure_date: "2027-02-03", amount: "7000.00", currency: "THB", payment_collect: "ota",
    notes: "Late arrival", customer: { name: "Somchai", surname: "Jaidee", mail: "guest@example.com", phone: "+66 81 234 5678", language: "th" },
    rooms: [{ room_type_id: ROOM_H1, rate_plan_id: PLAN_H1, checkin_date: "2027-02-01", checkout_date: "2027-02-03", amount: "7000.00",
      occupancy: { adults: 2, children: 1, infants: 0 }, days: { "2027-02-01": "3000.00", "2027-02-02": "4000.00" } }],
    ...over,
  };
}

async function setup(opts: { feedFails?: boolean } = {}) {
  const h = new Harness({ seed: true });
  h.env.CHANNEX_API_KEY = "test-key";
  const feed: Rev[] = [];
  const acks: string[] = [];
  const pushes: { path: string; values: Record<string, unknown>[] }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  h.channex = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    if (path === `/properties/${PROPERTY}`) return json(200, { data: { id: PROPERTY, attributes: { title: "Phasakura", currency: "THB" } } });
    if (path === "/room_types/options") {
      return json(200, { data: [ROOM_H1, ROOM_H2].map((id, i) => ({ id, attributes: { title: `House ${i + 1}`, occ_adults: 4, property_id: PROPERTY } })) });
    }
    if (path === "/rate_plans/options") return json(200, { data: [{ id: PLAN_H1, attributes: { title: "BAR", room_type_id: ROOM_H1, currency: "THB", occupancy: 2 } }] });
    if (path === "/booking_revisions/feed") {
      if (opts.feedFails) return json(500, { errors: { code: "internal", title: "Boom" } });
      assert.equal(u.searchParams.get("filter[property_id]"), PROPERTY);
      return json(200, { data: feed.filter((r) => !acks.includes(r.id)).map((r) => ({ type: "booking_revision", id: r.id, attributes: r })) });
    }
    const ack = /^\/booking_revisions\/(.+)\/ack$/.exec(path);
    if (ack && method === "POST") { acks.push(ack[1]!); return json(200, { meta: { message: "Success" } }); }
    if (method === "POST" && (path === "/availability" || path === "/restrictions")) {
      pushes.push({ path, values: JSON.parse(String(init!.body)).values });
      return json(200, { data: [], meta: { warnings: [] } });
    }
    return json(404, { errors: { code: "not_found", title: "Not Found" } });
  };
  const email = await h.user({ id: "owner", roles: ["SUPER_ADMIN"] });
  const token = await h.login(email);
  assert.equal((await h.api("PUT", "/api/admin/channels/settings", { token, body: { channex: true } })).status, 200);
  await h.api("PUT", "/api/admin/channels/channex/property", { token, body: { propertyId: PROPERTY } });
  assert.equal((await h.api("PUT", "/api/admin/channels/channex/units/dev_house_01", { token, body: { roomTypeId: ROOM_H1, ratePlanId: PLAN_H1 } })).status, 200);
  await h.api("PUT", "/api/admin/channels/channex/units/dev_house_02", { token, body: { roomTypeId: ROOM_H2 } });
  const tick = async () => { h.advance(60_000); await h.app.scheduled(h.env); };
  const booking = (id: string) => h.db.get<Record<string, unknown>>(
    "SELECT b.* FROM bookings b JOIN ota_bookings o ON o.booking_id = b.id WHERE o.channex_booking_id = ?", id);
  const ota = (id: string) => h.db.get<Record<string, unknown>>("SELECT * FROM ota_bookings WHERE channex_booking_id = ?", id);
  const nights = (unit: string) => h.db.all<{ stay_date: string }>("SELECT stay_date FROM booking_unit_nights WHERE unit_id = ? AND booking_id IS NOT NULL ORDER BY stay_date", unit).map((r) => r.stay_date);
  return { h, token, feed, acks, pushes, tick, booking, ota, nights };
}

describe("Channex — OTA bookings come in (phase O4)", () => {
  it("a new booking paid to the OTA: confirmed and paid here, nights locked at the OTA's prices, acknowledged", async () => {
    const { h, token, feed, acks, tick, booking, ota, nights } = await setup();
    const B = uuid();
    const rev = revision({ booking_id: B, status: "new" });
    feed.push(rev);
    await tick();
    assert.deepEqual(acks, [rev.id]);
    const b = booking(B)!;
    assert.match(String(b.booking_code), /^BK-20270110-[A-Z0-9]{4}$/);
    assert.deepEqual([b.booking_status, b.payment_status, b.source, b.check_in, b.check_out, b.nights, b.adults, b.children],
      ["CONFIRMED", "PAID", "ADMIN", "2027-02-01", "2027-02-03", 2, 2, 1]);
    assert.deepEqual([b.customer_name, b.customer_phone_normalized, b.customer_email, b.language_code, b.total_satang, b.app_fee_satang],
      ["Somchai Jaidee", "0812345678", "guest@example.com", "th", 700000, 0]);
    assert.match(String(b.admin_note), /^Booking\.com 9996013801 · paid to the OTA · Channex /);
    assert.deepEqual(nights("dev_house_01"), ["2027-02-01", "2027-02-02"]);
    const snap = h.db.get<{ nightly_prices_json: string; subtotal_satang: number }>("SELECT nightly_prices_json, subtotal_satang FROM booking_price_snapshots WHERE booking_id = ?", String(b.id))!;
    assert.deepEqual(JSON.parse(snap.nightly_prices_json), [{ date: "2027-02-01", priceSatang: 300000 }, { date: "2027-02-02", priceSatang: 400000 }]);
    const pay = h.db.get<Record<string, unknown>>("SELECT amount_satang, method, status, reference FROM payments WHERE booking_id = ?", String(b.id))!;
    assert.deepEqual({ ...pay }, { amount_satang: 700000, method: "OTHER", status: "PAID", reference: "Booking.com 9996013801" });
    assert.equal(ota(B)!.status, "ACTIVE");
    assert.equal(h.audits("OTA_BOOKING_CREATED").length, 1);
    const pub = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-01&checkOut=2027-02-02");
    assert.equal(pub.data.units.find((u) => u.unitId === "dev_house_01")!.available, false);
    const list = await h.api<OtaBookingsDto>("GET", "/api/admin/channels/channex/bookings", { token });
    assert.equal(list.data.lastFeedStatus, "OK");
    assert.deepEqual(list.data.items.map((i) => [i.otaName, i.status, i.bookingCode, i.paymentCollect]), [["Booking.com", "ACTIVE", b.booking_code, "ota"]]);

    // Channex offers the same revision again (our ack was lost): nothing new.
    acks.length = 0;
    await tick();
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 1);
    assert.deepEqual(acks, [rev.id]);
  });

  it("paid at the property: confirmed, unpaid (staff take the money at check-in), no payment row; no phone → placeholder", async () => {
    const { h, feed, tick, booking } = await setup();
    const B = uuid();
    feed.push(revision({ booking_id: B, status: "new", payment_collect: "property", customer: { name: "Anna", surname: null, mail: null, phone: null, language: "de" } }));
    await tick();
    const b = booking(B)!;
    assert.deepEqual([b.booking_status, b.payment_status, b.customer_name, b.customer_phone_normalized, b.language_code], ["CONFIRMED", "UNPAID", "Anna", "000000", "en"]);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payments")!.n, 0);
  });

  it("modified: the old booking is cancelled and a new one holds the new nights; cancelled: freed", async () => {
    const { h, feed, tick, booking, ota, nights } = await setup();
    const B = uuid();
    feed.push(revision({ booking_id: B, status: "new" }));
    await tick();
    const first = booking(B)!;
    feed.push(revision({
      booking_id: B, status: "modified", arrival_date: "2027-02-05", departure_date: "2027-02-06", amount: "3500.00",
      rooms: [{ room_type_id: ROOM_H2, checkin_date: "2027-02-05", checkout_date: "2027-02-06", amount: "3500.00", occupancy: { adults: 2 }, days: {} }],
    }));
    await tick();
    const second = booking(B)!;
    assert.notEqual(second.id, first.id);
    assert.equal(h.db.get<{ booking_status: string }>("SELECT booking_status FROM bookings WHERE id = ?", String(first.id))!.booking_status, "CANCELLED");
    assert.deepEqual(nights("dev_house_01"), [], "old nights freed");
    assert.deepEqual(nights("dev_house_02"), ["2027-02-05"]);
    assert.equal(second.total_satang, 350000);
    assert.equal(h.audits("OTA_BOOKING_MODIFIED").length, 1);

    feed.push(revision({ booking_id: B, status: "cancelled" }));
    await tick();
    assert.equal(h.db.get<{ booking_status: string }>("SELECT booking_status FROM bookings WHERE id = ?", String(second.id))!.booking_status, "CANCELLED");
    assert.deepEqual(nights("dev_house_02"), []);
    assert.equal(ota(B)!.status, "CANCELLED");
  });

  it("nights already booked here = double booking: kept as CONFLICT (no booking), CRITICAL event, acknowledged, resolvable", async () => {
    const { h, token, feed, acks, tick, ota } = await setup();
    h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason) VALUES ('dev_house_01', '2027-02-02', 'Repair')");
    const B = uuid();
    const rev = revision({ booking_id: B, status: "new" });
    feed.push(rev);
    await tick();
    const row = ota(B)!;
    assert.equal(row.status, "CONFLICT");
    assert.equal(row.booking_id, null);
    assert.match(String(row.problem), /Nights already booked here/);
    assert.ok(acks.includes(rev.id));
    assert.equal(h.events("OTA_BOOKING_CONFLICT").length, 1);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings")!.n, 0, "nothing half written");
    const res = await h.api<{ status: string }>("POST", `/api/admin/channels/channex/bookings/${row.id}/resolve`, { token, body: {} });
    assert.equal(res.data.status, "RESOLVED");
  });

  it("a room type no unit is mapped to = UNMAPPED; a failing feed is not acknowledged and is read again", async () => {
    const ctx = await setup();
    const B = uuid();
    ctx.feed.push(revision({ booking_id: B, status: "new", rooms: [{ room_type_id: uuid(), checkin_date: "2027-02-01", checkout_date: "2027-02-02", amount: "1.00", occupancy: { adults: 1 }, days: {} }] }));
    await ctx.tick();
    assert.equal(ctx.ota(B)!.status, "UNMAPPED");

    const bad = await setup({ feedFails: true });
    bad.feed.push(revision({ booking_id: uuid(), status: "new" }));
    await bad.tick();
    assert.deepEqual(bad.acks, []);
    assert.equal(bad.h.db.get<{ last_feed_status: string }>("SELECT last_feed_status FROM channex_settings")!.last_feed_status, "ERROR");
  });

  it("the OTA booking's nights go back to Channex as 0 in the same minute (bookings are read before availability is sent)", async () => {
    const { h, token, feed, pushes, tick } = await setup();
    await h.api("PUT", "/api/admin/channels/channex/ari", { token, body: { enabled: true } });
    pushes.length = 0;
    feed.push(revision({ booking_id: uuid(), status: "new" }));
    await tick();
    const a = pushes.find((p) => p.path === "/availability")!;
    assert.deepEqual(a.values.map((v) => [v.date, v.availability]), [["2027-02-01", 0], ["2027-02-02", 0]]);
  });

  it("the live account can start sending now that bookings come in", async () => {
    const { h, token } = await setup();
    h.env.CHANNEX_ENV = "production";
    const res = await h.api<{ ari: { liveBlocked: boolean } }>("GET", "/api/admin/channels", { token });
    assert.equal((res.data as unknown as { channex: { ari: { liveBlocked: boolean } } }).channex.ari.liveBlocked, false);
  });
});
