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
