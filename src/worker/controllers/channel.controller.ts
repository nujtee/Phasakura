import { ICAL_CHANNELS, type IcalChannel } from "../../shared/channel-types.ts";
import { requestMeta, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors.ts";
import { switches } from "./center.controller.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function feedKey(ctx: RequestContext): { unitId: string; channel: IcalChannel } {
  const unitId = ctx.params.unitId ?? "";
  const channel = (ctx.params.channel ?? "").toUpperCase() as IcalChannel;
  if (!ID_PATTERN.test(unitId)) throw new ValidationError({ unitId: "INVALID_ID" });
  if (!ICAL_CHANNELS.includes(channel)) throw new ValidationError({ channel: "INVALID_VALUE" });
  return { unitId, channel };
}

/** OTA channels (phase O1): Accommodation → OTA channels, and the public iCal links the OTAs read. */
export function channelController(services: ServicesFor) {
  const channex = (ctx: RequestContext) => {
    const s = services(ctx).channels.channex;
    if (!s) throw new ConflictError("Channex is not available", "CHANNEX_NOT_CONFIGURED");
    return s;
  };
  return {
    overview: withPermission("channels.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).channels.overview(auth, requestMeta(ctx)))),

    /** `{ ical?: boolean, channex?: boolean }` — SUPER_ADMIN (channels.toggle). */
    setEnabled: withPermission("channels.toggle", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      new Validator(body).allowOnly(["ical", "channex"]).assertValid();
      return jsonOk(await services(ctx).channels.setEnabled(auth, switches(body), requestMeta(ctx)));
    }),

    // ---------------------------------------------------------------- Channex (phase O2)

    channexTest: withPermission("channels.edit", services, async (ctx, auth) =>
      jsonOk(await channex(ctx).testConnection(auth, requestMeta(ctx)))),

    /** `{ propertyId: string | null }` — channels.edit (SUPER_ADMIN, MANAGER). */
    channexProperty: withPermission("channels.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["propertyId"]);
      if (body.propertyId !== null && typeof body.propertyId !== "string") v.errors.propertyId = "REQUIRED";
      v.assertValid();
      return jsonOk(await channex(ctx).selectProperty(auth, (body.propertyId as string | null) || null, requestMeta(ctx)));
    }),

    channexRooms: withPermission("channels.edit", services, async (ctx, auth) =>
      jsonOk(await channex(ctx).rooms(auth, requestMeta(ctx)))),

    /** `{ roomTypeId: string | null, ratePlanId?: string | null }` */
    channexMap: withPermission("channels.edit", services, async (ctx, auth) => {
      const unitId = ctx.params.unitId ?? "";
      if (!ID_PATTERN.test(unitId)) throw new ValidationError({ unitId: "INVALID_ID" });
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["roomTypeId", "ratePlanId"]);
      const uuid = (key: string) => {
        const value = body[key];
        if (value === null || value === undefined || value === "") return null;
        if (typeof value !== "string" || !UUID.test(value)) { v.errors[key] = "INVALID_ID"; return null; }
        return value;
      };
      if (body.roomTypeId === undefined) v.errors.roomTypeId = "REQUIRED";
      const roomTypeId = uuid("roomTypeId");
      const ratePlanId = uuid("ratePlanId");
      v.assertValid();
      return jsonOk(await channex(ctx).mapUnit(auth, unitId, roomTypeId, roomTypeId ? ratePlanId : null, requestMeta(ctx)));
    }),

    channexAutoCreate: withPermission("channels.edit", services, async (ctx, auth) =>
      jsonOk(await channex(ctx).autoCreate(auth, requestMeta(ctx)))),

    /** `{ enabled?: boolean, markupPercent?: number }` — sending availability / prices (phase O3). */
    channexAri: withPermission("channels.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["enabled", "markupPercent"]);
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") v.errors.enabled = "REQUIRED";
      if (body.markupPercent !== undefined && (typeof body.markupPercent !== "number" || !Number.isInteger(body.markupPercent)
        || body.markupPercent < 0 || body.markupPercent > 100)) v.errors.markupPercent = "OUT_OF_RANGE";
      if (body.enabled === undefined && body.markupPercent === undefined) v.errors.enabled = "REQUIRED";
      v.assertValid();
      return jsonOk(await channex(ctx).setAri(auth, { enabled: body.enabled as boolean | undefined, markupPercent: body.markupPercent as number | undefined }, requestMeta(ctx)));
    }),

    channexPush: withPermission("channels.edit", services, async (ctx, auth) =>
      jsonOk(await channex(ctx).pushNow(auth, requestMeta(ctx)))),

    // ---------------------------------------------------------------- OTA bookings (phase O4)

    otaBookings: withPermission("channels.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).otaBookings.list(auth, requestMeta(ctx)))),

    otaResolve: withPermission("channels.edit", services, async (ctx, auth) => {
      const id = ctx.params.id ?? "";
      if (!ID_PATTERN.test(id)) throw new ValidationError({ id: "INVALID_ID" });
      return jsonOk(await services(ctx).otaBookings.resolve(auth, id, requestMeta(ctx)));
    }),

    /** `{ importUrl?: string | null, label?: string | null }` — the OTA's calendar link for one unit; label = OTHER's name. */
    setImportUrl: withPermission("channels.edit", services, async (ctx, auth) => {
      const { unitId, channel } = feedKey(ctx);
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["importUrl", "label"]);
      if (body.importUrl !== undefined && body.importUrl !== null && typeof body.importUrl !== "string") v.errors.importUrl = "REQUIRED";
      if (body.label !== undefined && body.label !== null && typeof body.label !== "string") v.errors.label = "INVALID";
      if (body.importUrl === undefined && body.label === undefined) v.errors.importUrl = "REQUIRED";
      v.assertValid();
      const url = body.importUrl === undefined ? undefined : typeof body.importUrl === "string" && body.importUrl.trim() ? body.importUrl : null;
      const label = body.label === undefined ? undefined : (body.label as string | null);
      return jsonOk(await services(ctx).channels.setImportUrl(auth, unitId, channel, url, requestMeta(ctx), label));
    }),

    rotate: withPermission("channels.edit", services, async (ctx, auth) => {
      const { unitId, channel } = feedKey(ctx);
      return jsonOk(await services(ctx).channels.rotateToken(auth, unitId, channel, requestMeta(ctx)));
    }),

    sync: withPermission("channels.edit", services, async (ctx, auth) => {
      const { unitId, channel } = feedKey(ctx);
      return jsonOk(await services(ctx).channels.syncNow(auth, unitId, channel, requestMeta(ctx)));
    }),

    /** GET /api/public/ical/<secret>.ics — read by Booking.com / Agoda / Airbnb. */
    publicCalendar: (async (ctx) => {
      const ics = await services(ctx).channels.exportCalendar(ctx.params.file ?? "");
      if (ics === null) throw new NotFoundError("Calendar not found", "NOT_FOUND");
      return new Response(ctx.request.method === "HEAD" ? null : ics, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'inline; filename="calendar.ics"',
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex",
        },
      });
    }) satisfies Handler,
  };
}
