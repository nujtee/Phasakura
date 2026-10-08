import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { amenityCode, nextAmenityCode } from "../../src/client/admin/accommodation/amenity-code.ts";

const fixed = () => "abc123";

describe("amenity code for a new amenity (optional in the form)", () => {
  it("uses a typed code, tidied to a-z, 0-9, _", () => {
    assert.deepEqual(amenityCode("parking", "", fixed), { code: "parking", auto: false });
    assert.deepEqual(amenityCode("  Wi-Fi Zone ", "", fixed), { code: "wi_fi_zone", auto: false });
  });

  it("without a usable typed code: made from the English name, else random", () => {
    assert.deepEqual(amenityCode("", "Swimming pool", fixed), { code: "swimming_pool", auto: true });
    assert.deepEqual(amenityCode("ที่จอด", "Free parking!", fixed), { code: "free_parking", auto: true });
    assert.deepEqual(amenityCode("", "", fixed), { code: "amenity_abc123", auto: true });
    assert.deepEqual(amenityCode("x", "ห้องน้ำ", fixed), { code: "amenity_abc123", auto: true });
    assert.match(amenityCode("", "").code, /^amenity_[a-z0-9]{6}$/);
  });

  it("stays within 40 characters, also with a clash suffix", () => {
    const long = amenityCode("", "a very long english name for an amenity that goes on", fixed).code;
    assert.ok(long.length <= 40 && /^[a-z0-9_]+$/.test(long) && !long.endsWith("_"), long);
    assert.equal(nextAmenityCode("wifi", 1), "wifi_2");
    assert.equal(nextAmenityCode("wifi", 4), "wifi_5");
    const next = nextAmenityCode(long, 1);
    assert.ok(next.length <= 40 && next.endsWith("_2"), next);
  });
});
