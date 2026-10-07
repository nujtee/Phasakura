import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { getReportMessages, type ReportMessages } from "../../../shared/i18n/report-messages.ts";
import type { Cell, ReportColumn, ReportDto, ReportGroup, ReportTable } from "../../../shared/report-types.ts";
import { useAdmin } from "../AdminContext.tsx";

export function useReportMessages(): ReportMessages {
  const { locale } = useAdmin();
  return getReportMessages(locale.code);
}

/** Formats one cell for the screen / print view (money in baht, codes translated, dates localised). */
export function useCellFormatter(group: ReportGroup, timeZone: string) {
  const { locale } = useAdmin();
  const m = useReportMessages();
  const num = new Intl.NumberFormat(locale.code);
  const day = new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const month = new Intl.DateTimeFormat(locale.code, { month: "long", year: "numeric", timeZone: "UTC" });
  const year = new Intl.DateTimeFormat(locale.code, { year: "numeric", timeZone: "UTC" });
  const dateTime = new Intl.DateTimeFormat(locale.code, { dateStyle: "medium", timeStyle: "short", timeZone });
  return (c: ReportColumn, v: Cell | undefined): string => {
    if (v === null || v === undefined || v === "") return "—";
    switch (c.kind) {
      case "money": return typeof v === "number" ? formatBaht(v, locale.code) : String(v);
      case "int": return typeof v === "number" ? num.format(v) : String(v);
      case "percent": return typeof v === "number" ? `${v.toFixed(1)}%` : String(v);
      case "code": return (m.codes as Record<string, string>)[String(v)] ?? String(v);
      case "date": return day.format(new Date(`${v}T00:00:00Z`));
      case "datetime": return dateTime.format(new Date(String(v)));
      case "period": {
        const s = String(v);
        if (group === "year" || s.length === 4) return year.format(new Date(`${s}-01-01T00:00:00Z`));
        if (group === "month" || s.length === 7) return month.format(new Date(`${s}-01T00:00:00Z`));
        return day.format(new Date(`${s}T00:00:00Z`));
      }
      default: return String(v);
    }
  };
}

const NUMERIC = new Set(["int", "money", "percent"]);

/** Body cell class: numbers right-aligned; booking codes and status labels never wrap; free text gets room. */
function cellClass(c: ReportColumn): string | undefined {
  if (NUMERIC.has(c.kind)) return "adm-num";
  if (c.kind === "code" || c.key === "bookingCode") return "rpt-nowrap";
  return c.kind === "text" ? "rpt-text" : undefined;
}

/** Vertical bars for a period column (screen only; the table below carries the same numbers). */
function Bars({ table, column, label }: { table: ReportTable; column: ReportColumn; label: (c: ReportColumn, v: Cell) => string }) {
  const periodCol = table.columns[0]!;
  const values = table.rows.map((r) => (typeof r[column.key] === "number" ? (r[column.key] as number) : 0));
  const max = Math.max(1, ...values);
  const { locale } = useAdmin(); // before the early return (rules of hooks)
  if (table.rows.length < 2 || table.rows.length > 62) return null;
  // At most ~8 short axis labels (day number, short month, year): on a phone 31 full dates would
  // collide. The full period is in each bar's title and in the table below.
  const every = Math.ceil(table.rows.length / 8);
  const month = new Intl.DateTimeFormat(locale.code, { month: "short", timeZone: "UTC" });
  const axis = (v: Cell): string => {
    const text = String(v ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return String(Number(text.slice(8)));
    if (/^\d{4}-\d{2}$/.test(text)) return month.format(new Date(`${text}-01T00:00:00Z`));
    return text;
  };
  return (
    <div className="rpt-bars" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${table.rows.length}, minmax(0, 1fr))` }}>
      {table.rows.map((r, i) => (
        <div key={String(r.period ?? i)} className="rpt-bars__col" title={`${label(periodCol, r[periodCol.key] ?? null)}: ${label(column, r[column.key] ?? null)}`}>
          <span className="rpt-bars__bar" style={{ height: `${Math.round((values[i]! / max) * 100)}%` }} />
          <span className="rpt-bars__label">{i % every === 0 ? axis(r[periodCol.key] ?? null) : ""}</span>
        </div>
      ))}
    </div>
  );
}

/** Renders every table of a report — shared by the Reports page and the printable PDF view. */
export function ReportView({ report, print = false }: { report: ReportDto; print?: boolean }) {
  const m = useReportMessages();
  const fmt = useCellFormatter(report.group, report.timezone);
  const label = (key: string) => (m.cols as Record<string, string>)[key] ?? key;
  return (
    <div className="rpt">
      {report.tables.map((t) => {
        const chartCol = t.chart ? t.columns.find((c) => c.key === t.chart) : undefined;
        const empty = t.rows.length === 0;
        return (
          <section key={t.key} className="rpt-table" aria-labelledby={`rpt-${report.type}-${t.key}`}>
            <h2 className="adm-h2" id={`rpt-${report.type}-${t.key}`}>{(m.tables as Record<string, string>)[t.key] ?? t.key}</h2>
            {!print && chartCol && !empty && (
              <figure className="rpt-chart">
                <figcaption className="adm-small adm-muted">{label(chartCol.key)}</figcaption>
                <Bars table={t} column={chartCol} label={fmt} />
              </figure>
            )}
            {empty ? <p className="adm-muted">{m.ui.noData}</p> : (
              <div className={print ? undefined : "adm-tablewrap"}>
                <table className="adm-table rpt-grid">
                  <thead>
                    <tr>{t.columns.map((c) => <th key={c.key} scope="col" className={NUMERIC.has(c.kind) ? "adm-num" : undefined}>{label(c.key)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r, i) => (
                      <tr key={i}>
                        {t.columns.map((c, j) => {
                          const v = fmt(c, r[c.key]);
                          return j === 0
                            ? <th key={c.key} scope="row" className={NUMERIC.has(c.kind) ? "adm-num" : undefined}>{v}</th>
                            : <td key={c.key} className={cellClass(c)}>{v}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                  {t.totals && (
                    <tfoot>
                      <tr className="adm-table__total">
                        {t.columns.map((c, j) => (
                          <td key={c.key} className={NUMERIC.has(c.kind) ? "adm-num" : undefined}>
                            {j === 0 ? m.ui.totals : t.totals![c.key] === undefined ? "" : fmt(c, t.totals![c.key])}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
            {t.truncated && <p className="adm-small adm-text-error">{format(m.ui.truncated, { n: t.rows.length })}</p>}
          </section>
        );
      })}
      <ul className="rpt-notes">
        {report.notes.map((n) => <li key={n}>{(m.notes as Record<string, string>)[n] ?? n}</li>)}
      </ul>
    </div>
  );
}
