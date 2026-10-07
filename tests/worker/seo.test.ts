import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { negotiateLocale } from "../../src/shared/i18n/locales.ts";
import type { PageMetaDto } from "../../src/shared/seo-types.ts";
import { PAGE_SECURITY_HEADERS } from "../../src/worker/http/security-headers.ts";
import { injectHead, jsonForScript } from "../../src/worker/seo/html.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

const SHELL = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const BASE = "https://phasakura.test";

let h: Harness;
let root: string;

beforeEach(async () => {
  h = new Harness({ seed: true });
  h.env.ASSETS = { fetch: async () => new Response(SHELL, { headers: { "Content-Type": "text/html" } }) };
  await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
  root = await h.login("root@example.test");
});

const production = () => { (h.env as { APP_ENV: string }).APP_ENV = "production"; };

/** Minimal head parsing for assertions. */
function head(html: string) {
  const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const tags = html.match(/<(meta|link)\b[^>]*>/g) ?? [];
  const metaBy = (key: string) => tags.filter((t) => t.startsWith("<meta") && (attr(t, "name") === key || attr(t, "property") === key)).map((t) => attr(t, "content"));
  return {
    lang: /<html lang="([^"]+)"/.exec(html)?.[1],
    seoPath: /data-seo-path="([^"]+)"/.exec(html)?.[1],
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
    titles: (html.match(/<title>/g) ?? []).length,
    meta: (key: string) => metaBy(key)[0] ?? null,
    metas: metaBy,
    canonical: tags.filter((t) => attr(t, "rel") === "canonical").map((t) => attr(t, "href"))[0] ?? null,
    alternates: tags.filter((t) => attr(t, "rel") === "alternate").map((t) => `${attr(t, "hreflang")} ${attr(t, "href")}`),
    jsonLd: [...html.matchAll(/<script type="application\/ld\+json" data-seo>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>),
  };
}

async function page(path: string, headers: Record<string, string> = {}) {
  const res = await h.get(path, headers);
  return { res, html: await res.text() };
}

describe("app shell with page metadata (Phase 13)", () => {
  it("home: lang, title, description, canonical, hreflang, Open Graph, JSON-LD; dev deployments are noindex", async () => {
    const { res, html } = await page("/th/");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("Content-Language"), "th");
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow", "development is never indexed");
    const m = head(html);
    assert.equal(m.lang, "th");
    assert.equal(m.seoPath, "/th/");
    assert.equal(m.titles, 1, "the shell's empty <title> is replaced");
    assert.equal(m.title, "Phasakura (ตัวอย่าง)", "admin SEO title wins");
    assert.equal(m.meta("description"), "คำอธิบายตัวอย่าง");
    assert.equal(m.meta("robots"), "noindex, nofollow");
    assert.equal(m.canonical, `${BASE}/th/`);
    assert.deepEqual(m.alternates, [`th ${BASE}/th/`, `en ${BASE}/en/`, `zh-Hans ${BASE}/zh-cn/`, `x-default ${BASE}/th/`]);
    assert.equal(m.meta("og:locale"), "th_TH");
    assert.deepEqual(m.metas("og:locale:alternate"), ["en_US", "zh_CN"]);
    assert.equal(m.meta("og:url"), `${BASE}/th/`);
    assert.equal(m.meta("og:site_name"), "Phasakura (ข้อมูลตัวอย่าง)");
    const graph = (m.jsonLd[0]!["@graph"] as Record<string, unknown>[]);
    const lodging = graph.find((g) => g["@type"] === "LodgingBusiness")!;
    assert.equal(lodging.name, "Phasakura (ข้อมูลตัวอย่าง)");
    assert.equal(lodging.telephone, "000-000-0000");
    assert.equal(lodging.priceRange, "฿250 – ฿3,500", "from live active prices (camping per adult … dearest house)");
    assert.deepEqual(lodging.availableLanguage, ["th", "en", "zh-Hans"]);
    for (const [k, v] of Object.entries(PAGE_SECURITY_HEADERS)) assert.equal(res.headers.get(k), v, k);
    assert.match(html, /<div id="root"><\/div>/, "the app shell itself is unchanged");
  });

  it("production: indexable, cached with revalidation, other languages and pages get their own defaults", async () => {
    production();
    const { res, html } = await page("/en/gallery");
    assert.equal(res.headers.get("X-Robots-Tag"), null);
    assert.equal(res.headers.get("Cache-Control"), "public, no-cache");
    const m = head(html);
    assert.equal(m.lang, "en");
    assert.equal(m.title, "Gallery | Phasakura (sample data)");
    assert.equal(m.meta("description"), "Photos of the stay, the rooms and the nature around Phasakura (sample data).");
    assert.equal(m.meta("robots"), "index, follow");
    assert.equal(m.canonical, `${BASE}/en/gallery`);
    assert.ok(m.alternates.includes(`zh-Hans ${BASE}/zh-cn/gallery`));
    const types = m.jsonLd.map((d) => d["@type"]);
    assert.deepEqual(types, ["BreadcrumbList", "CollectionPage"]);
    const crumbs = m.jsonLd[0]!.itemListElement as { name: string; item: string }[];
    assert.deepEqual(crumbs.map((c) => c.item), [`${BASE}/en/`, `${BASE}/en/gallery`]);

    const zh = head((await page("/zh-cn/history")).html);
    assert.equal(zh.lang, "zh-CN");
    assert.equal(zh.meta("og:locale"), "zh_CN");
    assert.equal(zh.jsonLd[1]!["@type"], "AboutPage");
  });

  it("accommodation detail: unit title / description, Accommodation JSON-LD with occupancy and amenities; unknown or inactive → 404", async () => {
    production();
    const { res, html } = await page("/en/accommodation/house-sakura");
    assert.equal(res.status, 200);
    const m = head(html);
    assert.match(m.title ?? "", /\| Phasakura \(sample data\)$/);
    assert.equal(m.canonical, `${BASE}/en/accommodation/house-sakura`);
    assert.deepEqual(m.alternates.map((a) => a.split(" ")[0]), ["th", "en", "zh-Hans", "x-default"]);
    const acc = m.jsonLd.find((d) => d["@type"] === "Accommodation")!;
    assert.deepEqual(acc.occupancy, { "@type": "QuantitativeValue", maxValue: 4 });
    assert.ok((acc.amenityFeature as unknown[]).length >= 1);
    assert.equal((acc.containedInPlace as Record<string, string>)["@id"], `${BASE}/#lodging`);
    const crumbs = m.jsonLd.find((d) => d["@type"] === "BreadcrumbList")!.itemListElement as { item: string }[];
    assert.deepEqual(crumbs.map((c) => c.item), [`${BASE}/en/`, `${BASE}/en/booking`, `${BASE}/en/accommodation/house-sakura`]);

    const missing = await page("/en/accommodation/no-such-house");
    assert.equal(missing.res.status, 404);
    assert.equal(missing.res.headers.get("X-Robots-Tag"), "noindex, nofollow");
    assert.equal(head(missing.html).canonical, null);
    assert.equal(head(missing.html).title, "Page not found | Phasakura (sample data)");
    h.db.run("UPDATE accommodation_units SET status = 'INACTIVE' WHERE id = 'dev_house_01'");
    assert.equal((await page("/en/accommodation/house-sakura")).res.status, 404, "inactive units are not pages");
  });

  it("description falls back to the unit's own text, then a generated sentence with live price and capacity", async () => {
    production();
    h.db.run("UPDATE accommodation_translations SET seo_description = NULL, short_description = NULL WHERE unit_id = 'dev_vip_03'");
    const m = head((await page("/en/accommodation/vip-03")).html);
    assert.match(m.meta("description") ?? "", /^.+ at Phasakura \(sample data\): up to 4 guests, from ฿2,200 per night\.$/);
  });

  it("unknown pages are real 404s; file paths get no app shell; canonical fixes are permanent redirects", async () => {
    const nope = await page("/th/nope");
    assert.equal(nope.res.status, 404);
    assert.equal(head(nope.html).lang, "th");
    assert.equal((await page("/fr/")).res.status, 404);
    const php = await h.get("/wp-login.php");
    assert.equal(php.status, 404);
    assert.doesNotMatch(await php.text(), /<div id="root">/);
    const upper = await h.get("/EN/gallery?ref=x");
    assert.equal(upper.status, 301);
    assert.equal(upper.headers.get("Location"), "/en/gallery?ref=x", "query string kept");
    assert.equal((await h.get("/th/gallery/")).headers.get("Location"), "/th/gallery");
    assert.equal((await h.get("/th")).headers.get("Location"), "/th/");
    const post = await h.get("/th/", {}, "POST");
    assert.equal(post.status, 405);
    const headReq = await h.get("/th/gallery", {}, "HEAD");
    assert.equal(headReq.status, 200);
    assert.equal(await headReq.text(), "");
  });

  it("the bare / URL goes to the visitor's language", async () => {
    const go = async (accept?: string) => (await h.get("/", accept ? { "Accept-Language": accept } : {})).headers.get("Location");
    assert.equal(await go(), "/th/");
    assert.equal(await go("en-US,en;q=0.9"), "/en/");
    assert.equal(await go("zh-TW,zh;q=0.9,en;q=0.8"), "/zh-cn/");
    assert.equal(await go("fr-FR,fr;q=0.9,en;q=0.5"), "/en/");
    const res = await h.get("/");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Vary"), "Accept-Language");
  });

  it("booking lookup and admin pages are never indexed", async () => {
    production();
    const lookup = await page("/th/booking/lookup");
    assert.equal(lookup.res.status, 200);
    assert.equal(lookup.res.headers.get("X-Robots-Tag"), "noindex, nofollow");
    assert.equal(lookup.res.headers.get("Cache-Control"), "no-store");
    assert.equal(head(lookup.html).canonical, null);
    assert.deepEqual(head(lookup.html).alternates, []);
    const admin = await page("/en/admin/bookings");
    assert.equal(admin.res.status, 200);
    assert.equal(admin.res.headers.get("Cache-Control"), "no-store");
    assert.equal(admin.res.headers.get("Referrer-Policy"), "no-referrer");
    assert.match(admin.html, /<meta name="robots" content="noindex, nofollow" \/>/);
    assert.doesNotMatch(admin.html, /property="og:title"|rel="canonical"/);
    assert.equal(head(admin.html).lang, "en");
    assert.equal((await h.get("/admin/users")).status, 302);
  });

  it("admin SEO settings drive the page: texts, OG image, canonical, noindex, custom schema, Search Console code", async () => {
    production();
    const og = await h.upload<{ id: string; url: string }>(root, { bytes: pngBytes(1200, 630), name: "og.png", type: "image/png" }, "OG_IMAGE");
    const saved = await h.api("PUT", "/api/admin/seo/gallery", {
      token: root,
      body: { translations: {
        th: { seoTitle: 'แกลเลอรี </title><script>alert(1)</script> $& "q"', metaDescription: "ภาพบรรยากาศ", ogImageAssetId: og.data.id,
          ogTitle: "ภาพสวย ๆ", robots: "index,follow", schemaJson: '{"@context":"https://schema.org","@type":"ImageGallery","name":"x"}' },
        en: { robots: "noindex,follow" },
      } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.error));
    await h.api("PUT", "/api/admin/settings/marketing", { token: root, body: { gscVerification: "abc123-XYZ_9" } });

    const { html } = await page("/th/gallery");
    assert.doesNotMatch(html, /<script>alert/, "title is escaped");
    const m = head(html);
    assert.equal(m.title, "แกลเลอรี &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp; &quot;q&quot;");
    assert.equal(m.meta("og:title"), "ภาพสวย ๆ");
    assert.equal(m.meta("og:image"), `${BASE}${og.data.url}`);
    assert.equal(m.meta("og:image:width"), "1200");
    assert.equal(m.meta("twitter:card"), "summary_large_image");
    assert.equal(m.meta("google-site-verification"), "abc123-XYZ_9");
    assert.ok(m.jsonLd.some((d) => d["@type"] === "ImageGallery"), "admin schema added");
    assert.ok(!m.alternates.some((a) => a.startsWith("en ")), "no hreflang to the noindex English version");

    const en = await page("/en/gallery");
    assert.equal(en.res.headers.get("X-Robots-Tag"), "noindex, nofollow");
    assert.equal(head(en.html).meta("robots"), "noindex, follow");
    assert.equal(head(en.html).canonical, null);
    assert.equal(head(en.html).meta("og:image"), `${BASE}${og.data.url}`, "OG image falls back to the Thai entry");
  });

  it("JSON-LD can never close its <script>; injection never interprets $ patterns", () => {
    assert.equal(jsonForScript({ a: "</script><!--x-->&" }), '{"a":"\\u003c/script\\u003e\\u003c!--x--\\u003e\\u0026"}');
    const meta: PageMetaDto = {
      path: "/th/", status: 200, lang: "th", title: "$& $1 $$", description: null, canonical: null, robots: "noindex,nofollow",
      alternates: [], og: { type: "website", title: "x", description: null, url: null, siteName: null, locale: "th_TH", localeAlternates: [], image: null },
      jsonLd: [{ name: "</script>" }], googleSiteVerification: null, favicon: null,
    };
    const out = injectHead(SHELL, meta);
    assert.match(out, /<title>\$&amp; \$1 \$\$<\/title>/);
    assert.equal((out.match(/<\/script>/g) ?? []).length, (SHELL.match(/<\/script>/g) ?? []).length + 1, "only the JSON-LD block's own end tag");
  });

  it("serves the plain app shell when metadata cannot be built", async () => {
    h.db.run("DROP TABLE seo_settings");
    const original = console.error;
    console.error = () => {};
    try {
      const { res, html } = await page("/th/gallery");
      assert.equal(res.status, 200);
      assert.match(html, /<div id="root"><\/div>/);
    } finally {
      console.error = original;
    }
  });
});

describe("redirects, robots.txt, sitemap.xml, favicon", () => {
  it("Website → SEO → Redirects apply before routing, keep the query, count hits; inactive ones are ignored", async () => {
    const created = await h.api<{ id: string }>("POST", "/api/admin/cms/seoRedirect", { token: root, body: { fromPath: "/old-rooms", toPath: "/th/booking", statusCode: 301 } });
    assert.equal(created.status, 201, JSON.stringify(created.error));
    const res = await h.get("/old-rooms?utm=1");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "/th/booking?utm=1");
    assert.equal(h.db.get<{ hit_count: number }>("SELECT hit_count FROM seo_redirects WHERE id = ?", created.data.id)!.hit_count, 1);
    await h.api("PATCH", `/api/admin/cms/seoRedirect/${created.data.id}`, { token: root, body: { isActive: false } });
    assert.equal((await h.get("/old-rooms")).status, 404);
    const temp = await h.api("POST", "/api/admin/cms/seoRedirect", { token: root, body: { fromPath: "/th/history", toPath: "/th/gallery", statusCode: 302 } });
    assert.equal(temp.status, 201);
    assert.equal((await h.get("/th/history")).headers.get("Location"), "/th/gallery");
    assert.throws(() => h.db.run("INSERT INTO seo_redirects (id, from_path, to_path) VALUES ('x', '/a', '//evil.example')"), /CHECK/);
  });

  it("robots.txt blocks everything outside production and private areas in production", async () => {
    const dev = await (await h.get("/robots.txt")).text();
    assert.match(dev, /^User-agent: \*$/m);
    assert.match(dev, /^Disallow: \/$/m);
    production();
    const res = await h.get("/robots.txt");
    assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
    const txt = await res.text();
    for (const p of ["/api/", "/admin", "/th/admin", "/zh-cn/admin", "/en/booking/lookup", "/customer", "/payment"]) {
      assert.match(txt, new RegExp(`^Disallow: ${p.replace(/\//g, "\\/")}$`, "m"), p);
    }
    assert.doesNotMatch(txt, /^Disallow: \/$/m);
    assert.match(txt, new RegExp(`^Sitemap: ${BASE}/sitemap.xml$`, "m"));
  });

  it("sitemap.xml lists every indexable page in every language with hreflang, lastmod and images", async () => {
    production();
    const a = await h.upload<{ id: string; url: string }>(root, { bytes: pngBytes(1600, 1200), name: "a.png", type: "image/png" }, "ACCOMMODATION");
    await h.api("POST", "/api/admin/accommodations/dev_house_01/images", { token: root, body: { mediaAssetId: a.data.id } });
    await h.api("PUT", "/api/admin/seo/history", { token: root, body: { translations: { "zh-CN": { robots: "noindex,nofollow" } } } });
    const res = await h.get("/sitemap.xml");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/xml; charset=utf-8");
    const xml = await res.text();
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    for (const p of ["/th/", "/en/", "/zh-cn/", "/th/gallery", "/en/booking", "/th/history", "/en/accommodation/house-sakura", "/zh-cn/accommodation/vip-03"]) {
      assert.ok(locs.includes(`${BASE}${p}`), p);
    }
    assert.ok(!locs.includes(`${BASE}/zh-cn/history`), "noindex language version left out");
    assert.ok(!locs.some((l) => /admin|lookup|\/api\//.test(l)), "no private URLs");
    assert.equal(locs.length, new Set(locs).size, "no duplicates");
    const house = xml.split("<url>").find((u) => u.includes(`<loc>${BASE}/th/accommodation/house-sakura</loc>`))!;
    assert.match(house, /<lastmod>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/lastmod>/);
    assert.match(house, /hreflang="x-default" href="https:\/\/phasakura.test\/th\/accommodation\/house-sakura"/);
    assert.match(house, new RegExp(`<image:loc>${BASE}${a.data.url}</image:loc>`));
    assert.ok(!xml.includes("&") || !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), "XML entities escaped");
  });

  it("favicon.ico points at the branding favicon or is a 404", async () => {
    assert.equal((await h.get("/favicon.ico")).status, 404);
    const fav = await h.upload<{ id: string; url: string }>(root, { bytes: pngBytes(64, 64), name: "f.png", type: "image/png" }, "FAVICON");
    const b = await h.api("PUT", "/api/admin/settings/branding", { token: root, body: { favicon: fav.data.id } });
    assert.equal(b.status, 200, JSON.stringify(b.error));
    const res = await h.get("/favicon.ico");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), fav.data.url);
    const { html } = await page("/th/");
    assert.match(html, new RegExp(`<link rel="icon" href="${BASE}${fav.data.url}" />`), "first paint has the favicon");
    assert.doesNotMatch(html, /href="data:,"/, "placeholder removed");
  });
});

describe("public metadata API (client navigation)", () => {
  it("returns the same metadata as the HTML head; refuses odd paths", async () => {
    const res = await h.api<PageMetaDto>("GET", `/api/public/meta?path=${encodeURIComponent("/en/accommodation/vip-01")}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.path, "/en/accommodation/vip-01");
    assert.equal(res.data.status, 200);
    const fromHtml = head((await page("/en/accommodation/vip-01")).html);
    assert.equal(fromHtml.title, res.data.title.replace(/&/g, "&amp;"));
    assert.equal((await h.api<PageMetaDto>("GET", "/api/public/meta?path=/th/missing")).data.status, 404);
    for (const bad of ["", "th/", "//evil.example", "/\\evil"]) {
      assert.equal((await h.api("GET", `/api/public/meta?path=${encodeURIComponent(bad)}`)).status, 422, bad);
    }
    assert.equal((await h.api("GET", "/api/public/meta?path=/th/admin")).status, 404);
    assert.equal((await h.api("GET", "/api/public/meta?path=/EN/")).status, 404, "redirecting paths have no metadata");
  });
});

describe("language negotiation and header parity", () => {
  it("negotiates the entry language from Accept-Language", () => {
    assert.equal(negotiateLocale(null).code, "th");
    assert.equal(negotiateLocale("").code, "th");
    assert.equal(negotiateLocale("en;q=0.2, th;q=0.9").code, "th");
    assert.equal(negotiateLocale("zh-Hans-CN").code, "zh-CN");
    assert.equal(negotiateLocale("de, ja;q=0.5").code, "th");
    assert.equal(negotiateLocale("en;q=0, th;q=0.1").code, "th");
    assert.equal(negotiateLocale("EN-GB").code, "en");
  });

  it("pages rendered by the Worker carry exactly the security headers of public/_headers", () => {
    const file = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8");
    const block = file.split(/\n(?=\/)/).find((b) => b.startsWith("/*\n"))!;
    const fromFile = Object.fromEntries([...block.matchAll(/^\s+([A-Za-z-]+):\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));
    assert.deepEqual(PAGE_SECURITY_HEADERS, fromFile);
  });
});

describe("translation coverage (i18n)", () => {
  it("lists visible content with Thai text but no EN / ZH-CN; hidden content and other permissions are left out", async () => {
    type Cov = import("../../src/shared/seo-types.ts").TranslationCoverageDto;
    h.db.run(`INSERT INTO food_options (id, food_category_id, code, pricing_type, price_satang, child_pricing, status, sort_order)
              VALUES ('thai_only', 'dev_food_dinner', 'THAI_ONLY', 'PER_PERSON', 10000, 'FULL', 'ACTIVE', 9),
                     ('draft_dish', 'dev_food_dinner', 'DRAFT_DISH', 'PER_PERSON', 10000, 'FULL', 'DRAFT', 10)`);
    h.db.run(`INSERT INTO food_option_translations (food_option_id, language_code, name) VALUES
              ('thai_only', 'th', 'ต้มยำ'), ('thai_only', 'en', 'Tom yum'), ('draft_dish', 'th', 'ร่าง')`);
    h.db.run("UPDATE food_option_translations SET name = '  ' WHERE food_option_id = 'thai_only' AND language_code = 'en'");
    const res = await h.api<Cov>("GET", "/api/admin/i18n/coverage", { token: root });
    assert.equal(res.status, 200, JSON.stringify(res.error));
    const food = res.data.kinds.find((k) => k.kind === "foodOption")!;
    assert.deepEqual(food.items, [{ id: "thai_only", label: "ต้มยำ", missing: ["en", "zh-CN"] }], "blank text counts as missing; drafts are not listed");
    assert.equal(food.missing.en, 1);
    assert.equal(food.total, 5);
    const settings = res.data.kinds.find((k) => k.kind === "settings")!;
    assert.equal(settings.missing.en, 0, "seeded website texts exist in every language");
    const acc = res.data.kinds.find((k) => k.kind === "accommodation")!;
    assert.equal(acc.total, 5);
    const email = await h.user({ id: "noperm" });
    const noperm = await h.login(email);
    assert.equal((await h.api("GET", "/api/admin/i18n/coverage", { token: noperm })).status, 403);
  });
});
