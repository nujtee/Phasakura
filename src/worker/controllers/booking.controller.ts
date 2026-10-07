import type { BookingStatus, FoodSelection, PaymentStatus, PricingRuleInput, StaySelection } from "../../shared/booking-types.ts";
import { BOOKING_CODE_PATTERN, IDEMPOTENCY_KEY_PATTERN } from "../../shared/booking-types.ts";
import { MAX_PRICE_SATANG } from "../../shared/booking-rules.ts";
import { isIsoDate } from "../../shared/dates.ts";
import { DEFAULT_LOCALE, parseLocale } from "../../shared/i18n/locales.ts";
import { requestMeta, withAuth, type ServicesFor } from "../http/auth-guard.ts";
import { BadRequestError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { MAX_FOOD_LINES, MAX_GUESTS_PER_BOOKING, type QuoteInput } from "../services/quote.service.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const NO_STORE = { "Cache-Control": "no-store" };
const BOOKING_STATUSES = ["PENDING", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "EXPIRED", "NO_SHOW"] as const;
const PAYMENT_STATUSES = ["UNPAID", "PENDING_VERIFICATION", "VERIFIED", "PAID", "REJECTED", "REFUNDED"] as const;
const TARGET_TYPES = ["UNIT", "UNIT_TYPE", "CAMPING"] as const;
const UNIT_TYPES = ["HOUSE", "VIP_TENT"] as const;
const RULE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
const DAYS = /^[0-6]{1,7}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function langOf(raw: unknown) {
  if (raw === undefined || raw === null) return DEFAULT_LOCALE;
  const locale = typeof raw === "string" ? parseLocale(raw) : null;
  if (!locale) throw new BadRequestError("Unsupported language", "UNSUPPORTED_LANGUAGE");
  return locale;
}

function int(v: Validator, value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    v.errors[key] = value === undefined ? "REQUIRED" : "OUT_OF_RANGE";
    return min;
  }
  return value;
}

function date(v: Validator, value: unknown, key: string): string {
  if (!isIsoDate(value)) {
    v.errors[key] = value === undefined ? "REQUIRED" : "INVALID_DATE";
    return "";
  }
  return value;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const QUOTE_FIELDS = ["checkIn", "checkOut", "adults", "children", "stay", "food", "lang"] as const;

/** Parses the stay/guests/food part shared by quote and create. Strict: unknown fields are rejected. */
function parseQuote(body: Record<string, unknown>, v: Validator): QuoteInput {
  const checkIn = date(v, body.checkIn, "checkIn");
  const checkOut = date(v, body.checkOut, "checkOut");
  const adults = int(v, body.adults, "adults", 1, MAX_GUESTS_PER_BOOKING);
  const children = body.children === undefined ? 0 : int(v, body.children, "children", 0, MAX_GUESTS_PER_BOOKING);

  let stay: StaySelection = { kind: "UNIT", unitId: "" };
  const s = obj(body.stay);
  if (!s) v.errors.stay = "REQUIRED";
  else if (s.kind === "UNIT" && Object.keys(s).every((k) => k === "kind" || k === "unitId")) {
    if (typeof s.unitId !== "string" || !ID_PATTERN.test(s.unitId)) v.errors["stay.unitId"] = "INVALID_ID";
    else stay = { kind: "UNIT", unitId: s.unitId };
  } else if (s.kind === "CAMPING" && Object.keys(s).every((k) => k === "kind" || k === "tents")) {
    stay = { kind: "CAMPING", tents: int(v, s.tents, "stay.tents", 1, 100) };
  } else v.errors.stay = "INVALID_VALUE";

  const food: FoodSelection[] = [];
  if (body.food !== undefined) {
    if (!Array.isArray(body.food)) v.errors.food = "EXPECTED_ARRAY";
    else if (body.food.length > MAX_FOOD_LINES) v.errors.food = "TOO_MANY";
    else {
      body.food.forEach((raw, i) => {
        const f = obj(raw);
        const key = `food.${i}`;
        if (!f || !Object.keys(f).every((k) => ["optionId", "serviceDate", "adults", "children", "quantity"].includes(k))) {
          v.errors[key] = "INVALID_VALUE";
          return;
        }
        if (typeof f.optionId !== "string" || !ID_PATTERN.test(f.optionId)) {
          v.errors[`${key}.optionId`] = "INVALID_ID";
          return;
        }
        const line: FoodSelection = { optionId: f.optionId, serviceDate: date(v, f.serviceDate, `${key}.serviceDate`) };
        if (f.adults !== undefined) line.adults = int(v, f.adults, `${key}.adults`, 0, MAX_GUESTS_PER_BOOKING);
        if (f.children !== undefined) line.children = int(v, f.children, `${key}.children`, 0, MAX_GUESTS_PER_BOOKING);
        if (f.quantity !== undefined) line.quantity = int(v, f.quantity, `${key}.quantity`, 1, 500);
        food.push(line);
      });
    }
  }
  return { checkIn, checkOut, adults, children, stay, food, lang: langOf(body.lang).code };
}

function parseRule(body: Record<string, unknown>, partial: boolean): Partial<PricingRuleInput> {
  const v = new Validator(body).allowOnly(["targetType", "unitId", "unitType", "name", "dateFrom", "dateTo", "daysOfWeek", "priceSatang", "priority", "status"]);
  const out: Partial<PricingRuleInput> = {};
  const want = (k: string) => !partial || v.has(k);
  if (want("targetType")) out.targetType = v.oneOf("targetType", TARGET_TYPES, { required: true });
  if (v.has("unitId")) out.unitId = body.unitId === null ? null : v.string("unitId", { pattern: ID_PATTERN }) ?? null;
  if (v.has("unitType")) out.unitType = body.unitType === null ? null : v.oneOf("unitType", UNIT_TYPES) ?? null;
  if (want("name")) out.name = v.string("name", { required: true, max: 80 });
  if (want("dateFrom")) out.dateFrom = date(v, body.dateFrom, "dateFrom");
  if (want("dateTo")) out.dateTo = date(v, body.dateTo, "dateTo");
  if (v.has("daysOfWeek") || !partial) out.daysOfWeek = v.string("daysOfWeek", { pattern: DAYS }) ?? "0123456";
  if (want("priceSatang")) out.priceSatang = int(v, body.priceSatang, "priceSatang", 0, MAX_PRICE_SATANG);
  if (v.has("priority") || !partial) out.priority = body.priority === undefined ? 0 : int(v, body.priority, "priority", -1000, 1000);
  if (v.has("status") || !partial) out.status = v.oneOf("status", RULE_STATUSES) ?? "ACTIVE";
  v.assertValid();
  if (!partial) {
    if (out.targetType === "UNIT" && !out.unitId) throw new ValidationError({ unitId: "REQUIRED" });
    if (out.targetType === "UNIT_TYPE" && !out.unitType) throw new ValidationError({ unitType: "REQUIRED" });
    if (out.dateTo! < out.dateFrom!) throw new ValidationError({ dateTo: "BEFORE_START" });
    out.unitId ??= null;
    out.unitType ??= null;
  }
  return out;
}

function codeParam(ctx: RequestContext): string {
  const code = (ctx.params.code ?? "").toUpperCase();
  if (!BOOKING_CODE_PATTERN.test(code)) throw new ValidationError({ code: "INVALID_FORMAT" });
  return code;
}

export function bookingController(services: ServicesFor) {
  return {
    // ------------------------------------------------------------------ public
    /** GET /api/public/food-options?checkIn=&checkOut=&lang= — live menu, deadlines and remaining portions. */
    foodOptions: (async (ctx) => {
      const q = ctx.url.searchParams;
      const data = await services(ctx).quotes.catalogue(q.get("checkIn") ?? "", q.get("checkOut") ?? "", langOf(q.get("lang") ?? undefined).code);
      return jsonOk(data, { headers: NO_STORE });
    }) satisfies Handler,

    /** POST /api/public/bookings/quote — server-side price for the current selection. */
    quote: (async (ctx) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(QUOTE_FIELDS);
      const input = parseQuote(body, v);
      v.assertValid();
      return jsonOk(await services(ctx).bookings.quote(input), { headers: NO_STORE });
    }) satisfies Handler,

    /** POST /api/public/bookings — creates a PENDING booking (unpaid hold). */
    create: (async (ctx) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly([...QUOTE_FIELDS, "customer", "privacyAccepted", "expectedTotalSatang", "idempotencyKey"]);
      const input = parseQuote(body, v);
      const c = obj(body.customer);
      const cv = new Validator(c ?? {}).allowOnly(["name", "phone", "email", "lineId", "note"]);
      const customer = {
        name: cv.string("name", { required: true, max: 100 }),
        phone: cv.string("phone", { required: true, max: 24 }),
        email: cv.email("email") ?? null,
        lineId: cv.string("lineId", { max: 50 }) ?? null,
        note: cv.string("note", { max: 1000, raw: true })?.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") || null,
      };
      if (!c) v.errors.customer = "REQUIRED";
      for (const [k, e] of Object.entries(cv.errors)) v.errors[`customer.${k}`] = e;
      if (body.privacyAccepted !== true) v.errors.privacyAccepted = "MUST_ACCEPT";
      const expectedTotalSatang = int(v, body.expectedTotalSatang, "expectedTotalSatang", 0, MAX_PRICE_SATANG * 100);
      const idempotencyKey = v.string("idempotencyKey", { required: true, pattern: IDEMPOTENCY_KEY_PATTERN })!;
      v.assertValid();
      const { booking, replayed } = await services(ctx).bookings.create(
        { ...input, customer, expectedTotalSatang, idempotencyKey },
        requestMeta(ctx),
      );
      return jsonOk(booking, { status: replayed ? 200 : 201, headers: NO_STORE });
    }) satisfies Handler,

    /** POST /api/public/bookings/lookup { bookingCode, phone } — POST keeps the phone out of URLs and logs. */
    lookup: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["bookingCode", "phone"]);
      const bookingCode = v.string("bookingCode", { required: true, max: 20 });
      const phone = v.string("phone", { required: true, max: 24 });
      v.assertValid();
      return jsonOk(await services(ctx).bookings.lookup(bookingCode, phone, requestMeta(ctx)), { headers: NO_STORE });
    }) satisfies Handler,

    // ------------------------------------------------------------------ admin bookings
    list: withAuth(services, async (ctx, auth) => {
      const q = ctx.url.searchParams;
      const v = new Validator(Object.fromEntries(q.entries()));
      const status = v.oneOf("status", BOOKING_STATUSES) as BookingStatus | undefined;
      const payment = v.oneOf("payment", PAYMENT_STATUSES) as PaymentStatus | undefined;
      const from = q.get("from") ? date(v, q.get("from"), "from") : undefined;
      const to = q.get("to") ? date(v, q.get("to"), "to") : undefined;
      const search = v.string("q", { max: 60 });
      const before = v.string("before", { pattern: TIMESTAMP });
      const limitRaw = Number(q.get("limit") ?? 50);
      const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 50;
      v.assertValid();
      return jsonOk(await services(ctx).bookings.adminList(auth, { status, payment, from, to, q: search, before, limit }, requestMeta(ctx)), { headers: NO_STORE });
    }),

    get: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).bookings.adminGet(auth, codeParam(ctx), requestMeta(ctx)), { headers: NO_STORE })),

    cancel: withAuth(services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["reason"]);
      const reason = v.string("reason", { required: true, min: 3, max: 500 });
      v.assertValid();
      return jsonOk(await services(ctx).bookings.adminCancel(auth, codeParam(ctx), reason, requestMeta(ctx)), { headers: NO_STORE });
    }),

    // ------------------------------------------------------------------ admin pricing rules
    rules: withAuth(services, async (ctx, auth) => {
      const q = ctx.url.searchParams;
      const v = new Validator(Object.fromEntries(q.entries())).allowOnly(["targetType", "unitId", "status"]);
      const filter = {
        targetType: v.oneOf("targetType", TARGET_TYPES),
        unitId: v.string("unitId", { pattern: ID_PATTERN }),
        status: v.oneOf("status", RULE_STATUSES),
      };
      v.assertValid();
      return jsonOk(await services(ctx).pricingRules.list(auth, filter, requestMeta(ctx)));
    }),

    createRule: withAuth(services, async (ctx, auth) => {
      const input = parseRule(await readJsonObject(ctx.request), false) as PricingRuleInput;
      return jsonOk(await services(ctx).pricingRules.create(auth, input, requestMeta(ctx)), { status: 201 });
    }),

    updateRule: withAuth(services, async (ctx, auth) => {
      const ruleId = ctx.params.id ?? "";
      if (!ID_PATTERN.test(ruleId)) throw new ValidationError({ id: "INVALID_ID" });
      const patch = parseRule(await readJsonObject(ctx.request), true);
      return jsonOk(await services(ctx).pricingRules.update(auth, ruleId, patch, requestMeta(ctx)));
    }),
  };
}
