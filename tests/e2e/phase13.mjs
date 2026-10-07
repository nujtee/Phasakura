// Phase 13 end-to-end: server-rendered metadata, 404 / redirects, robots + sitemap, client head updates on
// navigation and language switch, global search (words in 3 languages, dates → live availability), admin SEO
// cards (translation coverage, site search), mobile layout, console / CSP errors.
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const DIR = process.env.E2E_FIXTURES;
const SHOTS = process.env.E2E_SHOTS;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 700)]); console.log("FAIL", name, String(e).slice(0, 700)); }
}
function watch(page) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/status of (409|422)/.test(text) || (/\/admin\/login$/.test(page.url()) && /status of 401/.test(text))) return;
    // The 404 page itself is expected to answer 404.
    if (/status of 404/.test(text) && /\/th\/no-such-page/.test(page.url())) return;
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US" });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;
const visitor = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 860 }, locale: "th-TH" });
const pv = await visitor.newPage(); watch(pv);
const anon = visitor.request;

const raw = async (path, headers = {}) => {
  const res = await anon.get(`${BASE}${path}`, { headers, maxRedirects: 0 });
  return { status: res.status(), headers: res.headers(), text: await res.text() };
};
const tag = (html, re) => re.exec(html)?.[1] ?? null;

// ------------------------------------------------------------------ what crawlers get (no JavaScript)
await check("server HTML: lang, title, description, canonical, hreflang, OG, JSON-LD on the first response", async () => {
  const r = await raw("/th/");
  assert(r.status === 200, `status ${r.status}`);
  assert(tag(r.text, /<html lang="([^"]+)"/) === "th", "lang");
  assert(tag(r.text, /<title>([^<]+)<\/title>/) === "Phasakura (ตัวอย่าง)", `title ${tag(r.text, /<title>([^<]+)<\/title>/)}`);
  assert(/<meta name="description" content="คำอธิบายตัวอย่าง"/.test(r.text), "description");
  assert(r.text.includes(`<link rel="canonical" href="${BASE}/th/"`), "canonical");
  for (const [h, p] of [["th", "/th/"], ["en", "/en/"], ["zh-Hans", "/zh-cn/"], ["x-default", "/th/"]]) {
    assert(r.text.includes(`hreflang="${h}" href="${BASE}${p}"`), `hreflang ${h}`);
  }
  assert(/property="og:locale" content="th_TH"/.test(r.text), "og:locale");
  const ld = [...r.text.matchAll(/<script type="application\/ld\+json" data-seo>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert(ld[0]["@graph"].some((g) => g["@type"] === "LodgingBusiness"), "LodgingBusiness");
  assert(r.headers["x-robots-tag"] === "noindex, nofollow", "dev server is noindex");
  assert(/default-src 'self'/.test(r.headers["content-security-policy"]), "CSP on pages");
  const unit = await raw("/en/accommodation/house-sakura");
  const acc = [...unit.text.matchAll(/<script type="application\/ld\+json" data-seo>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert(acc.some((d) => d["@type"] === "Accommodation" && d.occupancy.maxValue === 4), "Accommodation JSON-LD");
  assert(/<title>House 01/.test(unit.text), "unit title");
});

await check("404s, canonical redirects, language entry redirect, private pages", async () => {
  assert((await raw("/th/no-such-page")).status === 404, "unknown page 404");
  assert((await raw("/th/accommodation/nope")).status === 404, "unknown unit 404");
  assert((await raw("/wp-login.php")).status === 404, "file path 404");
  const upper = await raw("/EN/gallery");
  assert(upper.status === 301 && upper.headers.location === "/en/gallery", `upper ${upper.status} ${upper.headers.location}`);
  const root = await raw("/", { "Accept-Language": "zh-CN,zh;q=0.9" });
  assert(root.status === 302 && root.headers.location === "/zh-cn/", `root ${root.headers.location}`);
  const lookup = await raw("/th/booking/lookup");
  assert(!/rel="canonical"/.test(lookup.text) && /content="noindex, nofollow"/.test(lookup.text), "lookup noindex");
  const adminPage = await raw("/en/admin/bookings");
  assert(adminPage.headers["cache-control"] === "no-store" && !/property="og:/.test(adminPage.text), "admin shell");
});

await check("robots.txt and sitemap.xml", async () => {
  const robots = await raw("/robots.txt");
  assert(robots.status === 200 && /^Disallow: \/$/m.test(robots.text), "dev robots blocks everything");
  const sm = await raw("/sitemap.xml");
  assert(sm.status === 200 && /application\/xml/.test(sm.headers["content-type"]), "sitemap type");
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert(locs.length === 4 * 3 + 5 * 3, `urls ${locs.length}`);
  assert(locs.includes(`${BASE}/zh-cn/accommodation/vip-02`), "unit page listed");
  assert(!locs.some((l) => /admin|lookup/.test(l)), "no private URLs");
});

// ------------------------------------------------------------------ client navigation keeps <head> right
await check("in-app navigation and language switch update title, canonical, hreflang, OG and JSON-LD", async () => {
  await pv.goto(`${BASE}/th/`);
  await pv.locator(".site-header").waitFor();
  const server = await pv.title();
  assert(server === "Phasakura (ตัวอย่าง)", `server title kept after hydration: ${server}`);
  const head = () => pv.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    canonical: document.querySelector("link[rel=canonical]")?.getAttribute("href") ?? null,
    alternates: [...document.querySelectorAll("link[rel=alternate]")].map((l) => l.getAttribute("hreflang")),
    ogLocale: document.querySelector("meta[property='og:locale']")?.getAttribute("content") ?? null,
    robots: document.querySelector("meta[name=robots]")?.getAttribute("content") ?? null,
    ld: [...document.querySelectorAll("script[type='application/ld+json']")].map((s) => JSON.parse(s.textContent)["@type"] ?? "graph"),
    count: document.querySelectorAll("link[rel=canonical]").length,
  }));
  await pv.locator(".nav--desktop").getByRole("link", { name: "Gallery" }).click();
  const meta = (await (await anon.get(`${BASE}/api/public/meta?path=/th/gallery`)).json()).data;
  await until(async () => (await head()).canonical === `${BASE}/th/gallery`);
  let h = await head();
  assert(h.title === meta.title, `title ${h.title} vs ${meta.title}`);
  assert(h.count === 1, "one canonical");
  assert(JSON.stringify(h.ld) === JSON.stringify(["BreadcrumbList", "CollectionPage"]), `ld ${h.ld}`);
  await pv.locator(".lang-switcher--desktop").getByRole("link", { name: "English" }).click();
  await until(async () => (await head()).canonical === `${BASE}/en/gallery`);
  h = await head();
  assert(h.lang === "en" && h.ogLocale === "en_US", `lang ${h.lang} ${h.ogLocale}`);
  assert(h.alternates.join(",") === "th,en,zh-Hans,x-default", `alternates ${h.alternates}`);
  await pv.goto(`${BASE}/en/booking`);
  await pv.locator(".unit-card a").first().click();
  await until(async () => /\/en\/accommodation\//.test((await head()).canonical ?? ""));
  h = await head();
  assert(h.ld.includes("Accommodation"), "unit JSON-LD after navigation");
  assert(/\| Phasakura \(sample data\)$/.test(h.title), `unit title ${h.title}`);
});

// ------------------------------------------------------------------ search
await check("search: button opens a labelled dialog; Thai page finds an English word; Esc closes and returns focus", async () => {
  await pv.goto(`${BASE}/th/`);
  const toggle = pv.getByRole("button", { name: "ค้นหา" });
  await toggle.click();
  const dlg = pv.locator("dialog.search-dialog[open]");
  await dlg.waitFor();
  const input = dlg.getByRole("searchbox", { name: "ค้นหาในเว็บไซต์" });
  assert(await input.evaluate((el) => el === document.activeElement), "focus in the input");
  assert((await input.getAttribute("placeholder")) === "ค้นหาที่พัก อาหาร หรือกิจกรรม...", "placeholder");
  await input.fill("sakura");
  await dlg.locator(".search-result__title", { hasText: "บ้านซากุระ" }).waitFor();
  await dlg.getByText("1 ผลลัพธ์").waitFor();
  await pv.screenshot({ path: `${SHOTS}/p13-search-desktop.png` });
  await pv.keyboard.press("Escape");
  await until(async () => (await pv.locator("dialog.search-dialog[open]").count()) === 0);
  assert(await toggle.evaluate((el) => el === document.activeElement), "focus back on the button");
});

await check("search: '/' shortcut; groups by kind; dates add live availability; book link carries the dates", async () => {
  await pv.goto(`${BASE}/en/`);
  await pv.locator(".site-header").waitFor();
  await pv.keyboard.press("/");
  const dlg = pv.locator("dialog.search-dialog[open]");
  await dlg.waitFor();
  await dlg.getByRole("searchbox").fill("tent");
  await dlg.locator(".search-group__title", { hasText: "VIP tent" }).waitFor();
  await dlg.locator(".search-group__title", { hasText: "Camping" }).waitFor();
  assert((await dlg.locator(".search-badge").count()) === 0, "no availability without dates");
  await dlg.getByText("Add your dates (optional)").click();
  const ci = day(20), co = day(22);
  await dlg.getByLabel("Check-in").fill(ci);
  await dlg.getByLabel("Check-out").fill(co);
  await dlg.locator(".search-badge").first().waitFor();
  const badges = await dlg.locator(".search-badge").allTextContents();
  assert(badges.length >= 3 && badges.some((b) => /Free|tents left/.test(b)), `badges ${badges}`);
  await dlg.getByLabel("Check-out").fill(day(19));
  await dlg.getByText("Check-out must be after check-in.").waitFor();
  await dlg.getByLabel("Check-out").fill(co);
  await dlg.getByRole("link", { name: "See what is free and book these dates" }).click();
  await pv.waitForURL(new RegExp(`/en/booking\\?checkIn=${ci}&checkOut=${co}$`));
  assert((await pv.locator("dialog.search-dialog[open]").count()) === 0, "dialog closed");
  const inputs = await pv.locator("input[type=date]").evaluateAll((els) => els.map((e) => e.value));
  assert(inputs.includes(ci) && inputs.includes(co), `booking dates ${inputs}`);
});

await check("search: opening a result navigates in-app and is counted; Chinese words work", async () => {
  await pv.goto(`${BASE}/zh-cn/`);
  await pv.getByRole("button", { name: "搜索" }).click();
  const dlg = pv.locator("dialog.search-dialog[open]");
  await dlg.getByRole("searchbox").fill("早餐");
  await dlg.locator(".search-result__title", { hasText: "早餐 A" }).waitFor();
  await dlg.getByRole("searchbox").fill("小屋");
  const house = dlg.locator(".search-result", { hasText: "观星屋" });
  await house.waitFor();
  await house.click();
  await pv.waitForURL(/\/zh-cn\/accommodation\/house-stargazing$/);
  assert((await pv.locator("dialog.search-dialog[open]").count()) === 0, "dialog closed after opening a result");
});

// ------------------------------------------------------------------ admin SEO page
async function login(page, email, lang = "en") {
  await page.goto(`${BASE}/${lang}/admin/login`);
  await page.locator("input[autocomplete=username]").fill(email);
  await page.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await page.locator("form button[type=submit]").click();
  await page.waitForURL(`${BASE}/${lang}/admin`);
}

await check("admin SEO page: search engines, translation coverage, site search stats + rebuild, live redirect", async () => {
  await login(pa, "admin@example.test");
  // A dish with Thai text only shows up in the coverage report.
  const created = await req.post(`${BASE}/api/admin/cms/foodOption`, { headers: H, data: {
    foodCategoryId: "dev_food_dinner", code: "TOM_YUM", pricingType: "PER_PERSON", priceSatang: 12000, childPricing: "FULL", minQuantity: 1, status: "ACTIVE",
    translations: { th: { name: "ต้มยำกุ้ง" } } } });
  assert(created.ok(), `create dish ${created.status()} ${await created.text()}`);
  await pa.goto(`${BASE}/en/admin/seo`);
  await pa.getByRole("heading", { name: "Search engines" }).waitFor();
  await pa.getByText(`${BASE}/sitemap.xml`).waitFor();
  await pa.getByText("robots.txt in use").click();
  await pa.locator(".seo-robots pre", { hasText: "Disallow: /" }).waitFor();
  const cov = pa.locator(".adm-card", { has: pa.getByRole("heading", { name: "Translation coverage" }) });
  const dishRow = cov.locator("tr", { hasText: "Dishes" });
  await dishRow.waitFor();
  assert((await dishRow.locator("td").nth(1).textContent()) === "1", "1 dish without EN");
  await dishRow.getByText("Show items").click();
  await dishRow.getByText("ต้มยำกุ้ง").waitFor();
  const card = pa.locator(".adm-card", { has: pa.getByRole("heading", { name: "Site search" }) });
  await card.locator("td", { hasText: "sakura" }).first().waitFor();
  const xiaowu = card.locator("tr", { hasText: "小屋" });
  assert((await xiaowu.locator("td").nth(3).textContent()) === "1", "opened result counted as a click");
  await card.getByRole("button", { name: "Rebuild index now" }).click();
  await card.getByText(/Index rebuilt \(\d+ entries\)/).waitFor();
  await pa.screenshot({ path: `${SHOTS}/p13-admin-seo.png`, fullPage: true });
  // The rebuilt index finds the new dish right away (it was Thai-only: Thai text serves every language).
  const found = (await (await anon.get(`${BASE}/api/search?q=${encodeURIComponent("ต้มยำ")}&lang=en`)).json()).data;
  assert(found.results.some((r) => r.title === "ต้มยำกุ้ง"), "new dish searchable");
  // Redirect created in the admin works for visitors at once.
  const r = await req.post(`${BASE}/api/admin/cms/seoRedirect`, { headers: H, data: { fromPath: "/old-rooms", toPath: "/th/booking", statusCode: 301 } });
  assert(r.ok(), "redirect saved");
  await pv.goto(`${BASE}/old-rooms?from=flyer`);
  assert(pv.url() === `${BASE}/th/booking?from=flyer`, `redirected to ${pv.url()}`);
});

// ------------------------------------------------------------------ mobile
await check("mobile 390 px: search fills the screen, results readable, no horizontal scroll", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "th-TH" });
  const p = await ctx.newPage(); watch(p);
  await p.goto(`${BASE}/th/`);
  await p.getByRole("button", { name: "ค้นหา" }).tap();
  const dlg = p.locator("dialog.search-dialog[open]");
  await dlg.getByRole("searchbox").fill("เต็นท์");
  await dlg.locator(".search-result").first().waitFor();
  const box = await dlg.boundingBox();
  assert(box.width === 390 && box.height >= 800, `dialog ${box.width}x${box.height}`);
  const overflow = await dlg.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  assert(!overflow, "dialog overflows");
  await p.screenshot({ path: `${SHOTS}/p13-search-mobile.png` });
  await dlg.getByRole("button", { name: "ปิดการค้นหา" }).tap();
  for (const path of ["/th/", "/en/gallery", "/zh-cn/history"]) {
    await p.goto(`${BASE}${path}`);
    await p.locator(".site-header").waitFor();
    await p.waitForTimeout(400);
    const w = await p.evaluate(() => document.documentElement.scrollWidth);
    assert(w <= 390, `${path} scrollWidth ${w}`);
  }
  await ctx.close();
});

await check("no console or CSP errors", async () => {
  assert(consoleErrors.length === 0, consoleErrors.join("\n"));
});

await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { for (const f of failed) console.log(f.join(" | ")); process.exit(1); }
