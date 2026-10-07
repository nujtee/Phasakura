// Responsive sweep (Phase 15): every public page and the main admin pages at phone, tablet, laptop and
// desktop widths. Checks: no horizontal page scroll, nothing wider than the screen, header / main /
// footer present, the mobile menu opens and closes with the keyboard, controls large enough to tap
// (WCAG 2.2 target size, 24 × 24 CSS px), readable body text, and no console / CSP errors.
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const SHOTS = process.env.E2E_SHOTS;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 900)]); console.log("FAIL", name, String(e).slice(0, 900)); }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
function watch(page) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/status of (401|404)/.test(text) && /\/(admin\/login|no-such-page)/.test(page.url())) return;
    consoleErrors.push(`${page.url()} :: ${text}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}

const VIEWPORTS = [
  { name: "phone-320", width: 320, height: 640, mobile: true },
  { name: "phone-390", width: 390, height: 844, mobile: true },
  { name: "tablet-768", width: 768, height: 1024, mobile: true },
  { name: "laptop-1024", width: 1024, height: 768, mobile: false },
  { name: "desktop-1440", width: 1440, height: 900, mobile: false },
];
const PUBLIC = ["/th/", "/en/gallery", "/th/booking", "/en/accommodation/house-sakura", "/zh-cn/history", "/th/booking/lookup", "/en/no-such-page"];
const ADMIN = ["/en/admin", "/en/admin/bookings", "/en/admin/calendar", "/th/admin/payments", "/en/admin/settings-theme", "/en/admin/reports"];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });

/** Layout problems on the current page. */
async function layoutProblems(page, vw, opts) {
  return page.evaluate(({ vw, mobile, admin }) => {
    const issues = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > vw + 1) {
      // Name the widest offenders to make the failure actionable.
      const wide = [...document.querySelectorAll("body *")].filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.right <= vw + 1 || r.width === 0) return false;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return false; // inside a scroll box (tables)
        }
        return true;
      }).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} right=${Math.round(el.getBoundingClientRect().right)}`);
      issues.push(`horizontal scroll: ${doc.scrollWidth}px > ${vw}px ${wide.join(", ")}`);
    }
    for (const img of document.images) {
      const r = img.getBoundingClientRect();
      if (r.width > vw + 1 && !img.closest("[class*=slideshow], [class*=lightbox], .hero, .story-hero")) issues.push(`image wider than the screen: ${img.src.slice(-40)}`);
    }
    if (!document.querySelector("main")) issues.push("no main");
    if (!admin && !document.querySelector("header")) issues.push("no header");
    if (!admin && !document.querySelector("footer")) issues.push("no footer");
    // Body text at least 14 px; inputs at least 16 px on phones (no iOS zoom-on-focus).
    // The size most of the paragraph text is set in (hints and captions may be smaller).
    const bySize = new Map();
    for (const el of document.querySelectorAll("main p, main li, main td")) {
      const n = (el.textContent || "").trim().length;
      if (!n || !el.getBoundingClientRect().width) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      bySize.set(size, (bySize.get(size) || 0) + n);
    }
    const bodySize = [...bySize].sort((a, b) => b[1] - a[1])[0]?.[0];
    // Public pages read at ≥ 14 px; the back office's dense data tables may use 13 px.
    if (bodySize && bodySize < (admin ? 13 : 14)) issues.push(`most text is ${bodySize}px`);
    if (mobile && !admin) {
      for (const input of document.querySelectorAll("main input:not([type=checkbox]):not([type=radio]):not([type=hidden]), main select, main textarea")) {
        const r = input.getBoundingClientRect();
        if (r.width && parseFloat(getComputedStyle(input).fontSize) < 16) issues.push(`input text below 16px: #${input.id}`);
      }
    }
    // Target size (WCAG 2.2 SC 2.5.8): buttons and standalone controls at least 24 × 24.
    for (const el of document.querySelectorAll("button, [role=button], input[type=checkbox], input[type=radio], select, a.button, nav a, .lang-switcher a")) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (!r.width || s.visibility === "hidden" || el.closest("[aria-hidden=true], dialog:not([open])")) continue;
      if (r.width < 24 || r.height < 24) {
        // Inline links inside a sentence are exempt; so are controls with enough spacing — keep it simple: report.
        issues.push(`small target ${Math.round(r.width)}×${Math.round(r.height)}: ${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`);
      }
    }
    return [...new Set(issues)];
  }, { vw, ...opts });
}

// ------------------------------------------------------------------ public pages
for (const vp of VIEWPORTS) {
  await check(`public pages at ${vp.name}`, async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, locale: "th-TH" });
    const page = await ctx.newPage(); watch(page);
    const problems = [];
    for (const path of PUBLIC) {
      await page.goto(`${BASE}${path}`);
      await page.locator("main").waitFor();
      await page.waitForTimeout(500);
      for (const issue of await layoutProblems(page, vp.width, { mobile: vp.mobile, admin: false })) problems.push(`${path}: ${issue}`);
    }
    await page.goto(`${BASE}/th/`);
    await page.waitForTimeout(400);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/responsive-home-${vp.name}.png` });
    await page.goto(`${BASE}/th/booking`);
    await page.waitForTimeout(400);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/responsive-booking-${vp.name}.png`, fullPage: true });
    await ctx.close();
    assert(problems.length === 0, problems.join("\n"));
  });
}

// ------------------------------------------------------------------ navigation on small screens
await check("phone: the menu opens, traps nothing, closes with Esc and returns focus; links work", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  const page = await ctx.newPage(); watch(page);
  await page.goto(`${BASE}/en/`);
  const toggle = page.locator("header button[aria-expanded]").first();
  await toggle.waitFor();
  assert(await toggle.getAttribute("aria-expanded") === "false", "menu starts closed");
  await toggle.tap();
  assert(await toggle.getAttribute("aria-expanded") === "true", "aria-expanded true when open");
  const nav = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
  const links = await nav.getByRole("link").count();
  assert(links >= 4, `menu links ${links}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert(await toggle.getAttribute("aria-expanded") === "false", "Esc closes the menu");
  assert(await toggle.evaluate((el) => el === document.activeElement), "focus back on the menu button");
  await toggle.tap();
  await nav.getByRole("link", { name: "Gallery" }).tap();
  await page.waitForURL(/\/en\/gallery$/);
  assert(await toggle.getAttribute("aria-expanded") === "false", "menu closes after navigating");
  await ctx.close();
});

await check("landscape phone (844 × 390): header does not cover the page, booking form usable", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, locale: "th-TH" });
  const page = await ctx.newPage(); watch(page);
  await page.goto(`${BASE}/th/booking`);
  await page.locator("main").waitFor();
  const header = await page.locator("header").first().boundingBox();
  assert(header.height <= 390 * 0.3, `header takes ${header.height}px of 390`);
  const problems = await layoutProblems(page, 844, { mobile: true, admin: false });
  assert(problems.length === 0, problems.join("\n"));
  await ctx.close();
});

// ------------------------------------------------------------------ admin
const adminCtx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US" });
{
  const p = await adminCtx.newPage();
  await p.goto(`${BASE}/en/admin/login`);
  await p.locator("input[autocomplete=username]").fill("admin@example.test");
  await p.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await p.locator("form button[type=submit]").click();
  await p.waitForURL(/\/admin(\/|$)(?!login)/);
  // Some data so lists and the calendar are not empty.
  const day = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(Date.now() + n * 86400000));
  for (const [i, unitId] of ["dev_house_01", "dev_vip_01"].entries()) {
    const body = { checkIn: day(3 + i), checkOut: day(5 + i), adults: 2, children: 0, stay: { kind: "UNIT", unitId }, food: [], lang: "th" };
    const q = await (await adminCtx.request.post(`${BASE}/api/public/bookings/quote`, { headers: H, data: body })).json();
    await adminCtx.request.post(`${BASE}/api/public/bookings`, { headers: H, data: { ...body, customer: { name: `Responsive Guest ${i}`, phone: `081000000${i}` }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `responsive-key-${Date.now()}-${i}` } });
  }
  await p.close();
}
for (const vp of [VIEWPORTS[1], VIEWPORTS[2], VIEWPORTS[4]]) {
  await check(`admin pages at ${vp.name}`, async () => {
    const page = await adminCtx.newPage(); watch(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const problems = [];
    for (const path of ADMIN) {
      await page.goto(`${BASE}${path}`);
      await page.locator("main").waitFor();
      await page.waitForTimeout(600);
      for (const issue of await layoutProblems(page, vp.width, { mobile: vp.mobile, admin: true })) problems.push(`${path}: ${issue}`);
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/responsive-admin-${vp.name}.png` });
    await page.close();
    assert(problems.length === 0, problems.join("\n"));
  });
}

await check("admin on a phone: the side menu is reachable and closes after choosing a page", async () => {
  const page = await adminCtx.newPage(); watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/en/admin`);
  const toggle = page.locator("button[aria-expanded]").first();
  await toggle.waitFor();
  await toggle.click();
  await page.getByRole("link", { name: "Bookings" }).first().click();
  await page.waitForURL(/\/en\/admin\/bookings$/);
  await page.waitForTimeout(300);
  assert(await toggle.getAttribute("aria-expanded") === "false", "menu closed after navigating");
  await page.close();
});

await check("no console or CSP errors", async () => {
  assert(consoleErrors.length === 0, consoleErrors.join("\n"));
});

await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { for (const f of failed) console.log(f.join(" | ")); process.exit(1); }
