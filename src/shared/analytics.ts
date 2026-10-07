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
  | { name: "contact"; method: "phone" | "email" | "line" | "map" };

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
      return [];
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
      return null;
  }
}

/** Which consent category an event needs on each channel (GA4 = analytics, Pixel = marketing). */
export const CHANNEL_CONSENT = { ga4: "analytics", pixel: "marketing" } as const;
