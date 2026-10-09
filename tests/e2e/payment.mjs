// Payment step (migration 0023): ways to pay, PromptPay QR, slip upload, Manual approve, decline with a reason
// (guest told by LINE / e-mail), new-booking notices to staff, PayPal Checkout round trip (fake PayPal).
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const SHOTS = process.env.E2E_SHOTS;
const FIXTURES = process.env.E2E_FIXTURES;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const GROUP = `C${"5e".repeat(16)}`;
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 600)]); console.log("FAIL", name, String(e).slice(0, 600)); }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const day = (offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));
let seq = 0;
function watch(page) {
  page.on("console", (m) => { if (m.type() === "error" && !/status of (401|404|409|422|429)/.test(m.text())) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 250));
  }
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, locale: "en-US" });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;
const cron = () => req.post(`${BASE}/__e2e/cron`);
const emails = async () => (await (await req.get(`${BASE}/__e2e/email`)).json());
const linePushes = async () => (await (await req.get(`${BASE}/__e2e/line`)).json()).pushes;

async function book(body, phone, extra = {}) {
  const full = { adults: 2, children: 0, food: [], lang: "th", ...body };
  const q = await (await req.post(`${BASE}/api/public/bookings/quote`, { headers: H, data: full })).json();
  if (!q.data) throw new Error(JSON.stringify(q));
  const r = await (await req.post(`${BASE}/api/public/bookings`, { headers: H, data: { ...full, customer: { name: `Guest ${++seq}`, phone, ...extra }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `e2e-pay-${Date.now()}-${++seq}` } })).json();
  if (!r.data) throw new Error(JSON.stringify(r));
  return r.data;
}

await check("admin login", async () => {
  await pa.goto(`${BASE}/en/admin/login`);
  await pa.locator("input[autocomplete=username]").fill("admin@example.test");
  await pa.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await pa.locator("form button[type=submit]").click();
  await pa.waitForURL(`${BASE}/en/admin`);
});

await check("payment settings page: PayPal on, Manual approve; secrets shown as set, never their values", async () => {
  await pa.goto(`${BASE}/en/admin/payment-settings`);
  await pa.getByRole("heading", { name: "Payment settings" }).waitFor();
  await pa.getByText(/PayPal: sandbox/).waitFor();
  await pa.getByLabel(/PayPal — card or PayPal account/).check();
  await pa.getByLabel(/Manual approve/).check();
  await pa.getByText(/There is no verification service yet/).waitFor({ state: "detached" }).catch(() => undefined);
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Payment settings saved.").waitFor();
  assert(!/e2e-paypal-(client|secret)/.test(await pa.content()), "PayPal secret leaked");
  await pa.screenshot({ path: `${SHOTS}/pay-settings.png`, fullPage: true });
  const s = await (await req.get(`${BASE}/api/admin/payment-settings`, { headers: H })).json();
  assert(s.data.approvalMode === "MANUAL" && s.data.channels.PAYPAL === true, JSON.stringify(s.data));
});

await check("e-mail page: sender + staff address; test e-mail goes out through Resend", async () => {
  await pa.goto(`${BASE}/en/admin/settings-email`);
  await pa.getByRole("heading", { name: "E-mail notifications", exact: true }).waitFor();
  await pa.getByText("✓ Set").waitFor();
  await pa.getByLabel("Send e-mail notifications").check();
  await pa.getByLabel("Sender address").fill("booking@phasakura.test");
  await pa.getByLabel("Sender name").fill("Phasakura");
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved", { exact: false }).first().waitFor();
  await pa.locator(".email-add").getByLabel("E-mail").fill("owner@phasakura.test");
  await pa.locator(".email-add").getByLabel("Name").fill("Owner");
  await pa.getByRole("button", { name: "Add address" }).click();
  await pa.getByText("Address added.").waitFor();
  await pa.locator("tr", { hasText: "owner@phasakura.test" }).getByRole("button", { name: "Send test" }).click();
  await pa.getByText(/Test e-mail sent/).waitFor();
  const sent = await emails();
  assert(sent.some((m) => m.to[0] === "owner@phasakura.test" && m.from === "Phasakura <booking@phasakura.test>" && /Test/.test(m.subject)), JSON.stringify(sent));
  assert(!/e2e-resend-key/.test(await pa.content()), "Resend key leaked");
  await pa.screenshot({ path: `${SHOTS}/pay-email.png`, fullPage: true });
});

await check("LINE staff chat wants new bookings and payments", async () => {
  const s = await req.put(`${BASE}/api/admin/line/settings`, { headers: H, data: { enabled: true, guestEnabled: false, publicButton: false, reminderDaysBefore: 1, reminderTime: "18:00", sendWhenEmpty: false } });
  assert(s.ok(), await s.text());
  const r = await req.post(`${BASE}/api/admin/line/recipients`, { headers: H, data: { targetId: GROUP, name: "Front desk", language: "th", notifyBooking: true, notifyPayment: true, notifyCheckin: false, notifyFood: false } });
  assert(r.status() === 201, await r.text());
});

// ------------------------------------------------------------------ guest: book in the browser, pay by slip
const guest = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: "th-TH", isMobile: true, hasTouch: true });
const pg = await guest.newPage(); watch(pg);
let A = "";
await check("guest (mobile, TH): booking flow ends on the payment step; PromptPay QR with the amount; choose a channel", async () => {
  const ci = day(20), co = day(22);
  await pg.goto(`${BASE}/th/booking?checkIn=${ci}&checkOut=${co}&adults=2&children=0&unit=house-sakura`);
  await pg.getByRole("button", { name: "ถัดไป" }).click({ timeout: 15000 });
  await pg.locator("#bk-name").fill("สมชาย จ่ายเงิน");
  await pg.locator("#bk-phone").fill("0861234567");
  await pg.locator("#bk-email").fill("somchai@example.test");
  await pg.getByRole("button", { name: "ถัดไป" }).click();
  await pg.getByLabel(/ข้าพเจ้ายอมรับนโยบายความเป็นส่วนตัว/).check();
  await pg.getByRole("button", { name: /ยืนยันการจอง/ }).click();
  await pg.getByRole("heading", { name: "จองเรียบร้อย" }).waitFor();
  A = (await pg.locator(".confirmation__value").textContent()).trim();
  await pg.locator(".flow-steps [aria-current=step]", { hasText: "ชำระเงิน" }).waitFor();
  await pg.getByRole("group", { name: "เลือกช่องทางชำระเงิน" }).waitFor();
  for (const label of ["พร้อมเพย์", "โอนเข้าบัญชี", "PayPal"]) await pg.getByRole("radio", { name: new RegExp(label) }).waitFor();
  const qr = pg.locator("svg.qr");
  await qr.waitFor();
  assert(/PromptPay QR สำหรับชำระ ฿/.test(await qr.getAttribute("aria-label")), "QR label with the amount");
  const box = await qr.boundingBox();
  assert(box.width >= 180, `QR too small ${box.width}`);
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `horizontal scroll ${overflow}px`);
  await pg.locator(".pay").screenshot({ path: `${SHOTS}/pay-step-promptpay.png` });
  await pg.getByRole("radio", { name: /โอนเข้าบัญชี/ }).check();
  await pg.getByText(/โอนยอด ฿[\d,]+ เข้าบัญชีนี้/).waitFor();
  await pg.locator(".pay").screenshot({ path: `${SHOTS}/pay-step-bank.png` });
});

await check("guest attaches the slip (bank transfer) → waiting for staff (Manual approve)", async () => {
  await pg.locator(".slip input[type=file]").setInputFiles(`${FIXTURES}/g1.png`);
  await pg.getByRole("button", { name: "ส่งสลิป" }).click();
  await pg.getByText("ได้รับการชำระเงินแล้ว เจ้าหน้าที่กำลังตรวจสอบ", { exact: false }).waitFor();
  const detail = await (await req.get(`${BASE}/api/admin/bookings/${A}`, { headers: H })).json();
  assert(detail.data.payments[0].channel === "BANK_TRANSFER" && detail.data.paymentStatus === "PENDING_VERIFICATION", JSON.stringify(detail.data.payments));
});

await check("staff hear about the new booking on LINE and e-mail; the guest gets 'booking received'", async () => {
  await cron();
  const pushes = (await linePushes()).filter((p) => p.to === GROUP).map((p) => p.texts.join("\n"));
  assert(pushes.some((t) => /การจองใหม่ — รอชำระเงิน/.test(t) && t.includes(A)), JSON.stringify(pushes));
  const mail = await emails();
  assert(mail.some((m) => m.to[0] === "owner@phasakura.test" && m.subject.includes(`New booking ${A}`)), JSON.stringify(mail.map((m) => m.subject)));
  assert(mail.some((m) => m.to[0] === "somchai@example.test" && m.subject.includes(A) && /กรุณาชำระเงิน/.test(m.subject)), "guest booking received");
});

await check("slip review (Manual): banner, decline with a reason + cancel the booking; the guest is told", async () => {
  await pa.goto(`${BASE}/en/admin/slips`);
  await pa.getByText(/Manual approve: staff approve every payment/).waitFor();
  const card = pa.locator(".adm-slip", { hasText: A });
  await card.getByText("Bank transfer").waitFor();
  await card.getByRole("button", { name: "Decline / cancel" }).click();
  const dialog = pa.locator("dialog.slip-decline");
  await dialog.getByLabel(/Reason \(sent to the guest\)/).fill("ไม่พบยอดเงินเข้าบัญชี กรุณาติดต่อเรา");
  await dialog.getByLabel(/Cancel this booking/).check();
  await pa.screenshot({ path: `${SHOTS}/pay-decline-dialog.png` });
  await dialog.getByRole("button", { name: /Cancel this booking/ }).click();
  await pa.getByText("Booking cancelled — the guest was told.").waitFor();
  await cron();
  const mail = (await emails()).find((m) => m.to[0] === "somchai@example.test" && /ถูกยกเลิก/.test(m.subject));
  assert(mail && mail.text.includes("ไม่พบยอดเงินเข้าบัญชี กรุณาติดต่อเรา"), JSON.stringify(mail));
  await pg.goto(`${BASE}/th/booking/lookup?code=${A}`);
  assert((await pg.locator("#lk-code").inputValue()) === A, "code from the link");
  await pg.locator("#lk-phone").fill("0861234567");
  await pg.locator("form button[type=submit]").click();
  await pg.getByText("การจองนี้ถูกยกเลิก — ไม่พบยอดเงินเข้าบัญชี กรุณาติดต่อเรา").waitFor();
});

await check("approve: another slip is approved → confirmed, staff and guest told", async () => {
  const B = await book({ checkIn: day(24), checkOut: day(25), stay: { kind: "UNIT", unitId: "dev_house_02" } }, "0861111111", { email: "b@example.test" });
  await pg.goto(`${BASE}/th/booking/lookup?code=${B.bookingCode}`);
  await pg.locator("#lk-phone").fill("0861111111");
  await pg.locator("form button[type=submit]").click();
  await pg.getByRole("radio", { name: /โอนเข้าบัญชี/ }).check();
  await pg.locator(".slip input[type=file]").setInputFiles(`${FIXTURES}/g2.png`);
  await pg.getByRole("button", { name: "ส่งสลิป" }).click();
  await pg.getByText("ได้รับการชำระเงินแล้ว", { exact: false }).waitFor();
  await pa.goto(`${BASE}/en/admin/slips`);
  const card = pa.locator(".adm-slip", { hasText: B.bookingCode });
  await card.getByRole("button", { name: "Approve" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Approve" }).click();
  await pa.getByText(/Approved — the booking is confirmed/).waitFor();
  await cron();
  assert((await emails()).some((m) => m.to[0] === "b@example.test" && /ยืนยันการจอง/.test(m.subject)), "guest confirmed e-mail");
});

// ------------------------------------------------------------------ PayPal round trip
await check("PayPal: guest pays at (fake) PayPal and comes back to a confirmed booking", async () => {
  const C = await book({ checkIn: day(26), checkOut: day(27), stay: { kind: "UNIT", unitId: "dev_vip_01" } }, "0862222222");
  // Stand-in for PayPal's approval page: it sends the guest back to our return_url, as PayPal does.
  await pg.route("https://www.sandbox.paypal.com/**", (route) => {
    const token = new URL(route.request().url()).searchParams.get("token");
    return route.fulfill({ status: 302, headers: { location: `${BASE}/th/booking/lookup?paypal=return&code=${C.bookingCode}&token=${token}&PayerID=FAKEPAYER` } });
  });
  await pg.goto(`${BASE}/th/booking/lookup?code=${C.bookingCode}`);
  await pg.locator("#lk-phone").fill("0862222222");
  await pg.locator("form button[type=submit]").click();
  await pg.getByRole("radio", { name: /PayPal/ }).check();
  await pg.locator(".pay").screenshot({ path: `${SHOTS}/pay-step-paypal.png` });
  await pg.getByRole("button", { name: /ชำระด้วย PayPal/ }).click();
  await pg.waitForURL(/\/th\/booking\/lookup/);
  await pg.getByText("ชำระเงินผ่าน PayPal สำเร็จ การจองของคุณได้รับการยืนยันแล้ว").waitFor({ timeout: 15000 });
  // The phone was kept for this tab only: the booking opens by itself, confirmed.
  await pg.locator(".status-pill--confirmed").waitFor();
  assert(!/paypal=return|token=/.test(pg.url()), `query cleaned ${pg.url()}`);
  const calls = (await (await req.get(`${BASE}/__e2e/paypal`)).json()).requests;
  assert(calls.filter((c) => c.endsWith("/capture")).length === 1, JSON.stringify(calls));
  await pg.screenshot({ path: `${SHOTS}/pay-paypal-done.png`, fullPage: true });
  await pg.unroute("https://www.sandbox.paypal.com/**");
});

await check("PayPal declined → nothing taken, the guest can choose again", async () => {
  const D = await book({ checkIn: day(28), checkOut: day(29), stay: { kind: "UNIT", unitId: "dev_vip_01" } }, "0863333333");
  await req.post(`${BASE}/__e2e/paypal/mode`, { data: { mode: "DECLINED" } });
  await pg.route("https://www.sandbox.paypal.com/**", (route) => {
    const token = new URL(route.request().url()).searchParams.get("token");
    return route.fulfill({ status: 302, headers: { location: `${BASE}/th/booking/lookup?paypal=return&code=${D.bookingCode}&token=${token}` } });
  });
  await pg.goto(`${BASE}/th/booking/lookup?code=${D.bookingCode}`);
  await pg.locator("#lk-phone").fill("0863333333");
  await pg.locator("form button[type=submit]").click();
  await pg.getByRole("radio", { name: /PayPal/ }).check();
  await pg.getByRole("button", { name: /ชำระด้วย PayPal/ }).click();
  await pg.getByText(/PayPal ตัดเงินไม่สำเร็จ ยังไม่มีการตัดเงิน/).waitFor({ timeout: 15000 });
  await pg.getByRole("group", { name: "เลือกช่องทางชำระเงิน" }).waitFor();
  await pg.unroute("https://www.sandbox.paypal.com/**");
  await req.post(`${BASE}/__e2e/paypal/mode`, { data: { mode: "COMPLETED" } });
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
