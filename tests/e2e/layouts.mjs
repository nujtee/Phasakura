// Theme layouts (migration 0061): Settings → Theme → site layout → draft → publish, then the public home page in
// that layout on a desktop and a phone (date bar → booking page with the dates, the trust strip, the header button,
// no sideways scrolling, fonts served by the site itself, no console / CSP errors).
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

await check("Theme → site layout A: applies its colours, saves the draft, publishes", async () => {
  await pa.goto(`${BASE}/en/admin/settings-theme`);
  await pa.getByRole("heading", { name: "Site layout" }).waitFor();
  await pa.getByRole("button", { name: /A · Sakura Editorial/ }).click();
  await pa.getByText("This layout's colours and fonts are applied").waitFor();
  assert((await pa.getByRole("button", { name: /A · Sakura Editorial/ }).getAttribute("aria-pressed")) === "true", "not pressed");
  await pa.getByRole("button", { name: "Save draft" }).click();
  await pa.getByText("Saved").first().waitFor();
  await pa.screenshot({ path: `${SHOTS}/l-admin-theme-layout.png`, fullPage: false });
  await pa.getByRole("button", { name: "Publish theme" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Publish theme" }).click();
  await pa.getByText("Published").first().waitFor();
  const site = await (await admin.request.get(`${BASE}/api/public/site?lang=en`)).json();
  assert(site.data.layout === "EDITORIAL", `layout ${site.data.layout}`);
});

const visitor = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "th-TH" });
const pv = await visitor.newPage(); watch(pv);
const fonts = [];
pv.on("response", (r) => { if (/\.woff2(\?|$)/.test(r.url())) fonts.push([r.url(), r.status()]); });

await check("desktop: layout A on the home page (header button, date bar, trust strip, serif headings from the site)", async () => {
  await pv.goto(`${BASE}/th/`);
  await pv.locator(".layout-bookbar").waitFor();
  assert((await pv.evaluate(() => document.documentElement.dataset.layout)) === "EDITORIAL", "data-layout");
  assert(await pv.locator(".header-book").isVisible(), "header button hidden at 1440");
  assert(await pv.locator(".layout-trust li").count() >= 3, "trust strip");
  await pv.evaluate(() => document.fonts.ready);
  await pv.waitForTimeout(600);
  assert(fonts.length > 0 && fonts.every(([u, s]) => s === 200 && u.startsWith(BASE)), `fonts ${JSON.stringify(fonts)}`);
  const overflow = await pv.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `sideways scroll ${overflow}px`);
  await pv.screenshot({ path: `${SHOTS}/l-editorial-desktop.png`, fullPage: true });
});

await check("date bar → booking page with those dates", async () => {
  await pv.goto(`${BASE}/th/`);
  const inField = pv.locator(".layout-bookbar input[type=date]").first();
  const checkIn = await inField.inputValue();
  await pv.locator(".layout-bookbar__submit").click();
  await pv.waitForURL(/\/th\/booking\?checkIn=/);
  assert(new URL(pv.url()).searchParams.get("checkIn") === checkIn, pv.url());
});

const phone = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "th-TH" });
const pm = await phone.newPage(); watch(pm);
await check("phone: layout A fits (no sideways scroll; header button left to the floating one)", async () => {
  await pm.goto(`${BASE}/th/`);
  await pm.locator(".layout-bookbar").waitFor();
  assert(!(await pm.locator(".header-book").isVisible()), "header button visible on a phone");
  const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `sideways scroll ${overflow}px`);
  await pm.screenshot({ path: `${SHOTS}/l-editorial-phone.png`, fullPage: true });
});

await check("rollback to the classic version: the site is as before", async () => {
  await pa.goto(`${BASE}/en/admin/settings-theme`);
  await pa.getByRole("button", { name: "Restore" }).first().click();
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
