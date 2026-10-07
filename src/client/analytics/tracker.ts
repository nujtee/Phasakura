import { sanitizeLocation, toGa4, toPixel, type SiteEvent } from "../../shared/analytics.ts";

/**
 * Browser tracking runtime (Phase 14, spec §43–46).
 *
 * - Nothing is loaded until the visitor has chosen: GA4 needs Analytics consent, Meta Pixel needs
 *   Marketing consent (the Conversions API on the server follows the same choice, see
 *   booking_marketing). IDs come from Settings → Marketing; nothing is hard-coded.
 * - Withdrawing consent stops sending at once (ga-disable / fbq consent revoke) and deletes the
 *   trackers' first-party cookies.
 * - Page views are sent by the app with a cleaned URL (campaign parameters only); the Pixel's own
 *   history tracking and automatic event detection are switched off so nothing is collected by
 *   scraping the page. Nothing is sent from the back office.
 */

type Fn = (...args: unknown[]) => void;
interface Fbq extends Fn {
  callMethod?: Fn;
  queue: unknown[];
  push: Fbq;
  loaded: boolean;
  version: string;
  disablePushState?: boolean;
}
type TrackingWindow = Window & { dataLayer?: unknown[]; gtag?: Fn; fbq?: Fbq; _fbq?: Fbq } & Record<string, unknown>;

export interface TrackingConfig {
  ga4: string | null;
  pixel: string | null;
  analytics: boolean;
  marketing: boolean;
}

export const GA4_SRC = "https://www.googletagmanager.com/gtag/js";
export const PIXEL_SRC = "https://connect.facebook.net/en_US/fbevents.js";
const GA4_ID = /^G-[A-Z0-9]{4,20}$/;
const PIXEL_ID = /^\d{5,20}$/;

interface Runtime {
  w: TrackingWindow;
  doc: Document;
  config: TrackingConfig | null;
  /** Events before the settings arrived (first page view). */
  pending: SiteEvent[];
  ga4Loaded: string | null;
  pixelLoaded: string | null;
  ga4On: boolean;
  pixelOn: boolean;
  suspended: boolean;
  lastPage: SiteEvent | null;
}

let rt: Runtime | null = null;

function runtime(w?: TrackingWindow, doc?: Document): Runtime | null {
  if (w && doc && (!rt || rt.w !== w)) {
    rt = { w, doc, config: null, pending: [], ga4Loaded: null, pixelLoaded: null, ga4On: false, pixelOn: false, suspended: false, lastPage: null };
  }
  if (!rt && typeof window !== "undefined" && typeof document !== "undefined") return runtime(window as unknown as TrackingWindow, document);
  return rt;
}

/** Test hook: forget all state. */
export function resetTracking(w?: TrackingWindow, doc?: Document): void {
  rt = null;
  if (w && doc) runtime(w, doc);
}

function addScript(doc: Document, src: string): void {
  if (doc.querySelector?.(`script[src="${src}"]`)) return;
  const s = doc.createElement("script");
  s.async = true;
  s.src = src;
  doc.head.appendChild(s);
}

/** Deletes cookies by name (or prefix ending in "*") on this host and its parent domains. */
export function deleteCookies(doc: Document, names: string[], hostname: string): void {
  const present = doc.cookie.split(";").map((c) => c.split("=")[0]!.trim()).filter(Boolean);
  const match = (n: string) => names.some((p) => (p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p));
  const parts = hostname.split(".");
  const domains: (string | null)[] = [null];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`.${parts.slice(i).join(".")}`);
  for (const name of present.filter(match)) {
    for (const d of domains) doc.cookie = `${name}=; Max-Age=0; Path=/${d ? `; Domain=${d}` : ""}`;
  }
}

function gtag(r: Runtime): Fn {
  if (!r.w.gtag) {
    r.w.dataLayer = r.w.dataLayer ?? [];
    const dl = r.w.dataLayer;
    // gtag.js reads Arguments objects from the dataLayer (not arrays).
    r.w.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      dl.push(arguments);
    };
  }
  return r.w.gtag;
}

function fbq(r: Runtime): Fbq {
  if (!r.w.fbq) {
    const n = function (...args: unknown[]) {
      if (n.callMethod) n.callMethod(...args);
      else n.queue.push(args);
    } as Fbq;
    n.push = n;
    n.loaded = true;
    n.version = "2.0";
    n.queue = [];
    // The app sends PageView itself (cleaned URL, never in the back office).
    n.disablePushState = true;
    r.w.fbq = n;
    if (!r.w._fbq) r.w._fbq = n;
  }
  return r.w.fbq;
}

const adConsent = (marketing: boolean) => (marketing ? "granted" : "denied");

function startGa4(r: Runtime, id: string, marketing: boolean): void {
  const g = gtag(r);
  r.w[`ga-disable-${id}`] = false;
  const consent = { analytics_storage: "granted", ad_storage: adConsent(marketing), ad_user_data: adConsent(marketing), ad_personalization: adConsent(marketing) };
  if (r.ga4Loaded !== id) {
    g("consent", "default", consent);
    g("js", new Date());
    g("config", id, {
      send_page_view: false,
      allow_google_signals: marketing,
      allow_ad_personalization_signals: marketing,
      page_location: sanitizeLocation(r.w.location?.href ?? ""),
    });
    addScript(r.doc, `${GA4_SRC}?id=${encodeURIComponent(id)}`);
    r.ga4Loaded = id;
  } else {
    g("consent", "update", consent);
  }
  r.ga4On = true;
}

/** `purge` = the visitor withdrew (or never gave) consent: also delete GA cookies. */
function stopGa4(r: Runtime, purge: boolean): void {
  if (r.ga4Loaded) {
    r.w[`ga-disable-${r.ga4Loaded}`] = true;
    if (purge) r.w.gtag?.("consent", "update", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  }
  if (purge) deleteCookies(r.doc, ["_ga", "_ga_*", "_gid", "_gat*", "_gcl_*"], r.w.location?.hostname ?? "");
  r.ga4On = false;
}

function startPixel(r: Runtime, id: string): void {
  const f = fbq(r);
  if (r.pixelLoaded !== id) {
    f("consent", "grant");
    // No automatic events or page scraping: only the events below are sent.
    f("set", "autoConfig", false, id);
    f("init", id);
    addScript(r.doc, PIXEL_SRC);
    r.pixelLoaded = id;
  } else {
    f("consent", "grant");
  }
  r.pixelOn = true;
}

function stopPixel(r: Runtime, purge: boolean): void {
  if (r.pixelLoaded) r.w.fbq?.("consent", "revoke");
  if (purge) deleteCookies(r.doc, ["_fbp", "_fbc"], r.w.location?.hostname ?? "");
  r.pixelOn = false;
}

function sendGa4(r: Runtime, e: SiteEvent): void {
  const g = r.w.gtag;
  if (!g) return;
  for (const [name, params] of toGa4(e)) g("event", name, { ...params, send_to: r.ga4Loaded });
}

function sendPixel(r: Runtime, e: SiteEvent): void {
  const p = toPixel(e);
  const f = r.w.fbq;
  if (!p || !f) return;
  if (p.eventId) f("trackSingle", r.pixelLoaded, p.name, p.params, { eventID: p.eventId });
  else f("trackSingle", r.pixelLoaded, p.name, p.params);
}

/** Applies the IDs from the site settings and the visitor's current choice. Safe to call repeatedly. */
export function configureTracking(next: TrackingConfig, w?: TrackingWindow, doc?: Document): void {
  const r = runtime(w, doc);
  if (!r) return;
  const first = r.config === null;
  r.config = next;
  const ga4 = next.ga4 && GA4_ID.test(next.ga4) ? next.ga4 : null;
  const pixel = next.pixel && PIXEL_ID.test(next.pixel) ? next.pixel : null;

  const wasGa4 = r.ga4On;
  const wasPixel = r.pixelOn;
  if (ga4 && next.analytics && !r.suspended) {
    if (r.ga4Loaded && r.ga4Loaded !== ga4) stopGa4(r, false);
    startGa4(r, ga4, next.marketing);
  } else stopGa4(r, !next.analytics);

  if (pixel && next.marketing && !r.suspended) {
    if (r.pixelLoaded && r.pixelLoaded !== pixel) stopPixel(r, false);
    startPixel(r, pixel);
  } else stopPixel(r, !next.marketing);

  if (first) {
    const queued = r.pending;
    r.pending = [];
    for (const e of queued) track(e);
  } else if (r.lastPage) {
    // Consent given on this page: count the page view for the channel(s) that just started.
    if (r.ga4On && !wasGa4) sendGa4(r, r.lastPage);
    if (r.pixelOn && !wasPixel) sendPixel(r, r.lastPage);
  }
}

/** Back office: no tracking while staff work there. */
export function setTrackingSuspended(suspended: boolean): void {
  const r = runtime();
  if (!r || r.suspended === suspended) return;
  r.suspended = suspended;
  if (suspended) r.lastPage = null;
  if (r.config) configureTracking(r.config);
  else if (suspended && r.ga4Loaded) r.w[`ga-disable-${r.ga4Loaded}`] = true;
}

/** Sends one website event to every channel the visitor allowed. */
export function track(e: SiteEvent): void {
  const r = runtime();
  if (!r || r.suspended) return;
  if (e.name === "page_view") r.lastPage = e;
  if (r.config === null) {
    if (r.pending.length < 30) r.pending.push(e);
    return;
  }
  if (r.ga4On) sendGa4(r, e);
  if (r.pixelOn) sendPixel(r, e);
}

/** Once-per-booking events (Purchase) survive reloads of the confirmation page. */
export function trackOnce(key: string, e: SiteEvent): void {
  const r = runtime();
  const storageKey = `phasakura.tracked.${key}`;
  try {
    const s = r?.w.localStorage;
    if (s?.getItem(storageKey)) return;
    if (r?.config && (r.ga4On || r.pixelOn)) s?.setItem(storageKey, "1");
  } catch {
    // storage unavailable: may count twice on reload, GA4 / Meta de-duplicate by transaction / event id
  }
  track(e);
}
