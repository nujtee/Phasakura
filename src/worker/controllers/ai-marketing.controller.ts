import { REPORT_KINDS, type AiMarketingSettingsInput } from "../../shared/ai-marketing-types.ts";
import { isIsoDate } from "../../shared/dates.ts";
import { requestMeta, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const NO_STORE = { "Cache-Control": "no-store" };
/** Monthly AI budget: 0 – 100,000 THB. */
const MAX_BUDGET_SATANG = 10_000_000;

/** AI marketing report (migration 0053): list / read (reports.view), ask for one and settings (marketing.*). */
export function aiMarketingController(services: ServicesFor) {
  return {
    list: withPermission("reports.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).aiMarketing.list(auth, requestMeta(ctx)), { headers: NO_STORE })),

    get: withPermission("reports.view", services, async (ctx, auth) => {
      const id = ctx.params.id ?? "";
      if (!ID_PATTERN.test(id)) throw new ValidationError({ id: "INVALID_ID" });
      return jsonOk(await services(ctx).aiMarketing.get(auth, id, requestMeta(ctx)), { headers: NO_STORE });
    }),

    generate: withPermission("marketing.edit", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["kind", "periodStart"]);
      const kind = v.oneOf("kind", REPORT_KINDS, { required: true });
      const periodStart = v.string("periodStart", { max: 10 });
      if (periodStart !== undefined && !isIsoDate(periodStart)) v.errors.periodStart = "INVALID_DATE";
      v.assertValid();
      return jsonOk(await services(ctx).aiMarketing.generate(auth, { kind: kind!, periodStart }, requestMeta(ctx)), { status: 201, headers: NO_STORE });
    }),

    settings: withPermission("marketing.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).aiMarketing.settings(auth, requestMeta(ctx)), { headers: NO_STORE })),

    saveSettings: withPermission("marketing.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["enabled", "aiEnabled", "monthlyBudgetSatang", "notifyEmail", "notifyLine"]);
      const input: AiMarketingSettingsInput = {};
      for (const k of ["enabled", "aiEnabled", "notifyEmail", "notifyLine"] as const) if (v.has(k)) input[k] = v.boolean(k, false);
      if (v.has("monthlyBudgetSatang")) {
        const b = body.monthlyBudgetSatang;
        if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > MAX_BUDGET_SATANG) v.errors.monthlyBudgetSatang = "INVALID_VALUE";
        else input.monthlyBudgetSatang = b;
      }
      v.assertValid();
      return jsonOk(await services(ctx).aiMarketing.updateSettings(auth, input, requestMeta(ctx)), { headers: NO_STORE });
    }),
  };
}
