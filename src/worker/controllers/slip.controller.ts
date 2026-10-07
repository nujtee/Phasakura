import { requestMeta, withAuth, type ServicesFor } from "../http/auth-guard.ts";
import { HttpError, PayloadTooLargeError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { SLIP_LIMITS } from "../services/slip.service.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const QUEUE_STATUSES = ["PENDING_VERIFICATION", "VERIFIED", "REJECTED"] as const;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const TRANSACTION_REF = /^[A-Za-z0-9._-]{4,64}$/;

function paymentId(ctx: RequestContext): string {
  const id = ctx.params.id ?? "";
  if (!ID_PATTERN.test(id)) throw new ValidationError({ id: "INVALID_ID" });
  return id;
}

export function slipController(services: ServicesFor) {
  return {
    /** POST /api/public/bookings/slip — multipart { bookingCode, phone, file }. Booking ID + phone prove ownership. */
    submit: (async (ctx) => {
      const type = ctx.request.headers.get("Content-Type") ?? "";
      if (!/^multipart\/form-data;/i.test(type)) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use multipart/form-data");
      if (Number(ctx.request.headers.get("Content-Length") ?? "0") > SLIP_LIMITS.maxBytes + 64 * 1024) throw new PayloadTooLargeError();
      let form: FormData;
      try {
        form = await ctx.request.formData();
      } catch {
        throw new ValidationError({ body: "INVALID_MULTIPART" });
      }
      const unknown = [...form.keys()].filter((k) => !["bookingCode", "phone", "file"].includes(k));
      if (unknown.length) throw new ValidationError(Object.fromEntries(unknown.map((k) => [k, "UNKNOWN_FIELD"])));
      const code = form.get("bookingCode");
      const phone = form.get("phone");
      const file = form.get("file");
      const errors: Record<string, string> = {};
      if (typeof code !== "string" || code.length > 20) errors.bookingCode = "REQUIRED";
      if (typeof phone !== "string" || phone.length > 24) errors.phone = "REQUIRED";
      if (!(file instanceof File)) errors.file = "REQUIRED";
      if (Object.keys(errors).length) throw new ValidationError(errors);
      const result = await services(ctx).slips.submit(code as string, phone as string, file as File, requestMeta(ctx));
      return jsonOk(result, { status: 201, headers: { "Cache-Control": "no-store" } });
    }) satisfies Handler,

    queue: withAuth(services, async (ctx, auth) => {
      const q = ctx.url.searchParams;
      const v = new Validator(Object.fromEntries(q.entries())).allowOnly(["status", "before", "limit"]);
      const status = v.oneOf("status", QUEUE_STATUSES) ?? "PENDING_VERIFICATION";
      const before = v.string("before", { pattern: TIMESTAMP }) ?? null;
      const limitRaw = Number(q.get("limit") ?? 30);
      v.assertValid();
      const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 30;
      return jsonOk(await services(ctx).slips.queue(auth, status, before, limit, requestMeta(ctx)));
    }),

    image: withAuth(services, async (ctx, auth) => services(ctx).slips.slipImage(auth, paymentId(ctx), requestMeta(ctx))),

    verify: withAuth(services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["transactionRef"]);
      const transactionRef = v.string("transactionRef", { pattern: TRANSACTION_REF }) ?? null;
      v.assertValid();
      return jsonOk(await services(ctx).slips.verify(auth, paymentId(ctx), { transactionRef }, requestMeta(ctx)));
    }),

    reject: withAuth(services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["reason"]);
      const reason = v.string("reason", { required: true, min: 3, max: 500 })!;
      v.assertValid();
      return jsonOk(await services(ctx).slips.reject(auth, paymentId(ctx), reason, requestMeta(ctx)));
    }),
  };
}
