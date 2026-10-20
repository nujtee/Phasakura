import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelsDto, ChannexAutoCreateDto, ChannexPropertiesDto, ChannexRoomsDto, ChannexStatusDto } from "../../src/shared/channel-types.ts";
import { Harness } from "../helpers/harness.ts";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
let n = 0;
const uuid = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/** In-memory Channex: properties, room types, rate plans; 401 for any other key. */
function fakeChannex(h: Harness, opts: { failRatePlan?: boolean; failRoomAfter?: number; limitPushes?: number; warnOn?: string; production?: boolean } = {}) {
  const pushes: { path: string; values: Record<string, unknown>[] }[] = [];
  const roomTypes: { id: string; title: string; property_id: string; occ_adults: number; count_of_rooms: number }[] = [
    { id: uuid(), title: "Existing Bungalow", property_id: P1, occ_adults: 2, count_of_rooms: 1 },
  ];
  const ratePlans: { id: string; title: string; room_type_id: string; property_id: string; currency: string; occupancy: number; rate: string }[] = [
    { id: uuid(), title: "BAR", room_type_id: roomTypes[0]!.id, property_id: P1, currency: "THB", occupancy: 2, rate: "1500.00" },
  ];
  let createdRooms = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  h.channex = async (url, init) => {
    if (new Headers(init?.headers).get("user-api-key") !== "test-key") return json(401, { errors: { code: "unauthorized", title: "Unauthorized" } });
    const u = new URL(url);
    assert.equal(u.origin, opts.production ? "https://app.channex.io" : "https://staging.channex.io", "staging unless CHANNEX_ENV=production");
    const path = u.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method === "GET" && path === "/properties/options") {
      return json(200, { data: [P1, P2].map((id, i) => ({ type: "property", id, attributes: { id, title: i ? "Other place" : "Phasakura Khun Wang", currency: "THB" } })) });
    }
    const prop = /^\/properties\/(.+)$/.exec(path);
    if (method === "GET" && prop) {
      if (![P1, P2].includes(prop[1]!)) return json(404, { errors: { code: "not_found", title: "Not Found" } });
      return json(200, { data: { type: "property", id: prop[1], attributes: { title: prop[1] === P1 ? "Phasakura Khun Wang" : "Other place", currency: "THB", timezone: "Asia/Bangkok" } } });
    }
    const pid = u.searchParams.get("filter[property_id]");
    if (method === "GET" && path === "/room_types/options") {
      return json(200, { data: roomTypes.filter((r) => r.property_id === pid).map((r) => ({ type: "room_type", id: r.id, attributes: { ...r } })) });
    }
    if (method === "GET" && path === "/rate_plans/options") {
      return json(200, { data: ratePlans.filter((r) => r.property_id === pid).map((r) => ({ type: "rate_plan", id: r.id, attributes: { ...r, sell_mode: "per_room" } })) });
    }
    if (method === "POST" && path === "/room_types") {
      if (opts.failRoomAfter !== undefined && createdRooms >= opts.failRoomAfter) return json(429, { errors: { code: "http_too_many_requests", title: "Too Many Requests" } });
      createdRooms++;
      const r = { id: uuid(), ...body.room_type };
      roomTypes.push(r);
      return json(201, { data: { type: "room_type", id: r.id, attributes: r } });
    }
    if (method === "POST" && path === "/rate_plans") {
      if (opts.failRatePlan) return json(422, { errors: { code: "validation_error", title: "Validation Error", details: { currency: ["is invalid"] } } });
      const b = body.rate_plan;
      const r = { id: uuid(), title: b.title, room_type_id: b.room_type_id, property_id: b.property_id, currency: b.currency, occupancy: b.options[0].occupancy, rate: b.options[0].rate };
      ratePlans.push(r);
      return json(201, { data: { type: "rate_plan", id: r.id, attributes: { ...r, sell_mode: "per_room" } } });
    }
    if (method === "POST" && (path === "/availability" || path === "/restrictions")) {
      if (opts.limitPushes !== undefined && pushes.length >= opts.limitPushes) return json(429, { errors: { code: "http_too_many_requests", title: "Too Many Requests" } });
      pushes.push({ path, values: body.values });
      const warnings = opts.warnOn && path === opts.warnOn ? [{ warning: { rate: ["must be greater than 0"] } }] : [];
      return json(200, { data: [{ id: uuid(), type: "task" }], meta: { message: "Success", warnings } });
    }
    return json(404, { errors: { code: "not_found", title: "Not Found" } });
  };
  return { roomTypes, ratePlans, pushes };
}

let seq = 0;
async function staff(h: Harness, roles: string[]) {
  const id = `cx_${++seq}`;
  const email = await h.user({ id, roles });
  return { id, token: await h.login(email) };
}

async function setup(opts: { key?: boolean; on?: boolean } = { key: true, on: true }) {
  const h = new Harness({ seed: true });
  if (opts.key !== false) h.env.CHANNEX_API_KEY = "test-key";
  const fake = fakeChannex(h);
  const owner = await staff(h, ["SUPER_ADMIN"]);
  if (opts.on !== false && opts.key !== false) {
    const on = await h.api("PUT", "/api/admin/channels/settings", { token: owner.token, body: { channex: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
  }
  const api = <T>(method: string, path: string, body?: unknown, token = owner.token) => h.api<T>(method, `/api/admin/channels/channex${path}`, { token, body });
  return { h, owner, fake, api };
}

describe("Channex — switch and connection", () => {
  it("can't be switched on without CHANNEX_API_KEY; with it, SUPER_ADMIN switches (audited) and the page shows staging", async () => {
    const { h, owner } = await setup({ key: false });
    const before = await h.api<ChannelsDto>("GET", "/api/admin/channels", { token: owner.token });
    assert.equal(before.data.channex.available, false);
    assert.equal((await h.api("PUT", "/api/admin/channels/settings", { token: owner.token, body: { channex: true } })).error?.code, "CHANNEX_NOT_CONFIGURED");
    h.env.CHANNEX_API_KEY = "test-key";
    const on = await h.api<ChannelsDto>("PUT", "/api/admin/channels/settings", { token: owner.token, body: { channex: true } });
    assert.equal(on.data.channex.enabled, true);
    assert.equal(on.data.channex.environment, "staging");
    assert.equal(on.data.channex.units.length, 5);
    assert.equal(on.data.ical.enabled, false, "the iCal switch is left as it was");
    assert.equal(h.audits("CHANNEL_CHANNEX_ON").length, 1);
    const manager = await staff(h, ["MANAGER"]);
    assert.equal((await h.api("PUT", "/api/admin/channels/settings", { token: manager.token, body: { channex: false } })).status, 403);
  });

  it("test lists the properties (key sent as user-api-key, never stored); a wrong key is explained", async () => {
    const { h, api } = await setup();
    const res = await api<ChannexPropertiesDto>("POST", "/test", {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.data.properties.map((p) => p.title), ["Phasakura Khun Wang", "Other place"]);
    assert.equal(h.channexCalls[0]!.key, "test-key");
    assert.equal(h.db.get<{ last_check_status: string }>("SELECT last_check_status FROM channex_settings")!.last_check_status, "OK");
    assert.doesNotMatch(JSON.stringify(h.db.all("SELECT * FROM channex_settings")), /test-key/);
    assert.doesNotMatch(JSON.stringify(h.db.all("SELECT new_value FROM audit_logs")), /test-key/);

    h.env.CHANNEX_API_KEY = "wrong";
    const bad = await api("POST", "/test", {});
    assert.equal(bad.error?.code, "CHANNEX_KEY_INVALID");
    assert.match(h.db.get<{ last_check_error: string }>("SELECT last_check_error FROM channex_settings")!.last_check_error, /CHANNEX_KEY_INVALID/);
  });

  it("SUPER_ADMIN or MANAGER chooses the property; changing it clears the mapping; everything needs Channex on", async () => {
    const { h, owner, api } = await setup();
    const manager = await staff(h, ["MANAGER"]);
    const bookingAdmin = await staff(h, ["BOOKING_ADMIN"]);
    assert.equal((await api("PUT", "/property", { propertyId: P1 }, bookingAdmin.token)).status, 403);
    assert.equal((await api<ChannexStatusDto>("PUT", "/property", { propertyId: P2 }, manager.token)).data.property?.id, P2, "a Manager can choose");
    assert.equal((await api("PUT", "/property", { propertyId: "not-a-uuid" })).error?.details?.propertyId, "INVALID_ID");
    assert.equal((await api("PUT", "/property", { propertyId: "33333333-3333-4333-8333-333333333333" })).error?.code, "CHANNEX_NOT_FOUND");
    const chosen = await api<ChannexStatusDto>("PUT", "/property", { propertyId: P1 });
    assert.deepEqual(chosen.data.property, { id: P1, title: "Phasakura Khun Wang", currency: "THB" });
    assert.equal(h.audits("CHANNEX_PROPERTY_SET").length, 2);

    await api("POST", "/auto-create", {});
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM channex_unit_map")!.n, 5);
    await api("PUT", "/property", { propertyId: P2 });
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM channex_unit_map")!.n, 0, "another property: start the mapping again");

    await h.api("PUT", "/api/admin/channels/settings", { token: owner.token, body: { channex: false } });
    assert.equal((await api("GET", "/rooms")).error?.code, "CHANNEX_DISABLED");
  });
});

describe("Channex — room mapping", () => {
  it("auto-create: one room type (1 room) + a Standard per-room plan at the base price for each unmapped unit", async () => {
    const { h, api, fake } = await setup();
    await api("PUT", "/property", { propertyId: P1 });
    const res = await api<ChannexAutoCreateDto>("POST", "/auto-create", {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.created.length, 5);
    assert.deepEqual(res.data.failed, []);
    const house = h.channexCalls.find((c) => c.method === "POST" && c.url.endsWith("/room_types") && JSON.stringify(c.body).includes("HOUSE-01"))!.body as { room_type: Record<string, unknown> };
    assert.equal(house.room_type.count_of_rooms, 1);
    assert.equal(house.room_type.property_id, P1);
    assert.match(String(house.room_type.title), /^HOUSE-01 · /);
    const plan = fake.ratePlans.find((p) => p.room_type_id === res.data.created.find((c) => c.unitId === "dev_house_01")!.roomTypeId)!;
    assert.deepEqual([plan.title, plan.currency, plan.rate], ["Standard", "THB", "3500.00"]);
    assert.ok(res.data.status.units.every((u) => u.roomTypeId && u.ratePlanId));
    assert.equal(h.audits("CHANNEX_UNIT_CREATED").length, 5);
    const again = await api<ChannexAutoCreateDto>("POST", "/auto-create", {});
    assert.equal(again.data.created.length, 0, "mapped units are left alone");
  });

  it("auto-create stops on a rate limit and keeps what was made; a refused rate plan leaves the room mapped without one", async () => {
    const h1 = await setup();
    fakeChannex(h1.h, { failRoomAfter: 2 });
    await h1.api("PUT", "/property", { propertyId: P1 });
    const res = await h1.api<ChannexAutoCreateDto>("POST", "/auto-create", {});
    assert.equal(res.data.created.length, 2);
    assert.equal(res.data.failed.length, 1, "stops at the first rate limit");
    assert.match(res.data.failed[0]!.error, /CHANNEX_RATE_LIMITED/);

    const h2 = await setup();
    fakeChannex(h2.h, { failRatePlan: true });
    await h2.api("PUT", "/property", { propertyId: P1 });
    const res2 = await h2.api<ChannexAutoCreateDto>("POST", "/auto-create", {});
    assert.equal(res2.data.created.length, 5);
    assert.equal(res2.data.failed.length, 5);
    assert.ok(res2.data.status.units.every((u) => u.roomTypeId && !u.ratePlanId));
  });

  it("map by hand: the room type must be in the property and the rate plan of that room type; one unit per room type", async () => {
    const { h, api, fake } = await setup();
    assert.equal((await api("GET", "/rooms")).error?.code, "CHANNEX_NO_PROPERTY");
    await api("PUT", "/property", { propertyId: P1 });
    const rooms = await api<ChannexRoomsDto>("GET", "/rooms");
    assert.deepEqual(rooms.data.roomTypes.map((r) => r.title), ["Existing Bungalow"]);
    const room = fake.roomTypes[0]!.id;
    const rate = fake.ratePlans[0]!.id;
    const ok = await api<ChannexStatusDto>("PUT", "/units/dev_house_01", { roomTypeId: room, ratePlanId: rate });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.data.units.find((u) => u.unitId === "dev_house_01")!.ratePlanTitle, "BAR");
    assert.equal((await api("PUT", "/units/dev_house_02", { roomTypeId: room })).error?.code, "CHANNEX_ROOM_TAKEN");
    assert.equal((await api("PUT", "/units/dev_house_02", { roomTypeId: uuid() })).error?.details?.roomTypeId, "NOT_IN_PROPERTY");
    const other = (await api<ChannexAutoCreateDto>("POST", "/auto-create", {})).data.created.find((c) => c.unitId === "dev_house_02")!;
    assert.equal((await api("PUT", "/units/dev_house_02", { roomTypeId: other.roomTypeId, ratePlanId: rate })).error?.details?.ratePlanId, "NOT_OF_ROOM_TYPE");
    assert.equal((await api("PUT", "/units/dev_house_02", { roomTypeId: "x" })).error?.details?.roomTypeId, "INVALID_ID");
    assert.equal((await api("PUT", "/units/nope", { roomTypeId: room })).error?.code, "ACCOMMODATION_NOT_FOUND");
    const off = await api<ChannexStatusDto>("PUT", "/units/dev_house_01", { roomTypeId: null });
    assert.equal(off.data.units.find((u) => u.unitId === "dev_house_01")!.roomTypeId, null);
    assert.equal(h.audits("CHANNEX_UNIT_UNMAPPED").length, 1);
    const viewer = await staff(h, ["BOOKING_ADMIN"]);
    assert.equal((await api("GET", "/rooms", undefined, viewer.token)).status, 403);
  });
});

describe("Channex — availability and prices (phase O3)", () => {
  async function ready(opts: Parameters<typeof fakeChannex>[1] = {}) {
    const ctx = await setup();
    const fake = fakeChannex(ctx.h, opts);
    await ctx.api("PUT", "/property", { propertyId: P1 });
    const created = await ctx.api<ChannexAutoCreateDto>("POST", "/auto-create", {});
    assert.equal(created.data.created.length, 5);
    return { ...ctx, fake, created: created.data.created };
  }
  const avail = (p: { values: Record<string, unknown>[] }[], roomTypeId: string) =>
    p.filter((x) => x).flatMap((x) => x.values).filter((v) => v.room_type_id === roomTypeId);

  it("start sending: every night of every mapped unit, booked nights 0, prices with the OTA markup; audited", async () => {
    const { h, api, fake, created } = await ready();
    const house1 = created.find((c) => c.unitId === "dev_house_01")!;
    h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason) VALUES ('dev_house_01', '2027-02-01', 'Repair')");
    assert.equal((await api("PUT", "/ari", { markupPercent: 101 })).error?.details?.markupPercent, "OUT_OF_RANGE");
    const res = await api<ChannexStatusDto>("PUT", "/ari", { enabled: true, markupPercent: 15 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.ari.enabled, true);
    assert.equal(res.data.ari.lastPushStatus, "OK");
    const a = fake.pushes.find((p) => p.path === "/availability")!;
    const r = fake.pushes.find((p) => p.path === "/restrictions")!;
    assert.equal(a.values.length, 5 * 366, "today + 365 days, each unit");
    const h1 = a.values.filter((v) => v.room_type_id === house1.roomTypeId);
    assert.deepEqual(h1.find((v) => v.date === "2027-02-01"), { property_id: P1, room_type_id: house1.roomTypeId, date: "2027-02-01", availability: 0 });
    assert.equal(h1.find((v) => v.date === "2027-02-02")!.availability, 1);
    assert.equal(h1[0]!.date, "2027-01-10", "from today");
    const price = r.values.find((v) => v.rate_plan_id === house1.ratePlanId && v.date === "2027-02-02")!;
    assert.equal(price.rate, "4025.00", "3,500 + 15%");
    assert.equal(h.audits("CHANNEX_ARI_SET").length, 1);
    void avail;
  });

  it("then each minute only what changed: a booking closes one night; a seasonal price changes only its nights; nothing changed = nothing sent", async () => {
    const { h, api, fake, created } = await ready();
    const house1 = created.find((c) => c.unitId === "dev_house_01")!;
    await api("PUT", "/ari", { enabled: true });
    const n = fake.pushes.length;
    h.advance(60_000);
    await h.app.scheduled(h.env);
    assert.equal(fake.pushes.length, n, "no change, no call");
    h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason) VALUES ('dev_house_01', '2027-03-03', 'Private')");
    h.advance(60_000);
    await h.app.scheduled(h.env);
    assert.equal(fake.pushes.length, n + 1);
    assert.deepEqual(fake.pushes.at(-1), { path: "/availability", values: [{ property_id: P1, room_type_id: house1.roomTypeId, date: "2027-03-03", availability: 0 }] });
    h.db.run("DELETE FROM booking_unit_nights WHERE stay_date = '2027-03-03'");
    h.advance(60_000);
    await h.app.scheduled(h.env);
    assert.equal(fake.pushes.at(-1)!.values[0]!.availability, 1, "freed again");

    // A new markup: only prices go out again.
    const before = fake.pushes.length;
    await api("PUT", "/ari", { markupPercent: 10 });
    const sent = fake.pushes.slice(before);
    assert.deepEqual(sent.map((p) => p.path), ["/restrictions"]);
    assert.equal(sent[0]!.values.length, 5 * 366);
  });

  it("everything again after 24 hours; a re-mapped unit is sent in full at once", async () => {
    const { h, api, fake, created } = await ready();
    await api("PUT", "/ari", { enabled: true });
    const n = fake.pushes.length;
    h.advance(24 * 3_600_000);
    await h.app.scheduled(h.env);
    assert.equal(fake.pushes.slice(n).find((p) => p.path === "/availability")!.values.length, 5 * 366);
    const m = fake.pushes.length;
    const vip1 = created.find((c) => c.unitId === "dev_vip_01")!;
    const fresh = (await staff(h, ["SUPER_ADMIN"])).token; // a day later: sign in again
    await api("PUT", "/units/dev_vip_01", { roomTypeId: null }, fresh);
    const re = await api("PUT", "/units/dev_vip_01", { roomTypeId: vip1.roomTypeId, ratePlanId: vip1.ratePlanId }, fresh);
    assert.equal(re.status, 200, JSON.stringify(re.body));
    h.advance(60_000);
    await h.app.scheduled(h.env);
    assert.equal(fake.pushes.slice(m).find((p) => p.path === "/availability")!.values.length, 366, "only that unit");
  });

  it("a rate limit waits a minute and retries; refused entries are shown; stopping stops", async () => {
    const { h, api, fake } = await ready({ limitPushes: 0 });
    const res = await api<ChannexStatusDto>("PUT", "/ari", { enabled: true });
    assert.equal(res.data.ari.lastPushStatus, "ERROR");
    assert.match(res.data.ari.lastPushError!, /CHANNEX_RATE_LIMITED/);
    const calls = h.channexCalls.length;
    h.advance(30_000);
    await h.app.scheduled(h.env);
    assert.equal(h.channexCalls.length, calls, "waits out the minute");
    fakeChannex(h, { warnOn: "/restrictions" });
    h.advance(31_000);
    await h.app.scheduled(h.env);
    const st = (await h.api<ChannelsDto>("GET", "/api/admin/channels", { token: (await staff(h, ["SUPER_ADMIN"])).token })).data.channex.ari;
    assert.equal(st.lastPushStatus, "WARNING");
    assert.match(st.lastPushError!, /1 refused/);
    void fake;
    await api("PUT", "/ari", { enabled: false });
    const after = h.channexCalls.length;
    h.advance(25 * 3_600_000);
    await h.app.scheduled(h.env);
    assert.equal(h.channexCalls.length, after);
  });

  it("an inactive unit is closed on the OTA; the live account can't start yet; needs a mapped unit", async () => {
    const { h, api, fake, created } = await ready();
    h.db.run("UPDATE accommodation_units SET status = 'MAINTENANCE' WHERE id = 'dev_vip_02'");
    await api("PUT", "/ari", { enabled: true });
    const vip2 = created.find((c) => c.unitId === "dev_vip_02")!;
    assert.ok(fake.pushes[0]!.values.filter((v) => v.room_type_id === vip2.roomTypeId).every((v) => v.availability === 0));

    const live = await setup();
    live.h.env.CHANNEX_ENV = "production";
    fakeChannex(live.h, { production: true });
    assert.equal((await live.api<ChannexStatusDto>("PUT", "/property", { propertyId: P1 })).data.ari.liveBlocked, true);
    assert.equal((await live.api("PUT", "/ari", { enabled: true })).error?.code, "CHANNEX_NO_ROOMS");
    live.h.db.run("INSERT INTO channex_unit_map (unit_id, room_type_id, updated_at) VALUES ('dev_house_01', '99999999-9999-4999-8999-999999999999', 'x')");
    assert.equal((await live.api("PUT", "/ari", { enabled: true })).error?.code, "CHANNEX_LIVE_NEEDS_BOOKINGS");
  });
});
