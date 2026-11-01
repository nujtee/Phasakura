import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { campaignFromLanding, cleanTag, hasSource, sanitizeCampaign, sourceMedium } from "../../src/shared/campaign.ts";
import type { DashboardDto } from "../../src/shared/dashboard-types.ts";
import { bookingSources } from "../../src/worker/services/dashboard.service.ts";
import { Harness } from "../helpers/harness.ts";

// Where a booking came from (migration 0052, AI Marketing PR A1).

const NOW = "2027-01-10T03:00:00.000Z";

describe("campaign of a landing (pure)", () => {
  it("reads UTM tags, the other site's host and the path; never a query string or a click ID value", () => {
    const c = campaignFromLanding(
      "https://phasakura.com/th/booking?utm_source=Facebook&utm_medium=Paid%20Social&utm_campaign=Songkran%202027&fbclid=IwAR123secret&phone=0812345678",
      "https://l.facebook.com/l.php?u=xyz", NOW);
    assert.deepEqual(c, {
      utmSource: "facebook", utmMedium: "paid social", utmCampaign: "songkran 2027", utmTerm: null, utmContent: null,
      referrerHost: "l.facebook.com", landingPath: "/th/booking", clickKind: "FBCLID", firstSeenAt: NOW,
    });
    assert.doesNotMatch(JSON.stringify(c), /IwAR|0812345678|xyz/);

    const google = campaignFromLanding("https://phasakura.com/?gclid=Cj0KCQ", "https://www.google.co.th/", NOW)!;
    assert.equal(google.clickKind, "GCLID");
    assert.equal(google.referrerHost, "google.co.th");
    assert.deepEqual(sourceMedium(google), { source: "google", medium: "cpc" });
  });

  it("the site's own pages and sub-domains are not a source; a plain landing has no source", () => {
    const own = campaignFromLanding("https://phasakura.com/en/gallery", "https://phasakura.com/th", NOW)!;
    assert.equal(own.referrerHost, null);
    assert.equal(campaignFromLanding("https://phasakura.com/", "https://admin.phasakura.com/x", NOW)!.referrerHost, null);
    assert.equal(hasSource(own), false);
    assert.deepEqual(sourceMedium(own), { source: "(direct)", medium: "(none)" });
    assert.equal(campaignFromLanding("not a url", "", NOW), null);
    assert.equal(campaignFromLanding("https://phasakura.com/", "javascript:alert(1)", NOW)!.referrerHost, null);
  });

  it("names sources like GA4: organic search, social, referral, tagged", () => {
    const sm = (referrerHost: string | null, extra: Partial<Parameters<typeof sourceMedium>[0] & object> = {}) =>
      sourceMedium({ utmSource: null, utmMedium: null, referrerHost, clickKind: "NONE", ...extra });
    assert.deepEqual(sm("google.com"), { source: "google", medium: "organic" });
    assert.deepEqual(sm("bing.com"), { source: "bing", medium: "organic" });
    assert.deepEqual(sm("m.facebook.com"), { source: "facebook", medium: "social" });
    assert.deepEqual(sm("line.me"), { source: "line", medium: "social" });
    assert.deepEqual(sm("pantip.com"), { source: "pantip.com", medium: "referral" });
    assert.deepEqual(sm(null, { clickKind: "FBCLID" }), { source: "facebook", medium: "social" });
    assert.deepEqual(sm("google.com", { utmSource: "newsletter", utmMedium: "email" }), { source: "newsletter", medium: "email" });
    assert.deepEqual(sm(null, { utmSource: "google", clickKind: "GCLID" }), { source: "google", medium: "cpc" });
    assert.deepEqual(sourceMedium(null), { source: "(direct)", medium: "(none)" });
  });

  it("cleans whatever the browser sends and never throws", () => {
    assert.equal(cleanTag("  Hello<script>alert(1)</script>  "), "helloscriptalert(1)/script");
    assert.equal(cleanTag("x".repeat(300))!.length, 100);
    assert.equal(cleanTag(42), null);
    for (const bad of [null, "x", [1], 5, { utmSource: "" }, { landingPath: "//evil.com" }, { referrerHost: "not a host" }]) {
      assert.equal(sanitizeCampaign(bad), null, JSON.stringify(bad));
    }
    const c = sanitizeCampaign({ utmSource: "LINE", landingPath: "/th?x=1#y", clickKind: "OTHER", firstSeenAt: "yesterday", referrerHost: "WWW.Example.COM", extra: 1 })!;
    assert.deepEqual(c, {
      utmSource: "line", utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, referrerHost: "example.com", landingPath: "/th",
      clickKind: "NONE", firstSeenAt: null,
    });
  });
});

let keySeq = 0;
async function book(h: Harness, attribution?: unknown, checkIn = "2027-02-01", checkOut = "2027-02-03") {
  const stay = { checkIn, checkOut, adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "en" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: stay });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  return h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: {
      ...stay,
      customer: { name: "Somchai Guest", phone: "081-234-5678" },
      privacyAccepted: true,
      expectedTotalSatang: q.data.totalSatang,
      idempotencyKey: `attr-key-${String(++keySeq).padStart(8, "0")}`,
      ...(attribution === undefined ? {} : { attribution }),
    },
  });
}

const rowOf = (h: Harness, code: string) => h.db.get<Record<string, unknown>>(
  "SELECT a.* FROM booking_attribution a JOIN bookings b ON b.id = a.booking_id WHERE b.booking_code = ?", code);

describe("source stored with the booking", () => {
  it("keeps the cleaned source; garbage or nothing never fails the booking", async () => {
    const h = new Harness({ seed: true });
    const tagged = await book(h, {
      utmSource: "Facebook", utmMedium: "cpc", utmCampaign: "Rainy Season", referrerHost: "l.facebook.com", landingPath: "/th/booking?fbclid=abc",
      clickKind: "FBCLID", firstSeenAt: "2027-01-10T02:55:00.000Z",
    });
    assert.equal(tagged.status, 201, JSON.stringify(tagged.body));
    const row = rowOf(h, tagged.data.bookingCode)!;
    assert.deepEqual({ ...row, booking_id: undefined, created_at: undefined }, {
      booking_id: undefined, utm_source: "facebook", utm_medium: "cpc", utm_campaign: "rainy season", utm_term: null, utm_content: null,
      referrer_host: "l.facebook.com", landing_path: "/th/booking", click_kind: "FBCLID", first_seen_at: "2027-01-10T02:55:00.000Z", created_at: undefined,
    });

    const junk = await book(h, { utmSource: { $gt: "" }, landingPath: 12, clickKind: "<x>" }, "2027-02-05", "2027-02-06");
    assert.equal(junk.status, 201, JSON.stringify(junk.body));
    assert.equal(rowOf(h, junk.data.bookingCode), undefined, "nothing usable → no row");

    const none = await book(h, undefined, "2027-02-07", "2027-02-08");
    assert.equal(none.status, 201);
    assert.equal(rowOf(h, none.data.bookingCode), undefined);

    const notObject = await book(h, "utm_source=x", "2027-02-09", "2027-02-10");
    assert.equal(notObject.status, 201, "a string is ignored, not a validation error");
  });

  it("a booking still succeeds while the table is missing (code deployed before migration 0052)", async () => {
    const h = new Harness({ seed: true });
    h.db.exec("DROP TABLE booking_attribution");
    const res = await book(h, { utmSource: "google", utmMedium: "cpc" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const root = await h.login(await h.user({ id: "root_attr", roles: ["SUPER_ADMIN"] }));
    const d = await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: root });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.data.analytics.bookingSources, []);
  });

  it("dashboard: bookings of the last 30 days by source / medium; money only with permission", async () => {
    const h = new Harness({ seed: true });
    await book(h, { utmSource: "facebook", utmMedium: "cpc", utmCampaign: "a" });
    await book(h, { utmSource: "facebook", utmMedium: "cpc", utmCampaign: "b" }, "2027-02-05", "2027-02-06");
    await book(h, { referrerHost: "google.com", landingPath: "/" }, "2027-02-07", "2027-02-08");
    await book(h, undefined, "2027-02-09", "2027-02-10");

    const root = await h.login(await h.user({ id: "root_src", roles: ["SUPER_ADMIN"] }));
    const d = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: root })).data;
    assert.deepEqual(d.analytics.bookingSources, [
      { source: "facebook", medium: "cpc", bookings: 2, confirmed: 0, revenueSatang: 0 },
      { source: "(direct)", medium: "(none)", bookings: 1, confirmed: 0, revenueSatang: 0 },
      { source: "google", medium: "organic", bookings: 1, confirmed: 0, revenueSatang: 0 },
    ]);
    assert.equal(d.analytics.channels, null, "GA4 not connected");

    const viewer = await h.user({ id: "dash_only" });
    h.grant("dash_only", "dashboard.view");
    const dv = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: await h.login(viewer) })).data;
    assert.ok(dv.analytics.bookingSources.every((r) => r.revenueSatang === null));
    assert.equal(dv.analytics.bookingSources.length, 3);
  });

  it("rows past ten are summed as (other)", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      utm_source: `s${String(i).padStart(2, "0")}`, utm_medium: "cpc", referrer_host: null, click_kind: "NONE" as const,
      bookings: 20 - i, confirmed: 1, revenue: 100,
    }));
    const out = bookingSources(rows, true);
    assert.equal(out.length, 11);
    assert.deepEqual(out[10], { source: "(other)", medium: "", bookings: 10 + 9, confirmed: 2, revenueSatang: 200 });
  });
});
