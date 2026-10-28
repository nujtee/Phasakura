import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { distanceM, fitGeoref, type LonLat } from "../../src/shared/geo.ts";
import { emptyLandscape, validateLandscapeDocument, type LandscapeDocument, type LandscapeObject } from "../../src/shared/landscape-types.ts";
import {
  fromWorld, measuredDistance, photoGeoref, photoToSatellite, planUnit, satelliteFrame, shapeCenter, toWorld, worldSize, SATELLITE_FRAME,
} from "../../src/client/landscape/geometry.ts";
import { viewFor } from "../../src/client/landscape/booking-map.ts";

const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} ≉ ${b} (±${tol})`);
const obj = (id: string, over: Partial<LandscapeObject>): LandscapeObject => ({
  id, layerId: "stays", kind: "HOUSE", shape: { type: "rect", x: 0, y: 0, w: 1, h: 1 }, rotation: 0,
  style: { fill: "#cccccc", stroke: null, opacity: 1 }, label: null, link: null, groupId: null, locked: false, imageAssetId: null, ...over,
});
const satellite = (objects: LandscapeObject[] = []): LandscapeDocument =>
  ({ ...emptyLandscape("SATELLITE"), background: { kind: "SATELLITE", center: [100.5018, 13.7563], zoom: 18 }, objects });

describe("satellite plans", () => {
  it("[lon, lat] ↔ map pixels of the frame; lengths in metres; rect = north-west corner + extent east / south", () => {
    const doc = satellite([
      obj("house", { shape: { type: "rect", x: 100.5016, y: 13.7565, w: 0.0001, h: 0.00008 } }),
      obj("tent", { kind: "VIP_TENT", shape: { type: "circle", cx: 100.5018, cy: 13.7563, r: 4 } }),
    ]);
    const size = worldSize(doc, null);
    assert.deepEqual(size, SATELLITE_FRAME);
    const world = toWorld(doc, size);
    const tent = world[1]!.shape;
    assert.equal(tent.type, "circle");
    if (tent.type === "circle") {
      near(tent.cx, 800, 1e-6, "the centre is the middle of the frame"); near(tent.cy, 500, 1e-6);
      near(tent.r * satelliteFrame(doc.background as never).mpp, 4, 1e-9, "4 m radius");
    }
    const house = world[0]!.shape;
    assert.ok(house.type === "rect" && house.w > 0 && house.h > 0 && house.x < 800 && house.y < 500, JSON.stringify(house));
    const back = fromWorld(doc, world, size);
    assert.deepEqual(back.objects, doc.objects, "saved exactly as it was");
    assert.deepEqual(validateLandscapeDocument(back, { backgroundKind: "SATELLITE" }), {});
  });

  it("moving the frame keeps objects where they are on the earth", () => {
    const doc = satellite([obj("t", { kind: "TREE", shape: { type: "symbol", x: 100.502, y: 13.757, size: 6 } })]);
    const world = toWorld(doc, SATELLITE_FRAME);
    const moved = { ...doc, background: { kind: "SATELLITE" as const, center: [100.503, 13.758] as [number, number], zoom: 17 } };
    const again = fromWorld(moved, toWorld({ ...fromWorld(doc, world, SATELLITE_FRAME), background: moved.background }, SATELLITE_FRAME), SATELLITE_FRAME);
    assert.deepEqual(again.objects, doc.objects);
  });

  it("distances on a satellite plan are real metres; new objects are sized from 200 m", () => {
    const doc = satellite();
    const f = satelliteFrame(doc.background as never);
    near(measuredDistance(doc, SATELLITE_FRAME, [0, 0], [100, 0])!, 100 * f.mpp, 0.01);
    near(planUnit(doc.background, SATELLITE_FRAME) * f.mpp, 200, 1e-9);
  });

  it("the booking page shows the drawn area of a satellite plan, not the whole frame", () => {
    const doc = satellite([obj("a", { shape: { type: "rect", x: 100.5016, y: 13.7565, w: 0.0004, h: 0.0002 } })]);
    const world = toWorld(doc, SATELLITE_FRAME);
    const v = viewFor(doc, SATELLITE_FRAME, world, 10);
    assert.ok(v.w < SATELLITE_FRAME.w / 4 && v.w / v.h >= 1.5 - 1e-9 && v.w / v.h <= 2 + 1e-9, JSON.stringify(v));
    assert.deepEqual(viewFor(emptyLandscape("BLANK"), { w: 200, h: 120 }, [], 1), { x: 0, y: 0, w: 200, h: 120 });
  });
});

describe("photo → satellite", () => {
  const photo = { w: 2000, h: 1000 };
  const origin: LonLat = [100.5, 13.75];
  // 0.1 m per pixel, north-up: pixel (x, y) is x·0.1 m east and y·0.1 m south of the top-left corner.
  const geoOf = ([x, y]: [number, number]): LonLat => [
    origin[0] + ((x * 0.1) / (6_378_137 * Math.cos((origin[1] * Math.PI) / 180))) * (180 / Math.PI),
    origin[1] - ((y * 0.1) / 6_378_137) * (180 / Math.PI),
  ];
  const cps = ([[100, 100], [1900, 150], [1000, 900]] as [number, number][]).map((p) => ({ image: [p[0] / photo.w, p[1] / photo.h] as [number, number], geo: geoOf(p) }));
  const doc: LandscapeDocument = {
    ...emptyLandscape("PHOTO"),
    background: { kind: "PHOTO", assetId: null, opacity: 1, measuredWidthM: null, controlPoints: cps },
    objects: [
      obj("house", { label: "Sakura", link: { type: "UNIT", unitId: "h1" }, shape: { type: "rect", x: 0.25, y: 0.5, w: 0.05, h: 0.04 } }),
      obj("lawn", { kind: "GRASS", layerId: "ground", shape: { type: "polygon", points: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]] } }),
    ],
  };

  it("control points measure the photo (they win over a typed width)", () => {
    const g = photoGeoref(doc.background, photo)!;
    near(g.scaleM, 0.1, 1e-4);
    near(measuredDistance({ ...doc, background: { ...doc.background, measuredWidthM: 999 } as never }, photo, [0, 0], [1000, 0])!, 100, 0.05);
  });

  it("every object lands at its real place; links and labels kept; a valid satellite plan", () => {
    const g = fitGeoref(cps.map((c) => ({ image: [c.image[0] * photo.w, c.image[1] * photo.h] as [number, number], geo: c.geo })))!;
    const out = photoToSatellite(doc, photo, g);
    assert.equal(out.crs, "WGS84");
    assert.equal(out.background.kind, "SATELLITE");
    assert.deepEqual(validateLandscapeDocument(out, { backgroundKind: "SATELLITE" }), {});
    const house = out.objects.find((o) => o.id === "house")!;
    assert.equal(house.label, "Sakura");
    assert.deepEqual(house.link, { type: "UNIT", unitId: "h1" });
    // Centre of the house: photo pixel (550, 520).
    const world = toWorld(out, SATELLITE_FRAME).find((o) => o.id === "house")!;
    const f = satelliteFrame(out.background as never);
    const c = f.toLonLat(shapeCenter(world.shape));
    assert.ok(distanceM(c as LonLat, geoOf([550, 520])) < 0.2, `${distanceM(c as LonLat, geoOf([550, 520]))} m off`);
    // 100 px × 40 px of photo = 10 m × 4 m.
    if (house.shape.type === "rect") near(house.shape.w * 6_378_137 * Math.cos((13.75 * Math.PI) / 180) * (Math.PI / 180), 10, 0.05);
    const lawn = out.objects.find((o) => o.id === "lawn")!;
    assert.ok(lawn.shape.type === "polygon" && distanceM(lawn.shape.points[0] as LonLat, geoOf([200, 100])) < 0.2);
    // The whole photo fits in the frame.
    assert.ok(SATELLITE_FRAME.w * f.mpp >= 200);
  });
});
