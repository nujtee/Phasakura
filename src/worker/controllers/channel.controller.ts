import { ICAL_CHANNELS, type IcalChannel } from "../../shared/channel-types.ts";
import { requestMeta, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { NotFoundError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

function feedKey(ctx: RequestContext): { unitId: string; channel: IcalChannel } {
  const unitId = ctx.params.unitId ?? "";
  const channel = (ctx.params.channel ?? "").toUpperCase() as IcalChannel;
  if (!ID_PATTERN.test(unitId)) throw new ValidationError({ unitId: "INVALID_ID" });
  if (!ICAL_CHANNELS.includes(channel)) throw new ValidationError({ channel: "INVALID_VALUE" });
  return { unitId, channel };
}

/** OTA channels (phase O1): Accommodation → OTA channels, and the public iCal links the OTAs read. */
export function channelController(services: ServicesFor) {
  return {
    overview: withPermission("channels.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).channels.overview(auth, requestMeta(ctx)))),

    /** `{ ical: boolean }` — SUPER_ADMIN (channels.toggle). */
    setEnabled: withPermission("channels.toggle", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      new Validator(body).allowOnly(["ical"]).assertValid();
      if (typeof body.ical !== "boolean") throw new ValidationError({ ical: "REQUIRED" });
      return jsonOk(await services(ctx).channels.setEnabled(auth, { ical: body.ical }, requestMeta(ctx)));
    }),

    /** `{ importUrl: string | null }` — the OTA's calendar link for one unit. */
    setImportUrl: withPermission("channels.edit", services, async (ctx, auth) => {
      const { unitId, channel } = feedKey(ctx);
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["importUrl"]);
      if (body.importUrl !== null && typeof body.importUrl !== "string") v.errors.importUrl = "REQUIRED";
      v.assertValid();
      const url = typeof body.importUrl === "string" && body.importUrl.trim() ? body.importUrl : null;
      return jsonOk(await services(ctx).channels.setImportUrl(auth, unitId, channel, url, requestMeta(ctx)));
    }),

    rotate: withPermission("channels.edit", services, async (ctx, auth) => {
      const { unitId, channel } = feedKey(ctx);
      return jsonOk(await services(ctx).channels.rotateToken(auth, unitId, channel, requestMeta(ctx)));
    }),

    sync: withPermission("channels.edit", services, async (ctx, auth) => {
      const { unitId, channel } = feedKey(ctx);
      return jsonOk(await services(ctx).channels.syncNow(auth, unitId, channel, requestMeta(ctx)));
    }),

    /** GET /api/public/ical/<secret>.ics — read by Booking.com / Agoda. */
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
