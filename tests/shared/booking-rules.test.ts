import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBaht, parseBahtToSatang } from "../../src/shared/booking-rules.ts";
import { addDays, diffDays, isIsoDate, stayNights, todayIn } from "../../src/shared/dates.ts";

describe("money", () => {
  it("formats whole baht without decimals and partial baht with exactly two", () => {
    assert.equal(formatBaht(350000, "th"), "฿3,500");
    assert.equal(formatBaht(245050, "th"), "฿2,450.50");
    assert.equal(formatBaht(245001, "en"), "฿2,450.01");
    assert.equal(formatBaht(350000, "zh-CN"), "฿3,500");
  });

  it("parses THB input to integer satang without float errors", () => {
    assert.equal(parseBahtToSatang("2,450.50"), 245050);
    assert.equal(parseBahtToSatang("0.1"), 10);
    assert.equal(parseBahtToSatang("19.99"), 1999);
    assert.equal(parseBahtToSatang("฿ 3500"), 350000);
    for (const bad of ["", "-1", "1.234", "abc", "1e3", "12345678"]) assert.equal(parseBahtToSatang(bad), null, bad);
  });
});

describe("stay dates", () => {
  it("counts nights as check_out − check_in; check-out is not a night (§15)", () => {
    assert.deepEqual(stayNights("2027-01-10", "2027-01-13"), ["2027-01-10", "2027-01-11", "2027-01-12"]);
    assert.equal(diffDays("2027-01-10", "2027-01-13"), 3);
    assert.deepEqual(stayNights("2027-12-31", "2028-01-02"), ["2027-12-31", "2028-01-01"]);
    assert.deepEqual(stayNights("2028-02-28", "2028-03-01"), ["2028-02-28", "2028-02-29"], "leap day");
  });

  it("validates ISO dates strictly", () => {
    assert.equal(isIsoDate("2027-02-29"), false);
    assert.equal(isIsoDate("2028-02-29"), true);
    assert.equal(isIsoDate("2027-1-1"), false);
    assert.equal(addDays("2027-01-31", 1), "2027-02-01");
  });

  it("uses the property's time zone for 'today'", () => {
    // 2027-01-09 20:00 UTC is already 2027-01-10 in Bangkok (UTC+7)
    assert.equal(todayIn("Asia/Bangkok", new Date("2027-01-09T20:00:00Z")), "2027-01-10");
    assert.equal(todayIn("UTC", new Date("2027-01-09T20:00:00Z")), "2027-01-09");
  });
});
