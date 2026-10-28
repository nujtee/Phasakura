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

console.log("console errors:", consoleErrors.length, consoleErrors.slice(0, 5));
await check("no CSP violations or page errors", async () => {
  const bad = consoleErrors.filter((e) => /Content Security Policy|Refused to|pageerror/i.test(e));
  assert(!bad.length, bad.join("\n"));
});
await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
