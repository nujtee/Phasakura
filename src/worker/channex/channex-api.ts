/**
 * Channex.io REST API v1 (phase O2): just what connecting a site needs — properties, room types, rate plans.
 * Auth: the `user-api-key` header (a Cloudflare Secret, CHANNEX_API_KEY). Staging and production are separate
 * Channex accounts with separate keys (CHANNEX_ENV).
 */
export type ChannexFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type ChannexEnvironment = "staging" | "production";

export const CHANNEX_BASE: Record<ChannexEnvironment, string> = {
  staging: "https://staging.channex.io/api/v1",
  production: "https://app.channex.io/api/v1",
};

const TIMEOUT_MS = 15_000;

export interface ChannexProperty { id: string; title: string; currency: string | null; timezone?: string | null }
export interface ChannexRoomType { id: string; title: string; propertyId: string; occAdults: number; countOfRooms?: number }
export interface ChannexRatePlan { id: string; title: string; roomTypeId: string; currency: string | null; occupancy: number; sellMode: string | null }

/** A failed call, with a code the admin page can explain. */
export class ChannexError extends Error {
  constructor(
    readonly code: "CHANNEX_KEY_INVALID" | "CHANNEX_RATE_LIMITED" | "CHANNEX_UNREACHABLE" | "CHANNEX_REJECTED" | "CHANNEX_NOT_FOUND" | "CHANNEX_ERROR",
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

interface JsonApiItem<A> { id: string; type: string; attributes: A }

interface RevisionAttributes {
  booking_id: string; property_id: string; status: string; ota_name: string | null; ota_reservation_code: string | null;
  unique_id?: string | null; arrival_date: string; departure_date: string; amount: string | null; currency: string | null;
  payment_collect?: string | null; notes?: string | null;
  customer?: { name?: string | null; surname?: string | null; mail?: string | null; phone?: string | null; country?: string | null; language?: string | null } | null;
  occupancy?: { adults?: number; children?: number; infants?: number } | null;
  rooms?: {
    room_type_id: string | null; rate_plan_id: string | null; checkin_date: string; checkout_date: string; amount: string | null;
    occupancy?: { adults?: number; children?: number; infants?: number } | null; days?: Record<string, string> | null;
  }[] | null;
}

/** One booking revision from Channex (a new, changed or cancelled OTA booking). Amounts in major units ("1800.00"). */
export interface ChannexRevision {
  id: string;
  bookingId: string;
  propertyId: string;
  status: "new" | "modified" | "cancelled";
  otaName: string;
  otaCode: string | null;
  arrival: string;
  departure: string;
  amount: string | null;
  currency: string;
  paymentCollect: "ota" | "property" | null;
  notes: string | null;
  customer: { name: string; email: string | null; phone: string | null; language: string | null };
  rooms: { roomTypeId: string | null; checkIn: string; checkOut: string; amount: string | null; adults: number; children: number; days: Record<string, string> }[];
}

function toRevision(id: string, a: RevisionAttributes): ChannexRevision {
  const status = a.status === "cancelled" ? "cancelled" : a.status === "modified" ? "modified" : "new";
  const name = [a.customer?.name, a.customer?.surname].filter((x) => x && String(x).trim()).join(" ").trim();
  return {
    id, bookingId: a.booking_id, propertyId: a.property_id, status,
    otaName: (a.ota_name ?? "OTA").slice(0, 60) || "OTA",
    otaCode: a.ota_reservation_code ?? a.unique_id ?? null,
    arrival: a.arrival_date, departure: a.departure_date, amount: a.amount ?? null, currency: (a.currency ?? "THB").toUpperCase(),
    paymentCollect: a.payment_collect === "ota" || a.payment_collect === "property" ? a.payment_collect : null,
    notes: a.notes ?? null,
    customer: { name: name || "OTA guest", email: a.customer?.mail ?? null, phone: a.customer?.phone ?? null, language: a.customer?.language ?? null },
    rooms: (a.rooms ?? []).map((r) => ({
      roomTypeId: r.room_type_id, checkIn: r.checkin_date, checkOut: r.checkout_date, amount: r.amount ?? null,
      adults: Math.max(1, r.occupancy?.adults ?? 1), children: Math.max(0, (r.occupancy?.children ?? 0) + (r.occupancy?.infants ?? 0)),
      days: r.days ?? {},
    })),
  };
}

interface PushResponse { data?: { id: string; type: string }[]; meta?: { message?: string; warnings?: unknown[] } }

/** Channex applies the valid entries and lists the refused ones as warnings (still 200). */
export interface ChannexPushResult { tasks: string[]; warnings: string[] }

function pushResult(res: PushResponse): ChannexPushResult {
  return {
    tasks: (res.data ?? []).map((t) => t.id),
    warnings: (res.meta?.warnings ?? []).map((w) => JSON.stringify(w).slice(0, 300)),
  };
}

export class ChannexApi {
  constructor(
    private readonly key: string,
    readonly environment: ChannexEnvironment,
    private readonly fetcher: ChannexFetch = (input, init) => fetch(input, init),
  ) {}

  async properties(): Promise<ChannexProperty[]> {
    const res = await this.call<{ data: JsonApiItem<{ title: string; currency: string | null }>[] }>("GET", "/properties/options");
    return res.data.map((p) => ({ id: p.id, title: p.attributes.title, currency: p.attributes.currency ?? null }));
  }

  async property(id: string): Promise<ChannexProperty> {
    const res = await this.call<{ data: JsonApiItem<{ title: string; currency: string | null; timezone: string | null }> }>("GET", `/properties/${encodeURIComponent(id)}`);
    return { id: res.data.id, title: res.data.attributes.title, currency: res.data.attributes.currency ?? null, timezone: res.data.attributes.timezone ?? null };
  }

  async roomTypes(propertyId: string): Promise<ChannexRoomType[]> {
    const res = await this.call<{ data: JsonApiItem<{ title: string; occ_adults: number; property_id: string }>[] }>(
      "GET", `/room_types/options?filter[property_id]=${encodeURIComponent(propertyId)}`);
    return res.data.map((r) => ({ id: r.id, title: r.attributes.title, propertyId: r.attributes.property_id, occAdults: r.attributes.occ_adults }));
  }

  async ratePlans(propertyId: string): Promise<ChannexRatePlan[]> {
    const res = await this.call<{ data: JsonApiItem<{ title: string; room_type_id: string; currency: string | null; occupancy: number; sell_mode: string | null }>[] }>(
      "GET", `/rate_plans/options?filter[property_id]=${encodeURIComponent(propertyId)}`);
    return res.data.map((r) => ({
      id: r.id, title: r.attributes.title, roomTypeId: r.attributes.room_type_id, currency: r.attributes.currency ?? null,
      occupancy: r.attributes.occupancy, sellMode: r.attributes.sell_mode ?? null,
    }));
  }

  /** One room type per house / VIP tent (count_of_rooms 1: each is a single unit). */
  async createRoomType(input: { propertyId: string; title: string; adults: number; children: number }): Promise<ChannexRoomType> {
    const res = await this.call<{ data: JsonApiItem<{ title: string; occ_adults: number; count_of_rooms: number }> }>("POST", "/room_types", {
      room_type: {
        property_id: input.propertyId, title: input.title, count_of_rooms: 1,
        occ_adults: input.adults, occ_children: input.children, occ_infants: 0, room_kind: "room",
      },
    });
    return { id: res.data.id, title: res.data.attributes.title, propertyId: input.propertyId, occAdults: res.data.attributes.occ_adults, countOfRooms: res.data.attributes.count_of_rooms };
  }

  /** A per-room rate plan; `rate` in the currency's major units ("1800.00"). */
  async createRatePlan(input: { propertyId: string; roomTypeId: string; title: string; currency: string; occupancy: number; rate: string }): Promise<ChannexRatePlan> {
    const res = await this.call<{ data: JsonApiItem<{ title: string; currency: string | null; sell_mode: string | null }> }>("POST", "/rate_plans", {
      rate_plan: {
        property_id: input.propertyId, room_type_id: input.roomTypeId, title: input.title, currency: input.currency, sell_mode: "per_room",
        options: [{ occupancy: input.occupancy, is_primary: true, rate: input.rate }],
      },
    });
    return { id: res.data.id, title: res.data.attributes.title, roomTypeId: input.roomTypeId, currency: res.data.attributes.currency ?? input.currency, occupancy: input.occupancy, sellMode: res.data.attributes.sell_mode ?? "per_room" };
  }

  /** Availability per room type and night (0 / 1 for a single-unit room type). */
  async pushAvailability(values: { property_id: string; room_type_id: string; date: string; availability: number }[]): Promise<ChannexPushResult> {
    return pushResult(await this.call<PushResponse>("POST", "/availability", { values }));
  }

  /** Rates per rate plan and night; `rate` in major units ("1800.00"). */
  async pushRestrictions(values: { property_id: string; rate_plan_id: string; date: string; rate: string }[]): Promise<ChannexPushResult> {
    return pushResult(await this.call<PushResponse>("POST", "/restrictions", { values }));
  }

  /** Booking revisions not acknowledged yet, oldest first (phase O4). */
  async bookingFeed(propertyId: string, limit = 50): Promise<ChannexRevision[]> {
    const res = await this.call<{ data: JsonApiItem<RevisionAttributes>[] }>("GET",
      `/booking_revisions/feed?filter[property_id]=${encodeURIComponent(propertyId)}&order[inserted_at]=asc&pagination[limit]=${limit}&pagination[page]=1`);
    return res.data.map((r) => toRevision(r.id, r.attributes));
  }

  /** "Received": Channex stops offering this revision. */
  async ackRevision(revisionId: string): Promise<void> {
    await this.call("POST", `/booking_revisions/${encodeURIComponent(revisionId)}/ack`, {});
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetcher(`${CHANNEX_BASE[this.environment]}${path}`, {
        method,
        signal: controller.signal,
        headers: { "user-api-key": this.key, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ChannexError("CHANNEX_UNREACHABLE", controller.signal.aborted ? "Channex did not answer in time" : "Channex could not be reached");
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return (await res.json()) as T;
    let title = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { errors?: { title?: string; details?: Record<string, unknown> } };
      const details = err.errors?.details ? ` ${JSON.stringify(err.errors.details).slice(0, 200)}` : "";
      title = `${err.errors?.title ?? title}${details}`;
    } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) throw new ChannexError("CHANNEX_KEY_INVALID", title, res.status);
    if (res.status === 429) throw new ChannexError("CHANNEX_RATE_LIMITED", title, res.status);
    if (res.status === 404) throw new ChannexError("CHANNEX_NOT_FOUND", title, res.status);
    if (res.status === 400 || res.status === 422) throw new ChannexError("CHANNEX_REJECTED", title, res.status);
    throw new ChannexError("CHANNEX_ERROR", title, res.status);
  }
}

export function channexEnvironment(value: string | undefined): ChannexEnvironment {
  return value?.trim().toLowerCase() === "production" ? "production" : "staging";
}
