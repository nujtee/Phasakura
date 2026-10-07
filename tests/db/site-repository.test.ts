import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiSuccess, PublicSiteDto } from "../../src/shared/api-types.ts";
import { createApp } from "../../src/worker/index.ts";
import { D1SiteSettingsRepository } from "../../src/worker/repositories/site-settings.repository.ts";
import { makeEnv } from "../helpers/fake-env.ts";
import { SqliteD1 } from "../helpers/sqlite-d1.ts";

const app = createApp({ requestId: () => "req" });

async function site(db: SqliteD1, lang = "th"): Promise<PublicSiteDto> {
  const res = await app.fetch(new Request(`https://x.test/api/public/site?lang=${lang}`), makeEnv(db));
  assert.equal(res.status, 200);
  return ((await res.json()) as ApiSuccess<PublicSiteDto>).data;
}

function addAsset(db: SqliteD1, id: string, bucket: "PUBLIC" | "PRIVATE", key: string, purpose: string) {
  db.run(
    `INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, width, height, sha256)
     VALUES (?, ?, ?, ?, 'image/webp', 100, 240, 80, ?)`,
    id, bucket, key, purpose, id.padEnd(64, "0").slice(0, 64),
  );
}

describe("site settings repository against real D1 schema", () => {
  it("returns null against an empty database (real 'no such table' error)", async () => {
    const empty = new SqliteD1();
    assert.equal(await new D1SiteSettingsRepository(empty).findPublicSettings(), null);
  });

  it("returns configured=false after migrations but before any settings are saved", async () => {
    const data = await site(SqliteD1.migrated());
    assert.equal(data.configured, false);
    assert.equal(data.siteName, null);
  });

  it("serves seeded site name and tagline in every language", async () => {
    const db = SqliteD1.migrated({ seed: true });
    assert.equal((await site(db, "th")).siteName, "Phasakura (ข้อมูลตัวอย่าง)");
    assert.equal((await site(db, "en")).siteName, "Phasakura (sample data)");
    assert.equal((await site(db, "zh-cn")).siteName, "Phasakura（示例数据）");
    assert.equal((await site(db, "en")).logo.main, null, "no logo uploaded yet");
  });

  it("exposes logos uploaded to the PUBLIC bucket with dimensions", async () => {
    const db = SqliteD1.migrated({ seed: true });
    addAsset(db, "logo1", "PUBLIC", "branding/logo-main.webp", "LOGO");
    addAsset(db, "logo2", "PUBLIC", "branding/logo-mobile.webp", "LOGO");
    db.run("UPDATE branding_settings SET logo_main_asset_id = 'logo1', logo_mobile_asset_id = 'logo2' WHERE id = 1");
    const data = await site(db);
    assert.deepEqual(data.logo.main, { url: "/media/branding/logo-main.webp", alt: data.siteName, width: 240, height: 80 });
    assert.equal(data.logo.mobile?.url, "/media/branding/logo-mobile.webp");
  });

  it("never exposes a deleted asset as the logo", async () => {
    const db = SqliteD1.migrated({ seed: true });
    addAsset(db, "logo1", "PUBLIC", "branding/logo-main.webp", "LOGO");
    db.run("UPDATE branding_settings SET logo_main_asset_id = 'logo1' WHERE id = 1");
    db.run("UPDATE media_assets SET status = 'DELETED', deleted_at = 'x' WHERE id = 'logo1'");
    assert.equal((await site(db)).logo.main, null);
  });

  it("never exposes a PRIVATE (slip) asset even if referenced as a logo", async () => {
    const db = SqliteD1.migrated({ seed: true });
    addAsset(db, "slip1", "PRIVATE", "slips/2027/01/slip.webp", "PAYMENT_SLIP");
    db.run("UPDATE branding_settings SET logo_main_asset_id = 'slip1' WHERE id = 1");
    assert.equal((await site(db)).logo.main, null);
  });

  it("health check reports the database as reachable", async () => {
    const res = await app.fetch(new Request("https://x.test/api/health"), makeEnv(SqliteD1.migrated()));
    assert.equal(res.status, 200);
  });
});
