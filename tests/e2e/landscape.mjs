// Site plan editor (landscape, phase L2): draw, link a house, autosave, reload, undo, conflict, failed save +
// recovery, photo background. Runs against a fresh e2e server; admin@example.test is SUPER_ADMIN.
import { readFileSync } from "node:fs";
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const SHOTS = process.env.E2E_SHOTS;
const FIXTURES = process.env.E2E_FIXTURES;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 800)]); console.log("FAIL", name, String(e).slice(0, 800)); }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
function watch(page) {
  page.on("console", (m) => { if (m.type() === "error" && !/status of (401|404|409|422|429|500)/.test(m.text())) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 }, locale: "en-US" });
const pa = await ctx.newPage(); watch(pa);
const req = ctx.request;
let LAYOUT = "";
let PHOTO = "";
const api = async (method, path, data) => {
  const res = await req.fetch(`${BASE}${path}`, { method, headers: H, data });
  return { status: res.status(), body: await res.json().catch(() => null) };
};
const layout = async (id = LAYOUT) => (await api("GET", `/api/admin/landscape/layouts/${id}`)).body.data;
const svgBox = async () => pa.locator(".lse-canvas svg").boundingBox();
/** A world point (metres on the 200 × 120 m canvas) on the screen, from the SVG viewBox. */
async function screen(x, y) {
  const vb = (await pa.locator(".lse-canvas svg").getAttribute("viewBox")).split(" ").map(Number);
  const box = await svgBox();
  return [box.x + ((x - vb[0]) / vb[2]) * box.width, box.y + ((y - vb[1]) / vb[3]) * box.height];
}
const saved = () => pa.locator(".lse-status--saved").waitFor({ timeout: 15_000 });

await check("admin login; the site plan switched on; a blank plan made", async () => {
  await pa.goto(`${BASE}/en/admin/login`);
  await pa.locator("input[autocomplete=username]").fill("admin@example.test");
  await pa.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await pa.locator("form button[type=submit]").click();
  await pa.waitForURL(`${BASE}/en/admin`);
  assert((await api("PUT", "/api/admin/landscape/settings", { enabled: true })).status === 200, "switch on");
  const made = await api("POST", "/api/admin/landscape/layouts", { name: "Garden plan", backgroundKind: "BLANK" });
  assert(made.status === 201, JSON.stringify(made.body));
  LAYOUT = made.body.data.id;
  const photo = await api("POST", "/api/admin/landscape/layouts", { name: "Aerial", backgroundKind: "PHOTO" });
  PHOTO = photo.body.data.id;
});

await check("editor: draw a house, link it to House 01, autosave; it is there after a reload", async () => {
  await pa.goto(`${BASE}/en/admin/landscape`);
  await pa.getByRole("link", { name: "Open the editor" }).first().click();
  await pa.waitForURL(new RegExp(`/en/admin/landscape/${LAYOUT}$`));
  await pa.locator(".lse-canvas svg").waitFor();
  await pa.getByRole("button", { name: "House", exact: true }).click();
  const [x1, y1] = await screen(40, 30);
  const [x2, y2] = await screen(70, 50);
  await pa.mouse.move(x1, y1);
  await pa.mouse.down();
  await pa.mouse.move(x2, y2, { steps: 6 });
  await pa.mouse.up();
  await pa.getByLabel("Booking link").selectOption("dev_house_01");
  await pa.getByLabel("Name / text").fill("Sakura");
  await pa.getByLabel("Name / text").press("Enter");
  await saved();
  const doc = (await layout()).draft;
  const house = doc.objects.find((o) => o.kind === "HOUSE");
  assert(house && house.link?.unitId === "dev_house_01" && house.label === "Sakura", JSON.stringify(doc.objects));
  assert(Math.abs(house.shape.x - 40) < 1 && Math.abs(house.shape.w - 30) < 1, `metres ${JSON.stringify(house.shape)}`);
  await pa.reload();
  await pa.locator(".lse-canvas svg [data-id]").first().waitFor();
  assert(await pa.locator(".lse-canvas svg text", { hasText: "Sakura" }).count() === 1, "label drawn after reload");
});

await check("stamp trees, select with a box, move them with snapping, undo / redo", async () => {
  await pa.getByRole("button", { name: "Tree", exact: true }).click();
  for (const [x, y] of [[100, 80], [110, 80], [120, 80]]) { const [sx, sy] = await screen(x, y); await pa.mouse.click(sx, sy); }
  await pa.keyboard.press("Escape");
  await saved();
  assert((await layout()).draft.objects.filter((o) => o.kind === "TREE").length === 3, "3 trees");
  // Box-select the trees and drag them 20 m to the right.
  const [ax, ay] = await screen(90, 70);
  const [bx, by] = await screen(130, 90);
  await pa.mouse.move(ax, ay); await pa.mouse.down(); await pa.mouse.move(bx, by, { steps: 5 }); await pa.mouse.up();
  await pa.getByText("3 selected").waitFor();
  const [tx, ty] = await screen(110, 80);
  const [ux, uy] = await screen(130.7, 80.4);
  await pa.mouse.move(tx, ty); await pa.mouse.down(); await pa.mouse.move(ux, uy, { steps: 6 }); await pa.mouse.up();
  await saved();
  const xs = (await layout()).draft.objects.filter((o) => o.kind === "TREE").map((o) => o.shape.x).sort((a, b) => a - b);
  assert(JSON.stringify(xs) === JSON.stringify([120, 130, 140]), `snapped to the 5 m grid: ${xs}`);
  await pa.keyboard.press("Control+z");
  await saved();
  const back = (await layout()).draft.objects.filter((o) => o.kind === "TREE").map((o) => o.shape.x).sort((a, b) => a - b);
  assert(JSON.stringify(back) === JSON.stringify([100, 110, 120]), `undo: ${back}`);
  await pa.keyboard.press("Control+y");
  await saved();
  await pa.keyboard.press("Delete");
  await saved();
  assert((await layout()).draft.objects.filter((o) => o.kind === "TREE").length === 0, "deleted");
  await pa.keyboard.press("Control+z");
  await saved();
  if (SHOTS) await pa.screenshot({ path: `${SHOTS}/landscape-editor.png` });
});

await check("someone else saved meanwhile: nothing is overwritten; the admin chooses", async () => {
  const before = await layout();
  // Another admin saves (with the current revision) while this page still holds the older one.
  const other = { ...before.draft, objects: [...before.draft.objects, { ...before.draft.objects[0], id: "other1", link: null, label: "Theirs", shape: { type: "rect", x: 150, y: 20, w: 10, h: 10 } }] };
  assert((await api("PUT", `/api/admin/landscape/layouts/${LAYOUT}/draft`, { baseRevision: before.draftRevision, document: other })).status === 200, "other save");
  await pa.getByRole("button", { name: "Flowers", exact: true }).click();
  const [fx, fy] = await screen(20, 100);
  await pa.mouse.click(fx, fy);
  await pa.getByText(/saved this plan at/).waitFor({ timeout: 15_000 });
  assert((await layout()).draft.objects.some((o) => o.id === "other1"), "their work kept");
  await pa.getByRole("button", { name: "Save mine over it" }).click();
  await pa.getByRole("dialog").getByRole("button", { name: "Save mine over it" }).click();
  await saved();
  const after = (await layout()).draft;
  assert(!after.objects.some((o) => o.id === "other1") && after.objects.some((o) => o.kind === "FLOWER"), "mine saved on explicit choice");
});

await check("a failed save says so and keeps the work; it comes back after a reload (local copy)", async () => {
  await pa.route(`**/api/admin/landscape/layouts/${LAYOUT}/draft`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "x" } }) }));
  await pa.getByRole("button", { name: "Shrub", exact: true }).click();
  const [sx, sy] = await screen(60, 100);
  await pa.mouse.click(sx, sy);
  await pa.locator(".lse-status--error").waitFor({ timeout: 15_000 });
  await pa.unroute(`**/api/admin/landscape/layouts/${LAYOUT}/draft`);
  pa.once("dialog", (d) => d.accept());
  await pa.reload();
  await pa.getByText(/Unsaved work found from last time/).waitFor();
  await pa.getByRole("button", { name: "Restore" }).click();
  await saved();
  assert((await layout()).draft.objects.some((o) => o.kind === "SHRUB"), "restored and saved");
});

await check("photo plan: upload an aerial photo, draw a polygon; stored as 0…1 of the photo", async () => {
  await pa.goto(`${BASE}/en/admin/landscape/${PHOTO}`);
  await pa.getByRole("tab", { name: "Background" }).click();
  await pa.locator("input[type=file]").setInputFiles({ name: "aerial.png", mimeType: "image/png", buffer: readFileSync(`${FIXTURES}/hero-a.png`) });
  await pa.locator(".lse-canvas svg image").waitFor({ timeout: 20_000 });
  await saved();
  await pa.getByRole("button", { name: "Grass / lawn", exact: true }).click();
  const vb = (await pa.locator(".lse-canvas svg").getAttribute("viewBox")).split(" ").map(Number);
  const box = await svgBox();
  const at = (fx, fy) => [box.x + (((fx * 3000) - vb[0]) / vb[2]) * box.width, box.y + (((fy * 1500) - vb[1]) / vb[3]) * box.height];
  for (const [x, y] of [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]]) { const [sx, sy] = at(x, y); await pa.mouse.click(sx, sy); }
  await pa.keyboard.press("Enter");
  await saved();
  const doc = (await layout(PHOTO)).draft;
  const grass = doc.objects.find((o) => o.kind === "GRASS");
  assert(doc.crs === "IMAGE_NORM" && grass && grass.shape.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1), JSON.stringify(doc));
  assert(Math.abs(grass.shape.points[1][0] - 0.3) < 0.01, `normalised: ${JSON.stringify(grass.shape.points)}`);
  if (SHOTS) await pa.screenshot({ path: `${SHOTS}/landscape-photo.png` });
});

await check("publish from the list: links checked, booking page gets the plan", async () => {
  await pa.goto(`${BASE}/en/admin/landscape`);
  await pa.getByRole("button", { name: "Publish this draft" }).first().click();
  await pa.getByRole("dialog").getByRole("button", { name: "Publish this draft" }).click();
  await pa.getByText("Published version 1").first().waitFor();
  assert((await api("PUT", "/api/admin/landscape/public", { layoutId: LAYOUT })).status === 200, "public");
  const pub = await api("GET", "/api/public/landscape");
  assert(pub.body.data.layout.document.objects.some((o) => o.link?.unitId === "dev_house_01"), "house on the booking page plan");
});

const day = (offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));
const IN = day(61);
const OUT = day(62);
let SAKURA = "";
let MOMIJI = "";

await check("booking page map (L3): a second house is added and published; House 02 is booked on the test dates", async () => {
  const l = await layout();
  const doc = l.draft;
  SAKURA = doc.objects.find((o) => o.link?.unitId === "dev_house_01").id;
  MOMIJI = "momiji1";
  doc.objects.push({
    id: MOMIJI, layerId: "stays", kind: "HOUSE", shape: { type: "rect", x: 100, y: 30, w: 30, h: 20 }, rotation: 0,
    style: { fill: "#d7b98e", stroke: "#6d4c41", opacity: 1 }, label: "Momiji", link: { type: "UNIT", unitId: "dev_house_02" },
    groupId: null, locked: false, imageAssetId: null,
  });
  const saved2 = await api("PUT", `/api/admin/landscape/layouts/${LAYOUT}/draft`, { baseRevision: l.draftRevision, document: doc });
  assert(saved2.status === 200, JSON.stringify(saved2.body));
  const pub = await api("POST", `/api/admin/landscape/layouts/${LAYOUT}/publish`, { revision: saved2.body.data.draftRevision, makePublic: true });
  assert(pub.status === 200, JSON.stringify(pub.body));
  const full = { checkIn: IN, checkOut: OUT, adults: 2, children: 0, food: [], lang: "en", stays: [{ kind: "UNIT", unitId: "dev_house_02", adults: 2, children: 0 }] };
  const q = await api("POST", "/api/public/bookings/quote", full);
  assert(q.status === 200, JSON.stringify(q.body));
  const b = await api("POST", "/api/public/bookings", { ...full, customer: { name: "Map guest", phone: "0867777777" }, privacyAccepted: true, expectedTotalSatang: q.body.data.totalSatang, idempotencyKey: `e2e-map-${Date.now()}` });
  assert(b.status === 201 || b.status === 200, JSON.stringify(b.body));
});

const guest = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: "en-US", isMobile: true, hasTouch: true });
const pg = await guest.newPage(); watch(pg);

await check("guest: the map shows before a search, nothing coloured yet; skip link to the list", async () => {
  await pg.goto(`${BASE}/en/booking?checkIn=${IN}&checkOut=${OUT}&adults=2&children=0`);
  await pg.locator(".bmap__svg").waitFor();
  await pg.getByText("Site map", { exact: true }).waitFor();
  const label = await pg.locator(`[data-target="${SAKURA}"]`).getAttribute("aria-label");
  assert(/Not checked yet$/.test(label), label);
  assert(await pg.locator(".bmap__svg text", { hasText: "Momiji" }).count() === 1, "plan labels drawn");
  await pg.getByRole("link", { name: "Skip the map, go to the list of stays" }).click();
  assert(await pg.evaluate(() => document.activeElement?.id) === "stay-list", "focus moved to the list");
  if (SHOTS) await pg.screenshot({ path: `${SHOTS}/landscape-booking-before.png`, fullPage: true });
});

await check("guest: after the search, free / taken show on the map; tap a house, see its price, choose it", async () => {
  await pg.getByRole("button", { name: "Check availability" }).first().click();
  await pg.waitForFunction((id) => /— Available$/.test(document.querySelector(`[data-target="${id}"]`)?.getAttribute("aria-label") ?? ""), SAKURA);
  const momiji = await pg.locator(`[data-target="${MOMIJI}"]`).getAttribute("aria-label");
  assert(/— Not available$/.test(momiji), momiji);
  await pg.locator(`[data-target="${SAKURA}"]`).click();
  const panel = pg.locator("#bmap-panel");
  await panel.waitFor();
  await panel.locator(".bmap__chip", { hasText: "Available" }).waitFor();
  assert(/฿|THB/.test(await panel.innerText()), `price in the panel: ${await panel.innerText()}`);
  await panel.locator(".unit-pick__btn").click();
  await pg.locator("#picks").getByText("Sakura").first().waitFor();
  await pg.waitForFunction((id) => /— Chosen$/.test(document.querySelector(`[data-target="${id}"]`)?.getAttribute("aria-label") ?? ""), SAKURA);
  await panel.locator(".bmap__chip", { hasText: "Chosen" }).waitFor();
  if (SHOTS) await pg.screenshot({ path: `${SHOTS}/landscape-booking-picked.png`, fullPage: true });
});

await check("guest: keyboard — Tab to a house, Enter opens it; a taken house cannot be chosen", async () => {
  await pg.locator(`[data-target="${MOMIJI}"]`).focus();
  await pg.keyboard.press("Enter");
  const panel = pg.locator("#bmap-panel");
  await panel.locator(".bmap__chip", { hasText: "Not available" }).waitFor();
  assert(await pg.evaluate(() => document.activeElement?.id) === "bmap-panel", "focus moved to the details");
  assert(await panel.locator(".unit-pick__btn").count() === 0, "no choose button for a taken house");
});

await check("guest: zoom in / out / fit", async () => {
  const w0 = (await pg.locator(".bmap__svg").boundingBox()).width;
  await pg.getByRole("button", { name: "Zoom in" }).click();
  const w1 = (await pg.locator(".bmap__svg").boundingBox()).width;
  assert(w1 > w0 * 1.4, `${w0} → ${w1}`);
  await pg.getByRole("button", { name: "Fit" }).click();
  assert(Math.abs((await pg.locator(".bmap__svg").boundingBox()).width - w0) < 2, "back to fit");
});

await check("switched off by the Super Admin: the booking page has no map", async () => {
  assert((await api("PUT", "/api/admin/landscape/settings", { enabled: false })).status === 200, "switch off");
  await pg.reload();
  await pg.locator(".unit-grid").first().waitFor();
  await pg.waitForTimeout(500);
  assert(await pg.locator(".bmap").count() === 0, "no map");
  assert((await api("PUT", "/api/admin/landscape/settings", { enabled: true })).status === 200, "switch on again");
});

// ------------------------------------------------------------------ phase L4: satellite plans, control points
let SAT = "";
/** A world point of the editor canvas (any plan) on the screen. */
async function screenOf(x, y) {
  const vb = (await pa.locator(".lse-canvas svg").getAttribute("viewBox")).split(" ").map(Number);
  const box = await svgBox();
  return [box.x + ((x - vb[0]) / vb[2]) * box.width, box.y + ((y - vb[1]) / vb[3]) * box.height];
}

await check("satellite plan (L4): imagery from the Worker, credit shown; a house drawn is stored as longitude / latitude", async () => {
  const made = await api("POST", "/api/admin/landscape/layouts", { name: "Satellite", backgroundKind: "SATELLITE" });
  assert(made.status === 201, JSON.stringify(made.body));
  SAT = made.body.data.id;
  const [cLon, cLat] = made.body.data.draft.background.center;
  const tiles = pa.waitForResponse((r) => r.url().includes("/sat-tiles/") && r.status() === 200);
  await pa.goto(`${BASE}/en/admin/landscape/${SAT}`);
  await pa.locator(".lse-canvas svg").waitFor();
  await tiles;
  assert(await pa.locator('.lse-canvas svg image[href^="/sat-tiles/"]').count() > 0, "tiles drawn");
  await pa.getByRole("link", { name: "© MapTiler" }).waitFor();
  await pa.getByRole("button", { name: "House", exact: true }).click();
  const [x1, y1] = await screenOf(780, 480);
  const [x2, y2] = await screenOf(800, 495);
  await pa.mouse.move(x1, y1);
  await pa.mouse.down();
  await pa.mouse.move(x2, y2, { steps: 5 });
  await pa.mouse.up();
  await pa.getByLabel("Booking link").selectOption("dev_vip_01").catch(() => undefined);
  await pa.getByLabel("Name / text").fill("Sunrise");
  await pa.getByLabel("Name / text").press("Enter");
  await saved();
  const doc = (await layout(SAT)).draft;
  const house = doc.objects.find((o) => o.label === "Sunrise");
  assert(doc.crs === "WGS84" && house, JSON.stringify(doc));
  assert(Math.abs(house.shape.x - cLon) < 0.001 && Math.abs(house.shape.y - cLat) < 0.001, `near the centre: ${JSON.stringify(house.shape)}`);
  if (SHOTS) await pa.screenshot({ path: `${SHOTS}/landscape-satellite-editor.png` });
});

await check("satellite plan: a new centre moves the frame, the house stays on the earth; imagery for the new area after the save", async () => {
  const before = (await layout(SAT)).draft.objects.find((o) => o.label === "Sunrise").shape;
  await pa.getByRole("tab", { name: "Background" }).click();
  const field = pa.getByLabel("Centre (latitude, longitude)");
  const newTiles = pa.waitForResponse((r) => /\/sat-tiles\/\d+\/\d+\/\d+\?v=/.test(r.url()) && r.status() === 200, { timeout: 20_000 });
  await field.fill("18.788300, 98.985300");
  await field.press("Enter");
  await saved();
  await newTiles;
  const doc = (await layout(SAT)).draft;
  assert(JSON.stringify(doc.background.center) === JSON.stringify([98.9853, 18.7883]), JSON.stringify(doc.background));
  assert(JSON.stringify(doc.objects.find((o) => o.label === "Sunrise").shape) === JSON.stringify(before), "the house did not move on the earth");
  await field.fill("not a place");
  await field.press("Enter");
  await pa.getByText("Not a place — type it like 13.756300, 100.501800").waitFor();
});

await check("photo plan: two control points measure it; a satellite plan is made from it with everything in place", async () => {
  await pa.goto(`${BASE}/en/admin/landscape/${PHOTO}`);
  await pa.locator(".lse-canvas svg image").first().waitFor({ timeout: 20_000 });
  await pa.getByRole("tab", { name: "Background" }).click();
  // 3000 × 1500 px photo: pixel (300, 300) and (2700, 300) are 480 m apart east–west (0.2 m / px).
  for (const [px, py, where] of [[300, 300, "13.760000, 100.500000"], [2700, 300, "13.760000, 100.504444"]]) {
    await pa.getByRole("button", { name: "Add a control point" }).click();
    const [sx, sy] = await screenOf(px, py);
    await pa.mouse.click(sx, sy);
    const field = pa.getByLabel("Real coordinates of the new point");
    await field.fill(where);
    await field.press("Enter");
  }
  await pa.getByText(/move, turn, scale \(2 points\) · 1 photo pixel ≈ 0\.20 m/).waitFor();
  await saved();
  const bg = (await layout(PHOTO)).draft.background;
  assert(bg.controlPoints.length === 2 && Math.abs(bg.controlPoints[0].image[0] - 0.1) < 0.01, JSON.stringify(bg.controlPoints));
  if (SHOTS) await pa.screenshot({ path: `${SHOTS}/landscape-control-points.png` });
  await pa.getByRole("button", { name: "Make a satellite plan from this photo" }).click();
  await pa.waitForURL((u) => /\/en\/admin\/landscape\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith(PHOTO), { timeout: 20_000 });
  const id = pa.url().split("/").pop();
  const made = await layout(id);
  assert(made.name === "Aerial (satellite)" && made.draft.crs === "WGS84", JSON.stringify({ name: made.name, crs: made.draft.crs }));
  const grass = made.draft.objects.find((o) => o.kind === "GRASS");
  // The lawn's first corner was at 0.1 / 0.1 of the photo = pixel (300, 150): 0 m east, 30 m north of point 1.
  assert(grass && Math.abs(grass.shape.points[0][0] - 100.5) < 0.00005 && Math.abs(grass.shape.points[0][1] - (13.76 + 30 / 111320)) < 0.00005,
    JSON.stringify(grass?.shape.points[0]));
  await pa.locator('.lse-canvas svg image[href^="/sat-tiles/"]').first().waitFor();
});

await check("guest: a satellite plan on the booking page, with imagery and the credit", async () => {
  // Back over the house (the previous check moved the frame to another town).
  const l0 = await layout(SAT);
  const house = l0.draft.objects.find((o) => o.label === "Sunrise").shape;
  const back = await api("PUT", `/api/admin/landscape/layouts/${SAT}/draft`, { baseRevision: l0.draftRevision, document: { ...l0.draft, background: { ...l0.draft.background, center: [house.x, house.y] } } });
  assert(back.status === 200, JSON.stringify(back.body));
  const pub = await api("POST", `/api/admin/landscape/layouts/${SAT}/publish`, { revision: back.body.data.draftRevision, makePublic: true });
  assert(pub.status === 200, JSON.stringify(pub.body));
  const tiles = pg.waitForResponse((r) => r.url().includes("/sat-tiles/") && r.status() === 200, { timeout: 10_000 }).catch(() => null);
  await pg.goto(`${BASE}/en/booking`);
  await pg.locator(".bmap__svg").waitFor();
  if (!(await tiles)) {
    if (SHOTS) await pg.screenshot({ path: `${SHOTS}/landscape-satellite-debug.png` });
    const href = await pg.locator('.bmap__svg image[href^="/sat-tiles/"]').first().getAttribute("href");
    const r = await req.get(`${BASE}${href}`);
    throw new Error(`no tiles: ${href} → ${r.status()} ${await r.text()} ; plan ${JSON.stringify((await layout(SAT)).draft.background)}`);
  }
  await pg.locator(".bmap__attribution").getByText("© MapTiler").waitFor();
  assert(await pg.locator(".bmap__svg text", { hasText: "Sunrise" }).count() === 1, "house label drawn");
  if (SHOTS) await pg.screenshot({ path: `${SHOTS}/landscape-satellite-booking.png`, fullPage: false });
  assert((await req.get(`${BASE}/sat-tiles/17/0/0`)).status() === 404, "tiles elsewhere: 404");
});

// ------------------------------------------------------------------ phase L5: acceptance — mobile and desktop
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

await check("acceptance 8: booking map and the list on desktop and on a phone — no sideways scrolling", async () => {
  await pa.goto(`${BASE}/en/booking`);
  await pa.locator(".bmap__svg").waitFor();
  await pa.locator(".unit-grid").first().waitFor();
  assert(await overflow(pa) <= 0, `desktop overflow ${await overflow(pa)}`);
  await pg.goto(`${BASE}/en/booking`);
  await pg.locator(".bmap__svg").waitFor();
  assert(await overflow(pg) <= 0, `phone overflow ${await overflow(pg)}`);
  const box = await pg.locator(".bmap__frame").boundingBox();
  assert(box && box.width <= 390 && box.width > 300, `map fits the phone: ${JSON.stringify(box)}`);
});

await check("acceptance 8: the editor on a tablet (iPad portrait) — canvas, tools and panels all usable", async () => {
  await pa.setViewportSize({ width: 820, height: 1180 });
  try {
    await pa.goto(`${BASE}/en/admin/landscape/${LAYOUT}`);
    await pa.locator(".lse-canvas svg [data-id]").first().waitFor();
    assert(await overflow(pa) <= 0, `tablet overflow ${await overflow(pa)}`);
    for (const name of ["House", "Tree", "Fit"]) await pa.getByRole("button", { name, exact: true }).first().waitFor();
    await pa.getByRole("tab", { name: "Layers" }).click();
    await pa.getByRole("tab", { name: "Background" }).click();
    const canvas = await pa.locator(".lse-canvas").boundingBox();
    assert(canvas && canvas.width > 600 && canvas.height > 300, `canvas size ${JSON.stringify(canvas)}`);
    if (SHOTS) await pa.screenshot({ path: `${SHOTS}/landscape-editor-tablet.png` });
  } finally {
    await pa.setViewportSize({ width: 1440, height: 960 });
  }
});

// ------------------------------------------------------------------ iPad: the editor with fingers
const ipadCtx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 820, height: 1180 }, locale: "en-US", hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const ip = await ipadCtx.newPage(); watch(ip);
const cdp = await ipadCtx.newCDPSession(ip);
const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })) });
let IPAD = "";
async function ipScreen(x, y) {
  const vb = (await ip.locator(".lse-canvas svg").getAttribute("viewBox")).split(" ").map(Number);
  const box = await ip.locator(".lse-canvas svg").boundingBox();
  return [box.x + ((x - vb[0]) / vb[2]) * box.width, box.y + ((y - vb[1]) / vb[3]) * box.height];
}
const ipObjects = async () => (await (await req.fetch(`${BASE}/api/admin/landscape/layouts/${IPAD}`, { headers: H })).json()).data.draft.objects;
const ipSaved = () => ip.locator(".lse-status--saved").waitFor({ timeout: 15_000 });

await check("iPad: sign in, open a plan; finger-sized tools and the touch hint", async () => {
  const made = await api("POST", "/api/admin/landscape/layouts", { name: "iPad plan", backgroundKind: "BLANK" });
  IPAD = made.body.data.id;
  await ip.goto(`${BASE}/en/admin/login`);
  await ip.locator("input[autocomplete=username]").fill("admin@example.test");
  await ip.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await ip.locator("form button[type=submit]").tap();
  await ip.waitForURL(`${BASE}/en/admin`);
  await ip.goto(`${BASE}/en/admin/landscape/${IPAD}`);
  await ip.locator(".lse-canvas svg").waitFor();
  await ip.getByText("iPad: two fingers to pan and zoom").waitFor();
  const tool = await ip.getByRole("button", { name: "Tree", exact: true }).boundingBox();
  assert(tool.height >= 44, `tool ${tool.height}px high`);
});

await check("iPad: tap to place trees; a pinch zooms and never leaves a stray tree", async () => {
  await ip.getByRole("button", { name: "Tree", exact: true }).tap();
  for (const [x, y] of [[40, 40], [60, 40]]) { const [sx, sy] = await ipScreen(x, y); await ip.touchscreen.tap(sx, sy); }
  await ipSaved();
  assert((await ipObjects()).filter((o) => o.kind === "TREE").length === 2, "two trees");
  const w0 = Number((await ip.locator(".lse-canvas svg").getAttribute("viewBox")).split(" ")[2]);
  const [cx, cy] = await ipScreen(100, 60);
  await touch("touchStart", [[cx, cy]]);
  await touch("touchStart", [[cx, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[cx - i * 20, cy], [cx + 40 + i * 20, cy]]);
  await touch("touchEnd", []);
  const w1 = Number((await ip.locator(".lse-canvas svg").getAttribute("viewBox")).split(" ")[2]);
  assert(w1 < w0 * 0.5, `pinched in: ${w0} → ${w1}`);
  await ip.waitForTimeout(3000);
  assert((await ipObjects()).filter((o) => o.kind === "TREE").length === 2, "still two trees after the pinch");
  await ip.getByRole("button", { name: "Fit" }).tap();
});

await check("iPad: draw a lawn by tapping its corners, then “Finish”; select several by tapping", async () => {
  await ip.getByRole("button", { name: "Grass / lawn", exact: true }).tap();
  for (const [x, y] of [[100, 70], [150, 70], [150, 110]]) { const [sx, sy] = await ipScreen(x, y); await ip.touchscreen.tap(sx, sy); }
  await ip.getByRole("button", { name: "Finish", exact: true }).tap();
  await ipSaved();
  const lawn = (await ipObjects()).find((o) => o.kind === "GRASS");
  assert(lawn && lawn.shape.type === "polygon" && lawn.shape.points.length === 3, JSON.stringify(lawn));
  await ip.getByRole("button", { name: "Select / move (V)" }).tap();
  await ip.getByLabel("Select several (tap each)").check();
  for (const [x, y] of [[40, 40], [60, 40]]) { const [sx, sy] = await ipScreen(x, y); await ip.touchscreen.tap(sx, sy); }
  await ip.getByText("3 selected").waitFor(); // the new lawn + the two trees tapped
  const handle = await ip.locator(".lse-canvas .lse-handle").first().boundingBox().catch(() => null);
  if (SHOTS) await ip.screenshot({ path: `${SHOTS}/landscape-ipad.png` });
  assert(handle === null || handle.width >= 18, `handles finger-sized: ${JSON.stringify(handle)}`);
});
await ipadCtx.close();

// ------------------------------------------------------------------ palette: kinds staff add, change, hide, delete
await check("palette: add a kind “Sala”, draw it; rename Tree; hide Flowers", async () => {
  await pa.goto(`${BASE}/en/admin/landscape/${LAYOUT}`);
  await pa.locator(".lse-canvas svg [data-id]").first().waitFor();
  await pa.getByRole("tab", { name: "Kinds" }).click();
  await pa.getByRole("button", { name: "Add a kind" }).click();
  await pa.getByLabel("Name", { exact: true }).fill("Sala");
  await pa.getByLabel("Is a").selectOption("BUILDING");
  await pa.getByRole("button", { name: "Save kind" }).click();
  await pa.getByRole("button", { name: "Edit: Sala" }).waitFor();
  // Draw one.
  await pa.getByRole("toolbar").getByRole("button", { name: "Sala", exact: true }).click();
  const [x1, y1] = await screen(130, 80);
  const [x2, y2] = await screen(150, 95);
  await pa.mouse.move(x1, y1);
  await pa.mouse.down();
  await pa.mouse.move(x2, y2, { steps: 5 });
  await pa.mouse.up();
  await saved();
  const drawn = (await layout()).draft.objects.find((o) => o.typeId);
  assert(drawn && drawn.kind === "BUILDING" && drawn.style.fill === "#e0e0e0", JSON.stringify(drawn));
  // Rename a built-in, hide another.
  await pa.getByRole("tab", { name: "Kinds" }).click();
  await pa.getByRole("button", { name: "Edit: Tree" }).click();
  await pa.getByLabel("Name", { exact: true }).fill("Mango tree");
  await pa.getByRole("button", { name: "Save kind" }).click();
  await pa.getByRole("toolbar").getByRole("button", { name: "Mango tree", exact: true }).waitFor();
  await pa.getByRole("button", { name: "Hide: Flowers" }).click();
  await pa.getByRole("button", { name: "Show: Flowers" }).waitFor();
  assert(await pa.getByRole("toolbar").getByRole("button", { name: "Flowers", exact: true }).count() === 0, "hidden from the toolbar");
  // Still there after a reload (stored on the server).
  await pa.reload();
  await pa.getByRole("toolbar").getByRole("button", { name: "Mango tree", exact: true }).waitFor();
  if (SHOTS) {
    await pa.getByRole("tab", { name: "Kinds" }).click();
    await pa.screenshot({ path: `${SHOTS}/landscape-palette.png` });
  }
});

await check("palette: deleting “Sala” says how many are drawn and leaves them; built-ins go back as they ship", async () => {
  await pa.getByRole("tab", { name: "Kinds" }).click();
  await pa.getByRole("button", { name: "Delete: Sala" }).click();
  const dialog = pa.getByRole("dialog");
  await dialog.getByText(/The 1 objects drawn as it stay/).waitFor();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await pa.getByRole("button", { name: "Edit: Sala" }).waitFor({ state: "detached" });
  assert((await layout()).draft.objects.some((o) => o.typeId && o.kind === "BUILDING"), "the drawn sala stays");
  for (const name of ["Mango tree", "Flowers"]) {
    await pa.getByRole("button", { name: `Back to default: ${name}` }).click();
    await pa.getByRole("dialog").getByRole("button", { name: "Back to default" }).click();
  }
  await pa.getByRole("toolbar").getByRole("button", { name: "Tree", exact: true }).waitFor();
  await pa.getByRole("toolbar").getByRole("button", { name: "Flowers", exact: true }).waitFor();
});

console.log("console errors:", consoleErrors.length, consoleErrors.slice(0, 5));
await check("no CSP violations or page errors", async () => {
  const bad = consoleErrors.filter((e) => /Content Security Policy|Refused to|pageerror/i.test(e));
  assert(!bad.length, bad.join("\n"));
});
await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
