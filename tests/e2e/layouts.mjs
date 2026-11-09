// Theme layouts (migration 0061): Settings → Theme → site layout → draft → publish, then the public home page in
// that layout on a desktop and a phone (date bar → booking page with the dates, the trust strip, the header button,
// no sideways scrolling, fonts served by the site itself, no console / CSP errors).
import { readFileSync } from "node:fs";
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:8443";
const SHOTS = process.env.E2E_SHOTS;
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 1500)]); console.log("FAIL", name, String(e).slice(0, 1500)); }
}
function watch(page) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/\/admin\/login$/.test(page.url()) && /status of 401/.test(m.text())) return;
    consoleErrors.push(`${page.url()} :: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });

const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US" });
const pa = await admin.newPage(); watch(pa);

await check("admin login", async () => {
  await pa.goto(`${BASE}/en/admin/login`);
  await pa.getByLabel("Email or username").fill("admin@example.test");
  await pa.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await pa.getByRole("button", { name: "Sign in" }).click();
  await pa.waitForURL(`${BASE}/en/admin`);
});

await check("before: the public site is CLASSIC (nothing changes until an admin publishes)", async () => {
  const site = await (await admin.request.get(`${BASE}/api/public/site?lang=en`)).json();
  assert(site.data.layout === "CLASSIC", `layout ${site.data.layout}`);
});

const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const req = admin.request;
const api = async (method, path, data) => {
  const res = await req.fetch(`${BASE}${path}`, { method, headers: H, data });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${JSON.stringify(body)}`);
  return body.data;
};

await check("a published home slide (so the hero is drawn)", async () => {
  const res = await req.post(`${BASE}/api/admin/media`, { headers: H, multipart: { file: { name: "hero-b.png", mimeType: "image/png", buffer: readFileSync(`${process.env.E2E_FIXTURES}/hero-b.png`) }, purpose: "HOME_SLIDE" } });
  assert(res.status() === 201, await res.text());
  const asset = (await res.json()).data;
  const slide = await api("POST", "/api/admin/cms/homeSlide", {
    desktopAssetId: asset.id, contentPosition: "CENTER", overlayOpacity: 30, button1Url: "/th/booking",
    translations: { th: { title: "ตื่นมาใต้ร่มซากุระ", subtitle: "ขุนวาง เชียงใหม่", description: "บ้านพักและลานกางเต็นท์ท่ามกลางขุนเขา", button1Label: "ดูห้องว่าง" } },
  });
  await api("POST", `/api/admin/cms/homeSlide/${slide.id}/publish`);
});

const visitor = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "th-TH" });
const pv = await visitor.newPage(); watch(pv);
const fonts = [];
pv.on("response", (r) => { if (/\.woff2(\?|$)/.test(r.url())) fonts.push([r.url(), r.status()]); });
const phone = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "th-TH" });
const pm = await phone.newPage(); watch(pm);

for (const [layout, name] of [["EDITORIAL", "A · Sakura Editorial"], ["BOUTIQUE", "B · Boutique Minimal"], ["NIGHT", "C · Mountain Night"]]) {
  const slug = layout.toLowerCase();
  await check(`Theme → ${name}: applies its colours, saves the draft, publishes`, async () => {
    await pa.goto(`${BASE}/en/admin/settings-theme`);
    await pa.getByRole("heading", { name: "Site layout" }).waitFor();
    const pick = pa.getByRole("button", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await pick.click();
    await pa.getByText("This layout's colours and fonts are applied").waitFor();
    assert((await pick.getAttribute("aria-pressed")) === "true", "not pressed");
    await pa.getByRole("button", { name: "Save draft" }).click();
    await pa.getByText("Saved").first().waitFor();
    await pa.screenshot({ path: `${SHOTS}/l-admin-theme-${slug}.png`, fullPage: false });
    await pa.getByRole("button", { name: "Publish theme" }).click();
    await pa.locator("dialog[open]").getByRole("button", { name: "Publish theme" }).click();
    await pa.getByText("Published").first().waitFor();
    const site = await (await admin.request.get(`${BASE}/api/public/site?lang=en`)).json();
    assert(site.data.layout === layout, `layout ${site.data.layout}`);
  });

  await check(`${name} · desktop: header button, hero, date bar, trust strip, fonts from the site, no sideways scroll`, async () => {
    fonts.length = 0;
    await pv.goto(`${BASE}/th/`);
    await pv.locator(".layout-bookbar").waitFor();
    await pv.locator(".hero__media img").first().waitFor();
    assert((await pv.evaluate(() => document.documentElement.dataset.layout)) === layout, "data-layout");
    assert(await pv.locator(".header-book").isVisible(), "header button hidden at 1440");
    assert(await pv.locator(".layout-trust li").count() >= 3, "trust strip");
    await pv.evaluate(() => document.fonts.ready);
    await pv.waitForTimeout(700);
    assert(fonts.length > 0 && fonts.every(([u, s]) => s === 200 && u.startsWith(BASE)), `fonts ${JSON.stringify(fonts)}`);
    const overflow = await pv.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 0, `sideways scroll ${overflow}px`);
    // The hero's words stay readable: never hidden behind the date bar.
    const title = await pv.locator(".hero__slide.is-active .hero__title").boundingBox();
    const bar = await pv.locator(".layout-bookbar").boundingBox();
    assert(title && bar && title.y + title.height <= bar.y, `title ${JSON.stringify(title)} bar ${JSON.stringify(bar)}`);
    await pv.screenshot({ path: `${SHOTS}/l-${slug}-desktop.png`, fullPage: true });
  });

  await check(`${name} · date bar → booking page with those dates`, async () => {
    await pv.goto(`${BASE}/th/`);
    const checkIn = await pv.locator(".layout-bookbar input[type=date]").first().inputValue();
    await pv.locator(".layout-bookbar__submit").click();
    await pv.waitForURL(/\/th\/booking\?checkIn=/);
    assert(new URL(pv.url()).searchParams.get("checkIn") === checkIn, pv.url());
  });

  await check(`${name} · phone: fits (no sideways scroll; the header button is left to the floating one)`, async () => {
    await pm.goto(`${BASE}/th/`);
    await pm.locator(".layout-bookbar").waitFor();
    await pm.locator(".hero__media img").first().waitFor();
    assert(!(await pm.locator(".header-book").isVisible()), "header button visible on a phone");
    const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 0, `sideways scroll ${overflow}px`);
    await pm.waitForTimeout(400);
    await pm.screenshot({ path: `${SHOTS}/l-${slug}-phone.png`, fullPage: true });
  });
}

await check("Theme → D · Stay List: publishes", async () => {
  await pa.goto(`${BASE}/en/admin/settings-theme`);
  await pa.getByRole("heading", { name: "Site layout" }).waitFor();
  const pick = pa.getByRole("button", { name: /D · Stay List/ });
  await pick.click();
  await pa.getByText("This layout's colours and fonts are applied").waitFor();
  await pa.getByRole("button", { name: "Save draft" }).click();
  await pa.getByText("Saved").first().waitFor();
  await pa.getByRole("button", { name: "Publish theme" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Publish theme" }).click();
  await pa.getByText("Published").first().waitFor();
  const site = await (await admin.request.get(`${BASE}/api/public/site?lang=en`)).json();
  assert(site.data.layout === "LIST", `layout ${site.data.layout}`);
});

await check("D · desktop: the home page lists what is free with prices; filters; sorting; new dates search again", async () => {
  await pv.goto(`${BASE}/th/`);
  await pv.locator(".stay-row:not(.skeleton)").first().waitFor();
  assert((await pv.evaluate(() => document.documentElement.dataset.layout)) === "LIST", "data-layout");
  assert(await pv.locator(".hero").count() === 0, "no hero on the list layout");
  const all = await pv.locator(".stay-row").count();
  assert(all >= 2, `rows ${all}`);
  assert(/฿/.test(await pv.locator(".stay-row__total").first().innerText()), "price");
  await pv.locator(".stay-list__chip").nth(1).click();
  assert(await pv.locator(".stay-row").count() < all, "filter did nothing");
  await pv.locator(".stay-list__chip").first().click();
  await pv.locator(".stay-list__sort select").selectOption("PRICE");
  const totals = (await pv.locator(".stay-row:not(.is-full) .stay-row__total").allInnerTexts()).map((x) => Number(x.replace(/[^0-9]/g, "")));
  assert(totals.every((v, i) => i === 0 || totals[i - 1] <= v), `not sorted ${totals}`);
  const overflow = await pv.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `sideways scroll ${overflow}px`);
  await pv.screenshot({ path: `${SHOTS}/l-list-desktop.png`, fullPage: true });
  // Two nights: prices are for two nights.
  const inField = pv.locator(".stay-list__field input[type=date]").first();
  const checkIn = await inField.inputValue();
  const out = new Date(Date.parse(`${checkIn}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
  await pv.locator(".stay-list__field input[type=date]").nth(1).fill(out);
  await pv.locator(".stay-list__go").click();
  await pv.getByText(/ราคาสำหรับ 2 คืน/).first().waitFor();
});

await check("D · choose a house → booking page with that house and the dates", async () => {
  // "ดูรายละเอียด" on each house / tent row, to its own page.
  await pv.locator(".stay-list .stay-row__details").first().waitFor();
  assert(/^\/th\/accommodation\/[^/]+$/.test((await pv.locator(".stay-list .stay-row__details").first().getAttribute("href")) ?? ""), "details href");
  const link = pv.locator(".stay-row__pick").first();
  const href = await link.getAttribute("href");
  await link.click();
  await pv.waitForURL(/\/th\/booking\?/);
  const u = new URL(pv.url());
  assert(u.searchParams.get("checkIn") && u.searchParams.get("adults") === "2", pv.url());
  assert(href && (u.searchParams.get("unit") || u.hash === "#sec-camping"), `href ${href}`);
});

await check("D · phone: the search folds into a summary; rows fit", async () => {
  await pm.goto(`${BASE}/th/`);
  await pm.locator(".stay-row:not(.skeleton)").first().waitFor();
  assert(await pm.locator(".stay-list__summary").isVisible(), "summary");
  assert(!(await pm.locator(".stay-list__go").isVisible()), "fields open on a phone");
  await pm.locator(".stay-list__summary").click();
  assert(await pm.locator(".stay-list__go").isVisible(), "fields do not open");
  const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `sideways scroll ${overflow}px`);
  await pm.locator(".stay-list__summary").click();
  await pm.waitForTimeout(300);
  await pm.screenshot({ path: `${SHOTS}/l-list-phone.png`, fullPage: true });
});

await check("Theme → booking page: hotel-search list → published", async () => {
  await pa.goto(`${BASE}/en/admin/settings-theme`);
  await pa.getByRole("heading", { name: "Booking page" }).waitFor();
  const pick = pa.getByRole("button", { name: /Hotel-search list/ });
  await pick.click();
  assert((await pick.getAttribute("aria-pressed")) === "true", "not pressed");
  await pa.getByRole("button", { name: "Save draft" }).click();
  await pa.getByText("Saved").first().waitFor();
  await pa.getByRole("button", { name: "Publish theme" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Publish theme" }).click();
  await pa.getByText("Published").first().waitFor();
  const site = await (await admin.request.get(`${BASE}/api/public/site?lang=en`)).json();
  assert(site.data.bookingLayout === "LIST" && site.data.layout === "LIST", JSON.stringify([site.data.layout, site.data.bookingLayout]));
});

await check("booking page · list: rows with prices for the dates, type filter, price order, pick a house", async () => {
  await pv.goto(`${BASE}/th/booking`);
  await pv.locator(".booking-list .stay-row").first().waitFor();
  const all = await pv.locator(".booking-list .stay-row").count();
  assert(all >= 2, `rows ${all}`);
  assert(await pv.locator(".unit-grid .unit-card").count() === 0, "cards still drawn");
  // Every row links to the house's own page ("ดูรายละเอียด"), as the cards do.
  assert(await pv.locator(".booking-list .stay-row__details").count() === all, "details link on every row");
  const href = await pv.locator(".booking-list .stay-row__details").first().getAttribute("href");
  assert(/^\/th\/accommodation\/[^/]+$/.test(href ?? ""), `details link ${href}`);
  // Search dates (the existing search box) → prices for those nights, free ones first.
  await pv.locator(".stay-search button[type=submit]").click();
  await pv.locator(".booking-list .stay-list__found").waitFor();
  await pv.locator(".booking-list .stay-row__for").filter({ hasText: /ราคาสำหรับ \d+ คืน/ }).first().waitFor();
  await pv.locator(".booking-list .stay-list__chip").nth(1).click();
  assert(await pv.locator(".booking-list .stay-row").count() < all, "filter did nothing");
  assert(await pv.locator("#sec-camping").count() === 0, "camping shown under a house filter");
  await pv.locator(".booking-list .stay-list__chip").first().click();
  await pv.locator(".booking-list .stay-list__sort select").selectOption("PRICE");
  const totals = (await pv.locator(".booking-list .stay-row:not(.is-full) .stay-row__total").allInnerTexts()).map((x) => Number(x.replace(/[^0-9]/g, "")));
  assert(totals.every((v, i) => i === 0 || totals[i - 1] <= v), `not sorted ${totals}`);
  const overflow = await pv.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `sideways scroll ${overflow}px`);
  await pv.screenshot({ path: `${SHOTS}/l-booking-list-desktop.png`, fullPage: true });
  await pv.locator(".booking-list .stay-row:not(.is-full) .unit-pick__btn").first().click();
  await pv.locator(".booking-list .stay-row.is-picked").first().waitFor();
  await pv.locator("#picks").waitFor();
});

await check("booking page → ดูรายละเอียด: the house page checks the searched dates itself; เลือกที่พักนี้ at once", async () => {
  await pv.goto(`${BASE}/th/booking`);
  await pv.locator(".booking-list .stay-row").first().waitFor();
  // Other dates than the page starts with, so "kept" means kept.
  const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const checkIn = iso(20);
  await pv.locator(".stay-search input[type=date]").nth(0).fill(checkIn);
  await pv.locator(".stay-search input[type=date]").nth(1).fill(iso(21));
  await pv.locator(".stay-search button[type=submit]").click();
  await pv.locator(".booking-list .stay-list__found").waitFor();
  const row = pv.locator(".booking-list .stay-row:not(.is-full)").first();
  const rowPrice = (await row.locator(".stay-row__total").innerText()).replace(/[^0-9]/g, "");
  await row.locator(".stay-row__details").click();
  await pv.waitForURL(/\/th\/accommodation\//);
  const book = pv.locator(".detail__book");
  await book.waitFor({ timeout: 10000 });
  // The price at the top is the one of those dates (one night here), as in the list, not the usual price.
  await pv.locator(".detail__aside .unit-card__price-block").waitFor();
  const top = (await pv.locator(".detail__aside .unit-card__price strong").first().innerText()).replace(/[^0-9]/g, "");
  assert(top === rowPrice, `house page ${top} vs list ${rowPrice}`);
  assert(await pv.locator(".detail__aside .unit-card__price").count() === 1, "price shown twice");
  const href = await book.getAttribute("href");
  assert(href?.includes(`checkIn=${checkIn}`), `same dates: ${href} / ${checkIn}`);
  // Only check-in / check-out are shown, no second search box; "เปลี่ยนวันที่" brings it back.
  await pv.locator(".detail-dates").waitFor();
  assert(await pv.locator(".detail__aside .stay-search").count() === 0, "search box shown again");
  await pv.locator(".detail__aside").screenshot({ path: `${SHOTS}/l-detail-dates.png` });
  await pv.getByRole("button", { name: "เปลี่ยนวันที่" }).click();
  await pv.locator(".detail__aside .stay-search").waitFor();
  assert(await pv.locator(".detail__aside .stay-search input[type=date]").first().inputValue() === checkIn, "the form keeps the dates");
  // "กลับไปหน้าจองที่พัก": the booking page shows those dates again, already searched.
  await pv.getByRole("link", { name: /กลับไปหน้าจองที่พัก/ }).click();
  await pv.waitForURL(/\/th\/booking$/);
  await pv.locator(".booking-list .stay-list__found").waitFor();
  assert(await pv.locator(".stay-search input[type=date]").first().inputValue() === checkIn, "booking page keeps the dates");
  assert(/[?&]unit=/.test(href ?? ""), `the house goes along: ${href}`);
});

await check("house page opened without a search on the booking page: the date check as before", async () => {
  const fresh = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: "th-TH" });
  const p = await fresh.newPage();
  await p.goto(`${BASE}/th/booking`);
  await p.locator(".booking-list .stay-row__details").first().click();
  await p.waitForURL(/\/th\/accommodation\//);
  await p.locator(".detail__aside .stay-search").waitFor();
  assert(await p.locator(".detail-dates").count() === 0, "dates summary without a search");
  assert(await p.locator(".detail__book").count() === 0, "book button before a check");
  await fresh.close();
});

await check("booking page · list on a phone: fits", async () => {
  await pm.goto(`${BASE}/th/booking`);
  await pm.locator(".booking-list .stay-row").first().waitFor();
  const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `sideways scroll ${overflow}px`);
  await pm.screenshot({ path: `${SHOTS}/l-booking-list-phone.png`, fullPage: true });
});

await check("rollback to the classic version: the site is as before", async () => {
  await pa.goto(`${BASE}/en/admin/settings-theme`);
  await pa.getByRole("button", { name: "Restore" }).last().click();
  await pa.locator("dialog[open]").getByRole("button").filter({ hasText: /Restore/ }).click();
  await pa.getByText("Published").first().waitFor();
  await pv.goto(`${BASE}/th/`);
  await pv.locator(".site-header").waitFor();
  await pv.waitForTimeout(500);
  assert((await pv.evaluate(() => document.documentElement.dataset.layout)) === "CLASSIC", "still the layout");
  assert(await pv.locator(".layout-bookbar").count() === 0, "date bar on CLASSIC");
});

await check("no console / CSP errors", async () => {
  assert(consoleErrors.length === 0, consoleErrors.join("\n"));
});

await browser.close();
const passed = results.filter((r) => r[0] === "PASS").length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
