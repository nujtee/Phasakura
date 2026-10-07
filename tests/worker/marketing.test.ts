import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import type { PublicSiteDto } from "../../src/shared/api-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { currentConsent, metaBrowserIds, parseConsent, serializeConsent } from "../../src/shared/consent.ts";
import { cleanText, leadEventId, purchaseEventId, sanitizeLocation, toGa4, toPixel, type SiteEvent, type TrackItem } from "../../src/shared/analytics.ts";
import type { DashboardDto } from "../../src/shared/dashboard-types.ts";
import type { MarketingDto, MarketingEventDto, PrivacySettingsDto, PublicPrivacyDto } from "../../src/shared/settings-types.ts";
import type { RateLimitBinding } from "../../src/worker/env.ts";
import { PAGE_SECURITY_HEADERS, pageSecurityHeaders } from "../../src/worker/http/security-headers.ts";
import { resetGa4TokenCache } from "../../src/worker/marketing/ga4-data.ts";
import { rateGroup } from "../../src/worker/security/rate-limit.ts";
import { jsonResponse } from "../helpers/fake-http.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

const SHELL = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const TOKEN = "EAABsecretCapiToken1234567890";
const PIXEL = "123456789012345";
const PHONE = "0812345678";
const NAME = "Somchai Marketing";
const EMAIL = "guest.marketing@example.test";
const FBP = "fb.1.1767225600000.1234567890";
const FBC = "fb.1.1767225600000.IwAR0abcDEF";
const nowSec = (h: Harness) => Math.floor(h.now.getTime() / 1000);
const consentCookie = (h: Harness, analytics: boolean, marketing: boolean, version = 1) =>
  `pk_consent=${serializeConsent({ version, analytics, marketing, at: nowSec(h) })}`;

let seq = 0;
const key = () => `mkt-key-${String(++seq).padStart(10, "0")}`;

let h: Harness;
let root: string;

beforeEach(async () => {
  resetGa4TokenCache();
  h = new Harness({ seed: true });
  h.env.ASSETS = { fetch: async () => new Response(SHELL, { headers: { "Content-Type": "text/html" } }) };
  await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
  root = await h.login("root@example.test");
});

async function staff(perms: string[]) {
  const id = `mkt_staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

async function marketing(body: Partial<MarketingDto> = {}) {
  const r = await h.api<MarketingDto>("PUT", "/api/admin/settings/marketing", {
    token: root,
    body: {
      ga4Enabled: false, ga4MeasurementId: null, ga4PropertyId: null, metaPixelEnabled: false, metaPixelId: null, metaCapiEnabled: false,
      gscVerification: null, ...body,
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
}

async function capiOn() {
  h.env.META_CAPI_ACCESS_TOKEN = TOKEN;
  return marketing({ metaPixelEnabled: true, metaPixelId: PIXEL, metaCapiEnabled: true });
}

let week = 0;
/** Monday → Wednesday, a new week each time (same price: 2 nights × ฿3,500). */
function stayDates() {
  const start = new Date(Date.UTC(2027, 1, 1 + 7 * (week++ % 40)));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { checkIn: iso(start), checkOut: iso(new Date(start.getTime() + 2 * 86_400_000)) };
}

async function book(cookie: string | null, opts: { referer?: string; email?: boolean } = {}) {
  const body = { ...stayDates(), adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (Test) Safari/605" };
  if (cookie) headers.Cookie = cookie;
  if (opts.referer) headers.Referer = opts.referer;
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    headers,
    body: {
      ...body, customer: { name: NAME, phone: PHONE, ...(opts.email ? { email: EMAIL } : {}) }, privacyAccepted: true,
      expectedTotalSatang: q.data.totalSatang, idempotencyKey: key(),
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function pay(b: PublicBookingDto) {
  const r = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, {
    token: root, body: { amountSatang: b.totalSatang, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:00:00Z" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

type EventRow = { id: string; event_name: string; event_id: string; status: string; attempts: number; next_attempt_at: string; last_error: string | null; skip_reason: string | null; booking_id: string | null };
const events = () => h.db.all<EventRow>("SELECT * FROM marketing_events ORDER BY created_at, event_name");
const cron = () => h.app.scheduled(h.env, h.now.getTime());

// =============================================================================== pure building blocks

describe("consent cookie (spec §46)", () => {
  it("serializes / parses strictly; only the current version counts", () => {
    const c = { version: 3, analytics: true, marketing: false, at: 1767225600 };
    assert.equal(serializeConsent(c), "3.1.0.1767225600");
    assert.deepEqual(parseConsent("3.1.0.1767225600"), c);
    for (const bad of ["", "3.1.0", "3.2.0.1", "x.1.0.1", "3.1.0.1;evil", "99999.1.1.1", "3.1.0.1767225600.9"]) assert.equal(parseConsent(bad), null, bad);
    assert.deepEqual(currentConsent("a=b; pk_consent=3.1.1.1767225600; c=d", 3), { version: 3, analytics: true, marketing: true, at: 1767225600 });
    assert.equal(currentConsent("pk_consent=2.1.1.1767225600", 3), null, "an older version is not consent");
    assert.equal(currentConsent(null, 1), null);
  });

  it("reads Meta browser ids only in their documented format", () => {
    assert.deepEqual(metaBrowserIds(`_fbp=${FBP}; _fbc=${FBC}`), { fbp: FBP, fbc: FBC });
    assert.deepEqual(metaBrowserIds("_fbp=<script>; _fbc=fb.1.x.y"), { fbp: null, fbc: null });
    assert.deepEqual(metaBrowserIds(null), { fbp: null, fbc: null });
  });
});

describe("website events → GA4 / Meta Pixel (spec §43–44)", () => {
  const house: TrackItem = { id: "house-1", name: "บ้านริมผา", category: "HOUSE", price: 3500, quantity: 1 };
  const all: SiteEvent[] = [
    { name: "page_view", location: "https://x.test/th/booking/lookup?code=BK-1&phone=0812345678&utm_source=fb", title: "Lookup 081-234-5678", language: "th" },
    { name: "view_accommodation", item: house },
    { name: "search", term: "call me 0812345678 or a@b.co" },
    { name: "select_accommodation", item: house },
    { name: "begin_booking", value: 3500, items: [house] },
    { name: "begin_checkout", value: 7000, items: [house] },
    { name: "view_food" },
    { name: "select_food", item: { id: "dinner", name: "Dinner", category: "FOOD", price: 350 } },
    { name: "add_food", item: { id: "dinner", name: "Dinner", category: "FOOD", price: 350, quantity: 2 } },
    { name: "generate_lead", bookingCode: "BK-20270110-ABCD", value: 7000 },
    { name: "payment_submitted", bookingCode: "BK-20270110-ABCD", value: 7000 },
    { name: "booking_confirmed", bookingCode: "BK-20270110-ABCD", value: 7000, items: [house] },
    { name: "contact", method: "phone" },
  ];

  it("covers every GA4 event of the spec, purchase = Booking ID / total / THB", () => {
    const names = new Set(all.flatMap((e) => toGa4(e).map(([n]) => n)));
    for (const n of ["page_view", "view_item", "search", "select_item", "begin_checkout", "add_payment_info", "purchase", "generate_lead",
      "view_accommodation", "select_accommodation", "begin_booking", "select_food", "payment_submitted", "booking_confirmed", "view_food", "add_food"]) {
      assert.ok(names.has(n), n);
    }
    const purchase = toGa4(all[11]!).find(([n]) => n === "purchase")![1];
    assert.equal(purchase.transaction_id, "BK-20270110-ABCD");
    assert.equal(purchase.value, 7000);
    assert.equal(purchase.currency, "THB");
  });

  it("covers every Pixel event of the spec; Lead / Purchase carry the Conversions API event_id", () => {
    const pixel = all.map(toPixel).filter((p) => p !== null);
    assert.deepEqual([...new Set(pixel.map((p) => p.name))].sort(),
      ["AddPaymentInfo", "AddToCart", "Contact", "InitiateCheckout", "Lead", "PageView", "Purchase", "Search", "ViewContent"]);
    assert.equal(pixel.find((p) => p.name === "Lead")!.eventId, leadEventId("BK-20270110-ABCD"));
    assert.equal(pixel.find((p) => p.name === "Purchase")!.eventId, purchaseEventId("BK-20270110-ABCD"));
    assert.equal(leadEventId("X"), "lead-X");
    assert.equal(purchaseEventId("X"), "purchase-X");
  });

  it("never sends phone numbers, e-mails or query strings (only campaign parameters)", () => {
    const out = JSON.stringify(all.map((e) => [toGa4(e), toPixel(e)]));
    assert.doesNotMatch(out, /0812345678|081-234-5678|a@b\.co|phone=|code=BK/);
    assert.equal(sanitizeLocation("https://x.test/th/booking?phone=0812345678&utm_campaign=summer&gclid=abc#frag"), "https://x.test/th/booking?utm_campaign=summer&gclid=abc");
    assert.equal(sanitizeLocation("not a url"), "");
    assert.equal(cleanText("mail me: someone@example.com, tel +66 81 234 5678"), "mail me: [email], tel [number]");
  });
});

describe("page CSP follows the trackers that are on", () => {
  it("adds only the origins of enabled trackers", () => {
    assert.deepEqual(pageSecurityHeaders({ ga4: false, pixel: false }), PAGE_SECURITY_HEADERS);
    const ga = pageSecurityHeaders({ ga4: true, pixel: false })["Content-Security-Policy"]!;
    assert.match(ga, /script-src 'self' https:\/\/www\.googletagmanager\.com;/);
    assert.match(ga, /connect-src 'self' https:\/\/\*\.google-analytics\.com/);
    assert.doesNotMatch(ga, /facebook/);
    const px = pageSecurityHeaders({ ga4: false, pixel: true })["Content-Security-Policy"]!;
    assert.match(px, /script-src 'self' https:\/\/connect\.facebook\.net;/);
    assert.doesNotMatch(px, /google/);
    for (const csp of [ga, px]) {
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    }
  });

  it("pages get the widened CSP only while a tracker is switched on; admin pages never", async () => {
    let res = await h.get("/th/");
    assert.equal(res.headers.get("Content-Security-Policy"), PAGE_SECURITY_HEADERS["Content-Security-Policy"]);
    await marketing({ ga4Enabled: true, ga4MeasurementId: "G-TEST1234" });
    res = await h.get("/th/gallery");
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /googletagmanager/);
    res = await h.get("/th/admin");
    assert.doesNotMatch(res.headers.get("Content-Security-Policy") ?? "", /googletagmanager/);
  });
});

// =============================================================================== settings + public site

describe("tracking IDs and the cookie banner on the public site", () => {
  const site = async (lang = "th") => (await h.api<PublicSiteDto>("GET", `/api/public/site?lang=${lang}`)).data;

  it("no tracker → no IDs and no banner", async () => {
    const s = await site();
    assert.deepEqual(s.tracking, { ga4MeasurementId: null, metaPixelId: null });
    assert.equal(s.consent.enabled, false);
  });

  it("enabled trackers expose only their public IDs; the banner follows Settings → Privacy", async () => {
    h.env.META_CAPI_ACCESS_TOKEN = TOKEN;
    await marketing({ ga4Enabled: true, ga4MeasurementId: "g-test1234", metaPixelEnabled: true, metaPixelId: PIXEL, metaCapiEnabled: true });
    let s = await site("en");
    assert.deepEqual(s.tracking, { ga4MeasurementId: "G-TEST1234", metaPixelId: PIXEL });
    assert.deepEqual({ ...s.consent }, { enabled: true, version: 1, days: 180, text: null, policyPath: null });
    assert.doesNotMatch(JSON.stringify(s), new RegExp(TOKEN), "the CAPI token never reaches the browser");

    const saved = await h.api<PrivacySettingsDto>("PUT", "/api/admin/settings/privacy", {
      token: root,
      body: { bannerEnabled: true, consentDays: 90, translations: { th: { bannerText: "ข้อความแบนเนอร์", policyTitle: "นโยบาย", policyBody: "ย่อหน้าแรก\n\nย่อหน้าสอง" } } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    s = await site("th");
    assert.deepEqual({ ...s.consent }, { enabled: true, version: 1, days: 90, text: "ข้อความแบนเนอร์", policyPath: "/th/privacy" });
    s = await site("en");
    assert.equal(s.consent.text, null, "no English banner text → the app's standard text");
    assert.equal(s.consent.policyPath, "/en/privacy", "the policy page falls back to Thai");

    await h.api("PUT", "/api/admin/settings/privacy", { token: root, body: { bannerEnabled: false, consentDays: 90 } });
    s = await site("th");
    assert.equal(s.consent.enabled, false);
  });

  it("saving marketing settings validates IDs and is audited without secrets", async () => {
    const bad = await h.api("PUT", "/api/admin/settings/marketing", {
      token: root, body: { ga4Enabled: true, ga4MeasurementId: "UA-1", ga4PropertyId: "abc", metaPixelEnabled: false, metaPixelId: null, metaCapiEnabled: false, gscVerification: null },
    });
    assert.equal(bad.status, 422);
    assert.ok(bad.error?.details?.ga4MeasurementId && bad.error.details.ga4PropertyId);
    const noToken = await h.api("PUT", "/api/admin/settings/marketing", {
      token: root, body: { ga4Enabled: false, ga4MeasurementId: null, metaPixelEnabled: true, metaPixelId: PIXEL, metaCapiEnabled: true, gscVerification: null },
    });
    assert.equal(noToken.status, 422);
    assert.equal(noToken.error?.details?.metaCapiEnabled, "CAPI_TOKEN_MISSING");
    const m = await capiOn();
    assert.equal(m.capiTokenConfigured, true);
    assert.equal(m.capiPixelSource, "SETTINGS");
    h.env.META_PIXEL_ID = "999999999999";
    const again = (await h.api<MarketingDto>("GET", "/api/admin/settings/marketing", { token: root })).data;
    assert.equal(again.capiPixelSource, "SECRET");
    assert.equal(again.capiPixelMismatch, true);
    const audits = JSON.stringify(h.db.all("SELECT * FROM audit_logs WHERE action = 'UPDATE_MARKETING'"));
    assert.doesNotMatch(audits, new RegExp(TOKEN));
    assert.doesNotMatch(JSON.stringify(again), new RegExp(TOKEN));
  });
});

// =============================================================================== privacy settings + policy page

describe("Settings → Privacy (settings.privacy)", () => {
  it("permissions: needs settings.privacy to read or change", async () => {
    const viewer = await staff(["marketing.view"]);
    assert.equal((await h.api("GET", "/api/admin/settings/privacy", { token: viewer })).status, 403);
    assert.equal((await h.api("PUT", "/api/admin/settings/privacy", { token: viewer, body: { bannerEnabled: false } })).status, 403);
    assert.equal((await h.api("GET", "/api/admin/settings/privacy")).status, 401);
    const editor = await staff(["settings.privacy"]);
    assert.equal((await h.api("GET", "/api/admin/settings/privacy", { token: editor })).status, 200);
  });

  it("validates input (days range, languages, unknown fields, sizes)", async () => {
    for (const body of [
      { consentDays: 10 }, { consentDays: 400 }, { consentDays: "90" }, { translations: { fr: { policyBody: "x" } } },
      { translations: { th: { policyBody: "x".repeat(30001) } } }, { translations: { th: { bannerText: "x".repeat(601) } } },
      { translations: { th: { other: "x" } } }, { consentVersion: 7 }, { translations: [] },
    ]) {
      const r = await h.api("PUT", "/api/admin/settings/privacy", { token: root, body: { bannerEnabled: true, ...body } });
      assert.equal(r.status, 422, JSON.stringify(body));
    }
    const v = (await h.api<PrivacySettingsDto>("GET", "/api/admin/settings/privacy", { token: root })).data;
    assert.equal(v.consentVersion, 1, "the version is never set directly");
  });

  it("'ask everyone again' raises the version; audits keep policy length, not text", async () => {
    const policy = "นโยบายลับเฉพาะ ".repeat(50).trim();
    let r = await h.api<PrivacySettingsDto>("PUT", "/api/admin/settings/privacy", { token: root, body: { bannerEnabled: true, consentDays: 180, translations: { th: { policyBody: policy } } } });
    assert.equal(r.data.consentVersion, 1);
    r = await h.api<PrivacySettingsDto>("PUT", "/api/admin/settings/privacy", { token: root, body: { bannerEnabled: true, consentDays: 180, askAgain: true } });
    assert.equal(r.data.consentVersion, 2);
    assert.equal(r.data.translations.th?.policyBody, policy, "texts not sent are kept");
    assert.equal(h.audits("UPDATE_PRIVACY").length, 1);
    assert.equal(h.audits("RENEW_CONSENT").length, 1);
    const audit = JSON.stringify(h.db.all("SELECT old_value, new_value FROM audit_logs WHERE module = 'privacy'"));
    assert.doesNotMatch(audit, /นโยบายลับเฉพาะ/);
    assert.match(audit, new RegExp(`${policy.length} chars`));
    // A cookie for version 1 is no longer consent.
    assert.equal(currentConsent(consentCookie(h, true, true, 1), 2), null);
  });

  it("public policy: language → Thai fallback; page 404 until written; then in the sitemap", async () => {
    let p = (await h.api<PublicPrivacyDto>("GET", "/api/public/privacy?lang=en")).data;
    assert.equal(p.body, null);
    assert.equal((await h.get("/th/privacy")).status, 404);
    await h.api("PUT", "/api/admin/settings/privacy", {
      token: root, body: { translations: { th: { policyTitle: "นโยบายความเป็นส่วนตัวของเรา", policyBody: "เราเก็บข้อมูลเท่าที่จำเป็นสำหรับการจอง\n\n1. ข้อมูลที่เก็บ" } } },
    });
    p = (await h.api<PublicPrivacyDto>("GET", "/api/public/privacy?lang=en")).data;
    assert.equal(p.title, "นโยบายความเป็นส่วนตัวของเรา");
    assert.match(p.body ?? "", /^เราเก็บข้อมูล/);
    const page = await h.get("/en/privacy");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>นโยบายความเป็นส่วนตัวของเรา/);
    assert.match(html, /<meta name="description" content="เราเก็บข้อมูลเท่าที่จำเป็นสำหรับการจอง"/);
    (h.env as { APP_ENV: string }).APP_ENV = "production";
    const sitemap = await (await h.get("/sitemap.xml")).text();
    assert.match(sitemap, /\/th\/privacy<\/loc>/);
    assert.match(sitemap, /\/zh-cn\/privacy<\/loc>/);
    assert.equal((await h.get("/th/privacy/")).status, 301, "canonical: no trailing slash");
  });
});

// =============================================================================== attribution + Conversions API

describe("booking attribution (consent decides what is kept)", () => {
  type Attr = { consent_version: number; analytics_consent: number; marketing_consent: number; fbp: string | null; fbc: string | null; user_agent: string | null; ip_address: string | null; source_url: string | null };
  const attr = (b: PublicBookingDto) => h.db.get<Attr>("SELECT m.* FROM booking_marketing m JOIN bookings b ON b.id = m.booking_id WHERE b.booking_code = ?", b.bookingCode)!;

  it("no choice / analytics only → no browser ids, no IP, no user agent", async () => {
    await capiOn();
    const a = attr(await book(`_fbp=${FBP}`));
    assert.deepEqual([a.consent_version, a.analytics_consent, a.marketing_consent, a.fbp, a.fbc, a.user_agent, a.ip_address], [0, 0, 0, null, null, null, null]);
    const b = attr(await book(`${consentCookie(h, true, false)}; _fbp=${FBP}`));
    assert.deepEqual([b.consent_version, b.analytics_consent, b.marketing_consent, b.fbp, b.ip_address], [1, 1, 0, null, null]);
    assert.equal(events().length, 0, "no Lead without Marketing consent");
  });

  it("Marketing consent → ids kept, same-origin page only, Lead queued in the booking's batch", async () => {
    await capiOn();
    const b = await book(`${consentCookie(h, true, true)}; _fbp=${FBP}; _fbc=${FBC}`, { referer: "https://phasakura.test/th/booking?phone=0812345678" });
    const a = attr(b);
    assert.deepEqual([a.marketing_consent, a.fbp, a.fbc, a.ip_address], [1, FBP, FBC, h.ip]);
    assert.equal(a.user_agent, "Mozilla/5.0 (Test) Safari/605");
    assert.equal(a.source_url, "https://phasakura.test/th/booking", "query string (could hold personal data) dropped");
    const [lead] = events();
    assert.equal(lead!.event_name, "Lead");
    assert.equal(lead!.event_id, `lead-${b.bookingCode}`);
    const other = attr(await book(`${consentCookie(h, true, true)}`, { referer: "https://evil.example/x" }));
    assert.equal(other.source_url, null, "foreign referers are not kept");
  });

  it("consent for an older version (asked again) counts as no consent", async () => {
    await capiOn();
    await h.api("PUT", "/api/admin/settings/privacy", { token: root, body: { askAgain: true } });
    const a = attr(await book(`${consentCookie(h, true, true, 1)}; _fbp=${FBP}`));
    assert.deepEqual([a.marketing_consent, a.fbp], [0, null]);
    assert.equal(events().length, 0);
  });

  it("CAPI off → consent recorded, no events", async () => {
    await marketing({ metaPixelEnabled: true, metaPixelId: PIXEL });
    attr(await book(`${consentCookie(h, true, true)}; _fbp=${FBP}`));
    assert.equal(events().length, 0);
  });
});

describe("Purchase only when the booking is confirmed (spec §45)", () => {
  it("payment recorded by staff → one Purchase event (idempotent)", async () => {
    await capiOn();
    const b = await book(`${consentCookie(h, true, true)}; _fbp=${FBP}`);
    assert.deepEqual(events().map((e) => e.event_name), ["Lead"]);
    await pay(b);
    const purchase = events().find((e) => e.event_name === "Purchase")!;
    assert.equal(purchase.event_id, `purchase-${b.bookingCode}`);
    const cancelled = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: root, body: { reason: "test" } });
    assert.ok([200, 409, 422].includes(cancelled.status));
    assert.equal(events().filter((e) => e.event_name === "Purchase").length, 1);
  });

  it("slip verified automatically → Purchase; without consent → nothing", async () => {
    await capiOn();
    h.verifier({
      provider: "fake",
      verify: async () => ({ kind: "OK", slip: { transactionRef: `T${++seq}`, amountSatang: 700000, transferredAt: "2027-01-10T02:58:00.000Z", senderBank: "KBANK", receiverBank: "DEV", receiverAccountMasked: "xxx-x-x0000-x", receiverProxyMasked: null } }),
    });
    const withConsent = await book(`${consentCookie(h, false, true)}`);
    const r = await h.slip<{ booking: PublicBookingDto }>(withConsent.bookingCode, PHONE, { bytes: pngBytes(640, 900), name: "s.png", type: "image/png" });
    assert.equal(r.data.booking.status, "CONFIRMED");
    assert.ok(events().some((e) => e.event_id === `purchase-${withConsent.bookingCode}`));
    const without = await book(null);
    const r2 = await h.slip<{ booking: PublicBookingDto }>(without.bookingCode, PHONE, { bytes: pngBytes(641, 900), name: "s.png", type: "image/png" });
    assert.equal(r2.data.booking.status, "CONFIRMED");
    assert.equal(events().filter((e) => e.event_id.endsWith(without.bookingCode)).length, 0);
  });

  it("a booking that is never paid never gets a Purchase", async () => {
    await capiOn();
    const b = await book(`${consentCookie(h, true, true)}`);
    h.advance(2 * 60 * 60_000);
    await cron();
    assert.equal(h.db.get<{ s: string }>("SELECT booking_status AS s FROM bookings WHERE booking_code = ?", b.bookingCode)!.s, "EXPIRED");
    assert.deepEqual(events().map((e) => e.event_name), ["Lead"]);
  });
});

describe("Conversions API delivery (cron)", () => {
  it("sends Lead / Purchase with hashed ids and browser ids — never name, phone, e-mail; token only in the body", async () => {
    await capiOn();
    const b = await book(`${consentCookie(h, true, true)}; _fbp=${FBP}; _fbc=${FBC}`, { email: true, referer: "https://phasakura.test/th/booking" });
    await pay(b);
    await cron();
    assert.equal(h.meta.requests.length, 2);
    for (const req of h.meta.requests) {
      assert.equal(req.url, `https://graph.facebook.com/v23.0/${PIXEL}/events`);
      assert.equal(req.method, "POST");
      assert.doesNotMatch(req.url, /access_token/, "token never in the URL");
      assert.equal(req.json!.access_token, TOKEN);
      assert.equal(req.json!.test_event_code, undefined);
      const raw = req.body.replace(TOKEN, "");
      for (const pii of [NAME, "Somchai", PHONE, "812345678", EMAIL]) assert.ok(!raw.includes(pii), `no ${pii}`);
    }
    const [lead, purchase] = h.meta.requests.map((r) => (r.json!.data as Record<string, unknown>[])[0]!);
    assert.equal(lead!.event_name, "Lead");
    assert.equal(lead!.event_id, `lead-${b.bookingCode}`);
    assert.equal(lead!.action_source, "website");
    assert.equal(lead!.event_source_url, "https://phasakura.test/th/booking");
    const user = lead!.user_data as Record<string, unknown>;
    assert.equal(user.fbp, FBP);
    assert.equal(user.fbc, FBC);
    assert.equal(user.client_ip_address, h.ip);
    assert.match((user.external_id as string[])[0]!, /^[0-9a-f]{64}$/, "SHA-256, not the booking id itself");
    assert.equal(purchase!.event_name, "Purchase");
    assert.equal(purchase!.event_id, `purchase-${b.bookingCode}`);
    const custom = purchase!.custom_data as Record<string, unknown>;
    assert.deepEqual([custom.currency, custom.value, custom.order_id], ["THB", b.totalSatang / 100, b.bookingCode]);
    assert.deepEqual(events().map((e) => e.status), ["SENT", "SENT"]);
    // Nothing secret stored or logged.
    const dump = JSON.stringify([h.db.all("SELECT * FROM marketing_events"), h.db.all("SELECT * FROM audit_logs"), h.db.all("SELECT * FROM security_events")]);
    assert.doesNotMatch(dump, new RegExp(TOKEN));
    // A SENT event is final.
    assert.throws(() => h.db.run("UPDATE marketing_events SET status = 'PENDING' WHERE status = 'SENT'"), /MARKETING_EVENT_SENT_FINAL/);
  });

  it("test event code routes every event to Test events", async () => {
    await capiOn();
    h.env.META_TEST_EVENT_CODE = "TEST12345";
    await book(`${consentCookie(h, true, true)}`);
    await cron();
    assert.equal(h.meta.requests[0]!.json!.test_event_code, "TEST12345");
  });

  it("retries 5xx / network with backoff, gives up on 4xx; the token is scrubbed from errors", async () => {
    await capiOn();
    await book(`${consentCookie(h, true, true)}`);
    h.meta.next.push(jsonResponse({ error: { message: "temporarily unavailable", code: 2 } }, 503), "network");
    await cron();
    let [e] = events();
    assert.deepEqual([e!.status, e!.attempts], ["PENDING", 1]);
    assert.match(e!.last_error ?? "", /HTTP 503/);
    await cron();
    assert.equal(events()[0]!.attempts, 1, "not due yet (1 minute backoff)");
    h.advance(61_000);
    await cron();
    [e] = events();
    assert.deepEqual([e!.status, e!.attempts, e!.last_error], ["PENDING", 2, "NETWORK"]);
    h.advance(5 * 60_000 + 1000);
    h.meta.next.push(jsonResponse({ error: { message: `Invalid OAuth access token - Cannot parse access token ${TOKEN}`, code: 190 } }, 400));
    await cron();
    [e] = events();
    assert.equal(e!.status, "FAILED");
    assert.match(e!.last_error ?? "", /code 190/);
    assert.doesNotMatch(e!.last_error ?? "", new RegExp(TOKEN));
    assert.match(e!.last_error ?? "", /\[redacted\]/);
  });

  it("skips: CAPI switched off, token removed, too old; consent withdrawn data is never sent", async () => {
    await capiOn();
    await book(`${consentCookie(h, true, true)}`);
    await marketing({ metaPixelEnabled: true, metaPixelId: PIXEL, metaCapiEnabled: false });
    await cron();
    assert.deepEqual([events()[0]!.status, events()[0]!.skip_reason], ["SKIPPED", "CAPI_DISABLED"]);
    await capiOn();
    await book(`${consentCookie(h, true, true)}`);
    delete h.env.META_CAPI_ACCESS_TOKEN;
    await cron();
    assert.equal(events()[1]!.skip_reason, "TOKEN_MISSING");
    h.env.META_CAPI_ACCESS_TOKEN = TOKEN;
    await book(`${consentCookie(h, true, true)}`);
    h.advance(8 * 24 * 60 * 60_000);
    await cron();
    assert.equal(events()[2]!.skip_reason, "EXPIRED");
    assert.equal(h.meta.requests.length, 0);
  });

  it("retention: browser ids erased after 8 days, delivery log after 90", async () => {
    await capiOn();
    await book(`${consentCookie(h, true, true)}; _fbp=${FBP}`);
    await cron();
    h.now = new Date("2027-01-19T03:07:00.000Z");
    await cron();
    const m = h.db.get<{ fbp: string | null; ip_address: string | null; purged_at: string | null; marketing_consent: number }>("SELECT * FROM booking_marketing")!;
    assert.deepEqual([m.fbp, m.ip_address, m.marketing_consent], [null, null, 1]);
    assert.ok(m.purged_at);
    assert.equal(events().length, 1);
    h.now = new Date("2027-04-15T03:07:00.000Z");
    await cron();
    assert.equal(events().length, 0);
  });
});

describe("admin: delivery log and test event", () => {
  it("permissions: marketing.view lists, marketing.edit sends; audited", async () => {
    await capiOn();
    const viewer = await staff(["marketing.view"]);
    const nobody = await staff(["bookings.view"]);
    assert.equal((await h.api("GET", "/api/admin/marketing/events", { token: nobody })).status, 403);
    assert.equal((await h.api<MarketingEventDto[]>("GET", "/api/admin/marketing/events", { token: viewer })).status, 200);
    assert.equal((await h.api("POST", "/api/admin/marketing/capi-test", { token: viewer, body: {} })).status, 403);

    const noCode = await h.api("POST", "/api/admin/marketing/capi-test", { token: root, body: {} });
    assert.equal(noCode.status, 409);
    assert.equal(noCode.error?.code, "CAPI_TEST_CODE_MISSING");

    h.env.META_TEST_EVENT_CODE = "TEST777";
    const sent = await h.api<MarketingEventDto>("POST", "/api/admin/marketing/capi-test", { token: root, body: {} });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.data.status, "SENT");
    assert.equal(sent.data.isTest, true);
    const req = h.meta.requests.at(-1)!;
    assert.equal(req.json!.test_event_code, "TEST777");
    assert.equal(((req.json!.data as Record<string, unknown>[])[0]!).event_name, "PageView");
    assert.equal(h.audits("SEND_CAPI_TEST").length, 1);
    const list = (await h.api<MarketingEventDto[]>("GET", "/api/admin/marketing/events", { token: viewer })).data;
    assert.equal(list[0]!.id, sent.data.id);
    assert.doesNotMatch(JSON.stringify(list), new RegExp(TOKEN));
  });
});

// =============================================================================== GA4 Data API (dashboard)

async function serviceAccountKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { json: JSON.stringify({ type: "service_account", client_email: "dash@phasakura.iam.gserviceaccount.com", private_key: pem }), publicKey: pair.publicKey, pem };
}

describe("dashboard web analytics from the GA4 Data API", () => {
  it("not connected → GA4 figures are null, D1 figures still shown", async () => {
    const d = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: root })).data;
    assert.equal(d.analytics.ga4.status, "NOT_CONFIGURED");
    assert.equal(d.analytics.visitors, null);
    assert.equal(typeof d.analytics.bookingsCreated, "number");
    assert.equal(h.google.requests.length, 0);
  });

  it("service account JWT → token → batchRunReports; cached; key and token never stored or returned", async () => {
    const k = await serviceAccountKey();
    h.env.GA4_SERVICE_ACCOUNT_KEY = k.json;
    const m = await marketing({ ga4Enabled: true, ga4MeasurementId: "G-TEST1234", ga4PropertyId: "345678901" });
    assert.equal(m.ga4DataKeyConfigured, true);
    const d = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: root })).data;
    assert.equal(d.analytics.ga4.status, "OK");
    assert.deepEqual([d.analytics.visitors, d.analytics.pageViews, d.analytics.accommodationViews, d.analytics.bookingStarted, d.analytics.checkoutStarted],
      [321, 1234, 210, 40, 25]);

    const [tokenReq, report] = h.google.requests;
    assert.equal(tokenReq!.url, "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(tokenReq!.body);
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [hdr, claims, sig] = form.get("assertion")!.split(".");
    const decode = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(decode(hdr!), { alg: "RS256", typ: "JWT" });
    const c = decode(claims!);
    assert.equal(c.iss, "dash@phasakura.iam.gserviceaccount.com");
    assert.equal(c.scope, "https://www.googleapis.com/auth/analytics.readonly");
    assert.equal(c.aud, "https://oauth2.googleapis.com/token");
    assert.equal(Number(c.exp) - Number(c.iat), 3600);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k.publicKey, Buffer.from(sig!, "base64url"), new TextEncoder().encode(`${hdr}.${claims}`));
    assert.ok(valid, "signed with the service account's key");

    assert.equal(report!.url, "https://analyticsdata.googleapis.com/v1beta/properties/345678901:batchRunReports");
    assert.equal(report!.headers.get("Authorization"), "Bearer ya29.fake-access-token");
    const reqs = report!.json!.requests as { dateRanges: { startDate: string; endDate: string }[] }[];
    assert.deepEqual(reqs[0]!.dateRanges, [{ startDate: "2026-12-12", endDate: "2027-01-10" }], "30 days including today");

    // Cached: a second dashboard load does not call Google.
    await h.api("GET", "/api/admin/dashboard", { token: root });
    assert.equal(h.google.requests.length, 2);
    const dump = JSON.stringify([h.db.all("SELECT * FROM analytics_report_cache"), h.db.all("SELECT * FROM audit_logs"), m]);
    assert.doesNotMatch(dump, /PRIVATE KEY|ya29\.|eyJhbGci/);
  });

  it("Google errors: dashboard still loads, error shown to admins, retried after 15 minutes", async () => {
    h.env.GA4_SERVICE_ACCOUNT_KEY = (await serviceAccountKey()).json;
    await marketing({ ga4PropertyId: "345678901" });
    h.google.next.push(jsonResponse({ access_token: "ya29.x", expires_in: 3600 }), jsonResponse({ error: { code: 403, message: "User does not have sufficient permissions for this property.", status: "PERMISSION_DENIED" } }, 403));
    let d = await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: root });
    assert.equal(d.status, 200);
    assert.equal(d.data.analytics.ga4.status, "ERROR");
    assert.equal(d.data.analytics.visitors, null);
    const m = (await h.api<MarketingDto>("GET", "/api/admin/settings/marketing", { token: root })).data;
    assert.match(m.ga4DataError ?? "", /HTTP 403 User does not have sufficient permissions/);
    d = await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: root });
    assert.equal(h.google.requests.length, 2, "backing off");
    h.advance(16 * 60_000);
    d = await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: root });
    assert.equal(d.data.analytics.ga4.status, "OK");
    assert.equal(d.data.analytics.visitors, 321);
  });

  it("a broken key is reported as not configured, never echoed", async () => {
    h.env.GA4_SERVICE_ACCOUNT_KEY = "{not json";
    const m = await marketing({ ga4PropertyId: "345678901" });
    assert.equal(m.ga4DataKeyConfigured, false);
    const d = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: root })).data;
    assert.equal(d.analytics.ga4.status, "NOT_CONFIGURED");
  });
});

// =============================================================================== rate limiting

class FakeLimiter implements RateLimitBinding {
  calls: string[] = [];
  constructor(private readonly allow: number, private readonly fail = false) {}
  async limit({ key }: { key: string }) {
    if (this.fail) throw new Error("limiter down");
    this.calls.push(key);
    return { success: this.calls.filter((k) => k === key).length <= this.allow };
  }
}

describe("request rate limits (Workers Rate Limiting bindings)", () => {
  it("groups requests: auth, admin, public writes, public reads; health / webhook / files are exempt", () => {
    assert.equal(rateGroup("POST", "/api/auth/login"), "AUTH");
    assert.equal(rateGroup("GET", "/api/admin/bookings"), "ADMIN");
    assert.equal(rateGroup("POST", "/api/public/bookings"), "WRITE");
    assert.equal(rateGroup("POST", "/api/search/click"), "WRITE");
    assert.equal(rateGroup("GET", "/api/public/site"), "PUBLIC");
    assert.equal(rateGroup("GET", "/th/booking"), "PUBLIC");
    for (const p of ["/api/health", "/api/line/webhook", "/media/a.webp", "/assets/main.js"]) assert.equal(rateGroup("GET", p), null, p);
  });

  it("over the limit → 429 with Retry-After and one RATE_LIMITED security event per minute", async () => {
    const limiter = new FakeLimiter(2);
    h.env.RL_PUBLIC = limiter;
    for (let i = 0; i < 2; i++) assert.equal((await h.api("GET", "/api/public/site?lang=th")).status, 200);
    const over = await h.api("GET", "/api/public/site?lang=th");
    assert.equal(over.status, 429);
    assert.equal(over.error?.code, "TOO_MANY_REQUESTS");
    assert.equal(over.headers.get("Retry-After"), "60");
    await h.api("GET", "/api/public/site?lang=th");
    assert.equal(h.events("RATE_LIMITED").length, 1, "no log flood");
    assert.match(h.events("RATE_LIMITED")[0]!.details_json ?? "", /"group":"PUBLIC"/);
    assert.ok(limiter.calls.every((k) => k === `PUBLIC:${h.ip}`), "keyed per client IP");
    const page = await h.get("/th/gallery", { "CF-Connecting-IP": h.ip });
    assert.equal(page.status, 429);
    h.ip = "198.51.100.7";
    assert.equal((await h.api("GET", "/api/public/site?lang=th")).status, 200, "other visitors unaffected");
  });

  it("each group has its own binding; a limiter outage fails open", async () => {
    h.env.RL_AUTH = new FakeLimiter(0);
    h.env.RL_PUBLIC = new FakeLimiter(0, true);
    assert.equal((await h.api("POST", "/api/auth/login", { body: { identifier: "x@y.z", password: "nope-nope-nope" } })).status, 429);
    assert.equal((await h.api("GET", "/api/public/site?lang=th")).status, 200);
    assert.equal((await h.api("GET", "/api/health")).status, 200);
  });
});
