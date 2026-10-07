// Phase 16 end-to-end (server runs with APP_ENV=production): the post-deploy smoke test script against a
// running server, /api/health with the cron heartbeat, Admin → System status in three languages (checks,
// heartbeat, backlog, error log), permission gating, accessibility, mobile layout, console / CSP errors.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { audit, focusRing } from "./a11y.mjs";
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:8443";
const SHOTS = process.env.E2E_SHOTS;
const ROOT = join(import.meta.dirname, "..", "..");
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 1500)]); console.log("FAIL", name, String(e).slice(0, 1500)); }
}
function watch(page, allow = () => false) {
  page.on("console", (m) => {
    if (m.type() !== "error" || allow(m.text())) return;
    // The login page asks "am I signed in?" first; 401 is the expected answer there.
    if (/\/admin\/login$/.test(page.url()) && /status of 401/.test(m.text())) return;
    consoleErrors.push(`${page.url()} :: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const api = (await browser.newContext({ ignoreHTTPSErrors: true })).request;

async function login(page, email, lang = "en") {
  await page.goto(`${BASE}/${lang}/admin/login`);
  await page.locator("input[autocomplete=username]").fill(email);
  await page.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await page.locator("form button[type=submit]").click();
  await page.waitForURL(/\/admin(\/|$)(?!login)/);
}

await check("health before the first cron run: up, cron unknown (not an outage)", async () => {
  const res = await api.get(`${BASE}/api/health`);
  const body = (await res.json()).data;
  assert(res.status() === 200, `status ${res.status()}`);
  assert(body.database === "ok" && body.schema === "ok" && body.cron === "unknown", JSON.stringify(body));
  assert(res.headers()["cache-control"] === "no-store", "health must not be cached");
});

await check("cron heartbeat → health cron ok", async () => {
  await api.post(`${BASE}/__e2e/cron`);
  const body = (await (await api.get(`${BASE}/api/health`)).json()).data;
  assert(body.status === "ok" && body.cron === "ok", JSON.stringify(body));
});

await check("npm run smoke against this server: 0 errors (signed in, System status read, signed out)", async () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "smoke-test.ts"), BASE, "--no-http"], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_NO_WARNINGS: "1", SMOKE_ADMIN_IDENTIFIER: "admin@example.test", SMOKE_ADMIN_PASSWORD: "correct horse battery staple" },
  });
  const out = `${run.stdout}${run.stderr}`;
  console.log(out.split("\n").map((l) => `    ${l}`).join("\n"));
  // localhost is (correctly) not a valid production APP_BASE_URL: System status reports it as an error.
  const errors = out.split("\n").filter((l) => l.startsWith("✗") && !/system\s+baseUrl/.test(l));
  assert(errors.length === 0, errors.join("\n"));
  assert(/✓ pages\s+\/th\/ 200, indexable/.test(out) && /✓ security\s+cross-site POST rejected/.test(out) && /✓ assets/.test(out), "expected checks missing");
  assert(/✗ system\s+baseUrl/.test(out), "System status was read with the admin session");
});

const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US" });
const pa = await admin.newPage();
watch(pa);

await check("admin: System status page — readiness checks sorted by severity with fixes, heartbeat, backlog, errors", async () => {
  await login(pa, "admin@example.test");
  await pa.getByRole("link", { name: "System status" }).click();
  await pa.waitForURL(/\/en\/admin\/system$/);
  await pa.getByRole("heading", { name: "System status", level: 1 }).waitFor();
  const table = pa.locator("table.sys-checks");
  await table.waitFor();
  const rows = await table.locator("tr").allInnerTexts();
  assert(rows.length === 19, `19 checks, got ${rows.length}`);
  const levels = await table.locator("tr td:first-child .adm-badge").allInnerTexts();
  const rank = { Fix: 0, Check: 1, OK: 2 };
  assert(levels.every((l, i) => i === 0 || rank[levels[i - 1]] <= rank[l]), `not sorted: ${levels}`);
  const base = table.locator("tr", { hasText: "Main domain (APP_BASE_URL)" });
  assert(/Fix/.test(await base.innerText()), "localhost base URL is an error in production");
  assert(await base.locator(".sys-fix").isVisible(), "fix text shown for a problem");
  const text = await pa.locator("main").innerText();
  assert(/production/.test(text) && /https:\/\/localhost/.test(text), "environment + domain shown");
  assert(/cron/.test(text) && /Runs \d+/.test(text), `heartbeat shown: ${text.slice(0, 400)}`);
  assert(/No server errors/.test(text), "empty error log");
  assert(!/e2e-channel|e2e-capi-secret|PRIVATE KEY/.test(await pa.content()), "no secret values on the page");
  await pa.screenshot({ path: join(SHOTS, "p16-system-en.png"), fullPage: true });
});

await check("admin: refresh reloads; Thai and Chinese pages are translated", async () => {
  const before = await pa.locator("main").innerText();
  await pa.getByRole("button", { name: "Refresh" }).click();
  await pa.locator("table.sys-checks").waitFor();
  assert((await pa.locator("main").innerText()).includes("System status"), before.slice(0, 50));
  for (const [lang, title] of [["th", "สถานะระบบ"], ["zh-cn", "系统状态"]]) {
    await pa.goto(`${BASE}/${lang}/admin/system`);
    await pa.getByRole("heading", { name: title, level: 1 }).waitFor();
    await pa.locator("table.sys-checks").waitFor();
    const t = await pa.locator("main").innerText();
    assert(!/Main domain|Background jobs|Refresh/.test(t), `${lang}: English text leaked`);
    await pa.screenshot({ path: join(SHOTS, `p16-system-${lang}.png`), fullPage: true });
  }
});

await check("admin: accessibility audit + visible focus on System status", async () => {
  await pa.goto(`${BASE}/en/admin/system`);
  await pa.locator("table.sys-checks").waitFor();
  const issues = await audit(pa, { admin: true });
  assert(issues.length === 0, issues.join("\n"));
  const missing = await focusRing(pa, 14);
  assert(missing.length === 0, `no focus ring: ${missing.join(", ")}`);
});

await check("admin: mobile layout has no horizontal scroll", async () => {
  const m = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "en-US" });
  const p = await m.newPage();
  watch(p);
  await login(p, "admin@example.test");
  await p.goto(`${BASE}/en/admin/system`);
  await p.locator("table.sys-checks").waitFor();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  await p.screenshot({ path: join(SHOTS, "p16-system-mobile.png"), fullPage: true });
  await m.close();
});

await check("permission: a viewer has no System status link and the API refuses (403)", async () => {
  const v = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const p = await v.newPage();
  watch(p, (t) => /status of 403/.test(t));
  await login(p, "viewer@example.test");
  assert((await p.getByRole("link", { name: "System status" }).count()) === 0, "nav link hidden");
  await p.goto(`${BASE}/en/admin/system`);
  await p.getByRole("alert").waitFor();
  assert((await p.locator("table.sys-checks").count()) === 0, "no data shown");
  const res = await v.request.get(`${BASE}/api/admin/system`, { headers: { "X-Requested-With": "phasakura" } });
  assert(res.status() === 403, `API ${res.status()}`);
  await v.close();
});

await check("production mode: robots.txt allows indexing with the sitemap, pages indexable, admin noindex", async () => {
  const robots = await (await api.get(`${BASE}/robots.txt`)).text();
  assert(!/^Disallow: \/$/m.test(robots) && robots.includes(`Sitemap: ${BASE}/sitemap.xml`), robots);
  const home = await api.get(`${BASE}/th/`);
  assert(!home.headers()["x-robots-tag"], "home indexable");
  const adminPage = await api.get(`${BASE}/th/admin`);
  assert(/noindex/.test(adminPage.headers()["x-robots-tag"] ?? ""), "admin noindex");
});

await check("no console or CSP errors", async () => {
  assert(consoleErrors.length === 0, consoleErrors.join("\n"));
});

await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { for (const f of failed) console.log(f.join(" | ")); process.exit(1); }
