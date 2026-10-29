import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyLandscape, validateLandscapeDocument,
  type LandscapeDocument, type LandscapeLayoutDto, type LandscapeObject, type LandscapeOverviewDto, type LandscapeVersionDto, type PublicLandscapeDto,
} from "../../src/shared/landscape-types.ts";
import { Harness } from "../helpers/harness.ts";

// Site plan (landscape, migration 0039, phase L1). Seed: dev_house_01 / dev_house_02 (HOUSE), dev_vip_01 (VIP_TENT).
let seq = 0;

async function setup() {
  const h = new Harness({ seed: true });
  const root = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const role = async (r: string) => h.login(await h.user({ id: `${r.toLowerCase()}_${++seq}`, roles: [r] }));
  const on = () => h.api("PUT", "/api/admin/landscape/settings", { token: root, body: { enabled: true } });
  const create = async (backgroundKind = "BLANK", token = root) => {
    const res = await h.api<LandscapeLayoutDto>("POST", "/api/admin/landscape/layouts", { token, body: { name: "Main plan", backgroundKind } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.data;
  };
  const save = (id: string, baseRevision: number, document: unknown, token = root) =>
    h.api<LandscapeLayoutDto>("PUT", `/api/admin/landscape/layouts/${id}/draft`, { token, body: { baseRevision, document } });
  const publish = (id: string, revision: number, extra: Record<string, unknown> = {}, token = root) =>
    h.api<LandscapeLayoutDto>("POST", `/api/admin/landscape/layouts/${id}/publish`, { token, body: { revision, ...extra } });
  return { h, root, role, on, create, save, publish };
}

const obj = (over: Partial<LandscapeObject> = {}): LandscapeObject => ({
  id: `o${++seq}`, layerId: "stays", kind: "HOUSE", shape: { type: "rect", x: 10, y: 10, w: 12, h: 8 }, rotation: 0,
  style: { fill: "#c9a66b", stroke: "#333333", opacity: 1 }, label: "House", link: null, groupId: null, locked: false, imageAssetId: null, ...over,
});
const withObjects = (objects: LandscapeObject[], doc: LandscapeDocument = emptyLandscape("BLANK")): LandscapeDocument => ({ ...doc, objects });

describe("landscape document rules (shared with the editor)", () => {
  it("a coordinate reference fixed by the background; shapes in bounds; layers known", () => {
    const blank = emptyLandscape("BLANK");
    assert.deepEqual(validateLandscapeDocument(blank, { backgroundKind: "BLANK" }), {});
    assert.equal(validateLandscapeDocument(blank, { backgroundKind: "PHOTO" }).crs, "MUST_MATCH_BACKGROUND");
    const far = withObjects([obj({ shape: { type: "rect", x: 900, y: 10, w: 5, h: 5 } })]);
    assert.equal(validateLandscapeDocument(far, { backgroundKind: "BLANK" })["objects.0.shape"], "OUT_OF_BOUNDS");
    const photo = withObjects([obj({ shape: { type: "polygon", points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.3]] } })], emptyLandscape("PHOTO"));
    assert.deepEqual(validateLandscapeDocument(photo, { backgroundKind: "PHOTO" }), {}, "photo: 0…1 across the image");
    const sat = withObjects([obj({ shape: { type: "symbol", x: 100.5, y: 13.75, size: 0.0001 }, kind: "TREE", link: null })], emptyLandscape("SATELLITE"));
    assert.deepEqual(validateLandscapeDocument(sat, { backgroundKind: "SATELLITE" }), {}, "satellite: longitude / latitude");
    assert.equal(validateLandscapeDocument(withObjects([obj({ layerId: "nope" })]), { backgroundKind: "BLANK" })["objects.0.layerId"], "UNKNOWN_LAYER");
    assert.equal(validateLandscapeDocument(withObjects([obj({ shape: { type: "polygon", points: [[1, 1], [2, 2]] } })]), { backgroundKind: "BLANK" })["objects.0.shape"], "INVALID");
    assert.equal(validateLandscapeDocument(withObjects([obj({ style: { fill: "red", stroke: null, opacity: 1 } })]), { backgroundKind: "BLANK" })["objects.0.style"], "INVALID");
    const dup = obj();
    assert.equal(validateLandscapeDocument(withObjects([dup, { ...dup }]), { backgroundKind: "BLANK" })["objects.1"], "INVALID", "ids unique");
  });

  it("booking links: only houses / VIP tents / the camping area; checked against the units when publishing", () => {
    const units = [{ id: "u1", type: "HOUSE" as const, status: "ACTIVE" }, { id: "v1", type: "VIP_TENT" as const, status: "ACTIVE" }];
    const ctx = { backgroundKind: "BLANK" as const, units, campingEnabled: true, publish: true };
    assert.equal(validateLandscapeDocument(withObjects([obj({ kind: "TREE", link: { type: "UNIT", unitId: "u1" } })]), ctx)["objects.0.link"], "NOT_RESERVABLE");
    assert.equal(validateLandscapeDocument(withObjects([obj({ link: { type: "UNIT", unitId: "v1" } })]), ctx)["objects.0.link"], "UNIT_TYPE_MISMATCH");
    assert.equal(validateLandscapeDocument(withObjects([obj({ link: { type: "UNIT", unitId: "zz" } })]), ctx)["objects.0.link"], "UNKNOWN_UNIT");
    assert.equal(validateLandscapeDocument(withObjects([obj({ link: { type: "UNIT", unitId: "u1" } }), obj({ link: { type: "UNIT", unitId: "u1" } })]), ctx)["objects.1.link"], "UNIT_LINKED_TWICE");
    assert.equal(validateLandscapeDocument(withObjects([obj({ kind: "CAMPING_AREA", link: { type: "CAMPING" } })]), { ...ctx, campingEnabled: false })["objects.0.link"], "CAMPING_DISABLED");
    assert.deepEqual(validateLandscapeDocument(withObjects([obj({ link: { type: "UNIT", unitId: "zz" } })]), { backgroundKind: "BLANK" }), {}, "a draft may hold a link still to fix");
  });
});

describe("landscape switch and permissions", () => {
  it("off by default: no plan on the booking page, nothing can be made; only SUPER_ADMIN switches it (audited)", async () => {
    const { h, root, role, on, create } = await setup();
    const overview = await h.api<LandscapeOverviewDto>("GET", "/api/admin/landscape", { token: root });
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    assert.equal(overview.data.enabled, false);
    assert.equal(overview.data.canToggle, true);
    assert.deepEqual((await h.api<PublicLandscapeDto>("GET", "/api/public/landscape")).data, { enabled: false, layout: null });
    assert.equal((await h.api("POST", "/api/admin/landscape/layouts", { token: root, body: { name: "x", backgroundKind: "BLANK" } })).error?.code, "LANDSCAPE_OFF");

    const manager = await role("MANAGER");
    assert.equal((await h.api("PUT", "/api/admin/landscape/settings", { token: manager, body: { enabled: true } })).status, 403);
    assert.equal((await on()).status, 200);
    assert.equal(h.audits("LANDSCAPE_ON").length, 1);
    await create("BLANK", manager);

    const content = await role("CONTENT_ADMIN");
    const booking = await role("BOOKING_ADMIN");
    const viewer = await role("VIEWER");
    assert.equal((await h.api("GET", "/api/admin/landscape", { token: viewer })).status, 403);
    assert.equal((await h.api("GET", "/api/admin/landscape", { token: booking })).status, 200, "booking admins see the plans");
    assert.equal((await h.api("POST", "/api/admin/landscape/layouts", { token: booking, body: { name: "x", backgroundKind: "BLANK" } })).status, 403);
    const drawn = await create("BLANK", content);
    assert.equal((await h.api("POST", `/api/admin/landscape/layouts/${drawn.id}/publish`, { token: content, body: { revision: 1 } })).status, 403, "content admins draw, managers publish");
  });

  it("landscape.toggle stays with SUPER_ADMIN: never another role, never one user", async () => {
    const { h, root } = await setup();
    assert.throws(() => h.db.run("INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_manager', 'perm_landscape_toggle')"), /LANDSCAPE_TOGGLE_SUPER_ADMIN_ONLY/);
    const userId = `m_${++seq}`;
    await h.user({ id: userId, roles: ["MANAGER"] });
    const res = await h.api("PUT", `/api/admin/users/${userId}/permissions`, { token: root, body: { overrides: [{ code: "landscape.toggle", effect: "GRANT" }] } });
    assert.notEqual(res.status, 200);
  });
});

describe("drafts, publishing and versions", () => {
  it("saves a draft on top of the revision it started from; someone else's save is never overwritten", async () => {
    const { h, root, role, on, create, save } = await setup();
    await on();
    const layout = await create();
    assert.equal(layout.draftRevision, 1);
    assert.equal(layout.draft.crs, "CANVAS_M");
    const first = await save(layout.id, 1, withObjects([obj({ kind: "TREE", shape: { type: "symbol", x: 50, y: 40, size: 3 } })]));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.data.draftRevision, 2);
    // A second admin still on revision 1.
    const other = await role("MANAGER");
    const stale = await save(layout.id, 1, withObjects([]), other);
    assert.equal(stale.status, 409);
    assert.equal(stale.error?.code, "DRAFT_CONFLICT");
    assert.equal(stale.error?.details?.revision, "2");
    assert.equal((await h.api<LandscapeLayoutDto>("GET", `/api/admin/landscape/layouts/${layout.id}`, { token: root })).data.draft.objects.length, 1, "kept");
    // Server-side checks (the editor is not trusted).
    const bad = await save(layout.id, 2, withObjects([obj({ shape: { type: "rect", x: 10, y: 10, w: -1, h: 4 } })]));
    assert.equal(bad.status, 422);
    assert.equal(bad.error?.details?.["document.objects.0.shape"], "INVALID");
    const wrongCrs = await save(layout.id, 2, emptyLandscape("PHOTO"));
    assert.equal(wrongCrs.error?.details?.["document.crs"], "MUST_MATCH_BACKGROUND", "a background change needs a transformation, never a silent move");
    const photo = await create("PHOTO");
    const noImage = await save(photo.id, 1, { ...emptyLandscape("PHOTO"), background: { kind: "PHOTO", assetId: "no_such_asset", opacity: 1, measuredWidthM: null, controlPoints: [] } });
    assert.equal(noImage.error?.details?.["document.background.assetId"], "INVALID_IMAGE");
  });

  it("publish checks the booking links, freezes the draft as a version; the booking page gets it without hidden layers; bookings untouched", async () => {
    const { h, root, on, create, save, publish } = await setup();
    await on();
    const layout = await create();
    const counts = () => h.db.get<{ b: number; n: number }>("SELECT (SELECT COUNT(*) FROM bookings) AS b, (SELECT COUNT(*) FROM booking_unit_nights) AS n")!;
    const before = { ...counts() };
    const wrong = await save(layout.id, 1, withObjects([obj({ link: { type: "UNIT", unitId: "dev_vip_01" } })]));
    assert.equal(wrong.status, 200, "a draft may be unfinished");
    const refused = await publish(layout.id, 2);
    assert.equal(refused.status, 422);
    assert.equal(refused.error?.details?.["document.objects.0.link"], "UNIT_TYPE_MISMATCH");

    const doc = withObjects([
      obj({ link: { type: "UNIT", unitId: "dev_house_01" }, label: "Sakura" }),
      obj({ kind: "VIP_TENT", link: { type: "UNIT", unitId: "dev_vip_01" }, shape: { type: "circle", cx: 60, cy: 30, r: 4 } }),
      obj({ kind: "CAMPING_AREA", layerId: "ground", link: { type: "CAMPING" }, shape: { type: "polygon", points: [[80, 10], [120, 10], [120, 50], [80, 50]] } }),
      obj({ kind: "LABEL", layerId: "labels", label: "Staff only", shape: { type: "symbol", x: 5, y: 5, size: 2 } }),
    ]);
    doc.layers = doc.layers.map((l) => (l.id === "labels" ? { ...l, visible: false } : l));
    assert.equal((await save(layout.id, 2, doc)).status, 200);
    assert.equal((await publish(layout.id, 2)).error?.code, "DRAFT_CONFLICT", "publishing what was looked at, not a newer draft");
    const ok = await publish(layout.id, 3, { note: "first plan", makePublic: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.data.publishedVersionNo, 1);
    assert.equal(ok.data.isPublic, true);
    assert.equal(ok.data.unpublishedChanges, false);
    assert.equal(h.audits("LANDSCAPE_PUBLISH").length, 1);

    const pub = (await h.api<PublicLandscapeDto>("GET", "/api/public/landscape")).data;
    assert.equal(pub.enabled, true);
    assert.equal(pub.layout?.versionNo, 1);
    assert.deepEqual(pub.layout?.document.layers.map((l) => l.id), ["ground", "plants", "stays"], "hidden layer left out");
    assert.equal(pub.layout?.document.objects.length, 3);
    assert.ok(!JSON.stringify(pub).includes("root_"), "no admin names");
    assert.deepEqual({ ...counts() }, before, "publishing never touches bookings or nights");

    // Off again: the booking page shows nothing, the plan is kept.
    await h.api("PUT", "/api/admin/landscape/settings", { token: root, body: { enabled: false } });
    assert.deepEqual((await h.api<PublicLandscapeDto>("GET", "/api/public/landscape")).data, { enabled: false, layout: null });
    assert.equal((await save(layout.id, 3, doc)).error?.code, "LANDSCAPE_OFF");
  });

  it("versions are frozen; rollback publishes an old version again as a new one; restore copies it into the draft", async () => {
    const { h, root, on, create, save, publish } = await setup();
    await on();
    const layout = await create();
    await save(layout.id, 1, withObjects([obj({ kind: "TREE", shape: { type: "symbol", x: 20, y: 20, size: 2 } })]));
    await publish(layout.id, 2);
    await save(layout.id, 2, withObjects([]));
    await publish(layout.id, 3);
    const versions = (await h.api<LandscapeVersionDto[]>("GET", `/api/admin/landscape/layouts/${layout.id}/versions`, { token: root })).data;
    assert.deepEqual(versions.map((v) => [v.versionNo, v.objects]), [[2, 0], [1, 1]]);
    assert.throws(() => h.db.run("UPDATE landscape_versions SET note = 'x'"), /LANDSCAPE_VERSION_IMMUTABLE/);
    assert.throws(() => h.db.run("DELETE FROM landscape_versions"), /LANDSCAPE_VERSION_IMMUTABLE/);

    const v1 = versions.find((v) => v.versionNo === 1)!;
    const back = await h.api<LandscapeLayoutDto>("POST", `/api/admin/landscape/layouts/${layout.id}/versions/${v1.id}/republish`, { token: root });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.data.publishedVersionNo, 3);
    const after = (await h.api<LandscapeVersionDto[]>("GET", `/api/admin/landscape/layouts/${layout.id}/versions`, { token: root })).data;
    assert.deepEqual([after[0]!.versionNo, after[0]!.restoredFromNo, after[0]!.objects], [3, 1, 1]);
    assert.equal(h.audits("LANDSCAPE_ROLLBACK").length, 1);

    const restored = await h.api<LandscapeLayoutDto>("POST", `/api/admin/landscape/layouts/${layout.id}/versions/${v1.id}/restore`, { token: root, body: { baseRevision: 3 } });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.data.draft.objects.length, 1);
    assert.equal(restored.data.draftRevision, 4);
  });

  it("archiving takes a plan off the booking page; only a published plan can be shown there", async () => {
    const { h, root, on, create, publish } = await setup();
    await on();
    const layout = await create();
    assert.equal((await h.api("PUT", "/api/admin/landscape/public", { token: root, body: { layoutId: layout.id } })).error?.code, "LANDSCAPE_NOT_PUBLISHED");
    await publish(layout.id, 1, { makePublic: true });
    assert.equal((await h.api<PublicLandscapeDto>("GET", "/api/public/landscape")).data.layout?.name, "Main plan");
    assert.equal((await h.api("DELETE", `/api/admin/landscape/layouts/${layout.id}`, { token: root })).status, 200);
    assert.equal((await h.api<PublicLandscapeDto>("GET", "/api/public/landscape")).data.layout, null);
    assert.equal((await h.api("GET", `/api/admin/landscape/layouts/${layout.id}`, { token: root })).status, 404);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM landscape_versions")!.n, 1, "history kept");
  });

  it("reusable templates: shape, style and picture only (no place in a plan, no booking link)", async () => {
    const { h, root, on } = await setup();
    await on();
    const { id: _id, layerId: _l, groupId: _g, link: _k, ...object } = obj({ kind: "TREE", shape: { type: "symbol", x: 1, y: 1, size: 3 } });
    const made = await h.api<{ id: string; object: Record<string, unknown> }>("POST", "/api/admin/landscape/templates", { token: root, body: { name: "Big tree", object } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.data.object.link, undefined);
    const bad = await h.api("POST", "/api/admin/landscape/templates", { token: root, body: { name: "x", object: { ...object, kind: "SPACESHIP" } } });
    assert.equal(bad.status, 422);
    assert.equal((await h.api<unknown[]>("GET", "/api/admin/landscape/templates", { token: root })).data.length, 1);
    assert.equal((await h.api("DELETE", `/api/admin/landscape/templates/${made.data.id}`, { token: root })).status, 200);
    assert.equal((await h.api<unknown[]>("GET", "/api/admin/landscape/templates", { token: root })).data.length, 0);
  });
});

describe("satellite plans (phase L4): MapTiler imagery through the Worker", () => {
  const KEY = "maptiler-test-key-123";
  const tile = (lon: number, lat: number, z: number) => {
    const n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const r = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    return `/sat-tiles/${z}/${x}/${y}`;
  };

  it("no key: satellite plans cannot be made; the editor is told", async () => {
    const { h, root, on } = await setup();
    await on();
    const res = await h.api("POST", "/api/admin/landscape/layouts", { token: root, body: { name: "Sat", backgroundKind: "SATELLITE" } });
    assert.equal(res.status, 409);
    assert.equal(res.error?.code, "MAP_NOT_CONFIGURED");
    assert.equal((await h.api<LandscapeOverviewDto>("GET", "/api/admin/landscape", { token: root })).data.satelliteReady, false);
    assert.equal((await h.get("/sat-tiles/17/102127/60720")).status, 503);
  });

  it("with a key: a new plan starts over the site's location; tiles around it only, key never shown", async () => {
    const { h, root, on, create, publish } = await setup();
    h.env.MAPTILER_API_KEY = KEY;
    h.db.run(`INSERT INTO site_settings (id, default_language, latitude, longitude) VALUES (1, 'th', 18.7883, 98.9853)
      ON CONFLICT (id) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude`);
    await on();
    assert.equal((await h.api<LandscapeOverviewDto>("GET", "/api/admin/landscape", { token: root })).data.satelliteReady, true);
    const sat = await create("SATELLITE");
    assert.deepEqual(sat.draft.background, { kind: "SATELLITE", center: [98.9853, 18.7883], zoom: 17 });

    const here = await h.get(tile(98.9853, 18.7883, 17));
    assert.equal(here.status, 200);
    assert.equal(here.headers.get("Content-Type"), "image/png");
    assert.match(here.headers.get("Cache-Control") ?? "", /public, max-age=\d+/);
    const sent = h.tileRequests.at(-1)!.url;
    assert.match(sent, /^https:\/\/api\.maptiler\.com\/tiles\/satellite-v2\/17\/\d+\/\d+\?key=maptiler-test-key-123$/);
    assert.equal((await h.get(tile(98.9853, 18.7883, 20))).status, 200, "three zoom levels in");
    assert.equal((await h.get(tile(98.9853, 18.7883, 13))).status, 404, "too far out");
    const before = h.tileRequests.length;
    assert.equal((await h.get(tile(100.5018, 13.7563, 17))).status, 404, "elsewhere: not an open proxy");
    assert.equal(h.tileRequests.length, before, "nothing fetched for it");
    // The plan moves (editor): its new area is served right after the save, not only when the memo runs out.
    const moved = await h.api<LandscapeLayoutDto>("PUT", `/api/admin/landscape/layouts/${sat.id}/draft`, {
      token: root, body: { baseRevision: sat.draftRevision, document: { ...sat.draft, background: { kind: "SATELLITE", center: [100.5018, 13.7563], zoom: 17 } } },
    });
    assert.equal(moved.status, 200);
    h.advance(3000);
    assert.equal((await h.get(tile(100.5018, 13.7563, 17))).status, 200);
    sat.draftRevision = moved.data.draftRevision;
    sat.draft = moved.data.draft;

    // MapTiler refuses the key: a short code, never the key or MapTiler's answer.
    h.tileResponse = () => new Response(`Invalid key ${KEY}`, { status: 403 });
    const refused = await h.get(tile(100.5018, 13.7563, 18));
    assert.equal(refused.status, 403);
    const text = await refused.text();
    assert.equal(text, "MAP_KEY_REJECTED");
    assert.ok(!text.includes(KEY));
    h.tileResponse = () => new Response("<html>not an image</html>", { headers: { "Content-Type": "image/png" } });
    assert.equal((await h.get(tile(100.5018, 13.7563, 19))).status, 502, "only images go through");

    // A satellite plan publishes and reaches the booking page like the others.
    const doc = { ...sat.draft, background: { kind: "SATELLITE", center: [98.9853, 18.7883], zoom: 17 },
      objects: [obj({ kind: "HOUSE", link: { type: "UNIT", unitId: "dev_house_01" }, shape: { type: "rect", x: 98.985, y: 18.7885, w: 0.0001, h: 0.0001 } })] };
    const saved = await h.api<LandscapeLayoutDto>("PUT", `/api/admin/landscape/layouts/${sat.id}/draft`, { token: root, body: { baseRevision: sat.draftRevision, document: doc } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await publish(sat.id, saved.data.draftRevision, { makePublic: true })).status, 200);
    const pub = await h.api<PublicLandscapeDto>("GET", "/api/public/landscape");
    assert.equal(pub.data.layout?.document.background.kind, "SATELLITE");

    // Switched off: no tiles either.
    await h.api("PUT", "/api/admin/landscape/settings", { token: root, body: { enabled: false } });
    h.tileResponse = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { headers: { "Content-Type": "image/png" } });
    h.advance(60_000); // past the 30 s memo of the plan areas
    assert.equal((await h.get(tile(98.9853, 18.7883, 17))).status, 404);
  });
});

describe("palette (migration 0040): kinds staff add, change, hide and delete", () => {
  const sala = { kind: "BUILDING", name: "Sala", draw: "rect", fill: "#aa8844", stroke: "#553311", opacity: 1, layer: "stays", size: 0.05, group: "site", sortOrder: 125, hidden: false };
  type Row = { id: string; builtin: boolean; name: string | null; hidden: boolean; kind: string };

  it("add, rename, hide a built-in, reset it; delete a staff kind — drawn objects never change; audited", async () => {
    const { h, root, on, create, save } = await setup();
    await on();
    assert.deepEqual((await h.api<Row[]>("GET", "/api/admin/landscape/palette", { token: root })).data, [], "as it ships: nothing stored");

    const added = await h.api<Row[]>("POST", "/api/admin/landscape/palette", { token: root, body: sala });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const kind = added.data.find((r) => r.name === "Sala")!;
    assert.ok(kind && !kind.builtin && /^k/.test(kind.id));

    const renamed = await h.api<Row[]>("PUT", `/api/admin/landscape/palette/${kind.id}`, { token: root, body: { ...sala, name: "Pavilion" } });
    assert.equal(renamed.data.find((r) => r.id === kind.id)?.name, "Pavilion");
    const tree = await h.api<Row[]>("PUT", "/api/admin/landscape/palette/TREE", { token: root, body: { ...sala, kind: "TREE", name: null, draw: "symbol", layer: "plants", group: "nature", hidden: true } });
    assert.equal(tree.status, 200, JSON.stringify(tree.body));
    assert.deepEqual(tree.data.find((r) => r.id === "TREE"), { ...tree.data.find((r) => r.id === "TREE"), builtin: true, hidden: true, name: null });
    assert.equal((await h.api("PUT", "/api/admin/landscape/palette/TREE", { token: root, body: { ...sala, kind: "HOUSE" } })).error?.details?.kind, "BUILTIN_KIND_FIXED");

    // A plan with an object drawn as the staff kind.
    const layout = await create();
    const drawn = obj({ kind: "BUILDING", label: "Sala 1", typeId: kind.id });
    assert.equal((await save(layout.id, 1, withObjects([drawn]))).status, 200);
    assert.deepEqual((await h.api("GET", `/api/admin/landscape/palette/${kind.id}/usage`, { token: root })).data, { objects: 1 });

    const reset = await h.api<Row[]>("DELETE", "/api/admin/landscape/palette/TREE", { token: root });
    assert.equal(reset.data.some((r) => r.id === "TREE"), false, "back as it ships");
    const gone = await h.api<Row[]>("DELETE", `/api/admin/landscape/palette/${kind.id}`, { token: root });
    assert.equal(gone.data.some((r) => r.id === kind.id), false);
    const after = (await h.api<LandscapeLayoutDto>("GET", `/api/admin/landscape/layouts/${layout.id}`, { token: root })).data.draft.objects[0];
    assert.deepEqual(after, drawn, "the drawn object is untouched");
    assert.equal((await h.api("DELETE", `/api/admin/landscape/palette/${kind.id}`, { token: root })).status, 404);
    assert.deepEqual(["LANDSCAPE_KIND_CREATE", "LANDSCAPE_KIND_UPDATE", "LANDSCAPE_KIND_RESET", "LANDSCAPE_KIND_DELETE"].map((a) => h.audits(a).length > 0), [true, true, true, true]);
  });

  it("checked on the server: fields, permissions, switched off, at most 60 own kinds", async () => {
    const { h, root, role, on } = await setup();
    assert.equal((await h.api("POST", "/api/admin/landscape/palette", { token: root, body: sala })).error?.code, "LANDSCAPE_OFF");
    await on();
    const bad = await h.api("POST", "/api/admin/landscape/palette", { token: root, body: { ...sala, name: "", fill: "red", size: 2, draw: "star" } });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.error?.details ?? {}).sort(), ["draw", "fill", "name", "size"]);
    assert.equal((await h.api("POST", "/api/admin/landscape/palette", { token: root, body: { ...sala, extra: 1 } })).status, 422, "unknown fields refused");
    const booking = await role("BOOKING_ADMIN");
    assert.equal((await h.api("GET", "/api/admin/landscape/palette", { token: booking })).status, 200, "may look");
    assert.equal((await h.api("POST", "/api/admin/landscape/palette", { token: booking, body: sala })).status, 403);
    const content = await role("CONTENT_ADMIN");
    assert.equal((await h.api("POST", "/api/admin/landscape/palette", { token: content, body: sala })).status, 201, "content staff may add kinds");
    assert.equal((await h.api("GET", "/api/admin/landscape/palette")).status, 401);
    for (let i = 1; i < 60; i++) await h.api("POST", "/api/admin/landscape/palette", { token: root, body: { ...sala, name: `Kind ${i}` } });
    assert.equal((await h.api("POST", "/api/admin/landscape/palette", { token: root, body: sala })).error?.code, "TOO_MANY_KINDS");
    // An object's palette id is checked like any id.
    const doc = withObjects([obj({ typeId: "bad id!" })]);
    assert.equal(validateLandscapeDocument(doc, { backgroundKind: "BLANK" })["objects.0.typeId"], "INVALID_ID");
  });
});
