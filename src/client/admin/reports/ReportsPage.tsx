import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { addDays, diffDays, monthRange } from "../../../shared/dates.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import {
  KITCHEN_MAX_DAYS, REPORT_EXPORT_PERMISSION, REPORT_LIMITS, REPORT_TYPES, REPORT_VIEW_PERMISSION,
  type ReportDto, type ReportGroup, type ReportType,
} from "../../../shared/report-types.ts";
import { apiGet } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { PageTabs } from "../cms/CmsKit.tsx";
import { Alert, Button, errorMessage } from "../ui.tsx";
import { ReportView, useReportMessages } from "./ReportView.tsx";

type Mode = "daily" | "monthly" | "yearly" | "custom";

export interface ReportQuery {
  type: ReportType;
  from: string;
  to: string;
  group: ReportGroup;
}

export function reportSearch(q: ReportQuery, lang: string): string {
  return new URLSearchParams({ from: q.from, to: q.to, group: q.group, lang }).toString();
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Reports (spec §50): type + period (daily / monthly / yearly / custom), on-screen tables, Excel, PDF. */
export function ReportsPage({ fixedType }: { fixedType?: ReportType }) {
  const { t, can, locale, href } = useAdmin();
  const m = useReportMessages();
  const allowed = REPORT_TYPES.filter((x) => (fixedType ? x === fixedType : can(REPORT_VIEW_PERMISSION[x])));
  const [type, setType] = useState<ReportType>(fixedType ?? allowed[0] ?? "revenue");
  const kitchen = type === "kitchen";
  const [mode, setMode] = useState<Mode>(kitchen ? "daily" : "monthly");
  const base = today();
  const [date, setDate] = useState(base);
  const [month, setMonth] = useState(base.slice(0, 7));
  const [year, setYear] = useState(base.slice(0, 4));
  const [custom, setCustom] = useState({ from: monthRange(base).start, to: base, group: "day" as ReportGroup });
  const [report, setReport] = useState<ReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const query: ReportQuery | null = useMemo(() => {
    if (mode === "daily") return { type, from: date, to: date, group: "day" };
    if (mode === "monthly") {
      const r = monthRange(`${month}-01`);
      return { type, from: r.start, to: addDays(r.next, -1), group: "day" };
    }
    if (mode === "yearly") return { type, from: `${year}-01-01`, to: `${year}-12-31`, group: "month" };
    if (!custom.from || !custom.to) return null;
    return { type, from: custom.from, to: custom.to, group: kitchen ? "day" : custom.group };
  }, [mode, type, date, month, year, custom, kitchen]);

  const rangeError = query ? (() => {
    const days = diffDays(query.from, query.to) + 1;
    const errors = t.errors as Record<string, string>;
    if (days < 1) return errors.BEFORE_START!;
    if (days > (kitchen ? KITCHEN_MAX_DAYS : REPORT_LIMITS[query.group])) return errors.RANGE_TOO_LONG ?? errors.OUT_OF_RANGE!;
    return null;
  })() : null;

  const run = useCallback(async (q: ReportQuery) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await apiGet<ReportDto>(`/api/admin/reports/${q.type}?${reportSearch(q, locale.path)}`));
    } catch (err) {
      setError(errorMessage(t, err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [locale.path, t]);

  // Fixed presets run immediately; a custom range runs on submit.
  useEffect(() => {
    if (mode !== "custom" && query && !rangeError) void run(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, type, date, month, year]);

  const modes: { value: Mode; label: string }[] = kitchen
    ? [{ value: "daily", label: m.ui.daily }, { value: "custom", label: m.ui.custom }]
    : [{ value: "daily", label: m.ui.daily }, { value: "monthly", label: m.ui.monthly }, { value: "yearly", label: m.ui.yearly }, { value: "custom", label: m.ui.custom }];
  const canExport = can(REPORT_EXPORT_PERMISSION[type]);
  const current = report && report.type === type ? report : null;
  const years = Array.from({ length: 8 }, (_, i) => String(Number(base.slice(0, 4)) + 1 - i));

  return (
    <section className="rpt-page">
      <h1 className="adm-h1">{fixedType ? m.types[fixedType] : m.ui.title}</h1>
      {kitchen && <p className="adm-muted">{m.ui.kitchenIntro}</p>}
      {!fixedType && allowed.length > 1 && (
        <PageTabs label={m.ui.type} value={type} onChange={(v) => { setType(v); setReport(null); if (v === "kitchen" && (mode === "monthly" || mode === "yearly")) setMode("daily"); }}
          tabs={allowed.map((x) => ({ value: x, label: m.types[x] }))} />
      )}

      <form className="adm-card rpt-controls" onSubmit={(e: FormEvent) => { e.preventDefault(); if (query && !rangeError) void run(query); }}>
        <PageTabs label={m.ui.period} value={mode} onChange={setMode} tabs={modes} />
        <div className="adm-filters">
          {mode === "daily" && (
            <label className="adm-filter"><span>{m.ui.date}</span>
              <input type="date" value={date} onChange={(e) => setDate(e.currentTarget.value || base)} /></label>
          )}
          {mode === "monthly" && (
            <label className="adm-filter"><span>{m.ui.month}</span>
              <input type="month" value={month} onChange={(e) => setMonth(e.currentTarget.value || base.slice(0, 7))} /></label>
          )}
          {mode === "yearly" && (
            <label className="adm-filter"><span>{m.ui.year}</span>
              <select value={year} onChange={(e) => setYear(e.currentTarget.value)}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
          )}
          {mode === "custom" && (
            <>
              <label className="adm-filter"><span>{m.ui.from}</span>
                <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.currentTarget.value })} /></label>
              <label className="adm-filter"><span>{m.ui.to}</span>
                <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.currentTarget.value })} /></label>
              {!kitchen && (
                <label className="adm-filter"><span>{m.ui.groupBy}</span>
                  <select value={custom.group} onChange={(e) => setCustom({ ...custom, group: e.currentTarget.value as ReportGroup })}>
                    <option value="day">{m.ui.groupDay}</option><option value="month">{m.ui.groupMonth}</option><option value="year">{m.ui.groupYear}</option>
                  </select></label>
              )}
              <Button type="submit" disabled={!query || !!rangeError} busy={loading}>{m.ui.run}</Button>
            </>
          )}
        </div>
        {rangeError && <p className="adm-field__error" role="alert">{rangeError}</p>}
        {query && !rangeError && (
          <div className="adm-row adm-row--wrap rpt-actions">
            {canExport ? (
              <>
                <a className="adm-btn adm-btn--secondary" href={`/api/admin/reports/${type}/export?${reportSearch(query, locale.path)}`} download>
                  {m.ui.exportExcel}
                </a>
                <a className="adm-btn adm-btn--secondary" target="_blank" rel="noopener"
                  href={`${href("reports", "print")}?${new URLSearchParams({ type, from: query.from, to: query.to, group: query.group }).toString()}`}>
                  {m.ui.exportPdf}
                </a>
              </>
            ) : <span className="adm-small adm-muted">{m.ui.noExport}</span>}
          </div>
        )}
      </form>

      {error && <Alert kind="error">{error}</Alert>}
      {loading && !current && <p role="status">{m.ui.loading}</p>}
      {current && (
        <div aria-busy={loading || undefined}>
          <p className="adm-small adm-muted">{format(m.ui.periodLabel, { from: current.from, to: current.to })} · {format(m.ui.timezone, { tz: current.timezone })}</p>
          <ReportView report={current} />
        </div>
      )}
    </section>
  );
}
