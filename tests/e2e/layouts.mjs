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
