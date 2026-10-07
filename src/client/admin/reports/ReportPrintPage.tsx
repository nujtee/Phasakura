import { useEffect, useState } from "react";
import type { PublicSiteDto } from "../../../shared/api-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { REPORT_GROUPS, REPORT_TYPES, type ReportDto, type ReportGroup, type ReportType } from "../../../shared/report-types.ts";
import { apiGet } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, errorMessage } from "../ui.tsx";
import { ReportView, useReportMessages } from "./ReportView.tsx";

/**
 * Printable A4 report (the "PDF" export): the browser's print dialog saves it as a PDF with
 * correct Thai and Chinese text shaping — no font embedding, no third-party service.
 * The data request carries export=pdf, so the Worker checks reports.export and audits it.
 */
export function ReportPrintPage() {
  const { t, locale, me, href } = useAdmin();
  const m = useReportMessages();
  const [report, setReport] = useState<ReportDto | null>(null);
  const [site, setSite] = useState<PublicSiteDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const type = q.get("type") as ReportType;
    const group = (q.get("group") ?? "day") as ReportGroup;
    if (!(REPORT_TYPES as readonly string[]).includes(type) || !(REPORT_GROUPS as readonly string[]).includes(group)) {
      setError(t.common.notFound);
      return;
    }
    const params = new URLSearchParams({ from: q.get("from") ?? "", to: q.get("to") ?? "", group, lang: locale.path, export: "pdf" });
    const controller = new AbortController();
    Promise.all([
      apiGet<ReportDto>(`/api/admin/reports/${type}?${params.toString()}`, controller.signal),
      apiGet<PublicSiteDto>(`/api/public/site?lang=${locale.path}`, controller.signal).catch(() => null),
    ])
      .then(([r, s]) => { setReport(r); setSite(s); })
      .catch((err: unknown) => !controller.signal.aborted && setError(errorMessage(t, err)));
    return () => controller.abort();
  }, [locale.path, t]);

  useEffect(() => {
    if (!report) return;
    document.title = `${m.types[report.type]} ${report.from}–${report.to}`;
    const timer = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(timer);
  }, [report, m]);

  const generated = report
    ? new Intl.DateTimeFormat(locale.code, { dateStyle: "medium", timeStyle: "short", timeZone: report.timezone }).format(new Date(report.generatedAt))
    : "";

  return (
    <main className="rpt-print" lang={locale.code}>
      <div className="rpt-print__toolbar">
        <a href={href("reports")} className="adm-btn adm-btn--secondary">← {m.ui.back}</a>
        <button type="button" className="adm-btn adm-btn--primary" onClick={() => window.print()} disabled={!report}>{m.ui.print}</button>
        <span className="adm-small adm-muted">{m.ui.printHint}</span>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!report && !error && <p role="status">{m.ui.loading}</p>}
      {report && (
        <article className="rpt-print__doc">
          <header className="rpt-print__head">
            {site?.logo.main && <img src={site.logo.main.url} alt="" className="rpt-print__logo" />}
            <div>
              {site?.siteName && <p className="rpt-print__site">{site.siteName}</p>}
              <h1 className="rpt-print__title">{m.ui.title}: {m.types[report.type]}</h1>
              <p className="rpt-print__meta">
                {format(m.ui.periodLabel, { from: report.from, to: report.to })} · {format(m.ui.timezone, { tz: report.timezone })}
                <br />
                {format(m.ui.generatedAt, { time: generated })}{me ? ` · ${format(m.ui.generatedBy, { name: me.displayName })}` : ""}
              </p>
            </div>
          </header>
          <ReportView report={report} print />
        </article>
      )}
    </main>
  );
}
