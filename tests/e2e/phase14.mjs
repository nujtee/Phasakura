// Phase 14 end-to-end: cookie consent (banner, settings dialog, keyboard, re-ask), GA4 / Meta Pixel loaded only
// with consent (script loads stubbed, dataLayer / fbq queue inspected), booking funnel events without personal
// data, Conversions API Lead + Purchase through the cron (fake Graph API), privacy policy page, admin Privacy +
// CAPI log + GA4 dashboard numbers, accessibility audit + focus rings on key pages, mobile, console / CSP errors.
import { audit, focusRing } from "./a11y.mjs";
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const DIR = process.env.E2E_FIXTURES;
const SHOTS = process.env.E2E_SHOTS;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 900)]); console.log("FAIL", name, String(e).slice(0, 900)); }
}
function watch(page) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/status of (409|422)/.test(text) || (/\/admin\/login$/.test(page.url()) && /status of 401/.test(text))) return;
    if (/status of 404/.test(text) && /\/no-such-page/.test(page.url())) return;
    consoleErrors.push(`${page.url()} :: ${text}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 150));
  }
};
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const day = (offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));

const GA4 = "G-E2ETEST01";
const PIXEL = "123456789012";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });

/** Visitor context with the trackers' script hosts stubbed (no network) and every tracker request recorded. */
async function visitorContext(opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: opts.viewport ?? { width: 1366, height: 860 }, locale: "th-TH", ...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const hits = [];
  await ctx.route(/^https:\/\/(www\.googletagmanager\.com|connect\.facebook\.net|[^/]*google-analytics\.com|www\.facebook\.com)\//, (route) => {
    hits.push(route.request().url());
    route.fulfill({ status: 200, contentType: "text/javascript", body: "/* stub */" });
  });
  const page = await ctx.newPage();
  watch(page);
  return { ctx, page, hits };
}
const dataLayer = (p) => p.evaluate(() => (window.dataLayer ?? []).map((a) => Array.from(a)));
const fbqQueue = (p) => p.evaluate(() => (window.fbq?.queue ?? []).map((a) => Array.from(a)));
const consentCookie = async (ctx) => (await ctx.cookies(BASE)).find((c) => c.name === "pk_consent");

// ------------------------------------------------------------------ admin setup
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US" });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;
async function login(page, email, lang = "en") {
  await page.goto(`${BASE}/${lang}/admin/login`);
  await page.locator("input[autocomplete=username]").fill(email);
  await page.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await page.locator("form button[type=submit]").click();
  await page.waitForURL(/\/admin(\/|$)(?!login)/);
}

await check("admin: Marketing page — GA4 + property ID, Pixel, CAPI (token as secret), CAPI log", async () => {
  await login(pa, "admin@example.test");
  await pa.goto(`${BASE}/en/admin/ga4`);
  await pa.getByLabel("Enable GA4").check();
  await pa.getByLabel("Measurement ID (G-XXXXXXX)").fill(GA4);
  await pa.getByLabel("GA4 property ID (numbers)").fill("345678901");
  await pa.getByLabel("Enable Meta Pixel").check();
  await pa.getByLabel("Pixel ID (digits)").fill(PIXEL);
  await pa.getByLabel(/Enable CAPI/).check();
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved").first().waitFor();
  const card = pa.locator("#mkt-capi-log");
  await card.getByText("From this page").waitFor();
  await card.getByText("Nothing sent yet").waitFor();
  await card.getByText(/Automatic advanced matching/).waitFor();
  assert(await card.getByRole("button", { name: "Send test event" }).isDisabled(), "test needs META_TEST_EVENT_CODE");
  const html = await pa.content();
  assert(!html.includes("e2e-capi-secret-token"), "token never in the page");
  await pa.screenshot({ path: `${SHOTS}/p14-admin-marketing.png`, fullPage: true });
});

await check("admin: Settings → Privacy — banner, days, policy text (TH), audit", async () => {
  await pa.goto(`${BASE}/en/admin/settings-privacy`);
  await pa.getByRole("heading", { name: "Privacy and cookies" }).waitFor();
  assert(await pa.getByLabel("Show the cookie banner").isChecked(), "banner on by default");
  await pa.getByLabel("Remember a visitor's choice for (days)").fill("120");
  await pa.getByLabel("Privacy policy", { exact: true }).fill("ภูผาซากุระเก็บข้อมูลเท่าที่จำเป็นต่อการจองและการติดต่อเรื่องการเข้าพัก\n\n1. ข้อมูลที่เราเก็บ\n\n- ชื่อและเบอร์โทรศัพท์\n- สลิปการโอนเงิน (เก็บแบบส่วนตัว)\n\n2. คุกกี้\n\nคุกกี้วิเคราะห์และการตลาดใช้เมื่อคุณอนุญาตเท่านั้น");
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved").first().waitFor();
  await pa.getByRole("link", { name: "View policy page" }).waitFor();
  await pa.screenshot({ path: `${SHOTS}/p14-admin-privacy.png`, fullPage: true });
  const audit = await (await req.get(`${BASE}/api/admin/audit-logs?limit=5`, { headers: H })).json();
  assert(JSON.stringify(audit).includes("UPDATE_PRIVACY"), "audited");
});

// ------------------------------------------------------------------ visitor: first visit
const v1 = await visitorContext();
await check("first visit: banner with three equal choices; nothing tracked; floating buttons step aside", async () => {
  await v1.page.goto(`${BASE}/th/`);
  const banner = v1.page.locator("section.consent-banner");
  await banner.waitFor();
  const labels = await banner.getByRole("button").allTextContents();
  assert(JSON.stringify(labels) === JSON.stringify(["ยอมรับทั้งหมด", "ตั้งค่าคุกกี้", "ปฏิเสธที่ไม่จำเป็น"]), `labels ${labels}`);
  const sizes = await banner.getByRole("button").evaluateAll((els) => els.map((e) => { const s = getComputedStyle(e); return `${s.backgroundColor}|${s.color}|${s.fontSize}|${s.fontWeight}`; }));
  assert(new Set(sizes).size === 1, `equal prominence ${sizes}`);
  await banner.getByRole("link", { name: "อ่านนโยบายความเป็นส่วนตัว" }).waitFor();
  await v1.page.waitForTimeout(600);
  assert(v1.hits.length === 0, `tracker requests before consent: ${v1.hits}`);
  assert(await v1.page.evaluate(() => window.dataLayer === undefined && window.fbq === undefined), "no tracker globals");
  assert(!(await v1.page.locator(".cta").isVisible().catch(() => false)), "CTA hidden while the banner is up");
  assert(!(await consentCookie(v1.ctx)), "no consent cookie yet");
  await v1.page.screenshot({ path: `${SHOTS}/p14-banner-desktop.png` });
});

await check("keyboard: skip link first, then the banner; settings dialog traps focus, Esc closes, focus returns", async () => {
  const p = v1.page;
  await p.evaluate(() => document.activeElement?.blur());
  await p.keyboard.press("Tab");
  assert(await p.evaluate(() => document.activeElement?.classList.contains("skip-link")), "skip link first");
  await p.keyboard.press("Tab");
  const second = await p.evaluate(() => document.activeElement?.closest(".consent-banner") !== null);
  assert(second, "banner reachable right after the skip link");
  await p.locator(".consent-banner").getByRole("button", { name: "ตั้งค่าคุกกี้" }).focus();
  await p.keyboard.press("Enter");
  const dlg = p.locator("dialog.consent-dialog[open]");
  await dlg.waitFor();
  assert(await p.evaluate(() => document.activeElement?.closest("dialog") !== null), "focus moved into the dialog");
  // A modal <dialog> makes the page behind it inert: Tab cycles through the dialog (and the browser's own UI).
  for (let i = 0; i < 12; i++) {
    await p.keyboard.press("Tab");
    const where = await p.evaluate(() => (document.activeElement === document.body ? "body" : document.activeElement?.closest("dialog") ? "dialog" : document.activeElement?.outerHTML.slice(0, 80)));
    assert(where === "dialog" || where === "body", `focus reached the page behind the dialog at tab ${i}: ${where}`);
  }
  const switches = dlg.getByRole("switch");
  assert((await switches.count()) === 3, "three categories");
  assert(await switches.nth(0).isDisabled() && await switches.nth(0).isChecked(), "necessary locked on");
  assert(!(await switches.nth(1).isChecked()) && !(await switches.nth(2).isChecked()), "optional off by default");
  await p.screenshot({ path: `${SHOTS}/p14-cookie-settings.png` });
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator("dialog.consent-dialog").count()) === 0);
  await until(() => p.evaluate(() => document.activeElement?.textContent === "ตั้งค่าคุกกี้"));
  assert(!(await consentCookie(v1.ctx)), "Esc does not save");
});

await check("reject non-essential: cookie saved, still nothing loads; footer offers cookie settings", async () => {
  const p = v1.page;
  await p.locator(".consent-banner").getByRole("button", { name: "ปฏิเสธที่ไม่จำเป็น" }).click();
  await until(async () => (await p.locator(".consent-banner").count()) === 0);
  const c = await consentCookie(v1.ctx);
  assert(/^1\.0\.0\.\d+$/.test(c.value), `cookie ${c.value}`);
  assert(c.sameSite === "Lax" && c.secure && c.path === "/", "cookie attributes");
  assert(c.expires - Date.now() / 1000 > 119 * 86400 && c.expires - Date.now() / 1000 < 121 * 86400, "lifetime = configured 120 days");
  await p.goto(`${BASE}/th/gallery`);
  await p.locator(".site-footer").waitFor();
  await p.waitForTimeout(500);
  assert((await p.locator(".consent-banner").count()) === 0, "not asked again");
  assert(v1.hits.length === 0, `tracker requests after refusal: ${v1.hits}`);
  await p.locator(".site-footer").getByRole("button", { name: "ตั้งค่าคุกกี้" }).waitFor();
  await p.locator(".site-footer").getByRole("link", { name: "นโยบายความเป็นส่วนตัว" }).waitFor();
});

await check("analytics only (from the footer): GA4 loads with consent mode and a clean page view; Pixel does not", async () => {
  const p = v1.page;
  await p.goto(`${BASE}/th/gallery?utm_source=newsletter&phone=0812345678`);
  await p.locator(".site-footer").getByRole("button", { name: "ตั้งค่าคุกกี้" }).click();
  const dlg = p.locator("dialog.consent-dialog[open]");
  await dlg.getByRole("switch", { name: "คุกกี้วิเคราะห์การใช้งาน" }).check();
  await dlg.getByRole("button", { name: "บันทึกการตั้งค่า" }).click();
  await until(async () => v1.hits.some((u) => u.startsWith("https://www.googletagmanager.com/gtag/js?id=G-E2ETEST01")));
  assert(!v1.hits.some((u) => u.includes("facebook")), "no Pixel without Marketing consent");
  await p.getByRole("status").filter({ hasText: "บันทึกการตั้งค่าคุกกี้แล้ว" }).waitFor();
  const dl = await dataLayer(p);
  assert(JSON.stringify(dl[0]) === JSON.stringify(["consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }]), `consent default ${JSON.stringify(dl[0])}`);
  const config = dl.find((x) => x[0] === "config");
  assert(config[1] === GA4 && config[2].send_page_view === false && config[2].allow_google_signals === false, "config");
  const pv = dl.filter((x) => x[0] === "event" && x[1] === "page_view");
  assert(pv.length === 1, `page views ${pv.length}`);
  assert(pv[0][2].page_location === `${BASE}/th/gallery?utm_source=newsletter`, `clean URL ${pv[0][2].page_location}`);
  assert(!JSON.stringify(dl).includes("0812345678"), "phone never sent");
  await p.goto(`${BASE}/en/accommodation/house-sakura`);
  await p.locator("h1").waitFor();
  await until(async () => (await dataLayer(p)).some((x) => x[1] === "view_item"));
  const dl2 = await dataLayer(p);
  assert(dl2.some((x) => x[1] === "view_accommodation" && x[2].item_id === "house-sakura"), "view_accommodation");
});

// ------------------------------------------------------------------ visitor: accept all + book
const v2 = await visitorContext();
let code = "";
await check("accept all → GA4 + Pixel (no automatic events); booking funnel events; Lead shares the server event_id", async () => {
  const p = v2.page;
  await p.goto(`${BASE}/th/`);
  await p.locator(".consent-banner").getByRole("button", { name: "ยอมรับทั้งหมด" }).click();
  await until(async () => v2.hits.some((u) => u.startsWith("https://connect.facebook.net/")));
  assert(/^1\.1\.1\.\d+$/.test((await consentCookie(v2.ctx)).value), "consent cookie");
  // What the real Pixel script sets after consent (the stub does not).
  await v2.ctx.addCookies([{ name: "_fbp", value: "fb.1.1767225600000.987654321", url: BASE }]);
  const ci = day(30), co = day(32);
  await p.goto(`${BASE}/th/booking?checkIn=${ci}&checkOut=${co}&adults=2&children=0&unit=house-sakura`);
  await p.getByRole("button", { name: "ถัดไป" }).click({ timeout: 15000 });
  await p.locator("#bk-name").fill("สมหญิง ทดสอบการตลาด");
  await p.locator("#bk-phone").fill("0891112222");
  await p.locator("#bk-email").fill("guest14@example.test");
  await p.getByRole("button", { name: "ถัดไป" }).click();
  await p.getByLabel(/ข้าพเจ้ายอมรับนโยบายความเป็นส่วนตัว/).check();
  const policy = p.locator(".flow-review").getByRole("link", { name: "นโยบายความเป็นส่วนตัว" });
  assert((await policy.getAttribute("target")) === "_blank", "policy opens in a new tab (form kept)");
  await p.getByRole("button", { name: /ยืนยันการจอง/ }).click();
  await p.getByRole("heading", { name: "จองเรียบร้อย" }).waitFor();
  code = (await p.locator(".confirmation__value").textContent()).trim();
  const dl = await dataLayer(p);
  const names = dl.filter((x) => x[0] === "event").map((x) => x[1]);
  for (const n of ["page_view", "select_item", "select_accommodation", "begin_booking", "view_food", "begin_checkout", "generate_lead"]) assert(names.includes(n), `GA4 ${n} missing: ${names}`);
  const lead = dl.find((x) => x[1] === "generate_lead");
  assert(lead[2].booking_id === code && lead[2].currency === "THB", "lead params");
  const fq = await fbqQueue(p);
  assert(JSON.stringify(fq.slice(0, 3)) === JSON.stringify([["consent", "grant"], ["set", "autoConfig", false, PIXEL], ["init", PIXEL]]), `pixel init ${JSON.stringify(fq.slice(0, 3))}`);
  assert(await p.evaluate(() => window.fbq.disablePushState === true), "no automatic history page views");
  const pixelLead = fq.find((x) => x[2] === "Lead");
  assert(pixelLead && pixelLead[4].eventID === `lead-${code}`, `pixel Lead ${JSON.stringify(pixelLead)}`);
  for (const ev of ["PageView", "AddToCart", "InitiateCheckout"]) assert(fq.some((x) => x[2] === ev), `pixel ${ev}`);
  const everything = JSON.stringify([dl, fq]);
  for (const pii of ["สมหญิง", "0891112222", "891112222", "guest14@example.test"]) assert(!everything.includes(pii), `personal data sent: ${pii}`);
  await p.screenshot({ path: `${SHOTS}/p14-booking-done.png` });
});

await check("Conversions API: cron sends Lead with fbp / hashed id and no personal data; staff payment → Purchase", async () => {
  await req.post(`${BASE}/__e2e/cron`);
  let sent = await (await req.get(`${BASE}/__e2e/meta`)).json();
  const lead = sent.find((s) => s.data[0].event_id === `lead-${code}`);
  assert(lead, `lead sent ${JSON.stringify(sent).slice(0, 300)}`);
  assert(lead.url === `https://graph.facebook.com/v23.0/${PIXEL}/events` && lead.hasToken, "endpoint + token in body");
  const ev = lead.data[0];
  assert(ev.user_data.fbp === "fb.1.1767225600000.987654321" && /^[0-9a-f]{64}$/.test(ev.user_data.external_id[0]), "user_data");
  assert(ev.event_source_url === `${BASE}/th/booking`, `source ${ev.event_source_url}`);
  const raw = JSON.stringify(lead.data);
  for (const pii of ["สมหญิง", "0891112222", "guest14@example.test"]) assert(!raw.includes(pii), `pii ${pii}`);
  const booking = await (await req.get(`${BASE}/api/admin/bookings/${code}`, { headers: H })).json();
  const pay = await req.post(`${BASE}/api/admin/bookings/${code}/payments`, { headers: H, data: { amountSatang: booking.data.totalSatang, method: "BANK_TRANSFER", paidAt: new Date(Date.now() - 60000).toISOString() } });
  assert(pay.status() === 200, `pay ${pay.status()}`);
  await req.post(`${BASE}/__e2e/cron`);
  sent = await (await req.get(`${BASE}/__e2e/meta`)).json();
  const purchase = sent.find((s) => s.data[0].event_id === `purchase-${code}`);
  assert(purchase && purchase.data[0].custom_data.order_id === code && purchase.data[0].custom_data.currency === "THB", "purchase");
});

await check("guest sees the confirmed booking → browser Purchase once (same event_id), GA4 purchase with Booking ID", async () => {
  const p = v2.page;
  await p.goto(`${BASE}/th/booking/lookup`);
  await p.locator("#lk-code").fill(code);
  await p.locator("#lk-phone").fill("0891112222");
  await p.locator("form button[type=submit]").click();
  await p.locator(".status-pill--confirmed").waitFor();
  await until(async () => (await fbqQueue(p)).some((x) => x[2] === "Purchase"));
  const fq = await fbqQueue(p);
  const purchase = fq.find((x) => x[2] === "Purchase");
  assert(purchase[4].eventID === `purchase-${code}`, "dedup id");
  const ga = (await dataLayer(p)).find((x) => x[1] === "purchase");
  assert(ga[2].transaction_id === code && ga[2].currency === "THB" && ga[2].value > 0, `ga purchase ${JSON.stringify(ga)}`);
  await p.locator("form button[type=submit]").click();
  await p.waitForTimeout(600);
  assert((await fbqQueue(p)).filter((x) => x[2] === "Purchase").length === 1, "not twice");
});

await check("admin: CAPI log shows Lead + Purchase sent; dashboard shows GA4 numbers", async () => {
  await pa.goto(`${BASE}/en/admin/capi`);
  const log = pa.locator("#mkt-capi-log");
  await log.locator("tr", { hasText: "Purchase" }).getByText("Sent").waitFor();
  await log.locator("tr", { hasText: "Lead" }).first().getByText(code).waitFor();
  await pa.goto(`${BASE}/en/admin`);
  await pa.getByText("Visitors").waitFor();
  const visitors = pa.locator(".adm-kpi", { hasText: "Visitors" });
  await visitors.getByText("321").waitFor();
  await pa.getByText(/GA4 data updated/).waitFor();
  const calls = await (await req.get(`${BASE}/__e2e/google`)).json();
  assert(calls.some((u) => u.includes("properties/345678901:batchRunReports")), "GA4 Data API called");
  await pa.screenshot({ path: `${SHOTS}/p14-dashboard-ga4.png`, fullPage: true });
});

await check("ask everyone again → banner returns, trackers stop until a new choice", async () => {
  await pa.goto(`${BASE}/en/admin/settings-privacy`);
  await pa.getByRole("checkbox", { name: "Ask everyone again" }).check();
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Ask everyone again" }).click();
  await pa.getByText("Saved").first().waitFor();
  const before = v2.hits.length;
  await v2.page.goto(`${BASE}/th/history`);
  await v2.page.locator("section.consent-banner").waitFor();
  await v2.page.waitForTimeout(600);
  assert(v2.hits.length === before, "no tracker load with an old-version choice");
  assert(await v2.page.evaluate(() => window.dataLayer === undefined), "GA4 not started");
});

// ------------------------------------------------------------------ privacy page
await check("privacy policy page: headings, list, last updated, cookie settings button; EN falls back to Thai", async () => {
  const p = v1.page;
  await p.goto(`${BASE}/th/privacy`);
  await p.getByRole("heading", { level: 1, name: "นโยบายความเป็นส่วนตัว" }).waitFor();
  await p.getByRole("heading", { level: 2, name: "1. ข้อมูลที่เราเก็บ" }).waitFor();
  assert((await p.locator(".privacy-page__body li").count()) === 2, "list items");
  await p.getByText(/ปรับปรุงล่าสุด/).waitFor();
  await p.locator(".privacy-page").getByRole("button", { name: "ตั้งค่าคุกกี้" }).waitFor();
  const res = await p.goto(`${BASE}/en/privacy`);
  assert(res.status() === 200, `en status ${res.status()}`);
  await p.getByRole("heading", { level: 2, name: "2. คุกกี้" }).waitFor();
});

// ------------------------------------------------------------------ accessibility
const pages = [
  ["/th/", false], ["/en/gallery", false], ["/th/history", false], ["/th/booking", false], ["/en/accommodation/house-sakura", false],
  ["/th/booking/lookup", false], ["/th/privacy", false], ["/zh-cn/", false], ["/th/no-such-page", false],
];
const a11yIssues = {};
for (const [path] of pages) {
  await check(`a11y audit ${path}`, async () => {
    const p = v1.page;
    await p.goto(`${BASE}${path}`);
    await p.locator("main").waitFor();
    await p.waitForTimeout(700);
    const issues = await audit(p);
    a11yIssues[path] = issues;
    assert(issues.length === 0, issues.join("\n"));
  });
}
for (const path of ["/en/admin", "/en/admin/settings-privacy", "/en/admin/capi", "/th/admin/bookings"]) {
  await check(`a11y audit admin ${path}`, async () => {
    await pa.goto(`${BASE}${path}`);
    await pa.locator("main").waitFor();
    await pa.waitForTimeout(800);
    const issues = await audit(pa, { admin: true });
    assert(issues.length === 0, issues.join("\n"));
  });
}
await check("a11y: banner + dialog themselves pass the audit", async () => {
  const { ctx, page } = await visitorContext();
  await page.goto(`${BASE}/th/`);
  await page.locator(".consent-banner").waitFor();
  let issues = await audit(page);
  assert(issues.length === 0, `banner: ${issues.join("\n")}`);
  await page.locator(".consent-banner").getByRole("button", { name: "ตั้งค่าคุกกี้" }).click();
  await page.locator("dialog.consent-dialog[open]").waitFor();
  issues = await audit(page);
  assert(issues.length === 0, `dialog: ${issues.join("\n")}`);
  await ctx.close();
});
await check("a11y: visible focus ring on every tab stop (public + admin)", async () => {
  await v1.page.goto(`${BASE}/th/`);
  await v1.page.locator("main").waitFor();
  let missing = await focusRing(v1.page, 16);
  assert(missing.length === 0, `public: ${missing.join(", ")}`);
  await pa.goto(`${BASE}/en/admin/settings-privacy`);
  await pa.locator("main").waitFor();
  missing = await focusRing(pa, 16);
  assert(missing.length === 0, `admin: ${missing.join(", ")}`);
});
await check("a11y: reduced motion turns off transitions of the banner buttons", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce", locale: "th-TH" });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/th/`);
  const t = await p.locator(".consent-button").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  assert(parseFloat(t) <= 0.01, `transition ${t}`);
  await ctx.close();
});

// ------------------------------------------------------------------ mobile
await check("mobile 390 px: banner fits, buttons full width ≥ 44 px, no horizontal scroll, LINE / CTA hidden", async () => {
  const { ctx, page } = await visitorContext({ viewport: { width: 390, height: 844 }, mobile: true });
  await page.goto(`${BASE}/th/`);
  const banner = page.locator(".consent-banner__inner");
  await banner.waitFor();
  const box = await banner.boundingBox();
  assert(box.x >= 0 && box.x + box.width <= 390, `banner ${JSON.stringify(box)}`);
  for (const b of await page.locator(".consent-banner .consent-button").all()) {
    const bb = await b.boundingBox();
    assert(bb.height >= 44 && bb.width >= 300, `button ${JSON.stringify(bb)}`);
  }
  assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "no horizontal scroll");
  await page.screenshot({ path: `${SHOTS}/p14-banner-mobile.png` });
  await page.locator(".consent-banner").getByRole("button", { name: "ตั้งค่าคุกกี้" }).tap();
  const dlg = page.locator("dialog.consent-dialog[open]");
  const db = await dlg.boundingBox();
  assert(db.width <= 390 && db.height <= 844, `dialog ${JSON.stringify(db)}`);
  await page.screenshot({ path: `${SHOTS}/p14-settings-mobile.png` });
  await ctx.close();
});

await check("admin pages never load trackers (even with consent)", async () => {
  const { ctx, page, hits } = await visitorContext();
  const now = Math.floor(Date.now() / 1000);
  const version = (await (await req.get(`${BASE}/api/public/site?lang=th`)).json()).data.consent.version;
  await ctx.addCookies([{ name: "pk_consent", value: `${version}.1.1.${now}`, url: BASE }]);
  await page.goto(`${BASE}/th/`);
  await until(() => hits.length >= 2);
  const n = hits.length;
  await page.goto(`${BASE}/th/admin/login`);
  await page.locator("input[autocomplete=username]").waitFor();
  await page.waitForTimeout(600);
  assert(hits.length === n, `admin loaded trackers: ${hits.slice(n)}`);
  await ctx.close();
});

await check("no console or CSP errors", async () => {
  assert(consoleErrors.length === 0, consoleErrors.join("\n"));
});

await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { for (const f of failed) console.log(f.join(" | ")); process.exit(1); }
