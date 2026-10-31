// Several stays in one booking (migration 0026): the guest picks two houses, a VIP tent and camping with guests per
// stay; staff cancel one stay from the booking page (new total) and refund what was paid for it.
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const SHOTS = process.env.E2E_SHOTS;
const FIXTURES = process.env.E2E_FIXTURES;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 600)]); console.log("FAIL", name, String(e).slice(0, 600)); }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const day = (offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));
const baht = (s) => `฿${(s / 100).toLocaleString("en-US")}`;
function watch(page) {
  page.on("console", (m) => { if (m.type() === "error" && !/status of (401|404|409|422|429)/.test(m.text())) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, locale: "en-US" });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;

await check("admin login", async () => {
  await pa.goto(`${BASE}/en/admin/login`);
  await pa.locator("input[autocomplete=username]").fill("admin@example.test");
  await pa.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await pa.locator("form button[type=submit]").click();
  await pa.waitForURL(`${BASE}/en/admin`);
});

const guest = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: "th-TH", isMobile: true, hasTouch: true });
const pg = await guest.newPage(); watch(pg);
let CODE = "";

await check("guest (mobile, TH) picks two houses, a VIP tent and camping in one booking, with guests per stay", async () => {
  const ci = day(30), co = day(32);
  await pg.goto(`${BASE}/th/booking?checkIn=${ci}&checkOut=${co}&adults=6&children=1`);
  await pg.locator("form.stay-search button[type=submit]").click();
  const card = (name) => pg.locator(".unit-pick", { has: pg.getByRole("heading", { name }) });
  await card(/House 01/).getByRole("button", { name: "เลือกหลังนี้" }).click();
  const picks = pg.locator("#picks");
  await picks.getByRole("heading", { name: "ที่พักที่เลือก" }).waitFor();
  await card(/House 02/).getByRole("button", { name: "เพิ่มหลังนี้" }).click();
  await card(/VIP-01/).getByRole("button", { name: "เพิ่มหลังนี้" }).click();
  await card(/House 01/).getByRole("button", { name: /เลือกแล้ว/ }).waitFor();
  // The bar follows the guest down the page …
  await card(/VIP-01/).scrollIntoViewIfNeeded();
  await pg.locator(".picks-bar").getByText("3 รายการ").waitFor();
  // … and steps aside while the panel's own total and "next" are on screen.
  await picks.locator(".picks__foot").scrollIntoViewIfNeeded();
  await pg.locator(".picks-bar").waitFor({ state: "detached" });
  // Guests split from the search (6 adults, 1 child): House 01 takes 4, House 02 the other 2 + the child; VIP gets 1.
  const value = (stay, what) => picks.getByRole("group", { name: new RegExp(`${stay}.* · ${what}$`) }).locator("output").textContent();
  assert(await value("House 01", "ผู้ใหญ่") === "4", "House 01: 4 adults");
  assert(await value("House 02", "ผู้ใหญ่") === "2" && await value("House 02", "เด็ก") === "1", "House 02: 2 + 1");
  assert(await value("VIP-01", "ผู้ใหญ่") === "1", "VIP: 1 adult");
  // One fewer in House 01; one more in the VIP tent.
  await picks.getByRole("group", { name: /House 01.* · ผู้ใหญ่$/ }).getByRole("button", { name: /^ลด / }).click();
  await picks.getByRole("group", { name: /VIP-01.* · ผู้ใหญ่$/ }).getByRole("button", { name: /^เพิ่ม / }).click();
  await picks.getByText("รวม 3 รายการ · ผู้ใหญ่ 7 · เด็ก 1").waitFor();

  // Camping joins the same booking: 2 adults, 1 tent.
  const form = pg.getByRole("form", { name: "เลือกวันที่ จำนวนคน และจำนวนเต็นท์" });
  const adults = form.getByRole("group", { name: "ผู้ใหญ่" });
  for (let i = 0; i < 4; i++) await adults.getByRole("button", { name: /^ลด / }).click();
  await form.getByRole("group", { name: "เด็ก" }).getByRole("button", { name: /^ลด / }).click();
  await form.getByRole("button", { name: "เพิ่มลานกางเต็นท์ในการจองนี้" }).click();
  await picks.getByText("รวม 4 รายการ · ผู้ใหญ่ 9 · เด็ก 1").waitFor();
  await picks.getByText("ผู้ใหญ่ 2 · เด็ก 0").waitFor();
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `horizontal scroll ${overflow}px`);
  await picks.screenshot({ path: `${SHOTS}/multistay-picks.png` });
  await pg.screenshot({ path: `${SHOTS}/multistay-bar.png` });

  await picks.getByRole("button", { name: /ถัดไป/ }).click();
  await pg.getByRole("heading", { name: "รายการเพิ่มเติม" }).waitFor();
  const stay = pg.locator(".flow-stay");
  for (const name of ["House 01", "House 02", "VIP-01", "1 เต็นท์"]) await stay.getByText(name, { exact: false }).first().waitFor();
  const summary = pg.locator(".summary").first();
  await summary.locator(".summary__line--stay", { hasText: "House 02" }).getByText("ผู้ใหญ่ 2 · เด็ก 1").waitFor();
  await summary.locator(".summary__line--stay", { hasText: "VIP-01" }).getByText("ผู้ใหญ่ 2 · เด็ก 0").waitFor();
  await pg.getByRole("button", { name: /ถัดไป/ }).click();
  await pg.locator("#bk-name").fill("กลุ่ม เพื่อนเที่ยว");
  await pg.locator("#bk-phone").fill("0867777777");
  await pg.getByRole("button", { name: /ถัดไป/ }).click();
  await pg.getByLabel(/ข้าพเจ้ายอมรับนโยบายความเป็นส่วนตัว/).check();
  await pg.getByRole("button", { name: /ยืนยันการจอง/ }).click();
  await pg.getByRole("heading", { name: "จองเรียบร้อย" }).waitFor();
  CODE = (await pg.locator(".confirmation__value").first().textContent()).trim();
  await pg.screenshot({ path: `${SHOTS}/multistay-confirmation.png`, fullPage: true });

  const b = (await (await req.get(`${BASE}/api/admin/bookings/${CODE}`)).json()).data;
  assert(b.items.length === 4, `stays ${b.items.length}`);
  assert(JSON.stringify(b.items.map((i) => [i.adults, i.children])) === JSON.stringify([[3, 0], [2, 1], [2, 0], [2, 0]]), JSON.stringify(b.items.map((i) => [i.adults, i.children])));
  assert(b.adults === 9 && b.children === 1, `${b.adults}/${b.children}`);
});

await check("admin: the booking lists its stays; cancelling the VIP tent alone gives a new total", async () => {
  await pa.goto(`${BASE}/en/admin/bookings`);
  await pa.locator("tr", { hasText: CODE }).getByText(/House 01.*\+.*House 02.*\+.*VIP-01.*\+/).waitFor();
  await pa.goto(`${BASE}/en/admin/bookings/${CODE}`);
  await pa.getByRole("heading", { name: "Stays in this booking (4)" }).waitFor();
  const before = (await (await req.get(`${BASE}/api/admin/bookings/${CODE}`)).json()).data;
  const vip = before.items.find((i) => i.unitId === "dev_vip_01");
  const stay = pa.locator(".adm-stay", { has: pa.getByRole("heading", { name: /VIP-01/ }) });
  await stay.getByRole("button", { name: "Cancel this stay" }).click();
  const dialog = pa.locator("dialog[open]");
  await dialog.getByRole("heading", { name: /Cancel VIP-01/ }).waitFor();
  await dialog.getByLabel(/Reason for cancelling/).fill("One tent less");
  await pa.screenshot({ path: `${SHOTS}/multistay-cancel-dialog.png` });
  await dialog.getByRole("button", { name: "Cancel this stay" }).click();
  const total = before.totalSatang - vip.subtotalSatang;
  await pa.getByText(`VIP-01 cancelled — new total ${baht(total)}.`, { exact: false }).waitFor();
  await stay.getByText("Cancelled").waitFor();
  await pa.getByRole("heading", { name: "Stays in this booking (3)" }).waitFor();
  // "Record payment" now asks for the new total, not the old one.
  const amount = await pa.getByLabel(/Amount \(THB\)/).inputValue();
  assert(amount === String(total / 100), `record payment amount ${amount}`);
  await pa.screenshot({ path: `${SHOTS}/multistay-admin.png`, fullPage: true });
  const after = (await (await req.get(`${BASE}/api/admin/bookings/${CODE}`)).json()).data;
  assert(after.totalSatang === total && after.status === "PENDING", `${after.totalSatang} ${after.status}`);
  // The guest page shows the stay as cancelled and asks for the new total.
  await pg.goto(`${BASE}/th/booking/lookup?code=${CODE}`);
  await pg.locator("#lk-phone").fill("0867777777");
  await pg.locator("form button[type=submit]").click();
  await pg.locator(".summary__line--cancelled", { hasText: "VIP-01" }).getByText("ยกเลิกแล้ว").waitFor();
  await pg.locator(".pay__amount").getByText(baht(total)).waitFor();
});

await check("paid booking: cancelling a stay shows the money to refund; staff refund it from the payment", async () => {
  const body = { checkIn: day(40), checkOut: day(41), stays: [
    { kind: "UNIT", unitId: "dev_house_02", adults: 2, children: 0 }, { kind: "UNIT", unitId: "dev_vip_02", adults: 2, children: 0 },
  ], food: [], lang: "en" };
  const q = await (await req.post(`${BASE}/api/public/bookings/quote`, { headers: H, data: body })).json();
  const created = await (await req.post(`${BASE}/api/public/bookings`, { headers: H, data: { ...body, customer: { name: "Paid Group", phone: "0868888888" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `e2e-multi-${Date.now()}` } })).json();
  const P = created.data;
  assert(P, JSON.stringify(created));
  const paid = await req.post(`${BASE}/api/admin/bookings/${P.bookingCode}/payments`, { headers: H, data: { amountSatang: P.totalSatang, method: "BANK_TRANSFER", paidAt: new Date().toISOString() } });
  assert(paid.ok(), await paid.text());
  await pa.goto(`${BASE}/en/admin/bookings/${P.bookingCode}`);
  const vipSub = P.items[1].subtotalSatang;
  const stay = pa.locator(".adm-stay", { has: pa.getByRole("heading", { name: /VIP-02/ }) });
  await stay.getByRole("button", { name: "Cancel this stay" }).click();
  const dialog = pa.locator("dialog[open]");
  await dialog.getByLabel(/Reason for cancelling/).fill("VIP not needed");
  await dialog.getByRole("button", { name: "Cancel this stay" }).click();
  await pa.locator("#payment").getByText(`The guest paid ${baht(vipSub)} more than the total (a stay was cancelled).`, { exact: false }).waitFor();
  await pa.locator("#payment").getByRole("button", { name: "Refund" }).click();
  if ((await pa.getByLabel("Refund amount (THB)").inputValue()) !== String(vipSub / 100)) throw new Error("refund amount not the overpaid money");
  await pa.locator("form.adm-subform").getByLabel("Reason").fill("VIP tent cancelled");
  await pa.locator("form.adm-subform").getByRole("button", { name: "Refund" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Refund" }).click();
  await pa.getByText("Refund recorded", { exact: false }).first().waitFor();
  const b = (await (await req.get(`${BASE}/api/admin/bookings/${P.bookingCode}`)).json()).data;
  assert(b.overpaidSatang === 0 && b.paidSatang === b.totalSatang && b.status === "CONFIRMED", JSON.stringify([b.overpaidSatang, b.paidSatang, b.totalSatang, b.status]));
  await pa.screenshot({ path: `${SHOTS}/multistay-refund.png`, fullPage: true });
});

await check("booking page: a date search shows the time-based price of those nights and the total", async () => {
  const ci = day(60), co = day(62);
  const rule = { targetType: "UNIT_TYPE", unitId: null, unitType: "VIP_TENT", name: "e2e peak", dateFrom: ci, dateTo: ci, daysOfWeek: "0123456", priceSatang: 590000, priority: 9, status: "ACTIVE" };
  const made = await req.post(`${BASE}/api/admin/pricing-rules`, { headers: H, data: rule });
  assert(made.ok(), `rule: ${made.status()} ${await made.text()}`);
  const avail = await (await req.get(`${BASE}/api/public/availability?checkIn=${ci}&checkOut=${co}`, { headers: H })).json();
  const vip = avail.data.units.find((u) => u.unitType === "VIP_TENT");
  assert(vip.nightlyPricesSatang[0] === 590000 && vip.nightlyPricesSatang.length === 2, `nightly ${JSON.stringify(vip.nightlyPricesSatang)}`);
  const base = vip.nightlyPricesSatang[1];
  await pg.goto(`${BASE}/th/booking?checkIn=${ci}&checkOut=${co}&adults=2&children=0`);
  await pg.locator("form.stay-search button[type=submit]").click();
  const card = pg.locator(".unit-pick", { has: pg.getByRole("heading", { name: /VIP-01/ }) });
  const price = card.locator(".unit-card__price-block");
  await price.getByText(`${baht(Math.min(base, 590000))} – ${baht(Math.max(base, 590000))}`).waitFor();
  await price.getByText(baht(590000 + base)).waitFor();
  assert(/รวม 2 คืน/.test(await price.textContent()), "total for 2 nights");
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/booking-search-prices.png` });
});

console.log("console errors:", consoleErrors.length, consoleErrors.slice(0, 5));
await check("extra beds: staff switch them on (houses page), the guest adds one on the food step and the price follows", async () => {
  await pa.goto(`${BASE}/en/admin/houses`);
  const card = pa.locator(".adm-extrabeds:not(.adm-pets):not(.adm-movesettings)");
  await card.getByRole("heading", { name: "Extra beds" }).waitFor();
  await card.getByText("Guests cannot add them yet").waitFor();
  await card.getByRole("button", { name: "Settings" }).click();
  await card.getByLabel("Let guests add extra beds when booking").check();
  await card.getByLabel("Price per bed per night (THB)").fill("300");
  await card.getByLabel("Most per unit (beds)").fill("2");
  // Per house (migration 0047): all off, all on, then House 01 off on its own.
  const boxes = card.locator(".adm-extrabeds__unitlist input[type=checkbox]");
  const total = await boxes.count();
  assert(total >= 3, `house switches ${total}`);
  await card.getByRole("button", { name: "All off" }).click();
  assert((await card.locator(".adm-extrabeds__unitlist input:checked").count()) === 0, "all off");
  await card.getByRole("button", { name: "All on" }).click();
  assert((await card.locator(".adm-extrabeds__unitlist input:checked").count()) === total, "all on");
  await card.getByRole("checkbox", { name: /House 01/ }).uncheck();
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByText("Extra beds settings saved").waitFor();
  await card.getByText(/฿300 per bed per night · up to 2 per unit/).waitFor();
  await card.getByText(`on for ${total - 1} of ${total} units`).waitFor();
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/extra-beds-admin.png` });

  const ci = day(70), co = day(72);
  await pg.goto(`${BASE}/th/booking?checkIn=${ci}&checkOut=${co}&adults=2&children=0`);
  await pg.locator("form.stay-search button[type=submit]").click();
  const unit = pg.locator(".unit-pick", { has: pg.getByRole("heading", { name: /House 02/ }) });
  await unit.getByRole("button", { name: "เลือกหลังนี้" }).click();
  await pg.locator("#picks").getByRole("button", { name: /ถัดไป/ }).click();
  await pg.getByRole("heading", { name: "รายการเพิ่มเติม" }).waitFor();
  const beds = pg.locator(".extra-beds");
  await beds.getByRole("heading", { name: "ที่นอนเสริม" }).waitFor();
  await beds.getByText(/฿300 ต่อที่นอน ต่อคืน · สูงสุด 2 ที่นอนต่อหลัง/).waitFor();
  const summary = pg.locator(".summary");
  const before = await summary.textContent();
  await beds.getByRole("group", { name: "ที่นอนเสริม" }).getByRole("button", { name: /^เพิ่ม / }).click();
  await summary.getByText("ที่นอนเสริม 1 × 2 คืน").waitFor();
  await beds.getByText("ที่นอนเสริม 1 × 2 คืน = ฿600").waitFor();
  assert(before !== await summary.textContent(), "the summary changed");
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `horizontal scroll ${overflow}px`);
  if (SHOTS) await pg.screenshot({ path: `${SHOTS}/extra-beds-guest.png`, fullPage: true });

  // House 02 switched off too: the food step no longer offers beds for it.
  const house2 = (await (await req.get(`${BASE}/api/admin/accommodations?type=HOUSE`)).json()).data.find((u) => Object.values(u.translations ?? {}).some((x) => /House 02/.test(x?.name ?? "")));
  const settingsNow = (await (await req.get(`${BASE}/api/admin/extra-beds`)).json()).data;
  const put = await req.put(`${BASE}/api/admin/extra-beds`, { headers: H, data: { enabled: true, pricePerNightSatang: 30000, maxPerUnit: 2, offUnitIds: [...settingsNow.offUnitIds, house2.id] } });
  assert(put.ok(), `house 02 off: ${put.status()}`);
  const catalogue = (await (await pg.request.get(`${BASE}/api/public/food-options?checkIn=${ci}&checkOut=${co}&lang=th`)).json()).data;
  assert(catalogue.extraBed.offUnitIds.includes(house2.id), "booking page told which houses are off");

  // Off again for the other suites.
  const r = await req.put(`${BASE}/api/admin/extra-beds`, { headers: H, data: { enabled: false, pricePerNightSatang: 30000, maxPerUnit: 2, offUnitIds: [] } });
  assert(r.ok(), `switch off: ${r.status()}`);
});

await check("pets: a separate switch next to extra beds; the guest adds a pet, sees the weight limit and the price", async () => {
  await pa.goto(`${BASE}/en/admin/houses`);
  const card = pa.locator(".adm-pets");
  await card.getByRole("heading", { name: "Pet fee" }).waitFor();
  await card.getByText("Pets not allowed (guests cannot add them)").waitFor();
  await card.getByRole("button", { name: "Settings" }).click();
  await card.getByLabel("Allow pets (guests add them when booking)").check();
  await card.getByLabel("Price per pet (THB)").fill("200");
  await card.getByLabel("Charged").selectOption("NIGHT");
  await card.getByLabel("Heaviest pet (kg each)").fill("15");
  await card.getByLabel("Most per unit (pets)").fill("2");
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByText("Pet settings saved").waitFor();
  await card.getByText(/฿200 per pet per night · up to 15 kg · up to 2 per unit/).waitFor();
  // Extra beds keep their own switch (off).
  await pa.locator(".adm-extrabeds:not(.adm-pets):not(.adm-movesettings)").getByText("Guests cannot add them yet").waitFor();
  if (SHOTS) await pa.locator(".adm-pets").screenshot({ path: `${SHOTS}/pets-admin.png` });

  const ci = day(80), co = day(82);
  await pg.goto(`${BASE}/th/booking?checkIn=${ci}&checkOut=${co}&adults=2&children=0`);
  await pg.locator("form.stay-search button[type=submit]").click();
  const unit = pg.locator(".unit-pick", { has: pg.getByRole("heading", { name: /House 02/ }) });
  await unit.getByRole("button", { name: "เลือกหลังนี้" }).click();
  await pg.locator("#picks").getByRole("button", { name: /ถัดไป/ }).click();
  await pg.getByRole("heading", { name: "รายการเพิ่มเติม" }).waitFor();
  await pg.getByText("เลือกรายการเพิ่ม").first().waitFor();
  const pets = pg.locator(".pets");
  await pets.getByText(/฿200 ต่อตัว ต่อคืน · น้ำหนักไม่เกิน 15 กก\. ต่อตัว · สูงสุด 2 ตัวต่อหลัง/).waitFor();
  await pets.getByRole("group", { name: "สัตว์เลี้ยง" }).getByRole("button", { name: /^เพิ่ม / }).click();
  const summary = pg.locator(".summary");
  await summary.getByText("สัตว์เลี้ยง 1 × 2 คืน").waitFor();
  await summary.getByText("น้ำหนักไม่เกิน 15 กก. ต่อตัว").waitFor();
  await pets.getByText("สัตว์เลี้ยง 1 × 2 คืน = ฿400").waitFor();
  if (SHOTS) await pg.screenshot({ path: `${SHOTS}/pets-guest.png`, fullPage: true });
  const r = await req.put(`${BASE}/api/admin/pets`, { headers: H, data: { enabled: false, priceSatang: 20000, chargePer: "NIGHT", maxWeightKg: 15, maxPerUnit: 2 } });
  assert(r.ok(), `switch off: ${r.status()}`);
});

await check("guest changes the dates from the booking page: Booking ID + phone, calendar, fee QR, slip; staff verify → moved", async () => {
  // Staff switch it on (houses page card).
  await pa.goto(`${BASE}/en/admin/houses`);
  const card = pa.locator(".adm-movesettings");
  await card.getByRole("heading", { name: "Guests change their dates" }).waitFor();
  await card.getByRole("button", { name: "Settings" }).click();
  await card.getByLabel("Let guests change their dates from the booking page (Booking ID + phone)").check();
  await card.getByLabel("Date change fee (THB)").fill("300");
  await card.getByLabel("Up to how many days before check-in").fill("3");
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByText("Date change settings saved").waitFor();
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/move-admin.png` });

  // A paid booking (House 01, in 90 days).
  const ci = day(90), co = day(92);
  const body = { checkIn: ci, checkOut: co, stays: [{ kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0 }], food: [], lang: "th" };
  const q = await (await req.post(`${BASE}/api/public/bookings/quote`, { headers: H, data: body })).json();
  const made = await (await req.post(`${BASE}/api/public/bookings`, { headers: H, data: { ...body, customer: { name: "Mover", phone: "0867777777" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `e2e-move-${Date.now()}` } })).json();
  const B = made.data;
  const paid = await req.post(`${BASE}/api/admin/bookings/${B.bookingCode}/payments`, { headers: H, data: { amountSatang: B.totalSatang, method: "BANK_TRANSFER", paidAt: new Date().toISOString() } });
  assert(paid.ok(), `paid ${paid.status()}`);

  // Where it sits on a desktop: next to the page title, above the date search.
  await pa.goto(`${BASE}/th/booking`);
  await pa.locator(".move-launch").waitFor();
  if (SHOTS) await pa.screenshot({ path: `${SHOTS}/move-desktop-head.png`, clip: { x: 0, y: 0, width: 1366, height: 520 } });
  // The guest (mobile, TH).
  await pg.goto(`${BASE}/th/booking`);
  const launch = pg.locator(".move-launch");
  await launch.getByRole("heading", { name: "เลื่อนวันเข้าพัก" }).waitFor();
  await launch.getByLabel("Booking ID").fill(B.bookingCode);
  await launch.getByLabel("เบอร์โทรที่ใช้จอง").fill("0867777777");
  await launch.getByRole("button", { name: "เลื่อนจอง" }).click();
  const panel = pg.locator(".move-panel");
  await panel.getByText(/ค่าเลื่อนวันเข้าพัก ฿300/).waitFor();
  // Next month, first free day after the 10th.
  await panel.getByRole("button", { name: "เดือนถัดไป" }).click();
  await panel.locator(".move-day--ok").first().waitFor();
  const target = panel.locator(".move-day--ok").nth(9);
  await target.click();
  await panel.getByText(/House 01 .* ว่าง/).waitFor();
  await panel.locator(".move-summary").getByText("฿300").first().waitFor();
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `horizontal scroll ${overflow}px`);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/move-guest-pick.png` });
  await panel.getByRole("button", { name: "ยืนยันเลื่อนจอง" }).click();
  await panel.getByRole("heading", { name: "ชำระค่าเลื่อนวันเข้าพัก" }).waitFor();
  await panel.locator(".pay-qr, .pay__body").first().waitFor();
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/move-guest-pay.png` });
  await panel.locator(".slip input[type=file]").setInputFiles(`${FIXTURES}/g1.png`);
  await panel.locator(".slip").getByRole("button").last().click();
  await panel.getByText("ได้รับสลิปแล้ว กำลังตรวจสอบ").waitFor();

  // Staff verify the slip (it is marked as a date change fee) → the stay moves.
  await pa.goto(`${BASE}/en/admin/slips`);
  const item = pa.locator("article", { hasText: B.bookingCode });
  await item.getByText("Date change fee").waitFor();
  if (SHOTS) await item.screenshot({ path: `${SHOTS}/move-admin-slip.png` });
  const queue = await (await req.get(`${BASE}/api/admin/slips`, { headers: H })).json();
  const pay = queue.data.items.find((x) => x.bookingCode === B.bookingCode);
  const ok = await req.post(`${BASE}/api/admin/payments/${pay.paymentId}/verify`, { headers: H, data: {} });
  assert(ok.ok(), `verify ${ok.status()}`);
  const after = (await (await req.get(`${BASE}/api/admin/bookings/${B.bookingCode}`, { headers: H })).json()).data;
  assert(after.checkIn !== ci, "moved");
  assert(after.totalSatang === B.totalSatang + 30000, `total ${after.totalSatang}`);
  await pa.goto(`${BASE}/en/admin/bookings/${B.bookingCode}`);
  await pa.getByRole("heading", { name: "Date changes asked by the guest" }).waitFor();
  await pa.getByText("Moved").first().waitFor();
  const off = await req.put(`${BASE}/api/admin/move-settings`, { headers: H, data: { enabled: false, feeSatang: 30000, minDaysBefore: 3, maxMoves: 1, payMinutes: 60 } });
  assert(off.ok(), `switch off ${off.status()}`);
});

await check("no CSP violations or page errors", async () => {
  const bad = consoleErrors.filter((e) => /Content Security Policy|Refused to|pageerror/i.test(e));
  assert(!bad.length, bad.join("\n"));
});
await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
