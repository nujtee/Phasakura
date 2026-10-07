import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PublicAccommodationsDto } from "../../src/shared/accommodation-types.ts";
import type { PublicSiteDto } from "../../src/shared/api-types.ts";
import type { FoodCatalogueDto, FoodMenuDto } from "../../src/shared/booking-types.ts";
import type { CmsRecord } from "../../src/shared/cms-schema.ts";
import type { PublicGalleryDto } from "../../src/shared/content-types.ts";
import type { CustomFontDto, PublicFontFaceDto } from "../../src/shared/media-types.ts";
import type { ThemeAdminDto } from "../../src/shared/settings-types.ts";
import { customFontToken, FONT_STACKS, PRESET_TOKENS, validateThemeTokens } from "../../src/shared/theme.ts";
import { sniffFont } from "../../src/worker/media/image-sniff.ts";
import { ImageResolver } from "../../src/worker/media/image-resolver.ts";
import { Harness } from "../helpers/harness.ts";
import { fontBytes, jpegBytes, pngBytes, svgBytes, webpBytes } from "../helpers/images.ts";

type Uploaded = { id: string; url: string; width: number; height: number; variants: { url: string; width: number; height: number; mimeType: string }[] };
type File3 = { bytes: Uint8Array; name: string; type: string };

let h: Harness;
let root: string;
let viewer: string;

beforeEach(async () => {
  h = new Harness({ seed: true });
  await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
  await h.user({ id: "viewer", roles: ["VIEWER"] });
  root = await h.login("root@example.test");
  viewer = await h.login("viewer@example.test");
});

const png = (w: number, hgt: number, name = "o.png"): File3 => ({ bytes: pngBytes(w, hgt), name, type: "image/png" });
const webp = (w: number, hgt: number, name = "v.webp"): File3 => ({ bytes: webpBytes(w, hgt), name, type: "image/webp" });

/** Original + renditions in one multipart request, as the admin's browser sends them. */
function uploadWithVariants(token: string, purpose: string, original: File3, variants: File3[]) {
  return h.multipart<Uploaded>(token, "/api/admin/media", [["file", original], ["purpose", purpose], ...variants.map((v) => ["variant", v] as [string, File3])]);
}

const keyOf = (url: string) => url.slice("/media/".length);
const cms = <T = CmsRecord>(method: string, path: string, body?: unknown) => h.api<T>(method, `/api/admin/cms/${path}`, { token: root, body });

describe("responsive renditions (Phase 12: compression + responsive images)", () => {
  it("stores the original and its smaller renditions under server keys, linked to the original", async () => {
    const res = await uploadWithVariants(root, "GALLERY", png(2400, 1600), [webp(480, 320), webp(960, 640), webp(1600, 1067)]);
    assert.equal(res.status, 201, JSON.stringify(res.error));
    const key = keyOf(res.data.url);
    assert.match(key, /^gallery\/2027\/01\/[0-9a-f-]{36}\.png$/);
    const stem = key.replace(/\.png$/, "");
    assert.deepEqual(res.data.variants.map((v) => [keyOf(v.url), v.width, v.mimeType]), [
      [`${stem}-w480.webp`, 480, "image/webp"],
      [`${stem}-w960.webp`, 960, "image/webp"],
      [`${stem}-w1600.webp`, 1600, "image/webp"],
    ]);
    for (const v of res.data.variants) assert.ok(await h.bucket.get(keyOf(v.url)), "rendition object stored");
    const rows = h.db.all<{ parent_asset_id: string | null; purpose: string }>(
      "SELECT parent_asset_id, purpose FROM media_assets WHERE object_key LIKE ? ORDER BY width", `${stem}%`);
    assert.deepEqual(rows.map((r) => r.parent_asset_id), [res.data.id, res.data.id, res.data.id, null]);
    assert.ok(rows.every((r) => r.purpose === "GALLERY"));
    const audit = h.db.get<{ new_value: string }>("SELECT new_value FROM audit_logs WHERE action = 'UPLOAD' AND record_id = ?", res.data.id)!;
    assert.deepEqual(JSON.parse(audit.new_value).variants, [480, 960, 1600]);
  });

  it("rejects renditions that are not the same picture, repeated widths, too many, unsafe files — storing nothing", async () => {
    const before = h.bucket.objects.size;
    const cases: [File3[], string][] = [
      [[webp(2600, 1733)], "NOT_A_RENDITION"], // wider than the original
      [[webp(480, 480)], "NOT_A_RENDITION"], // different aspect ratio
      [[webp(2400, 1600)], "NOT_A_RENDITION"], // not smaller
      [[webp(480, 320), webp(480, 320, "b.webp")], "DUPLICATE_WIDTH"],
      [[webp(200, 133), webp(300, 200), webp(400, 267), webp(500, 333), webp(600, 400), webp(700, 467)], "TOO_MANY"],
      [[{ bytes: svgBytes, name: "x.webp", type: "image/webp" }], "UNSUPPORTED_IMAGE"],
    ];
    for (const [variants, code] of cases) {
      const res = await uploadWithVariants(root, "GALLERY", png(2400, 1600), variants);
      assert.equal(res.status, 422, code);
      assert.equal(res.error?.details?.variant, code);
    }
    // Logos, favicons, QR codes and social cards are used as uploaded: no renditions.
    const logo = await uploadWithVariants(root, "LOGO", png(800, 400), [webp(400, 200)]);
    assert.equal(logo.error?.details?.variant, "NOT_ALLOWED");
    const json = await h.multipart(root, "/api/admin/media", [["file", png(800, 600)], ["purpose", "GALLERY"], ["variant", "text"]]);
    assert.equal(json.error?.details?.variant, "EXPECTED_FILE");
    assert.equal(h.bucket.objects.size, before, "nothing stored for rejected uploads");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM media_assets")!.n, 0);
  });

  it("the database refuses renditions of another purpose, of a rendition, or of a deleted original", async () => {
    const a = (await uploadWithVariants(root, "GALLERY", png(1600, 900), [webp(480, 270)])).data;
    const variantId = h.db.get<{ id: string }>("SELECT id FROM media_assets WHERE parent_asset_id = ?", a.id)!.id;
    const insert = (id: string, parent: string, purpose = "GALLERY", bucket = "PUBLIC") => () => h.db.run(
      `INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256, parent_asset_id)
       VALUES (?, ?, ?, ?, 'image/webp', 10, ?, ?)`, id, bucket, `gallery/${id}.webp`, purpose, "b".repeat(64), parent);
    assert.throws(insert("v1", a.id, "HOME_SLIDE"), /MEDIA_VARIANT_INVALID/);
    assert.throws(insert("v2", variantId), /MEDIA_VARIANT_INVALID/);
    assert.throws(insert("v3", a.id, "GALLERY", "PRIVATE"), /MEDIA_VARIANT_INVALID/);
    h.db.run("UPDATE media_assets SET status = 'DELETED' WHERE id = ?", a.id);
    assert.throws(insert("v4", a.id), /MEDIA_VARIANT_INVALID/);
  });

  it("content and settings point at originals only, never at a rendition", async () => {
    const g = (await uploadWithVariants(root, "GALLERY", png(1600, 900), [webp(480, 270)])).data;
    const variantId = h.db.get<{ id: string }>("SELECT id FROM media_assets WHERE parent_asset_id = ?", g.id)!.id;
    const viaCms = await cms("POST", "galleryImage", { mediaAssetId: variantId, categoryId: "dev_gallery_nature" });
    assert.equal(viaCms.error?.details?.mediaAssetId, "MEDIA_NOT_FOUND");
    const acc = (await uploadWithVariants(root, "ACCOMMODATION", png(2000, 1500), [webp(480, 360)])).data;
    const accVariant = h.db.get<{ id: string }>("SELECT id FROM media_assets WHERE parent_asset_id = ?", acc.id)!.id;
    const attach = await h.api("POST", "/api/admin/accommodations/dev_house_01/images", { token: root, body: { mediaAssetId: accVariant } });
    assert.equal(attach.error?.details?.mediaAssetId, "INVALID_IMAGE");
  });

  it("builds srcset from the renditions, widest last, including the original", async () => {
    const g = (await uploadWithVariants(root, "GALLERY", png(2400, 1600), [webp(960, 640), webp(480, 320)])).data;
    const resolver = new ImageResolver(h.db, undefined);
    const map = await resolver.renditions([g.id, "missing"]);
    const srcset = resolver.srcset(map.get(g.id) ?? [], { key: keyOf(g.url), width: 2400 });
    assert.equal(srcset, `${g.variants[1]!.url} 480w, ${g.variants[0]!.url} 960w, ${g.url} 2400w`);
    assert.equal(resolver.srcset([], { key: keyOf(g.url), width: 2400 }), null, "no renditions: plain src only");
    assert.deepEqual(map.get("missing") ?? [], []);
  });

  it("deleting an accommodation photo removes its renditions from R2 too", async () => {
    const a = (await uploadWithVariants(root, "ACCOMMODATION", png(2000, 1500), [webp(480, 360), webp(960, 720)])).data;
    const add = await h.api<{ images: { id: string; mediaAssetId: string }[] }>("POST", "/api/admin/accommodations/dev_house_01/images", { token: root, body: { mediaAssetId: a.id } });
    assert.equal(add.status, 201, JSON.stringify(add.error));
    const pub = (await h.api<PublicAccommodationsDto>("GET", "/api/public/accommodations?lang=en")).data;
    const house = pub.houses.find((u) => u.id === "dev_house_01")!;
    const img = house.images.find((i) => i.url === a.url)!;
    assert.match(img.srcset ?? "", /-w480\.webp 480w, .*-w960\.webp 960w, .*\.png 2000w$/);
    assert.equal(house.cover?.url, a.url, "first photo became the cover");
    assert.ok(house.cover?.srcset, "cover has srcset too");

    const imageId = add.data.images.find((i) => i.mediaAssetId === a.id)!.id;
    const del = await h.api("DELETE", `/api/admin/accommodations/dev_house_01/images/${imageId}`, { token: root });
    assert.equal(del.status, 200, JSON.stringify(del.error));
    for (const url of [a.url, ...a.variants.map((v) => v.url)]) assert.equal(await h.bucket.get(keyOf(url)), null, `${url} deleted`);
    const statuses = h.db.all<{ status: string }>("SELECT status FROM media_assets WHERE id = ? OR parent_asset_id = ?", a.id, a.id);
    assert.ok(statuses.length === 3 && statuses.every((s) => s.status === "DELETED"));
  });
});

describe("public media access control (Phase 12)", () => {
  it("an unpublished gallery photo (and its renditions) is private: staff preview only, never cached", async () => {
    const g = (await uploadWithVariants(root, "GALLERY", png(1600, 900), [webp(480, 270)])).data;
    const urls = [g.url, g.variants[0]!.url];
    for (const u of urls) assert.equal((await h.get(u)).status, 404, `anonymous: ${u}`);
    const staff = await h.get(g.url, { Cookie: `__Host-sid=${viewer}` });
    assert.equal(staff.status, 200, "signed-in staff can preview drafts");
    assert.equal(staff.headers.get("Cache-Control"), "private, no-store");
    assert.equal((await h.get(g.url, { Cookie: "__Host-sid=forged" })).status, 404, "an invalid session is anonymous");

    const created = await cms("POST", "galleryImage", { mediaAssetId: g.id, categoryId: "dev_gallery_nature", translations: { th: { altText: "ทุ่งหญ้า" } } });
    assert.equal(created.status, 201, JSON.stringify(created.error));
    for (const u of urls) assert.equal((await h.get(u)).status, 404, "draft record: still private");
    await cms("POST", `galleryImage/${created.data.id}/publish`);
    for (const u of urls) {
      const res = await h.get(u);
      assert.equal(res.status, 200, `published: ${u}`);
      assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
      assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    }
    const gallery = (await h.api<PublicGalleryDto>("GET", "/api/public/gallery?lang=th")).data;
    assert.equal(gallery.images[0]?.image.alt, "ทุ่งหญ้า");
    assert.equal(gallery.images[0]?.image.srcset, `${g.variants[0]!.url} 480w, ${g.url} 1600w`);

    await cms("POST", `galleryImage/${created.data.id}/unpublish`);
    assert.equal((await h.get(g.url)).status, 404, "unpublished again");
    await cms("POST", `galleryImage/${created.data.id}/publish`);
    h.db.run("UPDATE gallery_categories SET status = 'DRAFT' WHERE id = 'dev_gallery_nature'");
    assert.equal((await h.get(g.url)).status, 404, "category hidden → its photos too");
  });

  it("a house photo is public only while the house is ACTIVE; logos are always public", async () => {
    const a = (await uploadWithVariants(root, "ACCOMMODATION", png(2000, 1500), [])).data;
    assert.equal((await h.get(a.url)).status, 404, "uploaded but not attached");
    await h.api("POST", "/api/admin/accommodations/dev_house_01/images", { token: root, body: { mediaAssetId: a.id } });
    assert.equal((await h.get(a.url)).status, 200);
    h.db.run("UPDATE accommodation_units SET status = 'INACTIVE' WHERE id = 'dev_house_01'");
    assert.equal((await h.get(a.url)).status, 404, "inactive house");
    const logo = (await h.upload<Uploaded>(root, png(600, 200), "LOGO")).data;
    assert.equal((await h.get(logo.url)).status, 200);
  });

  it("a slide is served only while published and inside its schedule", async () => {
    const s = (await uploadWithVariants(root, "HOME_SLIDE", png(2400, 1200), [webp(640, 320)])).data;
    const slide = await cms("POST", "homeSlide", { desktopAssetId: s.id, startAt: "2027-02-01T00:00:00.000Z" });
    assert.equal(slide.status, 201, JSON.stringify(slide.error));
    await cms("POST", `homeSlide/${slide.data.id}/publish`);
    assert.equal((await h.get(s.variants[0]!.url)).status, 404, "scheduled for later");
    h.now = new Date("2027-02-02T00:00:00.000Z");
    assert.equal((await h.get(s.variants[0]!.url)).status, 200, "inside the window");
  });
});

describe("food images (Phase 12)", () => {
  it("a dish photo shows in the public menu and the booking catalogue with srcset; hidden with the dish", async () => {
    const f = (await uploadWithVariants(root, "FOOD", png(1600, 1200), [webp(400, 300), webp(800, 600)])).data;
    assert.equal((await h.get(f.url)).status, 404);
    await h.api("PUT", `/api/admin/media/${f.id}/texts`, { token: root, body: { texts: { en: { altText: "Grilled fish" }, th: { altText: "ปลาย่าง" } } } });
    const set = await cms("PATCH", "foodOption/dev_food_dinner_a", { imageAssetId: f.id });
    assert.equal(set.status, 200, JSON.stringify(set.error));
    const wrong = await cms("PATCH", "foodOption/dev_food_dinner_a", { imageAssetId: (await h.upload<Uploaded>(root, png(800, 600), "GALLERY")).data.id });
    assert.equal(wrong.error?.details?.imageAssetId, "WRONG_MEDIA_PURPOSE");

    const menu = await h.api<FoodMenuDto>("GET", "/api/public/food-menu?lang=en");
    assert.equal(menu.status, 200);
    assert.match(menu.headers.get("Cache-Control") ?? "", /public/);
    const dinner = menu.data.categories.find((c) => c.code === "DINNER")!;
    const dish = dinner.options.find((o) => o.id === "dev_food_dinner_a")!;
    assert.equal(dish.name, "Dinner A");
    assert.deepEqual({ ...dish.image, srcset: undefined }, { url: f.url, srcset: undefined, alt: "Grilled fish", width: 1600, height: 1200 });
    assert.equal(dish.image?.srcset, `${f.variants[0]!.url} 400w, ${f.variants[1]!.url} 800w, ${f.url} 1600w`);
    assert.equal(menu.data.categories.find((c) => c.code === "BBQ")?.options[0]?.image, null);
    assert.ok(!menu.data.categories.some((c) => c.options.length === 0), "empty categories are left out");

    const cat = await h.api<FoodCatalogueDto>("GET", "/api/public/food-options?checkIn=2027-01-20&checkOut=2027-01-22&lang=th");
    const opt = cat.data.categories.flatMap((c) => c.options).find((o) => o.id === "dev_food_dinner_a")!;
    assert.equal(opt.image?.alt, "ปลาย่าง");
    assert.equal((await h.get(f.url)).status, 200, "active dish: public");

    h.db.run("UPDATE food_options SET status = 'INACTIVE' WHERE id = 'dev_food_dinner_a'");
    assert.equal((await h.get(f.url)).status, 404, "inactive dish: private again");
    const after = (await h.api<FoodMenuDto>("GET", "/api/public/food-menu?lang=en")).data;
    assert.ok(!after.categories.flatMap((c) => c.options).some((o) => o.id === "dev_food_dinner_a"));
  });
});

describe("uploaded fonts (Phase 12)", () => {
  const upload = (token: string, fields: Record<string, string>, file: File3 = { bytes: fontBytes("woff2"), name: "brand.woff2", type: "font/woff2" }) =>
    h.multipart<CustomFontDto>(token, "/api/admin/fonts", [["file", file], ...Object.entries(fields)]);

  it("sniffs WOFF2 / WOFF from the bytes, not the name", () => {
    assert.deepEqual(sniffFont(fontBytes("woff2")), { mime: "font/woff2", format: "woff2" });
    assert.deepEqual(sniffFont(fontBytes("woff")), { mime: "font/woff", format: "woff" });
    const truncated = fontBytes("woff2", 256).slice(0, 200);
    assert.equal(sniffFont(truncated), null, "header length must match the file");
    const badFlavor = fontBytes("woff2");
    badFlavor.set([9, 9, 9, 9], 4);
    assert.equal(sniffFont(badFlavor), null);
    assert.equal(sniffFont(pngBytes()), null);
    assert.equal(sniffFont(new Uint8Array(10)), null);
  });

  it("uploads a face, validates fields, refuses fakes and duplicates; needs settings.theme", async () => {
    const ok = await upload(root, { family: "Brand Sans", weight: "700", style: "normal", fallback: "ROUNDED" });
    assert.equal(ok.status, 201, JSON.stringify(ok.error));
    assert.equal(ok.data.token, `"Brand Sans", ${FONT_STACKS.ROUNDED}`);
    assert.equal(ok.data.format, "woff2");
    assert.match(ok.data.url, /^\/media\/fonts\/2027\/01\/[0-9a-f-]{36}\.woff2$/);
    const served = await h.get(ok.data.url);
    assert.equal(served.status, 200, "fonts are public files");
    assert.equal(served.headers.get("Content-Type"), "font/woff2");

    assert.equal((await upload(root, { family: "Brand Sans", weight: "700", style: "normal", fallback: "SANS" })).error?.code, "FONT_FACE_EXISTS");
    assert.equal((await upload(root, { family: "Brand Sans", weight: "400", style: "italic", fallback: "SANS" })).status, 201, "another face of the family");
    const fake = await upload(root, { family: "Evil", weight: "400", style: "normal", fallback: "SANS" }, { bytes: pngBytes(), name: "x.woff2", type: "font/woff2" });
    assert.equal(fake.error?.details?.file, "UNSUPPORTED_FONT");
    const big = await upload(root, { family: "Big", weight: "400", style: "normal", fallback: "SANS" }, { bytes: fontBytes("woff2", 2 * 1024 * 1024 + 8), name: "b.woff2", type: "font/woff2" });
    assert.equal(big.status, 413);
    for (const [fields, field, code] of [
      [{ family: 'x"; } body { color: red', weight: "400", style: "normal", fallback: "SANS" }, "family", "INVALID_FORMAT"],
      [{ family: "", weight: "400", style: "normal", fallback: "SANS" }, "family", "REQUIRED"],
      [{ family: "Ok", weight: "450", style: "normal", fallback: "SANS" }, "weight", "INVALID_VALUE"],
      [{ family: "Ok", weight: "400", style: "oblique", fallback: "SANS" }, "style", "INVALID_VALUE"],
      [{ family: "Ok", weight: "400", style: "normal", fallback: "COMIC" }, "fallback", "INVALID_VALUE"],
      [{ family: "Ok", weight: "400", style: "normal", fallback: "SANS", extra: "1" }, "extra", "UNKNOWN_FIELD"],
    ] as const) {
      const res = await upload(root, fields as Record<string, string>);
      assert.equal(res.error?.details?.[field], code, `${field} → ${code}`);
    }
    assert.equal((await upload(viewer, { family: "V", weight: "400", style: "normal", fallback: "SANS" })).status, 403);
    assert.equal((await h.api("GET", "/api/admin/fonts", { token: viewer })).status, 403);
    const list = await h.api<CustomFontDto[]>("GET", "/api/admin/fonts", { token: root });
    assert.deepEqual(list.data.map((f) => `${f.family} ${f.weight} ${f.style}`), ["Brand Sans 400 italic", "Brand Sans 700 normal"]);
    assert.equal(h.events("UPLOAD_REJECTED").length >= 1, true, "fake font logged");
  });

  it("theme tokens accept uploaded families only; the public site ships only the faces the theme uses", async () => {
    const brand = (await upload(root, { family: "Brand Serif", weight: "400", style: "normal", fallback: "SERIF" })).data;
    await upload(root, { family: "Unused Face", weight: "400", style: "normal", fallback: "SANS" });
    const unknown = await h.api("PUT", "/api/admin/theme/draft", {
      token: root, body: { preset: "CUSTOM", tokens: { ...PRESET_TOKENS.DEFAULT, "--font-heading": customFontToken("Not Uploaded", "SANS") } },
    });
    assert.equal(unknown.error?.details?.["tokens.--font-heading"], "INVALID_FONT");
    const injection = await h.api("PUT", "/api/admin/theme/draft", {
      token: root, body: { preset: "CUSTOM", tokens: { ...PRESET_TOKENS.DEFAULT, "--font-heading": '"Brand Serif"; color: red' } },
    });
    assert.equal(injection.error?.details?.["tokens.--font-heading"], "INVALID_FONT");

    const draft = await h.api<ThemeAdminDto>("PUT", "/api/admin/theme/draft", {
      token: root, body: { preset: "CUSTOM", tokens: { ...PRESET_TOKENS.DEFAULT, "--font-heading": brand.token } },
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.error));
    const preview = await h.api<{ fonts: PublicFontFaceDto[] }>("GET", "/api/admin/theme/preview", { token: root });
    assert.deepEqual(preview.data.fonts.map((f) => f.family), ["Brand Serif"], "draft preview loads its faces");
    assert.deepEqual((await h.api<PublicSiteDto>("GET", "/api/public/site?lang=th")).data.fonts, [], "nothing until published");

    await h.api("POST", "/api/admin/theme/publish", { token: root });
    const site = (await h.api<PublicSiteDto>("GET", "/api/public/site?lang=th")).data;
    assert.equal(site.theme?.["--font-heading"], brand.token);
    assert.deepEqual(site.fonts, [{ family: "Brand Serif", url: brand.url, weight: 400, style: "normal", format: "woff2" }]);
    assert.deepEqual(validateThemeTokens(site.theme, "any"), {});
  });

  it("a font the theme uses cannot be deleted; once unused, deleting removes the file", async () => {
    const brand = (await upload(root, { family: "Brand Serif", weight: "400", style: "normal", fallback: "SERIF" })).data;
    await h.api("PUT", "/api/admin/theme/draft", { token: root, body: { preset: "CUSTOM", tokens: { ...PRESET_TOKENS.DEFAULT, "--font-body": brand.token } } });
    const blocked = await h.api("DELETE", `/api/admin/fonts/${brand.id}`, { token: root });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.error?.code, "FONT_IN_USE");
    await h.api("POST", "/api/admin/theme/publish", { token: root });
    assert.equal((await h.api("DELETE", `/api/admin/fonts/${brand.id}`, { token: root })).error?.code, "FONT_IN_USE", "published theme uses it");

    await h.api("PUT", "/api/admin/theme/draft", { token: root, body: { preset: "DEFAULT", tokens: PRESET_TOKENS.DEFAULT } });
    await h.api("POST", "/api/admin/theme/publish", { token: root });
    const del = await h.api("DELETE", `/api/admin/fonts/${brand.id}`, { token: root });
    assert.equal(del.status, 200, JSON.stringify(del.error));
    assert.equal(await h.bucket.get(keyOf(brand.url)), null);
    assert.equal((await h.get(brand.url)).status, 404);
    assert.equal((await h.api("DELETE", `/api/admin/fonts/${brand.id}`, { token: root })).status, 404);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('UPLOAD_FONT', 'DELETE_FONT')")!.n, 2);
  });

  it("the database keeps font rows and font files consistent", () => {
    const sha = "a".repeat(64);
    h.db.run(`INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256) VALUES ('img', 'PUBLIC', 'g/x.png', 'GALLERY', 'image/png', 1, ?)`, sha);
    assert.throws(() => h.db.run(
      "INSERT INTO custom_fonts (id, family, weight, style, fallback, media_asset_id, created_at, created_by) VALUES ('f', 'X', 400, 'normal', 'SANS', 'img', '2027-01-10T00:00:00.000Z', 'root')"), /FONT_ASSET_INVALID/);
    h.db.run(`INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256) VALUES ('fnt', 'PUBLIC', 'fonts/x.woff2', 'FONT', 'font/woff2', 1, ?)`, sha);
    assert.throws(() => h.db.run(
      "INSERT INTO custom_fonts (id, family, weight, style, fallback, media_asset_id, created_at, created_by) VALUES ('f', 'Bad\"Name', 400, 'normal', 'SANS', 'fnt', '2027-01-10T00:00:00.000Z', 'root')"), /constraint/i);
    assert.throws(() => h.db.run(
      "INSERT INTO custom_fonts (id, family, weight, style, fallback, media_asset_id, created_at, created_by) VALUES ('f', 'Good', 450, 'normal', 'SANS', 'fnt', '2027-01-10T00:00:00.000Z', 'root')"), /constraint/i);
    h.db.run("INSERT INTO custom_fonts (id, family, weight, style, fallback, media_asset_id, created_at, created_by) VALUES ('f', 'Good', 400, 'normal', 'SANS', 'fnt', '2027-01-10T00:00:00.000Z', 'root')");
    assert.throws(() => h.db.run(
      `INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256) VALUES ('fnt2', 'PUBLIC', 'fonts/y.png', 'FONT', 'image/png', 1, ?)`, sha), /MEDIA_TYPE_PURPOSE/);
  });
});

describe("jpeg originals keep their own type", () => {
  it("serves a JPEG original with WebP renditions", async () => {
    const res = await uploadWithVariants(root, "HISTORY", { bytes: jpegBytes(2000, 1000), name: "x.jpg", type: "image/jpeg" }, [webp(480, 240)]);
    assert.equal(res.status, 201, JSON.stringify(res.error));
    assert.match(res.data.url, /\.jpg$/);
    assert.match(res.data.variants[0]!.url, /-w480\.webp$/);
  });
});
