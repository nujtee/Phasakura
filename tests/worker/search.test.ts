import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { stayNights } from "../../src/shared/dates.ts";
import { normalizeSearchText, searchTokens, type SearchAnalyticsDto, type SearchResponseDto } from "../../src/shared/search-types.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10T03:00Z (Bangkok 2027-01-10).
let h: Harness;
let root: string;

beforeEach(async () => {
  h = new Harness({ seed: true });
  await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
  root = await h.login("root@example.test");
});

const search = (query: string) => h.api<SearchResponseDto>("GET", `/api/search?${query}`);
const titles = (r: { data: SearchResponseDto }) => r.data.results.map((x) => `${x.type}:${x.title}`);

function bookUnit(unitId: string, checkIn: string, checkOut: string) {
  const nights = stayNights(checkIn, checkOut);
  h.db.run(
    `INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults, customer_name,
       customer_phone, customer_phone_normalized, accommodation_subtotal_satang, subtotal_satang, total_satang, booking_status)
     VALUES ('b1', 'BK-20270120-AAAA', 'th', ?, ?, ?, 2, 'Guest', '0812345678', '0812345678', 1, 1, 1, 'CONFIRMED')`,
    checkIn, checkOut, nights.length,
  );
  h.db.run("INSERT INTO booking_items (id, booking_id, item_type, unit_id, adults) VALUES ('i1', 'b1', 'HOUSE', ?, 2)", unitId);
  for (const n of nights) h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, booking_id, booking_item_id) VALUES (?, ?, 'b1', 'i1')", unitId, n);
}

describe("search text helpers", () => {
  it("normalises case, width, punctuation and invisible characters; tokens are unique and capped", () => {
    assert.equal(normalizeSearchText("  ＶＩＰ–Tent!! "), "vip tent");
    assert.equal(normalizeSearchText("บ้าน​ซากุระ"), normalizeSearchText("บ้านซากุระ"));
    assert.deepEqual(searchTokens("a b a c d e f g h"), ["a", "b", "c", "d", "e", "f"]);
  });
});

describe("global search (spec §40–41)", () => {
  it("builds the index on first use in all three languages and finds words in any language", async () => {
    const res = await search("q=sakura&lang=th");
    assert.equal(res.status, 200);
    assert.deepEqual(titles(res), ["HOUSE:House 01 — บ้านซากุระ"], "English word, Thai answer");
    assert.equal(res.data.results[0]!.url, "/th/accommodation/house-sakura");
    assert.deepEqual(res.data.results[0]!.price, { satang: 350000, per: "NIGHT" });
    assert.equal(res.data.results[0]!.availability, null, "no dates → no availability claim");
    const langs = h.db.all<{ language_code: string; n: number }>("SELECT language_code, count(*) AS n FROM search_index GROUP BY language_code ORDER BY language_code");
    assert.deepEqual(langs.map((l) => l.language_code), ["en", "th", "zh-CN"]);
    assert.ok(h.db.get("SELECT 1 FROM search_index_state WHERE id = 1"), "state recorded");

    const tents = await search(`q=${encodeURIComponent("เต็นท์")}&lang=en`);
    assert.ok(titles(tents).includes("VIP_TENT:VIP-01"), "type words are indexed in every language");
    assert.equal(tents.data.results.find((r) => r.type === "VIP_TENT")!.url, "/en/accommodation/vip-01");
    const food = await search("q=breakfast&lang=zh-cn");
    assert.deepEqual(titles(food), ["FOOD:早餐 A", "FOOD:早餐 B"]);
    assert.deepEqual(food.data.results[0]!.price, { satang: 15000, per: "PERSON" });
    const bbq = await search(`q=${encodeURIComponent("บาร์บีคิว")}&lang=en`);
    assert.deepEqual(titles(bbq), ["FOOD:BBQ set"]);
    const none = await search("q=zzzz&lang=th");
    assert.deepEqual(none.data.results, []);
  });

  it("re-reads every result from the source: unpublished / inactive content drops out before the index catches up", async () => {
    await search("q=sakura&lang=en");
    h.db.run("UPDATE accommodation_units SET status = 'INACTIVE' WHERE id = 'dev_house_01'");
    assert.deepEqual((await search("q=sakura&lang=en")).data.results, [], "index still has it; the answer does not");
    const history = await search(`q=${encodeURIComponent("ตัวอย่าง")}&lang=th`);
    assert.ok(history.data.results.some((r) => r.type === "HISTORY"));
    h.db.run("UPDATE history_timeline SET status = 'UNPUBLISHED'");
    h.db.run("UPDATE history_sections SET status = 'UNPUBLISHED'");
    assert.ok(!(await search(`q=${encodeURIComponent("ตัวอย่าง")}&lang=th`)).data.results.some((r) => r.type === "HISTORY"));
  });

  it("with dates, checks availability live: booked or too-small units are not free; free ones come first", async () => {
    bookUnit("dev_house_01", "2027-01-20", "2027-01-22");
    const res = await search("q=house&lang=en&checkIn=2027-01-21&checkOut=2027-01-23");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const byId = new Map(res.data.results.map((r) => [r.id, r]));
    assert.deepEqual(byId.get("dev_house_01")!.availability, { available: false, remaining: null });
    assert.deepEqual(byId.get("dev_house_02")!.availability, { available: true, remaining: null });
    assert.equal(res.data.results[0]!.id, "dev_house_02", "free first");

    const datesOnly = await search("lang=th&checkIn=2027-01-20&checkOut=2027-01-21&guests=4");
    assert.ok(datesOnly.data.results.every((r) => ["HOUSE", "VIP_TENT", "CAMPING"].includes(r.type)), "dates only → stays");
    const vip01 = datesOnly.data.results.find((r) => r.id === "dev_vip_01")!;
    assert.equal(vip01.availability?.available, false, "max 3 guests < 4");
    const camping = datesOnly.data.results.find((r) => r.type === "CAMPING")!;
    assert.equal(camping.availability?.available, true);
    assert.ok((camping.availability?.remaining ?? 0) > 0);
    const firstFull = datesOnly.data.results.findIndex((r) => r.availability?.available === false);
    assert.ok(datesOnly.data.results.slice(firstFull).every((r) => !r.availability?.available), "all free stays before full ones");
  });

  it("validates input", async () => {
    assert.equal((await search("q=a&lang=th")).error?.details?.q, "TOO_SHORT");
    assert.equal((await search("lang=th")).error?.details?.q, "TOO_SHORT");
    assert.equal((await search("q=house&checkIn=2027-01-20")).error?.details?.checkIn, "INVALID_DATE");
    assert.equal((await search("q=house&checkIn=2027-01-22&checkOut=2027-01-20")).error?.details?.checkOut, "MUST_BE_AFTER_CHECK_IN");
    assert.equal((await search("q=house&guests=0")).error?.details?.guests, "OUT_OF_RANGE");
    assert.equal((await search("q=house&lang=fr")).status, 400);
    const long = await search(`q=${"ab ".repeat(200)}&lang=th`);
    assert.equal(long.status, 200);
    assert.ok(long.data.query.length <= 100);
  });

  it("logs searches anonymously, counts zero results and clicks; admins see the summary", async () => {
    await search("q=Sakura&lang=th");
    await search("q=sakura&lang=th");
    await search("q=snorkel&lang=en");
    const history = h.db.all<Record<string, unknown>>("SELECT * FROM search_history");
    assert.equal(history.length, 3);
    assert.ok(history.every((r) => r.session_hash === null), "no session / IP");
    assert.ok(!Object.keys(history[0]!).some((k) => /ip|user/.test(k)));
    const click = await h.api("POST", "/api/search/click", { body: { q: "SAKURA", lang: "th" } });
    assert.equal(click.status, 200);
    for (let i = 0; i < 3; i++) await h.api("POST", "/api/search/click", { body: { q: "sakura", lang: "th" } });
    const row = h.db.get<{ search_count: number; click_count: number }>("SELECT * FROM search_analytics WHERE query_normalized = 'sakura'")!;
    assert.deepEqual({ ...row }, { ...row, search_count: 2, click_count: 2 }, "clicks never exceed searches");
    assert.equal((await h.api("POST", "/api/search/click", { body: { q: "x" }, headers: { "X-Requested-With": "" } })).status, 403, "CSRF guard");

    const viewerEmail = await h.user({ id: "v", roles: ["VIEWER"] });
    const viewer = await h.login(viewerEmail);
    assert.equal((await h.api("GET", "/api/admin/search/analytics", { token: viewer })).status, 403);
    const stats = await h.api<SearchAnalyticsDto>("GET", "/api/admin/search/analytics?days=30", { token: root });
    assert.equal(stats.status, 200);
    assert.deepEqual(stats.data.top[0], { query: "sakura", language: "th", searches: 2, zeroResults: 0, clicks: 2 });
    assert.deepEqual(stats.data.zeroResults, [{ query: "snorkel", language: "en", searches: 1 }]);
    assert.ok(stats.data.index.rows > 0);
    assert.equal((await h.api("GET", "/api/admin/search/analytics?days=0", { token: root })).status, 422);
  });

  it("the cron rebuilds the index only after content changed; admins can rebuild by hand (audited)", async () => {
    await search("q=sakura&lang=th");
    const at = () => h.db.get<{ rebuilt_at: string }>("SELECT rebuilt_at FROM search_index_state")!.rebuilt_at;
    const first = at();
    h.now = new Date(h.now.getTime() + 5 * 60_000);
    await h.app.scheduled(h.env, Date.UTC(2027, 0, 10, 3, 5));
    assert.equal(at(), first, "nothing changed → no rebuild");
    h.db.run("UPDATE accommodation_translations SET name = 'บ้านภูเขาหมอก' WHERE unit_id = 'dev_house_02' AND language_code = 'th'");
    await h.app.scheduled(h.env, Date.UTC(2027, 0, 10, 3, 10));
    assert.notEqual(at(), first, "content changed → rebuilt");
    assert.deepEqual(titles(await search(`q=${encodeURIComponent("ภูเขาหมอก")}&lang=th`)), ["HOUSE:บ้านภูเขาหมอก"]);

    const viewerEmail = await h.user({ id: "v2", roles: ["VIEWER"] });
    assert.equal((await h.api("POST", "/api/admin/search/reindex", { token: await h.login(viewerEmail) })).status, 403);
    const re = await h.api<{ rows: number }>("POST", "/api/admin/search/reindex", { token: root });
    assert.equal(re.status, 200);
    assert.ok(re.data.rows > 0);
    assert.equal(h.audits("REBUILD_SEARCH_INDEX").length, 1);
  });

  it("finds published gallery photos and history by their texts, with the Thai calendar year", async () => {
    h.db.run("INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, width, height, sha256) VALUES ('g1', 'PUBLIC', 'gallery/x.webp', 'GALLERY', 'image/webp', 10, 800, 600, ?)", "c".repeat(64));
    h.db.run("INSERT INTO gallery_images (id, media_asset_id, category_id, status) VALUES ('gi1', 'g1', 'dev_gallery_nature', 'PUBLISHED')");
    h.db.run("INSERT INTO gallery_image_translations (image_id, language_code, alt_text, title) VALUES ('gi1', 'th', 'ทะเลหมอกยามเช้า', 'ทะเลหมอก'), ('gi1', 'en', 'Sea of mist at dawn', 'Sea of mist')");
    const g = await search("q=mist&lang=th");
    assert.deepEqual(titles(g), ["GALLERY:ทะเลหมอก"]);
    assert.equal(g.data.results[0]!.url, "/th/gallery");
    assert.equal(g.data.results[0]!.image?.url, "/media/gallery/x.webp");
    const year = await search("q=2563&lang=th");
    assert.ok(titles(year).some((t) => t.startsWith("HISTORY:2563 ")), "BE year finds the 2020 event");
  });
});
