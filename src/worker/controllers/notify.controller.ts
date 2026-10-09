import { requestMeta, withAuth, type ServicesFor } from "../http/auth-guard.ts";
import { ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function id(ctx: RequestContext): string {
  const value = ctx.params.id ?? "";
  if (!ID_PATTERN.test(value)) throw new ValidationError({ id: "INVALID_ID" });
  return value;
}

/** E-mail notifications (Resend): settings, staff addresses, test, log. Permissions are checked in the service. */
export function emailController(services: ServicesFor) {
  return {
    settings: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).email.getSettings(auth, requestMeta(ctx)))),
    saveSettings: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).email.saveSettings(auth, await readJsonObject(ctx.request), requestMeta(ctx)))),
    recipients: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).email.recipients(auth, requestMeta(ctx)))),
    addRecipient: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).email.addRecipient(auth, await readJsonObject(ctx.request), requestMeta(ctx)), { status: 201 })),
    updateRecipient: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).email.updateRecipient(auth, id(ctx), await readJsonObject(ctx.request), requestMeta(ctx)))),
    deleteRecipient: withAuth(services, async (ctx, auth) => {
      await services(ctx).email.deleteRecipient(auth, id(ctx), requestMeta(ctx));
      return jsonOk({ deleted: true });
    }),
    testRecipient: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).email.test(auth, id(ctx), requestMeta(ctx)))),
    logs: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).email.logs(auth, ctx.url.searchParams, requestMeta(ctx)))),
    retry: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).email.retry(auth, id(ctx), requestMeta(ctx)))),
  };
}

const ORDER_ID = /^[A-Za-z0-9-]{8,64}$/;

/** PayPal Checkout for guests: start (Booking ID + phone), finish after PayPal (order id), cancel. */
export function paypalController(services: ServicesFor) {
  return {
    /** POST /api/public/bookings/paypal/order { bookingCode, phone } → { orderId, approveUrl } */
    order: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["bookingCode", "phone"]);
      const bookingCode = v.string("bookingCode", { required: true, max: 20 });
      const phone = v.string("phone", { required: true, max: 24 });
      v.assertValid();
      return jsonOk(await services(ctx).paypal.createOrder(bookingCode, phone, requestMeta(ctx)), { status: 201, headers: NO_STORE });
    }) satisfies Handler,

    /** POST /api/public/bookings/paypal/capture { orderId } — after PayPal's return_url. */
    capture: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["orderId"]);
      const orderId = v.string("orderId", { required: true, pattern: ORDER_ID });
      v.assertValid();
      return jsonOk(await services(ctx).paypal.capture(orderId, requestMeta(ctx)), { headers: NO_STORE });
    }) satisfies Handler,

    /** POST /api/public/bookings/paypal/cancel { orderId } — after PayPal's cancel_url (nothing was taken). */
    cancel: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["orderId"]);
      const orderId = v.string("orderId", { required: true, pattern: ORDER_ID });
      v.assertValid();
      return jsonOk(await services(ctx).paypal.cancel(orderId), { headers: NO_STORE });
    }) satisfies Handler,
  };
}
