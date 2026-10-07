import { BOOKING_CODE_PATTERN, PAYMENT_STATUSES_ALL } from "../../shared/booking-types.ts";
import { STAY_ACTIONS, type StayAction } from "../../shared/dashboard-types.ts";
import { isIsoDate } from "../../shared/dates.ts";
import { FOOD_ORDER_STATUSES, type FoodOrderStatus } from "../../shared/food-admin-types.ts";
import { PAYMENT_METHODS } from "../../shared/payment-types.ts";
import { requestMeta, withAuth, type ServicesFor } from "../http/auth-guard.ts";
import { NotFoundError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function q(ctx: RequestContext, key: string): string | undefined {
  const v = ctx.url.searchParams.get(key);
  return v === null || v === "" ? undefined : v;
}

function intField(v: Validator, body: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    v.errors[key] = value === undefined ? "REQUIRED" : "OUT_OF_RANGE";
    return 0;
  }
  return value;
}

/** Dashboard, calendar, payments list, stay actions, booking settings, food capacity and kitchen orders. */
export function adminDashboardController(services: ServicesFor) {
  return {
    dashboard: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).dashboard.dashboard(auth, requestMeta(ctx)), NO_STORE)),

    calendar: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).dashboard.calendar(auth, q(ctx, "from"), q(ctx, "to"), requestMeta(ctx)), NO_STORE)),

    payments: withAuth(services, async (ctx, auth) => {
      const v = new Validator(Object.fromEntries(ctx.url.searchParams.entries()))
        .allowOnly(["status", "method", "code", "from", "to", "before", "limit"]);
      const status = v.oneOf("status", PAYMENT_STATUSES_ALL) ?? null;
      const method = v.oneOf("method", PAYMENT_METHODS) ?? null;
      const code = v.string("code", { max: 20 })?.toUpperCase() ?? null;
      if (code && !BOOKING_CODE_PATTERN.test(code)) v.errors.code = "INVALID_FORMAT";
      const from = v.string("from");
      const to = v.string("to");
      if (from && !isIsoDate(from)) v.errors.from = "INVALID_DATE";
      if (to && !isIsoDate(to)) v.errors.to = "INVALID_DATE";
      const before = v.string("before", { max: 40 }) ?? null;
      const limit = Number(q(ctx, "limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) v.errors.limit = "OUT_OF_RANGE";
      v.assertValid();
      return jsonOk(await services(ctx).payments.listPayments(auth, {
        status, method, code, from: from ?? null, to: to ?? null, before, limit,
      }, requestMeta(ctx)), NO_STORE);
    }),

    stay: withAuth(services, async (ctx, auth) => {
      const code = (ctx.params.code ?? "").toUpperCase();
      const action = ctx.params.action as StayAction;
      if (!BOOKING_CODE_PATTERN.test(code)) throw new ValidationError({ code: "INVALID_FORMAT" });
      if (!(STAY_ACTIONS as readonly string[]).includes(action)) throw new NotFoundError();
      return jsonOk(await services(ctx).bookings.adminStay(auth, code, action, requestMeta(ctx)), NO_STORE);
    }),

    bookingSettings: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).bookings.getSettings(auth, requestMeta(ctx)))),

    saveBookingSettings: withAuth(services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["holdMinutes", "maxNights", "maxAdvanceDays", "maxTentsPerBooking"]);
      const input = {
        holdMinutes: intField(v, body, "holdMinutes", 5, 10_080),
        maxNights: intField(v, body, "maxNights", 1, 365),
        maxAdvanceDays: intField(v, body, "maxAdvanceDays", 1, 730),
        maxTentsPerBooking: intField(v, body, "maxTentsPerBooking", 1, 100),
      };
      v.assertValid();
      return jsonOk(await services(ctx).bookings.saveSettings(auth, input, requestMeta(ctx)));
    }),

    // ------------------------------------------------------------------ food (spec §22, §24)
    foodCapacity: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).foodAdmin.capacity(auth, q(ctx, "from"), q(ctx, "to"), requestMeta(ctx)), NO_STORE)),

    setFoodCapacity: withAuth(services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["maxQuantity"]);
      let max: number | null = null;
      if (body.maxQuantity !== null) max = intField(v, body, "maxQuantity", 0, 100_000);
      v.assertValid();
      return jsonOk(await services(ctx).foodAdmin.setCapacity(auth, ctx.params.categoryId ?? "", ctx.params.date ?? "", max, requestMeta(ctx)));
    }),

    foodOrders: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).foodAdmin.orders(auth, {
        from: q(ctx, "from"), to: q(ctx, "to"), categoryId: q(ctx, "categoryId"), status: q(ctx, "status"),
      }, requestMeta(ctx)), NO_STORE)),

    updateFoodOrder: withAuth(services, async (ctx, auth) => {
      const id = ctx.params.id ?? "";
      if (!ID_PATTERN.test(id)) throw new NotFoundError("Order not found", "RECORD_NOT_FOUND");
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["status", "expectedStatus", "kitchenNote"]);
      const status = v.oneOf("status", FOOD_ORDER_STATUSES, { required: true }) as FoodOrderStatus;
      const expectedStatus = v.oneOf("expectedStatus", FOOD_ORDER_STATUSES, { required: true }) as FoodOrderStatus;
      const kitchenNote = body.kitchenNote === null ? null : v.string("kitchenNote", { max: 500 });
      v.assertValid();
      return jsonOk(await services(ctx).foodAdmin.updateOrder(auth, id, {
        status, expectedStatus, ...(kitchenNote !== undefined ? { kitchenNote } : {}),
      }, requestMeta(ctx)));
    }),
  };
}
