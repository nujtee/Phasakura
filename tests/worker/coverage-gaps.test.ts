import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createApp } from "../../src/worker/index.ts";
import { fetchDashboardNumbers, parseServiceAccountKey, resetGa4TokenCache } from "../../src/worker/marketing/ga4-data.ts";
import { DEFAULT_GRAPH_VERSION, scrub, sendCapiEvent, type CapiEvent } from "../../src/worker/marketing/meta-capi.ts";
import { sniffImage } from "../../src/worker/media/image-sniff.ts";
import { createSlipVerifier, EasySlipVerifier } from "../../src/worker/slip/slip-verifier.ts";
import { makeEnv } from "../helpers/fake-env.ts";
import { jsonResponse } from "../helpers/fake-http.ts";
import { Harness } from "../helpers/harness.ts";
import { MIGRATIONS_DIR, migrationFiles, SqliteD1 } from "../helpers/sqlite-d1.ts";

/** Phase 15 — paths the coverage report showed as never exercised. */

describe("image sniffing: every accepted format and its variants", () => {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  it("JPEG with fill bytes, restart markers and APPn segments before the frame header", () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xff, 0xd0, 0xff, 0xe1, 0x00, 0x04, 0x00, 0x00, // fill byte, RST0, APP1 (len 4)
      0xff, 0xc4, 0x00, 0x04, 0x00, 0x00, // DHT is not a frame header
      0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 3, ...new Array(12).fill(0), // SOF2 progressive 800×600
    ]);
    assert.deepEqual(sniffImage(bytes), { mime: "image/jpeg", extension: "jpg", height: 600, width: 800 });
    assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, ...new Array(20).fill(0)])), null, "segment length < 2");
    assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0x12, ...new Array(20).fill(0)])), null, "garbage instead of a marker");
  });

  it("WebP lossy (VP8) and lossless (VP8L)", () => {
    const riff = (chunk: string, body: number[]) => new Uint8Array([...new TextEncoder().encode("RIFF"), 40, 0, 0, 0, ...new TextEncoder().encode("WEBP"), ...new TextEncoder().encode(chunk), ...body, ...new Array(24).fill(0)]);
    const lossy = riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02]);
    assert.deepEqual(sniffImage(lossy), { mime: "image/webp", extension: "webp", width: 800, height: 600 });
    const w = 1199, hgt = 799;
    const bits = w | (hgt << 14);
    const lossless = riff("VP8L", [0, 0, 0, 0, 0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255]);
    assert.deepEqual(sniffImage(lossless), { mime: "image/webp", extension: "webp", width: 1200, height: 800 });
    assert.equal(sniffImage(riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0x00, 0x00, 0x00])), null, "bad VP8 start code");
    assert.equal(sniffImage(riff("ABCD", [])), null);
  });

  it("AVIF via the ftyp brand and the ispe box; other ISO-BMFF files are refused", () => {
    const enc = (s: string) => [...new TextEncoder().encode(s)];
    const avif = new Uint8Array([...u32(24), ...enc("ftyp"), ...enc("avif"), 0, 0, 0, 0, ...enc("mif1"), ...enc("miaf"),
      ...new Array(20).fill(0), ...u32(20), ...enc("ispe"), 0, 0, 0, 0, ...u32(1920), ...u32(1080), ...new Array(16).fill(0)]);
    assert.deepEqual(sniffImage(avif), { mime: "image/avif", extension: "avif", width: 1920, height: 1080 });
    const mp4 = new Uint8Array([...u32(20), ...enc("ftyp"), ...enc("isom"), 0, 0, 0, 0, ...enc("mp41"), ...new Array(40).fill(0)]);
    assert.equal(sniffImage(mp4), null, "a video is not an image");
    const noIspe = new Uint8Array([...u32(16), ...enc("ftyp"), ...enc("avif"), 0, 0, 0, 0, ...new Array(40).fill(0)]);
    assert.equal(sniffImage(noIspe), null, "no dimensions → refused");
  });
});

describe("third-party clients: failure paths", () => {
  const event: CapiEvent = { event_name: "Lead", event_time: 1, event_id: "lead-X", action_source: "website", user_data: {} };

  it("Meta CAPI: network errors and timeouts retry; bad Pixel / version never call Meta; token scrubbed", async () => {
    let calls = 0;
    const down = await sendCapiEvent({ token: "TOKEN-123456", pixelId: "123456789", version: "v23.0", testEventCode: null, fetch: async () => { calls++; throw new TypeError("fetch failed"); } }, event);
    assert.deepEqual(down, { ok: false, retry: true, error: "NETWORK" });
    const slow = await sendCapiEvent({ token: "TOKEN-123456", pixelId: "123456789", version: "v23.0", testEventCode: null, fetch: async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); } }, event);
    assert.deepEqual(slow, { ok: false, retry: true, error: "TIMEOUT" });
    const before = calls;
    assert.deepEqual(await sendCapiEvent({ token: "t", pixelId: "abc", version: "v23.0", testEventCode: null, fetch: async () => { calls++; return jsonResponse({}); } }, event),
      { ok: false, retry: false, error: "Invalid Pixel ID" });
    assert.equal(calls, before);
    let url = "";
    await sendCapiEvent({ token: "t", pixelId: "123456789", version: "latest; DROP", testEventCode: null, fetch: async (u) => { url = u; return jsonResponse({ events_received: 1 }); } }, event);
    assert.equal(url, `https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}/123456789/events`, "unknown version → default, nothing injected into the URL");
    const odd = await sendCapiEvent({ token: "t", pixelId: "123456789", version: "v23.0", testEventCode: null, fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }) }, event);
    assert.equal(odd.ok, false);
    assert.equal((odd as { retry: boolean }).retry, true);
    assert.equal(scrub("access_token=EAAB123&x=1 and EAAB123", ["EAAB123"]), "access_token=[redacted]&x=1 and [redacted]");
  });

  it("GA4 Data API: unreadable keys, token refusals, network errors and bad property ids", async () => {
    resetGa4TokenCache();
    assert.equal(parseServiceAccountKey("{}"), null);
    assert.equal(parseServiceAccountKey(JSON.stringify({ client_email: "a@b", private_key: "not a pem" })), null);
    const badPem = { clientEmail: "a@b.iam.gserviceaccount.com", privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" };
    assert.deepEqual(await fetchDashboardNumbers({ key: badPem, propertyId: "123456", startDate: "2027-01-01", endDate: "2027-01-30", nowSec: 1, fetch: async () => jsonResponse({}) }),
      { ok: false, error: "INVALID_SERVICE_ACCOUNT_KEY" });
    assert.deepEqual(await fetchDashboardNumbers({ key: badPem, propertyId: "12; DROP", startDate: "x", endDate: "y", nowSec: 1 }), { ok: false, error: "INVALID_PROPERTY_ID" });

    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const key = { clientEmail: "dash@x.iam.gserviceaccount.com", privateKey: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n` };
    const refused = await fetchDashboardNumbers({ key, propertyId: "123456", startDate: "2027-01-01", endDate: "2027-01-30", nowSec: 1000,
      fetch: async () => jsonResponse({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400) });
    assert.deepEqual(refused, { ok: false, error: "HTTP 400 invalid_grant: Invalid JWT Signature." });
    const offline = await fetchDashboardNumbers({ key, propertyId: "123456", startDate: "2027-01-01", endDate: "2027-01-30", nowSec: 1000,
      fetch: async () => { throw new TypeError("fetch failed"); } });
    assert.deepEqual(offline, { ok: false, error: "NETWORK fetch failed" });
    let n = 0;
    const expired = await fetchDashboardNumbers({ key, propertyId: "123456", startDate: "2027-01-01", endDate: "2027-01-30", nowSec: 1000,
      fetch: async (u) => (u.includes("oauth2") ? jsonResponse({ access_token: "ya29.secret-token", expires_in: 3600 }) : (n++, jsonResponse({ error: { code: 401, message: "Request had invalid authentication credentials ya29.secret-token" } }, 401))) });
    assert.equal(expired.ok, false);
    assert.doesNotMatch((expired as { error: string }).error, /ya29\.secret/, "token scrubbed from the error");
    assert.equal(n, 1);
  });

  it("slip verification provider factory: only a known provider with a key", () => {
    assert.equal(createSlipVerifier({}), null);
    assert.equal(createSlipVerifier({ SLIP_VERIFY_PROVIDER: "easyslip" }), null, "no key → staff verify every slip");
    assert.equal(createSlipVerifier({ SLIP_VERIFY_PROVIDER: "ocr-only", SLIP_VERIFICATION_API_KEY: "k" }), null, "OCR alone is never a verifier");
    assert.ok(createSlipVerifier({ SLIP_VERIFY_PROVIDER: " EasySlip ", SLIP_VERIFICATION_API_KEY: "k" }) instanceof EasySlipVerifier);
  });
});

describe("admin edits that had no test", () => {
  it("amenity update: names, icon, status, sort order — audited; unknown amenity 404", async () => {
    const h = new Harness({ seed: true });
    await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
    const root = await h.login("root@example.test");
    const created = await h.api<{ id: string }>("POST", "/api/admin/amenities", { token: root, body: { code: "hot_tub", icon: "bath", names: { th: "อ่างน้ำร้อน", en: "Hot tub", "zh-CN": "热水浴缸" } } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const upd = await h.api<{ status: string; icon: string | null; names: Record<string, string> }>("PATCH", `/api/admin/amenities/${created.data.id}`, {
      token: root, body: { icon: null, status: "INACTIVE", sortOrder: 5, names: { en: "Outdoor hot tub" } },
    });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const row = h.db.get<{ status: string; icon: string | null; sort_order: number }>("SELECT status, icon, sort_order FROM amenities WHERE id = ?", created.data.id)!;
    assert.deepEqual([row.status, row.icon, row.sort_order], ["INACTIVE", null, 5]);
    assert.equal(h.db.get<{ name: string }>("SELECT name FROM amenity_translations WHERE amenity_id = ? AND language_code = 'en'", created.data.id)!.name, "Outdoor hot tub");
    assert.ok(h.db.all("SELECT 1 FROM audit_logs WHERE record_id = ? AND action LIKE '%AMENITY%'", created.data.id).length >= 2);
    assert.equal((await h.api("PATCH", "/api/admin/amenities/zz-missing", { token: root, body: { sortOrder: 1 } })).status, 404);
  });

  it("removing a unit translation (other than Thai) falls back to Thai publicly; Thai cannot be removed while active", async () => {
    const h = new Harness({ seed: true });
    await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
    const root = await h.login("root@example.test");
    const unit = (lang: string) => h.api<{ name: string }>("GET", `/api/public/accommodations/${h.db.get<{ slug: string }>("SELECT slug FROM accommodation_units WHERE id = 'dev_house_01'")!.slug}?lang=${lang}`);
    const thName = (await unit("th")).data.name;
    const res = await h.api("PUT", "/api/admin/accommodations/dev_house_01/translations", { token: root, body: { translations: { en: null } } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(h.db.get<{ n: number }>("SELECT count(*) AS n FROM accommodation_translations WHERE unit_id = 'dev_house_01' AND language_code = 'en'")!.n, 0);
    assert.equal((await unit("en")).data.name, thName, "English visitors see the Thai text instead of nothing");
    const refused = await h.api("PUT", "/api/admin/accommodations/dev_house_01/translations", { token: root, body: { translations: { th: null } } });
    assert.equal(refused.status, 422);
  });

  it("camping texts per language are saved with the settings (and validated)", async () => {
    const h = new Harness({ seed: true });
    await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
    const root = await h.login("root@example.test");
    const body = {
      isEnabled: true, maxTentsPerNight: 30, pricePerAdultNightSatang: 25_000, childFreeUnderAge: 12, maxGuestsPerTent: null, coverAssetId: null,
      translations: { th: { name: "ลานกางเต็นท์ริมผา", description: "วิวพระอาทิตย์ขึ้น" }, en: { name: "Cliffside camping" } },
    };
    const ok = await h.api("PUT", "/api/admin/camping", { token: root, body });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const pub = (await h.api<{ camping: { name: string } }>("GET", "/api/public/accommodations?lang=en")).data;
    assert.equal(pub.camping.name, "Cliffside camping");
    const bad = await h.api("PUT", "/api/admin/camping", { token: root, body: { ...body, translations: { en: { name: "" } } } });
    assert.equal(bad.status, 422);
  });
});

describe("deploy order: the site keeps working while new migrations are not applied yet", () => {
  const files = migrationFiles();
  // From the Phase 9 schema on (0010) every later migration may lag behind a deploy.
  for (let upTo = files.findIndex((f) => f.startsWith("0010")); upTo < files.length; upTo++) {
    const applied = files.slice(0, upTo + 1);
    it(`with migrations up to ${applied.at(-1)}`, async () => {
      const db = new SqliteD1();
      for (const f of applied) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      const app = createApp({ requestId: () => "req" });
      const env = makeEnv(db, { ASSETS: { fetch: async () => new Response("<!doctype html><html><head><title></title></head><body><div id=root></div></body></html>", { headers: { "Content-Type": "text/html" } }) } });
      const get = (path: string) => app.fetch(new Request(`https://phasakura.test${path}`), env);
      for (const path of ["/api/health", "/api/public/site?lang=th", "/th/", "/en/gallery", "/robots.txt"]) {
        const res = await get(path);
        assert.ok(res.status < 500, `${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
      const site = await (await get("/api/public/site?lang=th")).json() as { data: { consent?: { enabled: boolean }; tracking?: unknown } };
      if (site.data.consent) assert.equal(site.data.consent.enabled, false, "no trackers → no banner");
      // The cron must not fail either (it runs every minute).
      await app.scheduled(env, Date.parse("2027-01-10T03:00:00Z"));
    });
  }
});
