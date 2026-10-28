import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyLandscape, validateLandscapeDocument, type LandscapeObject } from "../../src/shared/landscape-types.ts";
import {
  fromWorld, handlePoints, hitTest, measuredDistance, objectsBox, resizeBox, rotatePoint, scaleShape, shapeBox, snap, toWorld, worldSize,
} from "../../src/client/landscape/geometry.ts";
import {
  commit, deleteObjects, drawOrder, duplicateObjects, expandGroups, groupObjects, initHistory, moveObjects, redo, removeLayer, reorderObjects, undo,
  type Scene,
} from "../../src/client/landscape/editor-state.ts";

const obj = (id: string, over: Partial<LandscapeObject> = {}): LandscapeObject => ({
  id, layerId: "stays", kind: "HOUSE", shape: { type: "rect", x: 10, y: 10, w: 20, h: 10 }, rotation: 0,
  style: { fill: "#cccccc", stroke: null, opacity: 1 }, label: null, link: null, groupId: null, locked: false, imageAssetId: null, ...over,
});
const scene = (objects: LandscapeObject[]): Scene => {
  const d = emptyLandscape("BLANK");
  return { objects, layers: d.layers, background: d.background };
};

describe("plan geometry", () => {
  it("photo plans: 0…1 of the image ↔ pixels, exactly both ways (a saved plan opens where it was)", () => {
    const doc = { ...emptyLandscape("PHOTO"), objects: [obj("a", { shape: { type: "polygon", points: [[0.1, 0.2], [0.5, 0.2], [0.3, 0.9]] } }), obj("b", { kind: "TREE", shape: { type: "symbol", x: 0.25, y: 0.5, size: 0.02 } })] };
    const size = worldSize(doc, { width: 2000, height: 1000 });
    const world = toWorld(doc, size);
    assert.deepEqual(world[0]!.shape, { type: "polygon", points: [[200, 200], [1000, 200], [600, 900]] });
    assert.deepEqual(world[1]!.shape, { type: "symbol", x: 500, y: 500, size: 40 }, "lengths follow the photo's width");
    const back = fromWorld(doc, world, size);
    assert.deepEqual(back.objects, doc.objects);
    assert.deepEqual(validateLandscapeDocument(back, { backgroundKind: "PHOTO" }), {});
  });

  it("blank canvas: metres stay metres (rounded to the millimetre)", () => {
    const doc = emptyLandscape("BLANK");
    const out = fromWorld(doc, [obj("a", { shape: { type: "rect", x: 1.23456, y: 2, w: 3, h: 4 } })], worldSize(doc, null));
    assert.deepEqual(out.objects[0]!.shape, { type: "rect", x: 1.235, y: 2, w: 3, h: 4 });
    assert.equal(out.crs, "CANVAS_M");
  });

  it("hit test follows rotation; polygons, paths and symbols", () => {
    const r = obj("r", { shape: { type: "rect", x: 0, y: 0, w: 20, h: 2 }, rotation: 90 });
    assert.equal(hitTest(r, [10, 1]), true, "centre");
    assert.equal(hitTest(r, [10, 8]), true, "rotated: now tall");
    assert.equal(hitTest(r, [18, 1]), false, "rotated: no longer wide");
    const poly = obj("p", { shape: { type: "polygon", points: [[0, 0], [10, 0], [0, 10]] } });
    assert.equal(hitTest(poly, [2, 2]), true);
    assert.equal(hitTest(poly, [8, 8]), false);
    const path = obj("l", { kind: "PATH", shape: { type: "path", points: [[0, 0], [10, 0]], width: 2 } });
    assert.equal(hitTest(path, [5, 0.9]), true);
    assert.equal(hitTest(path, [5, 3]), false);
  });

  it("resize keeps the opposite side; circles keep their shape; snapping", () => {
    const b = { x: 0, y: 0, w: 10, h: 10 };
    assert.deepEqual(resizeBox(b, 4, [20, 15], false, 0.1), { x: 0, y: 0, w: 20, h: 15 }, "se handle");
    assert.deepEqual(resizeBox(b, 0, [-5, 2], false, 0.1), { x: -5, y: 2, w: 15, h: 8 }, "nw handle");
    assert.deepEqual(resizeBox(b, 4, [20, 15], true, 0.1), { x: 0, y: 0, w: 20, h: 20 }, "keep ratio");
    assert.equal(handlePoints(b).length, 8);
    assert.deepEqual(scaleShape({ type: "circle", cx: 5, cy: 5, r: 5 }, b, { x: 0, y: 0, w: 20, h: 20 }), { type: "circle", cx: 10, cy: 10, r: 10 });
    assert.equal(snap(12.4, 5), 10);
    assert.equal(snap(12.4, 0), 12.4);
    const p = rotatePoint([10, 0], [0, 0], 90);
    assert.ok(Math.abs(p[0]) < 1e-9 && Math.abs(p[1] - 10) < 1e-9);
    assert.deepEqual(objectsBox([obj("a"), obj("b", { shape: { type: "rect", x: 40, y: 0, w: 5, h: 5 } })]), { x: 10, y: 0, w: 35, h: 20 });
  });

  it("measured vs illustrative distances", () => {
    const blank = emptyLandscape("BLANK");
    assert.equal(measuredDistance(blank, worldSize(blank, null), [0, 0], [3, 4]), 5, "blank canvas is in metres");
    const photo = emptyLandscape("PHOTO");
    const size = worldSize(photo, { width: 1000, height: 500 });
    assert.equal(measuredDistance(photo, size, [0, 0], [500, 0]), null, "not measured: illustrative");
    const measured = { ...photo, background: { ...photo.background, measuredWidthM: 80 } as typeof photo.background };
    assert.equal(measuredDistance(measured, size, [0, 0], [500, 0]), 40);
  });
});

describe("editor state", () => {
  it("undo / redo, one step per finished action", () => {
    let h = initHistory(scene([obj("a")]));
    h = commit(h, moveObjects(h.present, ["a"], 5, 0));
    h = commit(h, deleteObjects(h.present, ["a"]));
    assert.equal(h.present.objects.length, 0);
    h = undo(h);
    assert.equal(shapeBox(h.present.objects[0]!.shape).x, 15);
    h = undo(h);
    assert.equal(shapeBox(h.present.objects[0]!.shape).x, 10);
    assert.equal(undo(h), undo(undo(h)), "nothing further back");
    h = redo(redo(h));
    assert.equal(h.present.objects.length, 0);
    assert.equal(commit(h, h.present), h, "no change, no step");
  });

  it("locked objects and locked / hidden layers do not move or go", () => {
    const s0 = scene([obj("a", { locked: true }), obj("b"), obj("c", { layerId: "ground" })]);
    const s = { ...s0, layers: s0.layers.map((l) => (l.id === "ground" ? { ...l, locked: true } : l)) };
    const moved = moveObjects(s, ["a", "b", "c"], 5, 5);
    assert.deepEqual(moved.objects.map((o) => shapeBox(o.shape).x), [10, 15, 10]);
    assert.deepEqual(deleteObjects(s, ["a", "b", "c"]).objects.map((o) => o.id), ["a", "c"]);
  });

  it("groups select together; duplicates are new, unlinked, still grouped; drawing order by layer then list", () => {
    let s = scene([obj("a", { link: { type: "UNIT", unitId: "u1" } }), obj("b"), obj("c", { layerId: "ground" })]);
    s = groupObjects(s, ["a", "b"]);
    assert.deepEqual(expandGroups(s, ["a"]).sort(), ["a", "b"]);
    const d = duplicateObjects(s, ["a", "b"], 1);
    const copies = d.scene.objects.filter((o) => d.ids.includes(o.id));
    assert.equal(copies.length, 2);
    assert.ok(copies.every((o) => o.link === null && !["a", "b"].includes(o.id)));
    assert.equal(new Set(copies.map((o) => o.groupId)).size, 1);
    assert.notEqual(copies[0]!.groupId, s.objects[0]!.groupId);
    assert.deepEqual(drawOrder(s).map((o) => o.id), ["c", "a", "b"], "ground is below stays");
    assert.deepEqual(reorderObjects(s, ["a"], "top").objects.map((o) => o.id), ["b", "c", "a"]);
    assert.deepEqual(validateLandscapeDocument({ ...emptyLandscape("BLANK"), objects: d.scene.objects }, { backgroundKind: "BLANK" }), {});
  });

  it("a layer with objects is never removed (its objects would vanish)", () => {
    const s = scene([obj("a")]);
    assert.equal(removeLayer(s, "stays"), s);
    assert.equal(removeLayer(s, "labels").layers.length, 3);
  });
});
