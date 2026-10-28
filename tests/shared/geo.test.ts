import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  distanceM, fitGeoref, geoToImage, georefDistanceM, imageToGeo, metresPerPixel, parseLatLon, project, tilesFor, unproject, type LonLat,
} from "../../src/shared/geo.ts";

const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} ≉ ${b} (±${tol})`);

describe("Web Mercator", () => {
  it("projects and back; world size and tile numbers as map tiles use them", () => {
    const p: LonLat = [100.5018, 13.7563];
    const px = project(p, 17);
    const back = unproject(px, 17);
    near(back[0], p[0], 1e-9); near(back[1], p[1], 1e-9);
    assert.deepEqual(project([-180, 0], 0), [0, 128]);
    // Tile x = (lon + 180) / 360 · 2^17 = 102 127 for Bangkok (OpenStreetMap numbering).
    assert.equal(Math.floor(px[0] / 256), 102_127);
    near(metresPerPixel(0, 0), 156_543.03, 0.01);
    near(metresPerPixel(60, 1), 156_543.03 / 4, 0.01, "half at 60°, half again per zoom");
  });

  it("great-circle distance; tiles covering a box", () => {
    near(distanceM([100.5, 13.75], [100.5, 13.76]), 1113.19, 0.5, "0.01° of latitude (sphere of the map radius)");
    const tiles = tilesFor({ x: 300, y: 10, w: 300, h: 100 }, 2, 2);
    assert.deepEqual(tiles, [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
    assert.equal(tilesFor({ x: 0, y: 0, w: 256, h: 256 }, 2, 3).length, 9, "one zoom deeper: 2× tiles each way (edges included)");
  });

  it("reads coordinates as Google Maps copies them (latitude first)", () => {
    assert.deepEqual(parseLatLon("13.7563, 100.5018"), [100.5018, 13.7563]);
    assert.deepEqual(parseLatLon(" 13.7563 100.5018 "), [100.5018, 13.7563]);
    assert.equal(parseLatLon("100.5"), null);
    assert.equal(parseLatLon("95, 100"), null, "latitude over 90");
  });
});

describe("georeferencing a photo", () => {
  // A photo 2000 px wide covering 400 m, turned 30° clockwise, its pixel (0, 0) at a known place.
  const origin: LonLat = [100.5, 13.75];
  const metresPerPx = 0.2;
  const turn = (30 * Math.PI) / 180;
  const truth = ([x, y]: [number, number]): LonLat => {
    const e = metresPerPx * (x * Math.cos(turn) - y * Math.sin(turn));
    const s = metresPerPx * (x * Math.sin(turn) + y * Math.cos(turn));
    return [origin[0] + (e / (6_378_137 * Math.cos((origin[1] * Math.PI) / 180))) * (180 / Math.PI), origin[1] - (s / 6_378_137) * (180 / Math.PI)];
  };
  const at = (p: [number, number]) => ({ image: p, geo: truth(p) });

  it("2 points: move / turn / scale, exact; distances in metres", () => {
    const g = fitGeoref([at([100, 100]), at([1800, 900])])!;
    assert.equal(g.kind, "SIMILARITY");
    near(g.scaleM, metresPerPx, 1e-4);
    near(g.rotationDeg, 30, 0.01);
    assert.ok(g.rmsM < 0.01);
    const q = imageToGeo(g, [1000, 500]);
    const want = truth([1000, 500]);
    assert.ok(distanceM(q, want) < 0.05, `${distanceM(q, want)} m off`);
    const back = geoToImage(g, q);
    near(back[0], 1000, 1e-3); near(back[1], 500, 1e-3);
    near(georefDistanceM(g, [0, 0], [1000, 0]), 200, 0.05);
  });

  it("3+ points: affine; a wrong point shows as a large error", () => {
    const g = fitGeoref([at([100, 100]), at([1800, 200]), at([900, 1400])])!;
    assert.equal(g.kind, "AFFINE");
    near(g.scaleM, metresPerPx, 1e-4);
    const bad = fitGeoref([at([100, 100]), at([1800, 200]), at([900, 1400]), { image: [1500, 1300], geo: truth([1500, 1000]) }])!;
    const worst = bad.residualsM.indexOf(Math.max(...bad.residualsM));
    assert.equal(worst, 3, "the typo'd point is the one off");
    assert.ok(bad.rmsM > 5);
  });

  it("not enough or degenerate points: no fit", () => {
    assert.equal(fitGeoref([at([0, 0])]), null);
    assert.equal(fitGeoref([at([5, 5]), at([5, 5])]), null);
    // Three points in a line fall back to a similarity fit (an affine one is undefined).
    assert.equal(fitGeoref([at([0, 0]), at([100, 100]), at([200, 200])])!.kind, "SIMILARITY");
  });
});
