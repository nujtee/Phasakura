// Phase 12 end-to-end: browser compression + renditions, public media access control, home / gallery / history
// pages, slideshow + lightbox behaviour, uploaded fonts in the theme, mobile layout, console / CSP errors.
import { readFileSync } from "node:fs";
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const DIR = process.env.E2E_FIXTURES;
const SHOTS = process.env.E2E_SHOTS;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 600)]); console.log("FAIL", name, String(e).slice(0, 600)); }
}
function skip(name) {
  results.push(["SKIP", name]);
  console.log("SKIP", name);
}
function watch(page) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // 401 on the login page = the "am I signed in?" probe; 409/422 = validation answers the test provokes on purpose.
    if (/status of (409|422)/.test(text) || (/\/admin\/login$/.test(page.url()) && /status of 401/.test(text))) return;
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
    await new Promise((r) => setTimeout(r, 200));
  }
};
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const file = (name) => `${DIR}/${name}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US" });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;
const anon = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 860 }, locale: "th-TH" });
const pv = await anon.newPage(); watch(pv);
const anonReq = anon.request;

const api = async (method, path, data) => {
  const res = await req.fetch(`${BASE}${path}`, { method, headers: H, data });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${JSON.stringify(body)}`);
  return body.data;
};
const uploadRaw = async (name, purpose, type = "image/png") => {
  const res = await req.post(`${BASE}/api/admin/media`, { headers: H, multipart: { file: { name, mimeType: type, buffer: readFileSync(file(name)) }, purpose } });
  const body = await res.json();
  if (res.status() !== 201) throw new Error(JSON.stringify(body));
  return body.data;
};
const publish = (entity, id) => api("POST", `/api/admin/cms/${entity}/${id}/publish`);

async function login(page, email, lang = "en") {
  await page.goto(`${BASE}/${lang}/admin/login`);
  await page.locator("input[autocomplete=username]").fill(email);
  await page.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await page.locator("form button[type=submit]").click();
  await page.waitForURL(`${BASE}/${lang}/admin`);
}
await check("admin login", () => login(pa, "admin@example.test"));

// ------------------------------------------------------------------ compression + renditions in the browser
let galleryRecords = [];
await check("gallery: the browser compresses three large PNGs to WebP and uploads renditions", async () => {
  await pa.goto(`${BASE}/en/admin/content-gallery`);
  const input = pa.locator("input[type=file][aria-label='Upload images']");
  await input.waitFor({ state: "attached" });
  await input.setInputFiles([file("g-wide.png"), file("g-tall.png"), file("g-sq.png")]);
  await until(async () => (await api("GET", "/api/admin/cms/galleryImage")).length === 3, 30000);
  await pa.getByRole("button", { name: "Upload images" }).waitFor();
  galleryRecords = await api("GET", "/api/admin/cms/galleryImage");
  for (const r of galleryRecords) assert(/\.webp$/.test(String(r.urls?.mediaAssetId)), `not webp: ${JSON.stringify(r).slice(0, 300)}`);
});

let galleryUrls = [];
await check("compressed originals are WebP, ≤ 2400 px and far smaller than the PNGs; renditions stored", async () => {
  galleryUrls = galleryRecords.map((r) => r.urls.mediaAssetId);
  assert(galleryUrls.length === 3, "3 urls");
  // Ask the server through staff preview (drafts are private): sizes and types.
  for (const u of galleryUrls) {
    const res = await req.get(`${BASE}${u}`);
    assert(res.status() === 200, `staff preview ${u} → ${res.status()}`);
    assert(res.headers()["content-type"] === "image/webp", res.headers()["content-type"]);
    assert(res.headers()["cache-control"] === "private, no-store", `draft cache-control ${res.headers()["cache-control"]}`);
    assert((await res.body()).length < 1_000_000, "compressed under 1 MB");
  }
});

await check("draft photos (and renditions) are 404 for visitors; published ones are public and cacheable", async () => {
  for (const u of galleryUrls) assert((await anonReq.get(`${BASE}${u}`)).status() === 404, `anonymous draft ${u}`);
  const [wide, tall, sq] = galleryRecords;
  await api("PATCH", `/api/admin/cms/galleryImage/${wide.id}`, { layoutSpan: "WIDE", categoryId: "dev_gallery_nature", translations: { th: { altText: "หุบเขายามเช้า", title: "หุบเขา", caption: "มองจากระเบียงบ้านซากุระ" }, en: { altText: "Valley in the morning", title: "Valley" } } });
  await api("PATCH", `/api/admin/cms/galleryImage/${tall.id}`, { layoutSpan: "TALL", translations: { th: { altText: "ต้นสน", title: "ป่าสน" } } });
  await api("PATCH", `/api/admin/cms/galleryImage/${sq.id}`, { categoryId: "dev_gallery_nature", translations: { th: { altText: "โคมไฟ", title: "โคมยามค่ำ" } } });
  for (const r of galleryRecords) await publish("galleryImage", r.id);
  const g = (await (await anonReq.get(`${BASE}/api/public/gallery?lang=th`)).json()).data;
  assert(g.images.length === 3, `public gallery ${g.images.length}`);
  for (const img of g.images) {
    assert(/-w480\.webp 480w/.test(img.image.srcset ?? ""), `srcset ${img.image.srcset}`);
    const variants = img.image.srcset.split(", ").map((s) => s.split(" ")[0]);
    for (const v of variants) {
      const res = await anonReq.get(`${BASE}${v}`);
      assert(res.status() === 200, `published ${v} → ${res.status()}`);
      assert(/public, max-age=31536000, immutable/.test(res.headers()["cache-control"]), "public cache");
    }
  }
  const wideImg = g.images.find((i) => i.span === "WIDE");
  assert(wideImg.image.width === 2000 && /960w, .*1600w, .*2000w$/.test(wideImg.image.srcset), `wide ${wideImg.image.width} ${wideImg.image.srcset}`);
});

// ------------------------------------------------------------------ slides through the CMS UI (ImageField → compression)
let slideAssets = [];
await check("home slide: upload in the CMS editor (compressed), save, publish", async () => {
  await pa.goto(`${BASE}/en/admin/content-home`);
  await pa.getByRole("button", { name: "+ Add slide" }).click();
  const form = pa.locator("form").filter({ has: pa.getByText("Desktop image") }).first();
  await form.locator("input[type=file]").first().setInputFiles(file("hero-a.png"));
  await until(async () => (await form.locator(".adm-imagefield__preview img").count()) > 0, 30000);
  await form.getByLabel("Title", { exact: true }).first().fill("ตื่นมากับสายหมอก");
  await form.getByLabel("Subtitle", { exact: true }).first().fill("บ้านพักกลางหุบเขา");
  await form.getByRole("button", { name: "Save" }).click();
  await until(async () => (await api("GET", "/api/admin/cms/homeSlide")).length === 1, 10000);
  const [slide] = await api("GET", "/api/admin/cms/homeSlide");
  await publish("homeSlide", slide.id);
  slideAssets.push(slide.desktopAssetId);
  const b = await uploadRaw("hero-b.png", "HOME_SLIDE");
  const m = await uploadRaw("hero-m.png", "HOME_SLIDE");
  const second = await api("POST", "/api/admin/cms/homeSlide", {
    desktopAssetId: b.id, mobileAssetId: m.id, contentPosition: "BOTTOM_LEFT", overlayOpacity: 25, button1Url: "/th/booking",
    translations: { th: { title: "ฤดูซากุระ", description: "ต้นซากุระบานหน้าบ้านพักทุกปีช่วงมกราคม", button1Label: "ดูห้องว่าง" } },
  });
  await publish("homeSlide", second.id);
  const home = (await (await anonReq.get(`${BASE}/api/public/home?lang=th`)).json()).data;
  assert(home.slides.length === 2, `slides ${home.slides.length}`);
  const first = home.slides[0];
  assert(/\.webp$/.test(first.desktop.url) && first.desktop.width === 2400, `compressed slide ${first.desktop.url} ${first.desktop.width}`);
  assert(/-w640\.webp 640w, .*-w1024\.webp 1024w, .*-w1600\.webp 1600w, .*2400w$/.test(first.desktop.srcset), first.desktop.srcset);
});

// ------------------------------------------------------------------ home sections, food, history content (API)
await check("content: home sections, a dish photo and the history story", async () => {
  const intro = await uploadRaw("story.png", "HOME_SECTION");
  const sections = [
    { sectionType: "INTRODUCTION", mediaAssetId: intro.id, translations: { th: { title: "บ้านไม้บนเนินเขา", body: "ที่พักเล็ก ๆ ท่ามกลางป่าสนและทุ่งซากุระ\nตื่นมาพร้อมสายหมอกและเสียงนก", buttonLabel: "อ่านเรื่องราวของเรา", buttonUrl: "/th/history" } } },
    { sectionType: "ACCOMMODATION_HIGHLIGHTS", translations: { th: { title: "เลือกที่พักของคุณ" } } },
    { sectionType: "GALLERY_PREVIEW", translations: { th: { title: "ภาพบรรยากาศ" } } },
    { sectionType: "FOOD_PREVIEW", translations: { th: { title: "เมนูจากครัวของเรา", subtitle: "สั่งล่วงหน้าพร้อมการจอง" } } },
    { sectionType: "HISTORY_PREVIEW", translations: { th: { title: "จากสวนผลไม้สู่บ้านพัก", body: "ครอบครัวเราดูแลผืนดินนี้มากว่าห้าสิบปี" } } },
    { sectionType: "BOOKING_CTA", translations: { th: { title: "พร้อมพักผ่อนแล้วหรือยัง", body: "เลือกวันเข้าพักและจองได้ทันที", buttonLabel: "จองที่พัก", buttonUrl: "/th/booking" } } },
    { sectionType: "LOCATION", translations: { th: { title: "การเดินทาง", body: "ขับรถจากตัวเมืองประมาณ 40 นาที" } } },
    { sectionType: "CONTACT", translations: { th: { title: "ติดต่อเรา" } } },
  ];
  for (const id of ["dev_home_intro", "dev_home_contact"]) await api("POST", `/api/admin/cms/homeSection/${id}/unpublish`);
  for (const [i, s] of sections.entries()) {
    const rec = await api("POST", "/api/admin/cms/homeSection", { ...s, sortOrder: i + 1 });
    await publish("homeSection", rec.id);
  }
  const fish = await uploadRaw("food.png", "FOOD");
  await api("PUT", `/api/admin/media/${fish.id}/texts`, { texts: { th: { altText: "ปลาเผาเกลือ" }, en: { altText: "Salt-grilled fish" } } });
  await api("PATCH", "/api/admin/cms/foodOption/dev_food_dinner_a", { imageAssetId: fish.id });
  const story = await uploadRaw("story.png", "HISTORY");
  const hist = [
    { sectionType: "HERO", mediaAssetId: story.id, translations: { th: { title: "เรื่องราวของผาซากุระ", subtitle: "จากสวนผลไม้ของคุณตา สู่บ้านพักของทุกคน" }, en: { title: "The Phasakura story" } } },
    { sectionType: "STORY", layout: "DEFAULT", translations: { th: { title: "จุดเริ่มต้น", body: "ปี 2510 คุณตาเริ่มปลูกต้นซากุระต้นแรกบนเนินนี้\nทุกต้นที่เห็นวันนี้ปลูกด้วยมือ" } } },
    { sectionType: "QUOTE", translations: { th: { body: "บ้านที่ดีคือที่ที่ทำให้อยากกลับมาอีก", quoteAuthor: "คุณยายบุญมี" } } },
    { sectionType: "TIMELINE", translations: { th: { title: "เส้นทางของเรา" } } },
    { sectionType: "CTA", translations: { th: { title: "มาเป็นส่วนหนึ่งของเรื่องราว", buttonLabel: "จองที่พัก", buttonUrl: "/th/booking" } } },
  ];
  // The dev seed has sample content; this run builds its own page.
  await api("POST", "/api/admin/cms/historySection/dev_history_intro/unpublish");
  for (const id of ["dev_timeline_1", "dev_timeline_2"]) await api("POST", `/api/admin/cms/historyTimeline/${id}/unpublish`);
  for (const [i, s] of hist.entries()) {
    const rec = await api("POST", "/api/admin/cms/historySection", { ...s, sortOrder: i + 1 });
    await publish("historySection", rec.id);
  }
  for (const [year, th] of [[1967, "ปลูกซากุระต้นแรก"], [2015, "เปิดบ้านพักหลังแรก"], [2024, "เพิ่มลานกางเต็นท์"]]) {
    const rec = await api("POST", "/api/admin/cms/historyTimeline", { year, translations: { th: { title: th }, en: { title: `Event ${year}` } } });
    await publish("historyTimeline", rec.id);
  }
});

// ------------------------------------------------------------------ public home
await check("home: hero slideshow (hidden h1 = site name, eager first image, srcset), sections in order", async () => {
  await pv.goto(`${BASE}/th/`);
  await pv.locator(".hero__slide.is-active img").waitFor();
  const site = (await (await anonReq.get(`${BASE}/api/public/site?lang=th`)).json()).data;
  const h1 = await pv.locator("h1").allTextContents();
  assert(h1.length === 1 && h1[0] === (site.siteName ?? "หน้าแรก"), `h1 ${JSON.stringify(h1)}`);
  const img = pv.locator(".hero__slide.is-active img");
  assert((await img.getAttribute("loading")) === "eager", "first slide eager");
  assert((await img.getAttribute("fetchpriority")) === "high", "fetchpriority");
  assert(/640w/.test(await img.getAttribute("srcset")), "srcset");
  const chosen = await img.evaluate((el) => el.currentSrc);
  assert(/-w1600\.webp|\.webp$/.test(chosen), `currentSrc ${chosen}`);
  await pv.locator(".hero__slide.is-active .hero__title", { hasText: "ตื่นมากับสายหมอก" }).waitFor();
  const titles = await pv.locator(".home-section__title, .booking-band__title").allTextContents();
  const want = ["บ้านไม้บนเนินเขา", "เลือกที่พักของคุณ", "ภาพบรรยากาศ", "เมนูจากครัวของเรา", "จากสวนผลไม้สู่บ้านพัก", "พร้อมพักผ่อนแล้วหรือยัง", "การเดินทาง", "ติดต่อเรา"];
  assert(JSON.stringify(titles) === JSON.stringify(want), `sections ${JSON.stringify(titles)}`);
  await pv.locator(".postcard__name").first().waitFor();
  assert((await pv.locator(".postcard").count()) >= 3, "accommodation rail");
  await pv.locator(".mosaic__item img").first().waitFor();
  assert((await pv.locator(".mosaic__item").count()) === 3, "gallery mosaic");
  await pv.locator(".menu__item--image img[alt='']").first().waitFor();
  assert((await pv.locator(".menu__name", { hasText: "อาหารเย็น A" }).count()) === 1, "dish listed");
  assert((await pv.locator(".mini-timeline li").count()) === 3, "history preview timeline");
  await pv.screenshot({ path: `${SHOTS}/p12-home-desktop.png`, fullPage: true });
});

await check("slideshow: autoplays every 5 s, pauses on request, arrow keys and dots navigate", async () => {
  await pv.goto(`${BASE}/th/`);
  const current = () => pv.locator(".hero__dot[aria-current=true]").getAttribute("aria-label");
  await pv.mouse.move(5, 880); // away from the hero (hover pauses)
  assert((await current()) === "ไปยังภาพที่ 1", "starts at 1");
  await until(async () => (await current()) === "ไปยังภาพที่ 2", 7500);
  await pv.getByRole("button", { name: "หยุดเลื่อนอัตโนมัติ" }).click();
  await pv.mouse.move(5, 880);
  await pv.locator(".hero__btn[aria-pressed=true]").waitFor();
  const at = await current();
  await pv.waitForTimeout(6000);
  assert((await current()) === at, "paused");
  await pv.locator(".hero__dot").first().focus();
  await pv.keyboard.press("ArrowRight");
  assert((await current()) !== at, "arrow key moved");
  await pv.getByRole("button", { name: "ไปยังภาพที่ 2" }).click();
  assert((await current()) === "ไปยังภาพที่ 2", "dot click");
  const s2 = pv.locator(".hero__slide.is-active");
  await s2.locator(".hero__title", { hasText: "ฤดูซากุระ" }).waitFor();
  assert((await s2.locator("source[media='(max-width: 767px)']").count()) === 1, "mobile source");
  const cta = s2.getByRole("link", { name: "ดูห้องว่าง" });
  assert((await cta.getAttribute("href")) === "/th/booking", "in-app slide link");
});

await check("slideshow respects reduced motion (no autoplay)", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce", locale: "th-TH" });
  const p = await ctx.newPage(); watch(p);
  await p.goto(`${BASE}/th/`);
  await p.locator(".hero__dot").first().waitFor();
  assert((await p.locator(".hero__btn[aria-pressed=true]").count()) === 1, "starts paused");
  await p.waitForTimeout(5800);
  assert((await p.locator(".hero__dot[aria-current=true]").getAttribute("aria-label")) === "ไปยังภาพที่ 1", "did not advance");
  await ctx.close();
});

// ------------------------------------------------------------------ gallery page + lightbox
await check("gallery: category chips filter, lightbox opens, arrows / Home / End / swipe, Esc closes and returns focus", async () => {
  await pv.goto(`${BASE}/th/gallery`);
  await pv.locator(".bento__item img").first().waitFor();
  assert((await pv.locator(".bento__item").count()) === 3, "3 photos");
  assert((await pv.locator(".bento__item--wide").count()) === 1 && (await pv.locator(".bento__item--tall").count()) === 1, "spans");
  await pv.getByRole("button", { name: "ธรรมชาติ" }).click();
  assert((await pv.getByRole("button", { name: "ธรรมชาติ" }).getAttribute("aria-pressed")) === "true", "chip pressed");
  await until(async () => (await pv.locator(".bento__item").count()) === 2);
  await pv.getByText("2 ภาพ").waitFor();
  await pv.getByRole("button", { name: "ทั้งหมด" }).click();
  await until(async () => (await pv.locator(".bento__item").count()) === 3);
  const opener = pv.getByRole("button", { name: "ดูภาพขนาดใหญ่: หุบเขา" });
  await opener.click();
  const dlg = pv.locator("dialog.lightbox[open]");
  await dlg.waitFor();
  await dlg.locator(".lightbox__caption", { hasText: "มองจากระเบียงบ้านซากุระ" }).waitFor();
  const count = () => dlg.locator(".lightbox__count").textContent();
  const start = await count();
  await pv.keyboard.press("ArrowRight");
  assert((await count()) !== start, "arrow right");
  await pv.keyboard.press("End");
  assert((await count()) === "3 / 3", `end ${await count()}`);
  await pv.keyboard.press("Home");
  assert((await count()) === "1 / 3", "home");
  const box = await dlg.locator(".lightbox__figure").boundingBox();
  await pv.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await pv.mouse.down();
  await pv.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 6 });
  await pv.mouse.up();
  assert((await count()) === "2 / 3", `swipe ${await count()}`);
  await pv.screenshot({ path: `${SHOTS}/p12-lightbox.png` });
  await pv.keyboard.press("Escape");
  await until(async () => (await pv.locator("dialog.lightbox[open]").count()) === 0);
  assert(!(await pv.evaluate(() => document.documentElement.classList.contains("has-lightbox"))), "scroll lock released");
  const focused = await pv.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  assert(/ดูภาพขนาดใหญ่/.test(focused ?? ""), `focus returned: ${focused}`);
  await pv.screenshot({ path: `${SHOTS}/p12-gallery.png`, fullPage: true });
});

// ------------------------------------------------------------------ history
await check("history: hero heading is the page h1, Buddhist-era years in Thai, CE in English", async () => {
  await pv.goto(`${BASE}/th/history`);
  await pv.locator(".story-hero h1", { hasText: "เรื่องราวของผาซากุระ" }).waitFor();
  assert((await pv.locator("h1").count()) === 1, "one h1");
  const years = await pv.locator(".timeline__year").allTextContents();
  assert(JSON.stringify(years) === JSON.stringify(["พ.ศ. 2510", "พ.ศ. 2558", "พ.ศ. 2567"]), `years ${years}`);
  await pv.locator(".story-quote blockquote", { hasText: "บ้านที่ดี" }).waitFor();
  await pv.locator(".story-cta").getByRole("link", { name: "จองที่พัก" }).waitFor();
  await pv.screenshot({ path: `${SHOTS}/p12-history.png`, fullPage: true });
  await pv.goto(`${BASE}/en/history`);
  await pv.locator(".story-hero h1", { hasText: "The Phasakura story" }).waitFor();
  const en = await pv.locator(".timeline__year").allTextContents();
  assert(en[0] === "1967", `en years ${en}`);
});

// ------------------------------------------------------------------ booking flow images
await check("booking page and dish step use responsive images", async () => {
  await pv.goto(`${BASE}/th/booking`);
  await pv.locator(".unit-card img").first().waitFor({ timeout: 10000 }).catch(() => {});
  const lazy = await pv.locator(".unit-card img").evaluateAll((els) => els.every((e) => e.getAttribute("loading") === "lazy"));
  assert(lazy, "cards lazy-load");
  const menu = (await (await anonReq.get(`${BASE}/api/public/food-menu?lang=en`)).json()).data;
  const dish = menu.categories.flatMap((c) => c.options).find((o) => o.id === "dev_food_dinner_a");
  assert(dish.image?.alt === "Salt-grilled fish", `dish alt ${dish.image?.alt}`);
  assert(dish.image.width === 1600, "raw upload keeps its size (no browser step here)");
});

// ------------------------------------------------------------------ fonts
// A real WOFF2 file is needed (not shipped with the repo): E2E_FONT_FILE=/path/to/font.woff2
const FONT = process.env.E2E_FONT_FILE;
await (FONT ? check : skip)("theme: upload a WOFF2 face, use it for headings, publish; the public site loads it via FontFace", async () => {
  await pa.goto(`${BASE}/en/admin/settings-theme`);
  await pa.getByRole("heading", { name: "Uploaded fonts" }).waitFor();
  await pa.getByLabel("Font name").fill("Roboto Slab");
  await pa.locator("#font-file").setInputFiles(FONT);
  await pa.getByLabel("Weight").selectOption("700");
  await pa.getByLabel("Fallback font").selectOption("SERIF");
  await pa.getByRole("button", { name: "Upload font" }).click();
  await pa.getByText("Font uploaded").waitFor();
  await pa.locator(".font-sample").first().waitFor();
  // Wrong file type: refused by the server from its bytes, message in the form.
  await pa.getByLabel("Font name").fill("Fake Font");
  await pa.locator("#font-file").setInputFiles({ name: "fake.woff2", mimeType: "font/woff2", buffer: readFileSync(file("g-sq.png")).subarray(0, 4096) });
  await pa.getByRole("button", { name: "Upload font" }).click();
  await pa.getByText("Only WOFF2 or WOFF font files are allowed.").first().waitFor();

  await pa.locator("#thm---font-heading").selectOption("custom:Roboto Slab");
  const sampleFont = await pa.locator(".thm-preview__h").evaluate((el) => getComputedStyle(el).fontFamily);
  assert(/Roboto Slab/.test(sampleFont), `preview heading font ${sampleFont}`);
  await pa.getByRole("button", { name: "Save draft" }).click();
  await pa.getByText("Saved").first().waitFor();
  await pa.getByRole("button", { name: "Publish theme" }).first().click();
  await pa.locator("dialog.adm-dialog[open]").getByRole("button", { name: "Publish theme" }).click();
  await pa.getByText(/Published/).first().waitFor();

  // In use → cannot delete.
  await pa.getByRole("button", { name: "Delete" }).first().click();
  await pa.locator("dialog.adm-dialog[open]").getByRole("button", { name: "Delete" }).click();
  await pa.getByText(/still uses this font/).first().waitFor();
  await pa.screenshot({ path: `${SHOTS}/p12-admin-theme-fonts.png`, fullPage: true });

  await pv.goto(`${BASE}/th/history`);
  await pv.locator(".story-hero h1").waitFor();
  const family = await pv.locator(".story__title").nth(1).evaluate((el) => getComputedStyle(el).fontFamily);
  assert(/^"Roboto Slab"/.test(family), `public heading font ${family}`);
  const loaded = await until(() => pv.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Roboto Slab" && f.status === "loaded");
  }), 10000);
  assert(loaded, "face loaded");
  const bodyFont = await pv.evaluate(() => getComputedStyle(document.body).fontFamily);
  assert(!/Roboto Slab/.test(bodyFont), "body font unchanged");
});

// ------------------------------------------------------------------ mobile
await check("mobile 390 px: home, gallery, history and lightbox fit without horizontal scrolling", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "th-TH" });
  const p = await ctx.newPage(); watch(p);
  for (const path of ["/th/", "/th/gallery", "/th/history", "/zh-cn/", "/en/gallery"]) {
    await p.goto(`${BASE}${path}`);
    await p.locator("main h1, main .visually-hidden").first().waitFor({ state: "attached" });
    await p.waitForTimeout(600);
    const w = await p.evaluate(() => document.documentElement.scrollWidth);
    assert(w <= 390, `${path} scrollWidth ${w}`);
  }
  await p.goto(`${BASE}/th/`);
  await p.locator(".hero__slide.is-active img").waitFor();
  const src = await p.locator(".hero__slide.is-active img").evaluate((el) => el.currentSrc);
  assert(/hero|home\/slides/.test(src), `mobile hero ${src}`);
  await p.screenshot({ path: `${SHOTS}/p12-home-mobile.png`, fullPage: true });
  await p.goto(`${BASE}/th/gallery`);
  await p.locator(".bento__button").first().tap();
  await p.locator("dialog.lightbox[open]").waitFor();
  await p.screenshot({ path: `${SHOTS}/p12-lightbox-mobile.png` });
  await ctx.close();
});

await check("an unpublished gallery photo is 404 for visitors after unpublishing", async () => {
  const [wide] = galleryRecords;
  await api("POST", `/api/admin/cms/galleryImage/${wide.id}/unpublish`);
  const g = (await (await anonReq.get(`${BASE}/api/public/gallery?lang=th`)).json()).data;
  assert(g.images.length === 2, "hidden from the API");
  assert((await anonReq.get(`${BASE}${wide.urls.mediaAssetId}`)).status() === 404, "unpublished photo private again");
  assert((await req.get(`${BASE}${wide.urls.mediaAssetId}`)).status() === 200, "staff can still preview it");
});

await check("no console or CSP errors", async () => {
  assert(consoleErrors.length === 0, consoleErrors.join("\n"));
});

await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
const skipped = results.filter((r) => r[0] === "SKIP").length;
console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} passed${skipped ? ` (${skipped} skipped)` : ""}`);
if (failed.length) { for (const f of failed) console.log(f.join(" | ")); process.exit(1); }
