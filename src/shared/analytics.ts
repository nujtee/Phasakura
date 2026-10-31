/**
 * Website events (spec §43 GA4, §44 Meta Pixel) mapped from one internal event list.
 * Pure: no browser APIs, so the mapping and the "no personal data" rules are unit-tested.
 * Never sent: guest name, phone, e-mail, bank account, slip, note — only content ids / names,
 * prices, the Booking ID (transaction_id, as the spec requires) and the page path.
 */

export type ItemCategory = "HOUSE" | "VIP_TENT" | "CAMPING" | "FOOD";

export interface TrackItem {
  /** Content id: accommodation slug, "camping" or the dish id. */
  id: string;
  name: string;
  category: ItemCategory;
  /** Unit price in baht. */
  price?: number;
  quantity?: number;
}

export type SiteEvent =
  | { name: "page_view"; location: string; title: string; language: string }
  | { name: "view_accommodation"; item: TrackItem }
  | { name: "search"; term: string }
  | { name: "select_accommodation"; item: TrackItem }
  /** The guest picked a stay and the booking steps start (food, details, review). */
  | { name: "begin_booking"; value: number; items: TrackItem[] }
  /** The guest moves on to their details (checkout). */
  | { name: "begin_checkout"; value: number; items: TrackItem[] }
  | { name: "view_food" }
  | { name: "select_food"; item: TrackItem }
  | { name: "add_food"; item: TrackItem }
  | { name: "generate_lead"; bookingCode: string; value: number }
  | { name: "payment_submitted"; bookingCode: string; value: number }
  | { name: "booking_confirmed"; bookingCode: string; value: number; items: TrackItem[] }
  /** Phone / LINE / e-mail / map link clicked anywhere on the public site; `place` = where on the page. */
  | { name: "contact"; method: "phone" | "email" | "line" | "map"; place?: string }
  /** A "book" link / button (to the booking page) clicked; `place` = where on the page. */
  | { name: "click_book"; place: string }
  /** Core Web Vitals of this page view (LCP / CLS / INP), measured in the visitor's browser. */
  | { name: "web_vitals"; metric: "LCP" | "CLS" | "INP"; value: number; rating: "good" | "needs-improvement" | "poor"; page: string };

/** GA4 event name per contact method — the ones to mark as key events (conversions) in GA4. */
export const CONTACT_EVENTS = { phone: "click_call", line: "click_line", email: "click_email", map: "click_map" } as const;

/** Google's thresholds (good ≤ first, poor > second). */
export const WEB_VITAL_THRESHOLDS = { LCP: [2500, 4000], CLS: [0.1, 0.25], INP: [200, 500] } as const;

export function vitalRating(metric: keyof typeof WEB_VITAL_THRESHOLDS, value: number): "good" | "needs-improvement" | "poor" {
  const [good, poor] = WEB_VITAL_THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "needs-improvement" : "poor";
}

export const CURRENCY = "THB";

/** Shared with the server (Conversions API) so Meta keeps one of the two copies. */
export const leadEventId = (bookingCode: string) => `lead-${bookingCode}`;
export const purchaseEventId = (bookingCode: string) => `purchase-${bookingCode}`;
export const paymentEventId = (bookingCode: string) => `payment-${bookingCode}`;

/** Query parameters worth keeping in page_location (campaign attribution); everything else is dropped. */
const KEEP_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"]);

export function sanitizeLocation(href: string): string {
  try {
    const url = new URL(href);
    const kept = new URLSearchParams();
    for (const [k, v] of url.searchParams) if (KEEP_PARAMS.has(k)) kept.set(k, v.slice(0, 100));
    const q = kept.toString();
    return `${url.origin}${url.pathname}${q ? `?${q}` : ""}`;
  } catch {
    return "";
  }
}

const EMAIL = /[^\s@,;:<>()"']+@[^\s@,;:<>()"']+\.[^\s@,;:<>()"']+/g;
const PHONE = /\+?\d[\d\s\-()]{7,}\d/g;

/** Free text (titles, search words) without anything that looks like an e-mail or phone number. */
export function cleanText(text: string, max = 100): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[number]").replace(/\s+/g, " ").trim().slice(0, max);
}

const money = (n: number) => Math.round(n * 100) / 100;

function ga4Item(i: TrackItem): Record<string, unknown> {
  return {
    item_id: cleanText(i.id, 80),
    item_name: cleanText(i.name),
    item_category: i.category,
    ...(i.price !== undefined ? { price: money(i.price) } : {}),
    quantity: i.quantity ?? 1,
  };
}

/** GA4 events (gtag 'event' calls) for one website event. */
export function toGa4(e: SiteEvent): [string, Record<string, unknown>][] {
  switch (e.name) {
    case "page_view":
      return [["page_view", { page_location: sanitizeLocation(e.location), page_title: cleanText(e.title, 150), language: e.language }]];
    case "view_accommodation":
      return [
        ["view_item", { currency: CURRENCY, value: money(e.item.price ?? 0), items: [ga4Item(e.item)] }],
        ["view_accommodation", { item_id: e.item.id, item_name: cleanText(e.item.name), item_category: e.item.category }],
      ];
    case "search":
      return [["search", { search_term: cleanText(e.term) }]];
    case "select_accommodation":
      return [
        ["select_item", { item_list_name: "accommodation", items: [ga4Item(e.item)] }],
        ["select_accommodation", { item_id: e.item.id, item_name: cleanText(e.item.name), item_category: e.item.category }],
      ];
    case "begin_booking":
      return [["begin_booking", { currency: CURRENCY, value: money(e.value), items: e.items.map(ga4Item) }]];
    case "begin_checkout":
      return [["begin_checkout", { currency: CURRENCY, value: money(e.value), items: e.items.map(ga4Item) }]];
    case "view_food":
      return [["view_food", { item_list_name: "food" }]];
    case "select_food":
      return [["select_food", { item_id: e.item.id, item_name: cleanText(e.item.name) }]];
    case "add_food":
      return [["add_food", { currency: CURRENCY, value: money((e.item.price ?? 0) * (e.item.quantity ?? 1)), items: [ga4Item(e.item)] }]];
    case "generate_lead":
      return [["generate_lead", { currency: CURRENCY, value: money(e.value), booking_id: e.bookingCode }]];
    case "payment_submitted":
      return [
        ["add_payment_info", { currency: CURRENCY, value: money(e.value), payment_type: "bank_transfer" }],
        ["payment_submitted", { booking_id: e.bookingCode, currency: CURRENCY, value: money(e.value) }],
      ];
    case "booking_confirmed":
      return [
        ["purchase", { transaction_id: e.bookingCode, value: money(e.value), currency: CURRENCY, items: e.items.map(ga4Item) }],
        ["booking_confirmed", { booking_id: e.bookingCode, value: money(e.value), currency: CURRENCY }],
      ];
    case "contact":
      // A named event per method (mark click_call / click_line as key events in GA4) + GA4's generic "contact".
      return [
        [CONTACT_EVENTS[e.method], { method: e.method, ...(e.place ? { link_location: cleanText(e.place, 40) } : {}) }],
        ["contact", { method: e.method }],
      ];
    case "click_book":
      return [["click_book", { link_location: cleanText(e.place, 40) }]];
    case "web_vitals":
      // CLS is a score (×1000 as an integer, as Google's own web-vitals guide does); LCP / INP in milliseconds.
      return [[e.metric, {
        value: Math.round(e.metric === "CLS" ? e.value * 1000 : e.value),
        metric_value: e.metric === "CLS" ? Math.round(e.value * 1000) / 1000 : Math.round(e.value),
        metric_rating: e.rating,
        page_path: cleanText(e.page, 100),
        non_interaction: true,
      }]];
  }
}

export interface PixelCall {
  name: string;
  params: Record<string, unknown>;
  /** eventID for deduplication with the Conversions API. */
  eventId?: string;
}

/** Meta Pixel standard event (fbq 'track') for one website event, if any. */
export function toPixel(e: SiteEvent): PixelCall | null {
  const content = (items: TrackItem[]) => ({ content_ids: items.map((i) => cleanText(i.id, 80)), content_type: "product" });
  switch (e.name) {
    case "page_view":
      return { name: "PageView", params: {} };
    case "view_accommodation":
      return { name: "ViewContent", params: { ...content([e.item]), content_name: cleanText(e.item.name), value: money(e.item.price ?? 0), currency: CURRENCY } };
    case "search":
      return { name: "Search", params: { search_string: cleanText(e.term) } };
    case "select_accommodation":
      return { name: "AddToCart", params: { ...content([e.item]), content_name: cleanText(e.item.name), value: money(e.item.price ?? 0), currency: CURRENCY } };
    case "begin_checkout":
      return { name: "InitiateCheckout", params: { ...content(e.items), num_items: e.items.length, value: money(e.value), currency: CURRENCY } };
    case "add_food":
      return { name: "AddToCart", params: { ...content([e.item]), value: money((e.item.price ?? 0) * (e.item.quantity ?? 1)), currency: CURRENCY } };
    case "generate_lead":
      return { name: "Lead", params: { value: money(e.value), currency: CURRENCY }, eventId: leadEventId(e.bookingCode) };
    case "payment_submitted":
      return { name: "AddPaymentInfo", params: { value: money(e.value), currency: CURRENCY }, eventId: paymentEventId(e.bookingCode) };
    case "booking_confirmed":
      return { name: "Purchase", params: { ...content(e.items), num_items: e.items.length, value: money(e.value), currency: CURRENCY }, eventId: purchaseEventId(e.bookingCode) };
    case "contact":
      return { name: "Contact", params: {} };
    case "begin_booking":
    case "view_food":
    case "select_food":
    case "web_vitals":
    case "click_book":
      return null;
  }
}

/** Which consent category an event needs on each channel (GA4 = analytics, Pixel = marketing). */
export const CHANNEL_CONSENT = { ga4: "analytics", pixel: "marketing" } as const;
