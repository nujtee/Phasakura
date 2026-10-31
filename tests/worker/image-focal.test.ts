import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminUnitDto, PublicUnitDto } from "../../src/shared/accommodation-types.ts";
import type { CmsRecord } from "../../src/shared/cms-schema.ts";
import type { PublicHomeDto } from "../../src/shared/content-types.ts";
import { CENTER, findFocalPoint, isFocalPoint, objectPosition } from "../../src/shared/focal-point.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

// Focal point of an image (migration 0046): found by the admin's browser on upload, movable by staff,
// drawn by the public pages as object-position so a cropped photo keeps what matters.

/** RGBA picture: grey with flat sky on top, and a skin-coloured "face" square at (cx, cy) percent. */
function picture(w: number, h: number, face: { cx: number; cy: number; size: number } | null): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const sky = y < h * 0.3;
      px[i] = sky ? 190 : 120; px[i + 1] = sky ? 205 : 120; px[i + 2] = sky ? 225 : 120; px[i + 3] = 255;
      if (face) {
        const fx = (face.cx / 100) * w;
        const fy = (face.cy / 100) * h;
        if (Math.abs(x - fx) <= face.size / 2 && Math.abs(y - fy) <= face.size / 2) {
          // skin tone with a little texture
          const n = (x * 7 + y * 13) % 9;
          px[i] = 224 - n; px[i + 1] = 172 - n; px[i + 2] = 140 - n;
        }
      }
    }
  }
  return px;
}

describe("focal point detection", () => {
  it("finds a face low in a portrait photo and on the side of a landscape photo; plain pictures stay centred", () => {
    const portrait = findFocalPoint(picture(75, 100, { cx: 45, cy: 72, size: 14 }), 75, 100);
    assert.ok(Math.abs(portrait.y - 72) <= 6, `y ${portrait.y}`);
    assert.ok(Math.abs(portrait.x - 45) <= 8, `x ${portrait.x}`);

    const landscape = findFocalPoint(picture(100, 60, { cx: 82, cy: 50, size: 12 }), 100, 60);
    assert.ok(Math.abs(landscape.x - 82) <= 6, `x ${landscape.x}`);

    assert.deepEqual(findFocalPoint(new Uint8ClampedArray(100 * 60 * 4).fill(128), 100, 60), CENTER, "nothing stands out");
    assert.deepEqual(findFocalPoint(new Uint8ClampedArray(4), 1, 1), CENTER, "too small");
  });

  it("validates and formats points", () => {
    assert.equal(isFocalPoint({ x: 0, y: 100 }), true);
    for (const bad of [{ x: -1, y: 5 }, { x: 5, y: 101 }, { x: 1.5, y: 5 }, { x: "5", y: 5 }, null, [1, 2]]) assert.equal(isFocalPoint(bad), false, JSON.stringify(bad));
    assert.equal(objectPosition({ x: 30, y: 70 }), "30% 70%");
    assert.equal(objectPosition(null), undefined);
  });
});

async function editor(h: Harness, perms: string[]) {
  const id = `focal_${perms.join("_").replace(/\W/g, "")}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

const slideImage = (h: Harness, token: string, extra: Record<string, string> = {}, purpose = "HOME_SLIDE") =>
  h.upload<{ id: string; url: string; focal: { x: number; y: number } | null }>(token, { bytes: pngBytes(1200, 1600), name: "kids.png", type: "image/png" }, purpose, extra);

describe("focal point on upload, in admin and on the public pages", () => {
  it("is stored with the upload, shown in the slide editor, moved by staff (audited) and sent to the home page", async () => {
    const h = new Harness({ seed: true });
    const token = await editor(h, ["content.view", "content.home", "content.publish"]);
    const up = await slideImage(h, token, { focalX: "40", focalY: "72" });
    assert.equal(up.status, 201, JSON.stringify(up.error));
    assert.deepEqual(up.data.focal, { x: 40, y: 72 });
    assert.deepEqual({ ...h.db.get<{ focal_x: number; focal_y: number }>("SELECT focal_x, focal_y FROM media_assets WHERE id = ?", up.data.id) }, { focal_x: 40, focal_y: 72 });

    // Bad values are refused (and nothing half-valid is stored).
    for (const extra of [{ focalX: "101", focalY: "5" }, { focalX: "5" }, { focalX: "a", focalY: "5" }, { focalX: "-1", focalY: "5" }]) {
      const bad = await slideImage(h, token, extra as Record<string, string>);
      assert.equal(bad.status, 422, JSON.stringify(extra));
      assert.equal(bad.error?.details?.focal, "INVALID_VALUE");
    }

    const slide = await h.api<CmsRecord>("POST", "/api/admin/cms/homeSlide", { token, body: { desktopAssetId: up.data.id, translations: { th: { title: "เด็ก ๆ" } } } });
    assert.equal(slide.status, 201, JSON.stringify(slide.body));
    assert.deepEqual(slide.data.focals, { desktopAssetId: { x: 40, y: 72 }, mobileAssetId: null });
    await h.api("POST", `/api/admin/cms/homeSlide/${slide.data.id}/publish`, { token });
    let home = (await h.api<PublicHomeDto>("GET", "/api/public/home?lang=th")).data;
    assert.deepEqual(home.slides[0]!.desktop.focal, { x: 40, y: 72 });

    // Staff click another spot; then back to the centre.
    const moved = await h.api<{ focal: unknown }>("PUT", `/api/admin/media/${up.data.id}/focal`, { token, body: { focal: { x: 55, y: 66 } } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    home = (await h.api<PublicHomeDto>("GET", "/api/public/home?lang=th")).data;
    assert.deepEqual(home.slides[0]!.desktop.focal, { x: 55, y: 66 });
    assert.equal(h.audits("UPDATE_FOCAL").length, 1);
    await h.api("PUT", `/api/admin/media/${up.data.id}/focal`, { token, body: { focal: null } });
    home = (await h.api<PublicHomeDto>("GET", "/api/public/home?lang=th")).data;
    assert.equal(home.slides[0]!.desktop.focal, undefined, "no point = centre, field left out");

    for (const body of [{ focal: { x: 120, y: 5 } }, { focal: "50 50" }, { focal: { x: 5, y: 5 }, extra: 1 }]) {
      assert.equal((await h.api("PUT", `/api/admin/media/${up.data.id}/focal`, { token, body })).status, 422, JSON.stringify(body));
    }
    assert.equal((await h.api("PUT", "/api/admin/media/nope/focal", { token, body: { focal: null } })).status, 404);
  });

  it("only staff who may upload for that image's purpose can move its point", async () => {
    const h = new Harness({ seed: true });
    const home = await editor(h, ["content.home"]);
    const up = await slideImage(h, home);
    const gallery = await editor(h, ["content.gallery"]);
    assert.equal((await h.api("PUT", `/api/admin/media/${up.data.id}/focal`, { token: gallery, body: { focal: { x: 1, y: 1 } } })).status, 403);
    assert.equal((await h.api("PUT", `/api/admin/media/${up.data.id}/focal`, { body: { focal: { x: 1, y: 1 } } })).status, 401);
    assert.equal(h.db.get<{ focal_x: number | null }>("SELECT focal_x FROM media_assets WHERE id = ?", up.data.id)!.focal_x, null);
  });

  it("house photos carry the point in admin and on the public house page", async () => {
    const h = new Harness({ seed: true });
    await h.user({ id: "root_focal", roles: ["SUPER_ADMIN"] });
    const root = await h.login("root_focal@example.test");
    const up = await slideImage(h, root, { focalX: "20", focalY: "80" }, "ACCOMMODATION");
    const added = await h.api<AdminUnitDto>("POST", "/api/admin/accommodations/dev_house_01/images", { token: root, body: { mediaAssetId: up.data.id } });
    assert.ok(added.status < 300, JSON.stringify(added.body));
    assert.deepEqual(added.data.images.find((i) => i.mediaAssetId === up.data.id)?.focal, { x: 20, y: 80 });
    await h.api("PATCH", `/api/admin/accommodations/dev_house_01/images/${added.data.images.find((i) => i.mediaAssetId === up.data.id)!.id}`,
      { token: root, body: { status: "PUBLISHED" } });
    const slug = h.db.get<{ slug: string }>("SELECT slug FROM accommodation_units WHERE id = 'dev_house_01'")!.slug;
    const pub = await h.api<PublicUnitDto>("GET", `/api/public/accommodations/${slug}?lang=en`);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.deepEqual(pub.data.images.find((i) => i.url === up.data.url)?.focal, { x: 20, y: 80 });
  });
});
