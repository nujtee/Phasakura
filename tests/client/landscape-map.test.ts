import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AvailabilityDto, PublicUnitDto } from "../../src/shared/accommodation-types.ts";
import { emptyLandscape, type LandscapeObject } from "../../src/shared/landscape-types.ts";
import { campingStatus, drawable, mapScene, mapTargets, unitStatus } from "../../src/client/landscape/booking-map.ts";

const obj = (id: string, over: Partial<LandscapeObject> = {}): LandscapeObject => ({
  id, layerId: "stays", kind: "HOUSE", shape: { type: "rect", x: 0.125, y: 0.25, w: 0.25, h: 0.125 }, rotation: 0,
  style: { fill: "#cccccc", stroke: null, opacity: 1 }, label: null, link: null, groupId: null, locked: false, imageAssetId: null, ...over,
});
const unit = (id: string) => ({ id, slug: id, name: id, unitType: "HOUSE" }) as unknown as PublicUnitDto;
const availability = (units: [string, boolean][], campingRemaining = 5): AvailabilityDto => ({
  checkIn: "2026-11-01", checkOut: "2026-11-02", nights: 1,
  units: units.map(([unitId, available]) => ({ unitId, slug: unitId, unitType: "HOUSE", available, fitsGuests: true, nightlyPricesSatang: [190000] })),
  camping: {
    enabled: true, remaining: campingRemaining, nights: [], nightlyPricePerAdultSatang: [], fitsTents: null, reason: null, shortNights: [],
    minTents: 1, maxTentsPerBooking: 5, tarp: { offered: false, remaining: 0, shortNights: [] },
  },
});

describe("booking-page site map", () => {
  it("draws blank, photo and satellite plans", () => {
    assert.equal(drawable(emptyLandscape("BLANK")), true);
    assert.equal(drawable(emptyLandscape("PHOTO")), true);
    assert.equal(drawable(emptyLandscape("SATELLITE")), true);
  });

  it("photo plans are drawn in the photo's pixels, by layer order", () => {
    const doc = { ...emptyLandscape("PHOTO"), objects: [obj("house"), obj("lawn", { layerId: "ground", kind: "GRASS" })] };
    const { size, objects } = mapScene(doc, { width: 1000, height: 500 });
    assert.deepEqual(size, { w: 1000, h: 500 });
    assert.deepEqual(objects.map((o) => o.id), ["lawn", "house"], "ground below stays");
    assert.deepEqual(objects[1]!.shape, { type: "rect", x: 125, y: 125, w: 250, h: 62.5 });
  });

  it("status: picked wins; unknown before a search; free / taken after", () => {
    const u = unit("h1");
    assert.equal(unitStatus(u, null, new Set()), "unknown");
    assert.equal(unitStatus(u, availability([["h1", true]]), new Set()), "available");
    assert.equal(unitStatus(u, availability([["h1", false]]), new Set()), "unavailable");
    assert.equal(unitStatus(u, availability([["h1", true]]), new Set(["h1"])), "picked");
    assert.equal(campingStatus(null, true, false), "unknown");
    assert.equal(campingStatus(availability([], 0), true, false), "unavailable");
    assert.equal(campingStatus(availability([], 3), true, true), "picked");
  });

  it("only links to stays the page shows can be tapped; camping only while it is on", () => {
    const objects = [
      obj("a", { link: { type: "UNIT", unitId: "h1" } }),
      obj("b", { link: { type: "UNIT", unitId: "hidden" } }),
      obj("c", { kind: "CAMPING_AREA", link: { type: "CAMPING" } }),
      obj("d"),
    ];
    const on = mapTargets(objects, { units: [unit("h1")], availability: availability([["h1", false]]), pickedIds: new Set(), campingEnabled: true, campingPicked: false });
    assert.deepEqual([...on.keys()], ["a", "c"]);
    assert.equal(on.get("a")!.status, "unavailable");
    assert.equal(on.get("c")!.status, "available");
    const off = mapTargets(objects, { units: [unit("h1")], availability: null, pickedIds: new Set(), campingEnabled: false, campingPicked: false });
    assert.deepEqual([...off.keys()], ["a"]);
  });
});
