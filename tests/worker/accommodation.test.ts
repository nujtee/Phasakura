import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type {
  AdminAvailabilityDto,
  AdminUnitDto,
  AmenityDto,
  AvailabilityDto,
  CampingNightDto,
  CampingSettingsDto,
  PublicAccommodationsDto,
  PublicUnitDto,
} from "../../src/shared/accommodation-types.ts";
import { addDays, stayNights } from "../../src/shared/dates.ts";
import { sniffImage } from "../../src/worker/media/image-sniff.ts";
import { Harness } from "../helpers/harness.ts";
import { htmlBytes, jpegBytes, pngBytes, svgBytes, webpBytes } from "../helpers/images.ts";

// Harness clock: 2027-01-10T03:00Z → today in Bangkok = 2027-01-10.
const TODAY = "2027-01-10";
let h: Harness;
let root: string;
let manager: string;
let content: string;
let booking: string;
let viewer: string;

beforeEach(async () => {
  h = new Harness({ seed: true });
  await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
  await h.user({ id: "mgr", roles: ["MANAGER"] });
  await h.user({ id: "content", roles: ["CONTENT_ADMIN"] });
  await h.user({ id: "booking", roles: ["BOOKING_ADMIN"] });
  await h.user({ id: "viewer", roles: ["VIEWER"] });
  root = await h.login("root@example.test");
  manager = await h.login("mgr@example.test");
  content = await h.login("content@example.test");
  booking = await h.login("booking@example.test");
  viewer = await h.login("viewer@example.test");
});

/** Inserts a confirmed booking holding `unitId` for [checkIn, checkOut). */
function bookUnit(unitId: string, checkIn: string, checkOut: string, code = "BK-20270201-AAAA") {
  const nights = stayNights(checkIn, checkOut);
  const bookingId = `b-${code}`;
  h.db.run(
    `INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults, customer_name,
       customer_phone, customer_phone_normalized, accommodation_subtotal_satang, subtotal_satang, total_satang, booking_status)
     VALUES (?, ?, 'th', ?, ?, ?, 2, 'Private Guest Name', '0812345678', '0812345678', 1, 1, 1, 'CONFIRMED')`,
    bookingId, code, checkIn, checkOut, nights.length,
  );
  const type = h.db.get<{ unit_type: string }>("SELECT unit_type FROM accommodation_units WHERE id = ?", unitId)!.unit_type;
  h.db.run("INSERT INTO booking_items (id, booking_id, item_type, unit_id, adults) VALUES (?, ?, ?, ?, 2)", `i-${code}`, bookingId, type, unitId);
  for (const n of nights) {
    h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, booking_id, booking_item_id) VALUES (?, ?, ?, ?)", unitId, n, bookingId, `i-${code}`);
  }
}

describe("public accommodation API", () => {
  it("lists only ACTIVE houses and VIP tents in the requested language, plus camping", async () => {
    h.db.run("UPDATE accommodation_units SET status = 'DRAFT' WHERE id = 'dev_vip_03'");
    const res = await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=en");
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.houses.map((u) => u.name), ["House 01 — Sakura House", "House 02 — Stargazing House"]);
    assert.deepEqual(res.data.vipTents.map((u) => u.unitCode), ["VIP-01", "VIP-02"]);
    assert.equal(res.data.houses[0]!.priceSatang, 350000);
    assert.deepEqual(res.data.houses[0]!.amenities.map((a) => a.name), ["Wi-Fi", "Air conditioning", "Private bathroom"]);
    assert.equal(res.data.camping.enabled, true);
    assert.equal(res.data.camping.pricePerAdultNightSatang, 25000);
    assert.equal(res.data.camping.name, "Bring your own tent");
    assert.match(res.headers.get("Cache-Control") ?? "", /public/);
  });

  it("falls back to the default language when a translation is missing", async () => {
    h.db.run("DELETE FROM accommodation_translations WHERE unit_id = 'dev_house_02' AND language_code = 'zh-CN'");
    const res = await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=zh-cn");
    assert.equal(res.data.houses[1]!.name, "House 02 — บ้านชมดาว");
    assert.equal(res.data.houses[0]!.name, "01号屋 — 樱花屋");
  });

  it("detail by slug; unknown, draft and malformed slugs are not exposed", async () => {
    const ok = await h.api<PublicUnitDto>("GET", "/api/public/accommodations/house-sakura?lang=th");
    assert.equal(ok.data.unitCode, "HOUSE-01");
    assert.equal((await h.api("GET", "/api/public/accommodations/nope")).status, 404);
    h.db.run("UPDATE accommodation_units SET status = 'MAINTENANCE' WHERE id = 'dev_house_01'");
    assert.equal((await h.api("GET", "/api/public/accommodations/house-sakura")).status, 404);
    assert.equal((await h.api("GET", "/api/public/accommodations/..%2Fadmin")).status, 422);
  });
});

describe("public availability (§12, §15)", () => {
  const avail = (q: string) => h.api<AvailabilityDto>("GET", `/api/public/availability?${q}`);

  it("checks every stay night; check-out day is free for the next guest", async () => {
    bookUnit("dev_house_01", "2027-02-01", "2027-02-04");
    const overlap = await avail("checkIn=2027-02-03&checkOut=2027-02-05");
    const house1 = overlap.data.units.find((u) => u.unitId === "dev_house_01")!;
    assert.equal(house1.available, false);
    assert.equal(overlap.data.units.find((u) => u.unitId === "dev_house_02")!.available, true, "separate inventory");

    const backToBack = await avail("checkIn=2027-02-04&checkOut=2027-02-06");
    assert.equal(backToBack.data.units.find((u) => u.unitId === "dev_house_01")!.available, true);
    assert.equal(backToBack.data.nights, 2);
    assert.equal(backToBack.headers.get("Cache-Control"), "no-store");
  });

  it("reveals no booking details", async () => {
    bookUnit("dev_house_01", "2027-02-01", "2027-02-04");
    const res = await avail("checkIn=2027-02-01&checkOut=2027-02-02");
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes("BK-") && !text.includes("Private Guest") && !text.includes("0812345678"));
  });

  it("reports guest capacity fit per unit", async () => {
    const res = await avail("checkIn=2027-02-01&checkOut=2027-02-02&guests=4");
    assert.equal(res.data.units.find((u) => u.unitId === "dev_house_01")!.fitsGuests, true);
    assert.equal(res.data.units.find((u) => u.unitId === "dev_vip_01")!.fitsGuests, false);
  });

  it("camping: 30 max, A=3 + B=5 → 22 remaining; minimum across all nights", async () => {
    h.db.run("UPDATE booking_settings SET max_tents_per_booking = 30"); // this test is about nightly capacity
    h.db.run("INSERT INTO camping_night_inventory (stay_date, max_tents, tents_used) VALUES ('2027-03-01', 30, 8)");
    h.db.run("INSERT INTO camping_night_inventory (stay_date, max_tents, tents_used) VALUES ('2027-03-02', 30, 25)");
    const one = await avail("checkIn=2027-03-01&checkOut=2027-03-02&tents=22");
    assert.equal(one.data.camping.remaining, 22);
    assert.equal(one.data.camping.fitsTents, true);
    const two = await avail("checkIn=2027-03-01&checkOut=2027-03-03&tents=6");
    assert.deepEqual(two.data.camping.nights, [{ date: "2027-03-01", remaining: 22 }, { date: "2027-03-02", remaining: 5 }]);
    assert.equal(two.data.camping.remaining, 5);
    assert.equal(two.data.camping.fitsTents, false);
    assert.equal(two.data.camping.reason, "FULL");
    assert.deepEqual(two.data.camping.shortNights, ["2027-03-02"], "names the night that is short");
  });

  it("camping disabled → nothing available", async () => {
    h.db.run("UPDATE camping_settings SET is_enabled = 0");
    const res = await avail("checkIn=2027-03-01&checkOut=2027-03-02&tents=1");
    assert.equal(res.data.camping.enabled, false);
    assert.equal(res.data.camping.remaining, 0);
    assert.equal(res.data.camping.fitsTents, false);
  });

  it("validates the stay window", async () => {
    const cases: [string, string, string][] = [
      ["checkIn=2027-01-09&checkOut=2027-01-11", "checkIn", "IN_THE_PAST"],
      ["checkIn=2027-02-01&checkOut=2027-02-01", "checkOut", "MUST_BE_AFTER_CHECK_IN"],
      ["checkIn=2027-02-01&checkOut=2027-03-05", "checkOut", "STAY_TOO_LONG"],
      [`checkIn=${addDays(TODAY, 366)}&checkOut=${addDays(TODAY, 367)}`, "checkIn", "TOO_FAR_AHEAD"],
      ["checkIn=2027-02-30&checkOut=2027-03-01", "checkIn", "INVALID_DATE"],
      ["checkIn=tomorrow&checkOut=2027-03-01", "checkIn", "INVALID_DATE"],
    ];
    for (const [q, field, code] of cases) {
      const res = await avail(q);
      assert.equal(res.status, 422, q);
      assert.equal(res.error?.details?.[field], code, q);
    }
    assert.equal((await avail("checkIn=2027-02-01&checkOut=2027-02-02&guests=-1")).status, 422);
    assert.equal((await avail("checkIn=2027-01-10&checkOut=2027-01-11")).status, 200, "today is bookable");
  });
});

describe("admin: houses & VIP tents", () => {
  const newUnit = { unitCode: "HOUSE-03", unitType: "HOUSE", slug: "house-river", basePriceSatang: 420000, standardGuests: 2, maxGuests: 6 };

  it("enforces permissions: view vs edit", async () => {
    assert.equal((await h.api("GET", "/api/admin/accommodations", { token: viewer })).status, 200);
    assert.equal((await h.api("GET", "/api/admin/accommodations", { token: content })).status, 200);
    assert.equal((await h.api("POST", "/api/admin/accommodations", { token: viewer, body: newUnit })).status, 403);
    assert.equal((await h.api("POST", "/api/admin/accommodations", { token: content, body: newUnit })).status, 403);
    assert.equal((await h.api("POST", "/api/admin/accommodations", { token: booking, body: newUnit })).status, 403);
    assert.equal((await h.api("POST", "/api/admin/accommodations", { token: manager, body: newUnit })).status, 201);
  });

  it("create → translate → activate → visible publicly", async () => {
    const created = await h.api<AdminUnitDto>("POST", "/api/admin/accommodations", { token: manager, body: newUnit });
    assert.equal(created.data.status, "DRAFT");
    const id = created.data.id;

    const early = await h.api("PATCH", `/api/admin/accommodations/${id}`, { token: manager, body: { status: "ACTIVE" } });
    assert.equal(early.error?.details?.status, "ADD_TRANSLATION_BEFORE_ACTIVATING");

    const tr = await h.api<AdminUnitDto>("PUT", `/api/admin/accommodations/${id}/translations`, {
      token: manager,
      body: { translations: { th: { name: "House 03 — บ้านริมน้ำ", description: "บรรทัด 1\nบรรทัด 2" }, en: { name: "House 03 — Riverside" } } },
    });
    assert.equal(tr.data.translations.th?.description, "บรรทัด 1\nบรรทัด 2");
    await h.api("PATCH", `/api/admin/accommodations/${id}`, { token: manager, body: { status: "ACTIVE" } });

    const pub = await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=en");
    assert.ok(pub.data.houses.some((u) => u.name === "House 03 — Riverside"));
    assert.equal(h.audits("CREATE").filter((a) => a.record_id === id).length, 1);
  });

  it("validates input, uniqueness and immutable type", async () => {
    const bad = await h.api("POST", "/api/admin/accommodations", {
      token: root, body: { ...newUnit, unitCode: "house 3", slug: "Bad Slug", basePriceSatang: 12.5, maxGuests: 1, hack: 1 },
    });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.error!.details!).sort(), ["basePriceSatang", "hack", "slug", "unitCode"]);
    const fewer = await h.api("POST", "/api/admin/accommodations", { token: root, body: { ...newUnit, maxGuests: 1 } });
    assert.equal(fewer.error?.details?.maxGuests, "LESS_THAN_STANDARD_GUESTS");
    const dupCode = await h.api("POST", "/api/admin/accommodations", { token: root, body: { ...newUnit, unitCode: "HOUSE-01" } });
    assert.equal(dupCode.error?.code, "UNIT_CODE_TAKEN");
    const dupSlug = await h.api("POST", "/api/admin/accommodations", { token: root, body: { ...newUnit, slug: "house-sakura" } });
    assert.equal(dupSlug.error?.code, "SLUG_TAKEN");
    const html = await h.api("PUT", "/api/admin/accommodations/dev_house_01/translations", {
      token: root, body: { translations: { fr: { name: "x" } } },
    });
    assert.equal(html.error?.details?.fr, "UNSUPPORTED_LANGUAGE");
  });

  it("changing price requires pricing.edit and is recorded in price history", async () => {
    // A delegated editor without pricing.edit
    h.grant("content", "accommodation.edit");
    const denied = await h.api("PATCH", "/api/admin/accommodations/dev_house_01", { token: content, body: { basePriceSatang: 1 } });
    assert.equal(denied.status, 403);
    const ok = await h.api<AdminUnitDto>("PATCH", "/api/admin/accommodations/dev_house_01", { token: content, body: { maxGuests: 5 } });
    assert.equal(ok.data.maxGuests, 5);

    await h.api("PATCH", "/api/admin/accommodations/dev_house_01", { token: manager, body: { basePriceSatang: 390000 } });
    const history = h.db.all<{ old_price_satang: number; new_price_satang: number; changed_by: string }>(
      "SELECT old_price_satang, new_price_satang, changed_by FROM price_history WHERE entity_id = 'dev_house_01'",
    );
    assert.deepEqual(history.map((r) => ({ ...r })), [{ old_price_satang: 350000, new_price_satang: 390000, changed_by: "mgr" }]);
  });

  it("soft delete is refused with upcoming bookings, otherwise hides the unit everywhere", async () => {
    bookUnit("dev_house_01", "2027-02-01", "2027-02-03");
    const refused = await h.api("DELETE", "/api/admin/accommodations/dev_house_01", { token: manager });
    assert.equal(refused.error?.code, "UNIT_HAS_FUTURE_BOOKINGS");

    assert.equal((await h.api("DELETE", "/api/admin/accommodations/dev_house_02", { token: manager })).status, 200);
    const list = await h.api<AdminUnitDto[]>("GET", "/api/admin/accommodations?type=HOUSE", { token: manager });
    assert.deepEqual(list.data.map((u) => u.id), ["dev_house_01"]);
    assert.equal((await h.api("GET", "/api/public/accommodations/house-stargazing")).status, 404);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accommodation_units WHERE id = 'dev_house_02'")!.n, 1, "row kept");
  });

  it("amenities: create with 3 languages, attach to a unit, reject unknown ids", async () => {
    const created = await h.api<AmenityDto>("POST", "/api/admin/amenities", {
      token: manager, body: { code: "hot_tub", icon: "bath", names: { th: "อ่างน้ำร้อน", en: "Hot tub", "zh-CN": "热水浴缸" } },
    });
    assert.equal(created.status, 201);
    const set = await h.api<AdminUnitDto>("PUT", "/api/admin/accommodations/dev_vip_03/amenities", {
      token: manager, body: { amenityIds: [created.data.id, "dev_amenity_wifi"] },
    });
    assert.deepEqual(set.data.amenityIds, [created.data.id, "dev_amenity_wifi"]);
    const pub = await h.api<PublicUnitDto>("GET", "/api/public/accommodations/vip-03?lang=zh-cn");
    assert.deepEqual(pub.data.amenities.map((a) => a.name), ["热水浴缸", "无线网络"]);
    const unknown = await h.api("PUT", "/api/admin/accommodations/dev_vip_03/amenities", { token: manager, body: { amenityIds: ["nope"] } });
    assert.equal(unknown.error?.details?.amenityIds, "UNKNOWN_AMENITY");
    const noThai = await h.api("POST", "/api/admin/amenities", { token: manager, body: { code: "x_y", names: { en: "X" } } });
    assert.equal(noThai.error?.details?.names, "DEFAULT_LANGUAGE_REQUIRED");
  });
});

describe("images: secure upload, storage, serving (§54, §55, §56)", () => {
  type Uploaded = { id: string; url: string; width: number; height: number; mimeType: string };

  it("stores an image under a server-generated key and serves it with safe headers", async () => {
    const res = await h.upload<Uploaded>(manager, { bytes: pngBytes(1200, 800), name: "../../etc/passwd.png", type: "image/png" }, "ACCOMMODATION");
    assert.equal(res.status, 201);
    assert.equal(res.data.mimeType, "image/png");
    assert.deepEqual([res.data.width, res.data.height], [1200, 800]);
    assert.match(res.data.url, /^\/media\/accommodation\/2027\/01\/[0-9a-f-]{36}\.png$/, "client file name ignored");
    const key = res.data.url.slice("/media/".length);
    assert.ok(h.bucket.objects.has(key));

    const served = await h.get(res.data.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("Content-Type"), "image/png");
    assert.equal(served.headers.get("X-Content-Type-Options"), "nosniff");
    assert.match(served.headers.get("Content-Security-Policy") ?? "", /sandbox/);
    assert.match(served.headers.get("Cache-Control") ?? "", /immutable/);
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), pngBytes(1200, 800));
    const etag = served.headers.get("ETag")!;
    assert.equal((await h.get(res.data.url, { "If-None-Match": etag })).status, 304);
    assert.equal(h.audits("UPLOAD").length, 1);
  });

  it("identifies type from bytes: JPEG and WebP accepted regardless of declared type", async () => {
    const jpg = await h.upload<Uploaded>(manager, { bytes: jpegBytes(1024, 768), name: "a.bin", type: "application/octet-stream" }, "ACCOMMODATION");
    assert.equal(jpg.data.mimeType, "image/jpeg");
    assert.match(jpg.data.url, /\.jpg$/);
    const webp = await h.upload<Uploaded>(manager, { bytes: webpBytes(640, 480), name: "b.webp", type: "image/webp" }, "ACCOMMODATION");
    assert.deepEqual([webp.data.mimeType, webp.data.width, webp.data.height], ["image/webp", 640, 480]);
  });

  it("rejects SVG, HTML disguised as PNG, and empty files", async () => {
    for (const [bytes, name, type] of [[svgBytes, "x.svg", "image/svg+xml"], [htmlBytes, "x.png", "image/png"], [new Uint8Array(0), "x.png", "image/png"]] as const) {
      const res = await h.upload(manager, { bytes, name, type }, "ACCOMMODATION");
      assert.equal(res.status, 422, name);
    }
    assert.equal(h.bucket.objects.size, 0, "nothing stored");
    assert.equal(h.events("UPLOAD_REJECTED").length, 2);
  });

  it("enforces purpose permissions and never accepts private slips here", async () => {
    const gallery = await h.upload(booking, { bytes: pngBytes(), name: "g.png", type: "image/png" }, "GALLERY");
    assert.equal(gallery.status, 403);
    const slip = await h.upload(root, { bytes: pngBytes(), name: "s.png", type: "image/png" }, "PAYMENT_SLIP");
    assert.equal(slip.status, 422);
    const extra = await h.upload(root, { bytes: pngBytes(), name: "e.png", type: "image/png" }, "ACCOMMODATION", { bucket: "PRIVATE" });
    assert.equal(extra.error?.details?.bucket, "UNKNOWN_FIELD");
    const json = await h.api("POST", "/api/admin/media", { token: root, body: { purpose: "ACCOMMODATION" } });
    assert.equal(json.status, 415);
    assert.equal((await h.upload(root, { bytes: pngBytes(), name: "a.png", type: "image/png" }, "ACCOMMODATION")).status, 201);
    const noAuth = await h.app.fetch(new Request("https://phasakura.test/api/admin/media", {
      method: "POST", headers: { Origin: "https://phasakura.test", "X-Requested-With": "phasakura" }, body: new FormData(),
    }), h.env);
    assert.equal(noAuth.status, 401);
  });

  it("rejects oversized images", async () => {
    const huge = await h.upload(manager, { bytes: pngBytes(20_000, 20_000), name: "h.png", type: "image/png" }, "ACCOMMODATION");
    assert.equal(huge.error?.details?.file, "IMAGE_TOO_LARGE_DIMENSIONS");
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(pngBytes());
    const tooBig = await h.upload(manager, { bytes: big, name: "b.png", type: "image/png" }, "ACCOMMODATION");
    assert.equal(tooBig.status, 413);
  });

  it("/media only serves registered, active, public assets", async () => {
    assert.equal((await h.get("/media/accommodation/2027/01/nope.png")).status, 404);
    // URL normalisation turns /media/../x into /x: it never reaches the media handler (SPA page, not a file).
    const escaped = await h.get("/media/../wrangler.jsonc");
    assert.match(await escaped.text(), /<!doctype html>/i);
    assert.equal((await h.get("/media/a%2F..%2Fsecret")).status, 404, "decoded traversal rejected by key guard");
    // An object that exists in the bucket but is not registered (or is private) is never served.
    await h.bucket.put("slips/2027/01/private.jpg", jpegBytes());
    h.db.run(
      "INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256) VALUES ('slip', 'PRIVATE', 'slips/2027/01/private.jpg', 'PAYMENT_SLIP', 'image/jpeg', 10, ?)",
      "a".repeat(64),
    );
    assert.equal((await h.get("/media/slips/2027/01/private.jpg")).status, 404);
    assert.equal((await h.get("/media/x.png", {}, "POST")).status, 405);
  });

  it("gallery lifecycle on a unit: add (auto-cover), alt text, unpublish, reorder, cover, remove", async () => {
    const up = async () => (await h.upload<Uploaded>(manager, { bytes: pngBytes(), name: "p.png", type: "image/png" }, "ACCOMMODATION")).data;
    const [a, b, c] = [await up(), await up(), await up()];
    const add = (id: string) => h.api<AdminUnitDto>("POST", "/api/admin/accommodations/dev_house_01/images", { token: manager, body: { mediaAssetId: id } });
    let unit = (await add(a.id)).data;
    assert.equal(unit.coverAssetId, a.id, "first image becomes cover");
    await add(b.id);
    unit = (await add(c.id)).data;
    assert.equal((await add(c.id)).error?.code, "IMAGE_ALREADY_ADDED");

    await h.api("PUT", `/api/admin/media/${b.id}/texts`, {
      token: manager, body: { texts: { th: { altText: "ห้องนอนหลัก", caption: "วิวภูเขา" }, en: { altText: "Main bedroom" } } },
    });

    const imgB = unit.images.find((i) => i.mediaAssetId === b.id)!;
    const imgC = unit.images.find((i) => i.mediaAssetId === c.id)!;
    await h.api("PATCH", `/api/admin/accommodations/dev_house_01/images/${imgC.id}`, { token: manager, body: { status: "UNPUBLISHED" } });
    let pub = (await h.api<PublicUnitDto>("GET", "/api/public/accommodations/house-sakura?lang=en")).data;
    assert.equal(pub.images.length, 2, "unpublished image hidden");
    assert.equal(pub.images[1]!.alt, "Main bedroom");
    assert.equal((await h.api<PublicUnitDto>("GET", "/api/public/accommodations/house-sakura?lang=th")).data.images[1]!.caption, "วิวภูเขา");

    const order = [imgC.id, imgB.id, unit.images[0]!.id];
    const reordered = await h.api<AdminUnitDto>("PUT", "/api/admin/accommodations/dev_house_01/images/order", { token: manager, body: { imageIds: order } });
    assert.deepEqual(reordered.data.images.map((i) => i.id), order);
    assert.equal((await h.api("PUT", "/api/admin/accommodations/dev_house_01/images/order", { token: manager, body: { imageIds: [imgB.id] } })).status, 422);

    await h.api("PUT", "/api/admin/accommodations/dev_house_01/cover", { token: manager, body: { mediaAssetId: b.id } });
    pub = (await h.api<PublicUnitDto>("GET", "/api/public/accommodations/house-sakura?lang=en")).data;
    assert.equal(pub.cover?.url, b.url);

    const removed = await h.api<AdminUnitDto>("DELETE", `/api/admin/accommodations/dev_house_01/images/${imgB.id}`, { token: manager });
    assert.notEqual(removed.data.coverAssetId, b.id, "cover moved to another image");
    assert.equal((await h.get(b.url)).status, 404, "removed image no longer served");
    assert.ok(!h.bucket.objects.has(b.url.slice(7)), "object deleted from R2");
  });

  it("only ACCOMMODATION images can be attached to a unit", async () => {
    const logo = await h.upload<Uploaded>(root, { bytes: pngBytes(), name: "l.png", type: "image/png" }, "LOGO");
    const res = await h.api("POST", "/api/admin/accommodations/dev_house_01/images", { token: root, body: { mediaAssetId: logo.data.id } });
    assert.equal(res.error?.details?.mediaAssetId, "INVALID_IMAGE");
  });
});

describe("date blocks & admin availability grid", () => {
  it("blocks dates (inclusive), shows them in the grid and hides them from public availability", async () => {
    const res = await h.api("POST", "/api/admin/accommodations/dev_house_02/blocks", {
      token: booking, body: { startDate: "2027-02-01", endDate: "2027-02-03", reason: "Roof repair" },
    });
    assert.equal(res.status, 201);
    const grid = await h.api<AdminAvailabilityDto>("GET", "/api/admin/availability?from=2027-01-31&days=5", { token: booking });
    const house2 = grid.data.units.find((u) => u.id === "dev_house_02")!;
    assert.deepEqual(grid.data.dates.map((d) => house2.nights[d]!.state), ["FREE", "BLOCKED", "BLOCKED", "BLOCKED", "FREE"]);
    assert.equal(house2.nights["2027-02-01"]!.blockReason, "Roof repair");
    const pub = await h.api<AvailabilityDto>("GET", "/api/public/availability?checkIn=2027-02-03&checkOut=2027-02-04");
    assert.equal(pub.data.units.find((u) => u.unitId === "dev_house_02")!.available, false);
  });

  it("cannot block over a booking or an existing block; unblocking never frees a booking", async () => {
    bookUnit("dev_house_01", "2027-02-02", "2027-02-04");
    const over = await h.api("POST", "/api/admin/accommodations/dev_house_01/blocks", {
      token: root, body: { startDate: "2027-02-01", endDate: "2027-02-02", reason: "x" },
    });
    assert.equal(over.error?.code, "DATES_UNAVAILABLE");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE block_reason IS NOT NULL")!.n, 0, "atomic");

    await h.api("DELETE", "/api/admin/accommodations/dev_house_01/blocks?startDate=2027-02-01&endDate=2027-02-10", { token: root });
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE unit_id = 'dev_house_01'")!.n, 2);
  });

  it("requires accommodation.block; rejects past dates", async () => {
    const body = { startDate: "2027-02-01", endDate: "2027-02-01", reason: "x" };
    assert.equal((await h.api("POST", "/api/admin/accommodations/dev_house_01/blocks", { token: viewer, body })).status, 403);
    const past = await h.api("POST", "/api/admin/accommodations/dev_house_01/blocks", {
      token: root, body: { ...body, startDate: "2027-01-01" },
    });
    assert.equal(past.error?.details?.startDate, "IN_THE_PAST");
  });

  it("booking codes are shown only to users with bookings.view", async () => {
    bookUnit("dev_house_01", "2027-02-01", "2027-02-02", "BK-20270201-ZZZZ");
    const withView = await h.api<AdminAvailabilityDto>("GET", "/api/admin/availability?from=2027-02-01&days=1", { token: booking });
    assert.equal(withView.data.units.find((u) => u.id === "dev_house_01")!.nights["2027-02-01"]!.bookingCode, "BK-20270201-ZZZZ");
    const withoutView = await h.api<AdminAvailabilityDto>("GET", "/api/admin/availability?from=2027-02-01&days=1", { token: content });
    assert.equal(withoutView.data.units.find((u) => u.id === "dev_house_01")!.nights["2027-02-01"]!.bookingCode, undefined);
    assert.deepEqual(withoutView.data.camping, [], "camping needs camping.view");
    assert.equal((await h.api("GET", "/api/admin/availability?from=2027-02-01&days=100", { token: root })).status, 422);
  });
});

describe("camping settings & nightly capacity", () => {
  const nights = async (from: string, days: number) =>
    (await h.api<AdminAvailabilityDto>("GET", `/api/admin/availability?from=${from}&days=${days}`, { token: root })).data.camping;

  it("reads settings; price change needs pricing.edit and is recorded", async () => {
    const s = await h.api<CampingSettingsDto>("GET", "/api/admin/camping", { token: booking });
    assert.equal(s.data.maxTentsPerNight, 30);
    assert.equal(s.data.translations.en?.name, "Bring your own tent");
    h.grant("booking", "camping.edit");
    const body = { ...s.data, translations: undefined, pricePerAdultNightSatang: 30000 };
    delete (body as Record<string, unknown>).translations;
    assert.equal((await h.api("PUT", "/api/admin/camping", { token: booking, body })).status, 403);
    const ok = await h.api<CampingSettingsDto>("PUT", "/api/admin/camping", { token: manager, body });
    assert.equal(ok.data.pricePerAdultNightSatang, 30000);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM price_history WHERE entity_type = 'CAMPING'")!.n, 1);
  });

  it("new default capacity flows to future nights except admin overrides; cannot go below tents sold", async () => {
    h.db.run("INSERT INTO camping_night_inventory (stay_date, max_tents, tents_used) VALUES ('2027-03-01', 30, 12)");
    const override = await h.api<CampingNightDto>("PUT", "/api/admin/camping/nights/2027-03-02", { token: manager, body: { maxTents: 15 } });
    assert.deepEqual([override.data.capacity, override.data.isOverride], [15, true]);

    const base = (await h.api<CampingSettingsDto>("GET", "/api/admin/camping", { token: root })).data;
    const { translations: _t, ...settings } = base;
    await h.api("PUT", "/api/admin/camping", { token: manager, body: { ...settings, maxTentsPerNight: 40 } });
    assert.deepEqual((await nights("2027-03-01", 3)).map((n) => n.capacity), [40, 15, 40]);

    const tooLow = await h.api("PUT", "/api/admin/camping", { token: manager, body: { ...settings, maxTentsPerNight: 10 } });
    assert.equal(tooLow.error?.code, "BELOW_TENTS_SOLD");
    assert.deepEqual((await nights("2027-03-01", 1)).map((n) => n.capacity), [40], "unchanged after rollback");

    const nightTooLow = await h.api("PUT", "/api/admin/camping/nights/2027-03-01", { token: manager, body: { maxTents: 11 } });
    assert.equal(nightTooLow.error?.code, "BELOW_TENTS_SOLD");

    const reset = await h.api<CampingNightDto>("PUT", "/api/admin/camping/nights/2027-03-02", { token: manager, body: { maxTents: null } });
    assert.deepEqual([reset.data.capacity, reset.data.isOverride], [40, false]);
    assert.equal((await h.api("PUT", "/api/admin/camping/nights/2027-01-01", { token: manager, body: { maxTents: 5 } })).status, 422);
  });

  it("cannot enable camping without a name in the default language", async () => {
    h.db.run("DELETE FROM camping_setting_translations WHERE language_code = 'th'");
    const base = (await h.api<CampingSettingsDto>("GET", "/api/admin/camping", { token: root })).data;
    const { translations: _t, ...settings } = base;
    const res = await h.api("PUT", "/api/admin/camping", { token: root, body: { ...settings, isEnabled: true } });
    assert.equal(res.error?.details?.isEnabled, "ADD_TRANSLATION_BEFORE_ACTIVATING");
  });
});

describe("image sniffer (unit)", () => {
  it("reads PNG / JPEG / WebP dimensions from headers", () => {
    assert.deepEqual(sniffImage(pngBytes(12, 34)), { mime: "image/png", extension: "png", width: 12, height: 34 });
    assert.deepEqual(sniffImage(jpegBytes(640, 360)), { mime: "image/jpeg", extension: "jpg", width: 640, height: 360 });
    assert.deepEqual(sniffImage(webpBytes(300, 200)), { mime: "image/webp", extension: "webp", width: 300, height: 200 });
    assert.equal(sniffImage(svgBytes), null);
    assert.equal(sniffImage(htmlBytes), null);
  });
});
