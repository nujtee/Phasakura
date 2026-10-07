import { ACCOUNT_NUMBER_PATTERN, PAYMENT_METHODS, PROMPTPAY_PATTERN, type ReceivingAccountInput } from "../../shared/payment-types.ts";
import { BOOKING_CODE_PATTERN } from "../../shared/booking-types.ts";
import { MAX_PRICE_SATANG } from "../../shared/booking-rules.ts";
import { requestMeta, withAuth, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const STATUSES = ["ACTIVE", "INACTIVE"] as const;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function param(ctx: RequestContext, name: string, pattern: RegExp): string {
  const value = name === "code" ? (ctx.params[name] ?? "").toUpperCase() : ctx.params[name] ?? "";
  if (!pattern.test(value)) throw new ValidationError({ [name]: "INVALID_FORMAT" });
  return value;
}

function money(v: Validator, value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_PRICE_SATANG * 100) {
    v.errors[key] = value === undefined ? "REQUIRED" : "OUT_OF_RANGE";
    return 0;
  }
  return value;
}

/** Account fields: digits normalised (spaces/dashes in PromptPay removed); at least one of account number / PromptPay. */
function parseAccount(body: Record<string, unknown>, partial: boolean): Partial<ReceivingAccountInput> {
  const v = new Validator(body).allowOnly(["bankName", "accountName", "accountNumber", "promptpayNumber", "qrAssetId", "status", "sortOrder"]);
  const out: Partial<ReceivingAccountInput> = {};
  const want = (k: string) => !partial || v.has(k) || body[k] === null;
  if (want("bankName")) out.bankName = v.string("bankName", { required: true, max: 80 });
  if (want("accountName")) out.accountName = v.string("accountName", { required: true, max: 120 });
  if (want("accountNumber")) out.accountNumber = body.accountNumber === null ? null : v.string("accountNumber", { pattern: ACCOUNT_NUMBER_PATTERN }) ?? null;
  if (want("promptpayNumber")) {
    const raw = body.promptpayNumber;
    if (raw === null || raw === undefined || raw === "") out.promptpayNumber = null;
    else if (typeof raw !== "string") v.errors.promptpayNumber = "EXPECTED_STRING";
    else {
      const digits = raw.replace(/[\s-]/g, "");
      if (PROMPTPAY_PATTERN.test(digits)) out.promptpayNumber = digits;
      else v.errors.promptpayNumber = "INVALID_FORMAT";
    }
  }
  if (want("qrAssetId")) out.qrAssetId = body.qrAssetId === null ? null : v.string("qrAssetId", { pattern: ID_PATTERN }) ?? null;
  if (v.has("status") || !partial) out.status = v.oneOf("status", STATUSES) ?? "ACTIVE";
  if (v.has("sortOrder") || !partial) {
    const n = body.sortOrder ?? 0;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 10_000) v.errors.sortOrder = "OUT_OF_RANGE";
    else out.sortOrder = n;
  }
  v.assertValid();
  if (!partial && !out.accountNumber && !out.promptpayNumber) throw new ValidationError({ accountNumber: "ACCOUNT_OR_PROMPTPAY_REQUIRED" });
  return out;
}

export function paymentController(services: ServicesFor) {
  return {
    // ------------------------------------------------------------------ receiving accounts
    accounts: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).payments.listAccounts(auth, requestMeta(ctx)))),

    createAccount: withPermission("receiving_accounts.edit", services, async (ctx, auth) => {
      const input = parseAccount(await readJsonObject(ctx.request), false) as ReceivingAccountInput;
      return jsonOk(await services(ctx).payments.createAccount(auth, input, requestMeta(ctx)), { status: 201 });
    }),

    updateAccount: withPermission("receiving_accounts.edit", services, async (ctx, auth) => {
      const patch = parseAccount(await readJsonObject(ctx.request), true);
      return jsonOk(await services(ctx).payments.updateAccount(auth, param(ctx, "id", ID_PATTERN), patch, requestMeta(ctx)));
    }),

    setPrimary: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).payments.setPrimary(auth, param(ctx, "id", ID_PATTERN), requestMeta(ctx)))),

    deleteAccount: withAuth(services, async (ctx, auth) => {
      await services(ctx).payments.deleteAccount(auth, param(ctx, "id", ID_PATTERN), requestMeta(ctx));
      return jsonOk({ deleted: true });
    }),

    // ------------------------------------------------------------------ payments on a booking
    recordPayment: withPermission("payments.verify", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["amountSatang", "method", "paidAt", "reference", "note"]);
      const amountSatang = money(v, body.amountSatang, "amountSatang");
      const method = v.oneOf("method", PAYMENT_METHODS, { required: true })!;
      const paidAtRaw = v.string("paidAt", { required: true, pattern: TIMESTAMP });
      const reference = v.string("reference", { max: 100 }) ?? null;
      const note = v.string("note", { max: 500 }) ?? null;
      v.assertValid();
      const paidAt = new Date(paidAtRaw).toISOString();
      return jsonOk(await services(ctx).payments.recordPayment(auth, param(ctx, "code", BOOKING_CODE_PATTERN),
        { amountSatang, method, paidAt, reference, note }, requestMeta(ctx)), { headers: { "Cache-Control": "no-store" } });
    }),

    refund: withPermission("payments.refund", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["amountSatang", "reason"]);
      const amountSatang = money(v, body.amountSatang, "amountSatang");
      const reason = v.string("reason", { required: true, min: 3, max: 500 })!;
      v.assertValid();
      return jsonOk(await services(ctx).payments.refund(auth, param(ctx, "code", BOOKING_CODE_PATTERN), param(ctx, "paymentId", ID_PATTERN),
        { amountSatang, reason }, requestMeta(ctx)), { headers: { "Cache-Control": "no-store" } });
    }),
  };
}
