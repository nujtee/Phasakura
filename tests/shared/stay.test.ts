import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stayActions } from "../../src/shared/stay.ts";

describe("stayActions (which stay buttons work today)", () => {
  const stay = (status: string, today: string) => stayActions(status, "2027-01-10", "2027-01-12", today);

  it("confirmed: check-in and no-show open on the arrival day; check-in closes on the departure day", () => {
    assert.deepEqual(stay("CONFIRMED", "2027-01-09"), { checkIn: "NOT_YET", noShow: "NOT_YET", checkOut: null });
    assert.deepEqual(stay("CONFIRMED", "2027-01-10"), { checkIn: "OK", noShow: "OK", checkOut: null });
    assert.deepEqual(stay("CONFIRMED", "2027-01-11"), { checkIn: "OK", noShow: "OK", checkOut: null });
    assert.deepEqual(stay("CONFIRMED", "2027-01-12"), { checkIn: "ENDED", noShow: "OK", checkOut: null });
  });

  it("checked in: only check-out, any day; other states: nothing", () => {
    assert.deepEqual(stay("CHECKED_IN", "2027-01-10"), { checkIn: null, noShow: null, checkOut: "OK" });
    assert.deepEqual(stay("CHECKED_IN", "2027-01-15"), { checkIn: null, noShow: null, checkOut: "OK" });
    for (const s of ["PENDING", "CHECKED_OUT", "CANCELLED", "EXPIRED", "NO_SHOW"]) {
      assert.deepEqual(stay(s, "2027-01-10"), { checkIn: null, noShow: null, checkOut: null }, s);
    }
  });
});
