import { getLocale, parseLocale } from "../../shared/i18n/locales.ts";
import { REPORT_GROUPS, REPORT_TYPES, type ReportGroup, type ReportType } from "../../shared/report-types.ts";
import { requestMeta, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { NotFoundError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import { reportFileName, reportToXlsx } from "../reports/report-export.ts";
import type { RequestContext } from "../router.ts";
import type { ReportRequest } from "../services/report.service.ts";
import { Validator } from "../validation.ts";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function parse(ctx: RequestContext, today: () => Promise<string>, extra: string[]): Promise<ReportRequest & { export?: string; format?: string }> {
  const type = ctx.params.type as ReportType;
  if (!(REPORT_TYPES as readonly string[]).includes(type)) throw new NotFoundError("Unknown report", "REPORT_NOT_FOUND");
  const v = new Validator(Object.fromEntries(ctx.url.searchParams.entries())).allowOnly(["from", "to", "group", "lang", ...extra]);
  const group = (v.oneOf("group", REPORT_GROUPS) ?? "day") as ReportGroup;
  const langRaw = v.string("lang", { max: 10 });
  const locale = langRaw ? parseLocale(langRaw) : getLocale("th");
  if (!locale) v.errors.lang = "INVALID_VALUE";
  const from = v.string("from", { max: 10 });
  const to = v.string("to", { max: 10 });
  const exp = v.string("export", { max: 10 });
  const fmt = v.string("format", { max: 10 });
  v.assertValid();
  const d = from && to ? null : await today();
  return { type, group, lang: locale!.code, from: from ?? d!, to: to ?? from ?? d!, export: exp, format: fmt };
}

/** Reports (spec §50): JSON for the screen / print (PDF) view, XLSX download. */
export function reportController(services: ServicesFor) {
  return {
    run: withPermission(["reports.view", "kitchen.view"], services, async (ctx, auth) => {
      const s = services(ctx);
      const req = await parse(ctx, () => s.reports.today(), ["export"]);
      if (req.export !== undefined && req.export !== "pdf") throw new ValidationError({ export: "INVALID_VALUE" });
      const report = await s.reports.run(auth, req, requestMeta(ctx), req.export === "pdf" ? "pdf" : undefined);
      return jsonOk(report, { headers: { "Cache-Control": "no-store" } });
    }),

    exportXlsx: withPermission(["reports.export", "kitchen.view"], services, async (ctx, auth) => {
      const s = services(ctx);
      const req = await parse(ctx, () => s.reports.today(), ["format"]);
      if (req.format !== undefined && req.format !== "xlsx") throw new ValidationError({ format: "INVALID_VALUE" });
      const report = await s.reports.run(auth, req, requestMeta(ctx), "xlsx");
      const site = await s.site.getPublicSite(getLocale(req.lang as "th"));
      const bytes = reportToXlsx(report, req.lang as "th", site.siteName);
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": XLSX_TYPE,
          "Content-Disposition": `attachment; filename="${reportFileName(report, "xlsx")}"`,
          "Cache-Control": "no-store",
          "Content-Length": String(bytes.length),
        },
      });
    }),
  };
}
