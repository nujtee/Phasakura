import { requestMeta, withAuth, type ServicesFor } from "../http/auth-guard.ts";
import { PayloadTooLargeError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { WEBHOOK_MAX_BYTES } from "../services/line.service.ts";
import { Validator } from "../validation.ts";

const NO_STORE = { "Cache-Control": "no-store" };

/** LINE (spec §47): admin settings / recipients / log, guest opt-in, and the Messaging API webhook. */
export function lineController(services: ServicesFor) {
  return {
    settings: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).line.getSettings(auth, requestMeta(ctx)))),
    saveSettings: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).line.saveSettings(auth, await readJsonObject(ctx.request), requestMeta(ctx)))),
    check: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).line.check(auth, requestMeta(ctx)))),

    recipients: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).line.recipients(auth, requestMeta(ctx)))),
    addRecipient: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).line.addRecipient(auth, await readJsonObject(ctx.request), requestMeta(ctx)), { status: 201 })),
    updateRecipient: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).line.updateRecipient(auth, ctx.params.id!, await readJsonObject(ctx.request), requestMeta(ctx)))),
    deleteRecipient: withAuth(services, async (ctx, auth) => {
      await services(ctx).line.deleteRecipient(auth, ctx.params.id!, requestMeta(ctx));
      return jsonOk({ deleted: true });
    }),
    testRecipient: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).line.test(auth, ctx.params.id!, requestMeta(ctx)))),

    createLinkCode: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).line.createLinkCode(auth, await readJsonObject(ctx.request), requestMeta(ctx)), { status: 201, headers: NO_STORE })),
    linkStatus: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).line.linkStatus(auth, ctx.params.id!, requestMeta(ctx)))),

    logs: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).line.logs(auth, ctx.url.searchParams, requestMeta(ctx)))),
    retry: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).line.retry(auth, ctx.params.id!, requestMeta(ctx)))),
    cancel: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).line.cancel(auth, ctx.params.id!, requestMeta(ctx)))),
    runNow: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).line.runNow(auth, requestMeta(ctx)))),

    /** POST /api/public/bookings/line-link { bookingCode, phone } — Booking ID + phone prove the booking is theirs. */
    guestLink: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["bookingCode", "phone"]);
      const bookingCode = v.string("bookingCode", { required: true, max: 20 });
      const phone = v.string("phone", { required: true, max: 24 });
      v.assertValid();
      return jsonOk(await services(ctx).line.guestLink(bookingCode, phone, requestMeta(ctx)), { headers: NO_STORE });
    }) satisfies Handler,

    guestUnlink: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["bookingCode", "phone"]);
      const bookingCode = v.string("bookingCode", { required: true, max: 20 });
      const phone = v.string("phone", { required: true, max: 24 });
      v.assertValid();
      return jsonOk(await services(ctx).line.guestUnlink(bookingCode, phone, requestMeta(ctx)), { headers: NO_STORE });
    }) satisfies Handler,

    /** POST /api/line/webhook — called by LINE; authenticated by `x-line-signature`, not by cookies. */
    webhook: (async (ctx) => {
      const declared = Number(ctx.request.headers.get("Content-Length") ?? "0");
      if (declared > WEBHOOK_MAX_BYTES) throw new PayloadTooLargeError();
      const raw = new Uint8Array(await ctx.request.arrayBuffer());
      if (raw.length > WEBHOOK_MAX_BYTES) throw new PayloadTooLargeError();
      const handled = await services(ctx).line.webhook(raw, ctx.request.headers.get("x-line-signature"), requestMeta(ctx));
      return jsonOk({ handled });
    }) satisfies Handler,
  };
}
