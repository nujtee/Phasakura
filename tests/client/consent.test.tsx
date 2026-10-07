import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicSiteDto } from "../../src/shared/api-types.ts";
import { consentEn, consentTh, consentZhCN } from "../../src/shared/i18n/consent-messages.ts";
import { adminPrivacyEn, adminPrivacyTh, adminPrivacyZhCN } from "../../src/shared/i18n/admin-privacy-messages.ts";
import { getLocale, type LocaleCode } from "../../src/shared/i18n/index.ts";
import { configureTracking, deleteCookies, resetTracking, setTrackingSuspended, track, trackOnce, GA4_SRC, PIXEL_SRC } from "../../src/client/analytics/tracker.ts";
import { contactMethod } from "../../src/client/components/Layout.tsx";
import { Footer } from "../../src/client/components/Footer.tsx";
import { ConsentBanner } from "../../src/client/consent/ConsentBanner.tsx";
import { ConsentDialog } from "../../src/client/consent/ConsentDialog.tsx";
import { consentCookie, ConsentProvider, readConsent } from "../../src/client/consent/ConsentProvider.tsx";
import { I18nProvider } from "../../src/client/i18n/I18nProvider.tsx";
import { RouterProvider } from "../../src/client/router/Router.tsx";
import { SiteContext } from "../../src/client/site/SiteProvider.tsx";

function keysOf(o: unknown, prefix = ""): string[] {
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === "object" && v ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`])).sort();
}

const wrap = (node: React.ReactNode, lang: LocaleCode = "th", site: Partial<PublicSiteDto> | null = null) => {
  const locale = getLocale(lang);
  const value = { status: "ready" as const, site: (site ?? {}) as PublicSiteDto, retry: () => {}, preview: false, exitPreview: () => {} };
  return renderToStaticMarkup(
    <RouterProvider initialPath={`/${locale.path}/`}>
      <I18nProvider locale={locale}>
        <SiteContext.Provider value={value}>{node}</SiteContext.Provider>
      </I18nProvider>
    </RouterProvider>,
  );
};

describe("consent texts", () => {
  it("TH / EN / ZH-CN have the same keys (site and admin)", () => {
    assert.deepEqual(keysOf(consentEn), keysOf(consentTh));
    assert.deepEqual(keysOf(consentZhCN), keysOf(consentTh));
    assert.deepEqual(keysOf(adminPrivacyEn), keysOf(adminPrivacyTh));
    assert.deepEqual(keysOf(adminPrivacyZhCN), keysOf(adminPrivacyTh));
  });

  it("uses the spec's button wording in Thai", () => {
    assert.equal(consentTh.acceptAll, "ยอมรับทั้งหมด");
    assert.equal(consentTh.settings, "ตั้งค่าคุกกี้");
    assert.equal(consentTh.rejectOptional, "ปฏิเสธที่ไม่จำเป็น");
  });
});

describe("cookie banner and settings dialog", () => {
  const noop = () => {};

  it("banner: three equally styled choices, labelled region, policy link, custom text", () => {
    const html = wrap(<ConsentBanner text="ข้อความของเรา" policyPath="/th/privacy" onAcceptAll={noop} onReject={noop} onSettings={noop} />);
    const buttons = [...html.matchAll(/<button type="button" class="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(buttons, [["consent-button", "ยอมรับทั้งหมด"], ["consent-button", "ตั้งค่าคุกกี้"], ["consent-button", "ปฏิเสธที่ไม่จำเป็น"]]);
    assert.match(html, /<section class="consent-banner" aria-labelledby="[^"]+" aria-describedby="[^"]+"/);
    assert.match(html, /ข้อความของเรา/);
    assert.match(html, /<a href="\/th\/privacy"[^>]*>อ่านนโยบายความเป็นส่วนตัว<\/a>/);
    assert.match(html, /aria-haspopup="dialog"/);
  });

  it("banner: standard text in the visitor's language when none is set; no policy link without a policy", () => {
    const html = wrap(<ConsentBanner text={null} policyPath={null} onAcceptAll={noop} onReject={noop} onSettings={noop} />, "en");
    assert.match(html, /We use cookies/);
    assert.match(html, /Reject non-essential/);
    assert.doesNotMatch(html, /privacy/);
  });

  it("dialog: Necessary locked on, Analytics and Marketing off until chosen, switches are labelled", () => {
    const html = wrap(<ConsentDialog initial={null} onSave={noop} onClose={noop} policyPath={null} />);
    const switches = [...html.matchAll(/<input id="([^"]+)" type="checkbox" role="switch" class="consent-switch"([^>]*)>/g)];
    assert.equal(switches.length, 3);
    assert.match(switches[0]![2]!, /disabled=""/);
    assert.match(switches[0]![2]!, /checked=""/);
    assert.doesNotMatch(switches[1]![2]!, /checked/);
    assert.doesNotMatch(switches[2]![2]!, /checked/);
    for (const s of switches) assert.match(html, new RegExp(`<label for="${s[1]}"`), "each switch has a label");
    assert.match(html, /<dialog class="consent-dialog" aria-labelledby="[^"]+"/);
    assert.match(html, /aria-label="ปิด"/);
    const withChoice = wrap(<ConsentDialog initial={{ version: 1, analytics: true, marketing: false, at: 1 }} onSave={noop} onClose={noop} policyPath={null} />);
    const after = [...withChoice.matchAll(/role="switch" class="consent-switch"([^>]*)>/g)].map((m) => /checked/.test(m[1]!));
    assert.deepEqual(after, [true, true, false]);
  });

  it("footer: privacy link and 'Cookie settings' when a tracker is on", () => {
    const site = {
      siteName: "S", contact: { phone: null, email: null, lineOaUrl: null, mapUrl: null, address: null },
      tracking: { ga4MeasurementId: "G-ABCDE12", metaPixelId: null },
      consent: { enabled: true, version: 1, days: 180, text: null, policyPath: "/en/privacy" },
    } as Partial<PublicSiteDto>;
    const html = wrap(<ConsentProvider><Footer currentPage={null} /></ConsentProvider>, "en", site);
    assert.match(html, /<a href="\/en\/privacy"[^>]*>Privacy policy<\/a>/);
    assert.match(html, /<button type="button" class="link-button"[^>]*>Cookie settings<\/button>/);
    const off = wrap(<ConsentProvider><Footer currentPage={null} /></ConsentProvider>, "en", { ...site, tracking: { ga4MeasurementId: null, metaPixelId: null }, consent: { ...site.consent!, policyPath: null } });
    assert.doesNotMatch(off, /Cookie settings|Privacy policy/);
  });
});

describe("stored choice", () => {
  const now = 1_800_000_000;
  it("valid only for the current version and within the configured days", () => {
    assert.deepEqual(readConsent(`a=1; pk_consent=2.1.0.${now - 100}`, 2, 180, now), { version: 2, analytics: true, marketing: false, at: now - 100 });
    assert.equal(readConsent(`pk_consent=1.1.1.${now}`, 2, 180, now), null, "asked again");
    assert.equal(readConsent(`pk_consent=2.1.1.${now - 181 * 86_400}`, 2, 180, now), null, "expired");
    assert.equal(readConsent(`pk_consent=2.1.1.${now + 86_400}`, 2, 180, now), null, "from the future");
    assert.equal(readConsent("pk_consent=garbage", 2, 180, now), null);
  });

  it("cookie: first-party, whole site, lifetime in days, Lax, Secure on https", () => {
    assert.equal(consentCookie({ version: 3, analytics: false, marketing: true, at: now }, 90, true), `pk_consent=3.0.1.${now}; Path=/; Max-Age=7776000; SameSite=Lax; Secure`);
    assert.doesNotMatch(consentCookie({ version: 3, analytics: false, marketing: true, at: now }, 90, false), /Secure/);
  });
});

// ------------------------------------------------------------------ tracking runtime

class FakeDoc {
  jar = new Map<string, string>();
  scripts: string[] = [];
  head = { appendChild: (el: { src: string }) => { this.scripts.push(el.src); } };
  createElement() { return { async: false, src: "" }; }
  querySelector(sel: string) { const src = /src="([^"]+)"/.exec(sel)?.[1]; return src && this.scripts.includes(src) ? {} : null; }
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  set cookie(v: string) {
    const [pair, ...attrs] = v.split(";");
    const [name, value] = pair!.split("=");
    if (attrs.some((a) => /max-age=0/i.test(a))) this.jar.delete(name!.trim());
    else this.jar.set(name!.trim(), value ?? "");
  }
}

type Win = Record<string, unknown> & { dataLayer?: IArguments[]; fbq?: { queue: unknown[][] }; location: { href: string; hostname: string }; localStorage: Storage };

function setup() {
  const doc = new FakeDoc();
  const store = new Map<string, string>();
  const w: Win = {
    location: { href: "https://x.test/th/booking?phone=0812345678&utm_source=fb", hostname: "x.test" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as Storage,
  };
  resetTracking(w as never, doc as unknown as Document);
  const calls = () => (w.dataLayer ?? []).map((a) => [...a] as unknown[]);
  const fb = () => (w.fbq?.queue ?? []).map((a) => [...a]);
  return { doc, w, calls, fb, store };
}

const IDS = { ga4: "G-ABCDE12", pixel: "123456789012" };

describe("tracking runtime (consent-gated)", () => {
  beforeEach(() => resetTracking());

  it("nothing loads or is queued without consent", () => {
    const { doc, w } = setup();
    track({ name: "page_view", location: "https://x.test/th/", title: "Home", language: "th" });
    configureTracking({ ...IDS, analytics: false, marketing: false });
    track({ name: "search", term: "tent" });
    assert.deepEqual(doc.scripts, []);
    assert.equal(w.dataLayer, undefined);
    assert.equal(w.fbq, undefined);
  });

  it("Analytics consent → GA4 only, consent mode + config without automatic page view; earlier page view sent with a clean URL", () => {
    const { doc, w, calls } = setup();
    track({ name: "page_view", location: w.location.href, title: "Booking", language: "th" });
    configureTracking({ ...IDS, analytics: true, marketing: false });
    assert.deepEqual(doc.scripts, [`${GA4_SRC}?id=G-ABCDE12`]);
    assert.equal(w.fbq, undefined, "no Pixel without Marketing consent");
    const c = calls();
    assert.deepEqual(c[0], ["consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }]);
    assert.equal(c[1]![0], "js");
    assert.deepEqual(c[2]!.slice(0, 2), ["config", "G-ABCDE12"]);
    assert.equal((c[2]![2] as Record<string, unknown>).send_page_view, false);
    assert.equal((c[2]![2] as Record<string, unknown>).allow_google_signals, false);
    assert.equal((c[2]![2] as Record<string, unknown>).page_location, "https://x.test/th/booking?utm_source=fb");
    const pv = c.find((x) => x[0] === "event" && x[1] === "page_view")!;
    assert.equal((pv[2] as Record<string, unknown>).page_location, "https://x.test/th/booking?utm_source=fb");
    assert.doesNotMatch(JSON.stringify(c), /0812345678/);
  });

  it("Marketing consent → Pixel without automatic events; Lead / Purchase carry the shared event id", () => {
    const { doc, fb, w } = setup();
    configureTracking({ ...IDS, analytics: false, marketing: true });
    assert.deepEqual(doc.scripts, [PIXEL_SRC]);
    assert.equal((w.fbq as unknown as { disablePushState: boolean }).disablePushState, true);
    track({ name: "generate_lead", bookingCode: "BK-1", value: 7000 });
    trackOnce("purchase.BK-1", { name: "booking_confirmed", bookingCode: "BK-1", value: 7000, items: [] });
    trackOnce("purchase.BK-1", { name: "booking_confirmed", bookingCode: "BK-1", value: 7000, items: [] });
    const q = fb();
    assert.deepEqual(q.slice(0, 3), [["consent", "grant"], ["set", "autoConfig", false, IDS.pixel], ["init", IDS.pixel]]);
    assert.deepEqual(q[3], ["trackSingle", IDS.pixel, "Lead", { value: 7000, currency: "THB" }, { eventID: "lead-BK-1" }]);
    assert.equal(q.filter((x) => x[2] === "Purchase").length, 1, "once per booking per browser");
    assert.deepEqual(q.find((x) => x[2] === "Purchase")![4], { eventID: "purchase-BK-1" });
  });

  it("withdrawing consent stops sending and deletes the trackers' cookies", () => {
    const { doc, w, calls, fb } = setup();
    configureTracking({ ...IDS, analytics: true, marketing: true });
    doc.jar.set("_ga", "GA1.1.1"); doc.jar.set("_ga_ABCDE12", "GS1"); doc.jar.set("_fbp", "fb.1.1.1"); doc.jar.set("pk_consent", "1.1.1.1"); doc.jar.set("other", "x");
    configureTracking({ ...IDS, analytics: false, marketing: false });
    assert.equal(w["ga-disable-G-ABCDE12"], true);
    assert.deepEqual(calls().at(-1), ["consent", "update", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }]);
    assert.deepEqual(fb().at(-1), ["consent", "revoke"]);
    assert.deepEqual([...doc.jar.keys()].sort(), ["other", "pk_consent"]);
    const before = calls().length;
    track({ name: "search", term: "x" });
    assert.equal(calls().length, before, "nothing sent after withdrawal");
  });

  it("back office: suspended while staff work there; resumes without replaying the old page", () => {
    const { calls, w } = setup();
    configureTracking({ ...IDS, analytics: true, marketing: false });
    track({ name: "page_view", location: "https://x.test/th/", title: "Home", language: "th" });
    setTrackingSuspended(true);
    assert.equal(w["ga-disable-G-ABCDE12"], true);
    const n = calls().length;
    track({ name: "page_view", location: "https://x.test/th/admin", title: "Admin", language: "th" });
    assert.equal(calls().length, n);
    setTrackingSuspended(false);
    assert.equal(w["ga-disable-G-ABCDE12"], false);
    assert.equal(calls().filter((x) => x[1] === "page_view").length, 1, "the admin page is never sent");
  });

  it("deleteCookies covers parent domains", () => {
    const seen: string[] = [];
    const doc = { get cookie() { return "_ga=1; keep=2"; }, set cookie(v: string) { seen.push(v); } } as unknown as Document;
    deleteCookies(doc, ["_ga"], "www.example.co.th");
    assert.deepEqual(seen, [
      "_ga=; Max-Age=0; Path=/", "_ga=; Max-Age=0; Path=/; Domain=.www.example.co.th", "_ga=; Max-Age=0; Path=/; Domain=.example.co.th", "_ga=; Max-Age=0; Path=/; Domain=.co.th",
    ]);
  });

  it("contact links → Contact event method", () => {
    assert.equal(contactMethod("tel:+66812345678"), "phone");
    assert.equal(contactMethod("mailto:a@b.co"), "email");
    assert.equal(contactMethod("https://line.me/R/ti/p/@abc"), "line");
    assert.equal(contactMethod("https://lin.ee/abc"), "line");
    assert.equal(contactMethod("https://maps.app.goo.gl/xyz"), "map");
    assert.equal(contactMethod("https://www.google.com/maps/place/x"), "map");
    assert.equal(contactMethod("/th/booking"), null);
    assert.equal(contactMethod("https://evil.example/line.me/"), null);
  });
});
