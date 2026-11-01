import { useEffect, useState, type FormEvent } from "react";
import {
  REPORT_KINDS,
  type AiMarketingSettingsDto, type InsightDto, type MarketingReportDto, type MarketingReportListItemDto, type PeriodTotals, type ReportKind,
} from "../../../shared/ai-marketing-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { aiMarketingMessages, type AiMarketingMessages } from "../../../shared/i18n/ai-marketing-messages.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest, ApiError } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, useDateFormatter } from "../ui.tsx";

/** AI marketing report (migration 0053): list + settings + ask for one; one report in full. */
export function AiMarketingPage({ reportId }: { reportId?: string }) {
  return reportId ? <ReportView key={reportId} id={reportId} /> : <ReportList />;
}

function useM(): AiMarketingMessages {
  return aiMarketingMessages(useAdmin().locale.code);
}

function useNumbers() {
  const { locale } = useAdmin();
  const num = new Intl.NumberFormat(locale.code);
  return {
    num: (v: number | null | undefined) => (v === null || v === undefined ? "—" : num.format(v)),
    pct: (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${num.format(v)}%`),
    baht: (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatBaht(v, locale.code)),
    date: (iso: string) => new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`)),
  };
}

function generateError(m: AiMarketingMessages, err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return m.err.TOO_MANY;
    const code = err.details.periodStart as keyof AiMarketingMessages["err"] | undefined;
    if (code && m.err[code]) return m.err[code];
  }
  return fallback;
}

// =============================================================================== list

function ReportList() {
  const { t, can, href } = useAdmin();
  const m = useM();
  const n = useNumbers();
  const dateTime = useDateFormatter();
  const [reports, setReports] = useState<MarketingReportListItemDto[] | null>(null);
  const [settings, setSettings] = useState<AiMarketingSettingsDto | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [kind, setKind] = useState<ReportKind>("WEEKLY");
  const [periodStart, setPeriodStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState("");
  const canEdit = can("marketing.edit");
  const canView = can("reports.view");

  useEffect(() => {
    const controller = new AbortController();
    const fail = (err: unknown) => !controller.signal.aborted && setMessage({ kind: "error", text: errorMessage(t, err) });
    if (canView) apiGet<MarketingReportListItemDto[]>("/api/admin/ai-marketing/reports", controller.signal).then(setReports).catch(fail);
    if (can("marketing.view")) {
      apiGet<AiMarketingSettingsDto>("/api/admin/ai-marketing/settings", controller.signal)
        .then((x) => { setSettings(x); setBudget(String(x.monthlyBudgetSatang / 100)); })
        .catch(fail);
    }
    return () => controller.abort();
  }, [t, can, canView]);

  async function save(patch: Partial<Pick<AiMarketingSettingsDto, "enabled" | "aiEnabled" | "monthlyBudgetSatang" | "notifyEmail" | "notifyLine">>) {
    if (!settings) return;
    const before = settings;
    setMessage(null);
    setSettings({ ...settings, ...patch }); // shown at once; put back if saving fails
    try {
      setSettings(await apiRequest<AiMarketingSettingsDto>("PUT", "/api/admin/ai-marketing/settings", patch));
      setMessage({ kind: "success", text: m.saved });
    } catch (err) {
      setSettings(before);
      setMessage({ kind: "error", text: err instanceof ApiError && err.details.aiEnabled === "AI_KEY_MISSING" ? m.aiKeyMissing : errorMessage(t, err) });
    }
  }

  function saveBudget(e: FormEvent) {
    e.preventDefault();
    const baht = Number(budget);
    if (!Number.isInteger(baht) || baht < 0 || baht > 100_000) return setMessage({ kind: "error", text: m.budgetInvalid });
    void save({ monthlyBudgetSatang: baht * 100 });
  }

  async function generate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const r = await apiRequest<MarketingReportDto>("POST", "/api/admin/ai-marketing/reports", { kind, ...(periodStart ? { periodStart } : {}) });
      setReports(await apiGet<MarketingReportListItemDto[]>("/api/admin/ai-marketing/reports"));
      setMessage({ kind: "success", text: `${m[r.kind]} ${n.date(r.periodStart)} – ${n.date(r.periodEnd)}` });
    } catch (err) {
      setMessage({ kind: "error", text: generateError(m, err, errorMessage(t, err)) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="adm-page aim" aria-labelledby="aim-h">
      <h1 className="adm-h1" id="aim-h">{m.title}</h1>
      <p className="adm-muted">{m.intro}</p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}

      <div className="adm-grid2 adm-grid2--gap adm-grid2--tables">
        {settings && (
          <div className="adm-card" data-testid="aim-settings">
            <h2 className="adm-h2">{m.settingsTitle}</h2>
            <label className="adm-check">
              <input type="checkbox" checked={settings.enabled} disabled={!canEdit} onChange={(e) => void save({ enabled: e.target.checked })} />
              {m.enabled}
            </label>
            <p className="adm-field__hint">{m.enabledHint}</p>
            <fieldset className="aim-notify" disabled={!canEdit}>
              <legend>{m.notifyTitle}</legend>
              <label className="adm-check">
                <input type="checkbox" checked={settings.notifyEmail} onChange={(e) => void save({ notifyEmail: e.target.checked })} />
                {m.notifyEmail}
              </label>
              <label className="adm-check">
                <input type="checkbox" checked={settings.notifyLine} onChange={(e) => void save({ notifyLine: e.target.checked })} />
                {m.notifyLine}
              </label>
              <p className="adm-field__hint">{m.notifyHint}</p>
            </fieldset>
            <label className="adm-check">
              <input type="checkbox" checked={settings.aiEnabled} disabled={!canEdit || (!settings.aiKeyConfigured && !settings.aiEnabled)}
                onChange={(e) => void save({ aiEnabled: e.target.checked })} />
              {m.aiEnabled}
            </label>
            <p className="adm-field__hint">{settings.aiKeyConfigured ? m.aiHint : m.aiKeyMissing}</p>
            <form className="aim-budget" onSubmit={saveBudget} noValidate>
              <div className="adm-field">
                <label htmlFor="aim-budget">{m.budget}</label>
                <input id="aim-budget" inputMode="numeric" value={budget} disabled={!canEdit} onChange={(e) => setBudget(e.target.value)} />
              </div>
              {canEdit && <Button type="submit" variant="secondary">{t.common.save}</Button>}
            </form>
            <p className="adm-small" data-testid="aim-spend">{format(m.spent, {
              spent: n.baht(settings.monthSpentSatang), budget: n.baht(settings.monthlyBudgetSatang), calls: n.num(settings.monthAiCalls),
            })}</p>
            <p className="adm-small adm-muted">{format(m.modelLine, { model: settings.model ?? "—" })}</p>
          </div>
        )}
        {canEdit && canView && (
          <form className="adm-card" onSubmit={generate} noValidate data-testid="aim-generate">
            <h2 className="adm-h2">{m.generateTitle}</h2>
            <div className="adm-field">
              <label htmlFor="aim-kind">{m.kind}</label>
              <select id="aim-kind" value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
                {REPORT_KINDS.map((k) => <option key={k} value={k}>{m[k]}</option>)}
              </select>
            </div>
            <div className="adm-field">
              <label htmlFor="aim-start">{m.periodStart}</label>
              <input id="aim-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              <p className="adm-field__hint">{kind === "WEEKLY" ? m.periodStartHintWeekly : m.periodStartHintMonthly}</p>
            </div>
            <Button type="submit" busy={busy}>{busy ? m.generating : m.generate}</Button>
          </form>
        )}
      </div>

      {!canView ? <Alert kind="info">{m.needsReports}</Alert> : (
        <div className="adm-card">
          <h2 className="adm-h2">{m.listTitle}</h2>
          {reports && reports.length === 0 && <p className="adm-muted">{m.empty}</p>}
          {reports && reports.length > 0 && (
            <div className="adm-tablewrap">
              <table className="adm-table" data-testid="aim-list">
                <thead>
                  <tr>
                    <th scope="col">{m.colPeriod}</th>
                    <th scope="col">{m.colKind}</th>
                    <th scope="col" className="adm-num">{m.colBookings}</th>
                    <th scope="col" className="adm-num">{m.colRevenue}</th>
                    <th scope="col" className="adm-num">{m.colOccupancy}</th>
                    <th scope="col">{m.colStatus}</th>
                    <th scope="col">{m.colCreated}</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id}>
                      <td><Link to={href("ai-marketing", r.id)}>{n.date(r.periodStart)} – {n.date(r.periodEnd)}</Link></td>
                      <td>{m[r.kind]}</td>
                      <td className="adm-num">{n.num(r.bookings)}</td>
                      <td className="adm-num">{n.baht(r.revenueSatang)}</td>
                      <td className="adm-num">{n.pct(r.occupancyPercent)}</td>
                      <td>{m[`status${r.status}`]}</td>
                      <td>{dateTime(r.createdAt)} · {m[`trigger${r.trigger}`]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// =============================================================================== one report

function insightText(m: AiMarketingMessages, n: ReturnType<typeof useNumbers>, i: InsightDto): string {
  const template = (m.insight as Record<string, string>)[i.code];
  if (!template) return i.code;
  const p: Record<string, string | number> = { ...i.params };
  if (i.code.startsWith("REVENUE_")) {
    p.now = n.baht(Number(i.params.now));
    p.before = n.baht(Number(i.params.before));
  }
  for (const k of ["from", "to", "first"]) if (typeof p[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p[k] as string)) p[k] = n.date(p[k] as string);
  if (typeof p.change === "number") p.change = Math.abs(p.change);
  return format(template, p);
}

/** Consecutive dates as [first, last] runs: 1, 2, 3, 5 → [1–3], [5–5]. */
function dayRanges(days: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const d of days) {
    const last = out[out.length - 1];
    const next = last ? new Date(Date.parse(`${last[1]}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
    if (last && next === d) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

function Kpi({ label, value, before }: { label: string; value: string; before?: string }) {
  return (
    <li className="adm-kpi">
      <span className="adm-kpi__label">{label}</span>
      <strong className="adm-kpi__value">{value}</strong>
      {before !== undefined && <span className="adm-kpi__sub">{before}</span>}
    </li>
  );
}

function Rows({ title, head, rows }: { title: string; head: string[]; rows: (string | number)[][] }) {
  const m = useM();
  return (
    <div className="aim-block">
      <h3 className="adm-h3">{title}</h3>
      {rows.length === 0 ? <p className="adm-muted">{m.none}</p> : <div className="adm-tablewrap">
        <table className="adm-table">
          <thead><tr>{head.map((h, i) => <th key={h} scope="col" className={i ? "adm-num" : undefined}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, i) => <td key={i} className={i ? "adm-num" : undefined}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>}
    </div>
  );
}

function ReportView({ id }: { id: string }) {
  const { t, href } = useAdmin();
  const m = useM();
  const n = useNumbers();
  const [r, setR] = useState<MarketingReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<MarketingReportDto>(`/api/admin/ai-marketing/reports/${encodeURIComponent(id)}`, controller.signal)
      .then(setR)
      .catch((err: unknown) => !controller.signal.aborted && setError(errorMessage(t, err)));
    return () => controller.abort();
  }, [id, t]);

  if (error) return <section className="adm-page"><Link to={href("ai-marketing")}>{m.back}</Link><Alert kind="error">{error}</Alert></section>;
  if (!r) return null;
  const x = r.metrics;
  const c = x.current;
  const p = x.previous;
  const before = (pick: (t: PeriodTotals) => string) => format(m.vsPrev, { v: pick(p) });
  const levelClass = { WARN: "aim-insight--warn", GOOD: "aim-insight--good", INFO: "aim-insight--info" } as const;
  const ga = x.ga4;
  const ev = ga.events ?? {};

  return (
    <section className="adm-page aim aim-report" aria-labelledby="aim-r-h">
      <div className="aim-toolbar">
        <Link to={href("ai-marketing")}>{m.back}</Link>
        <Button variant="secondary" onClick={() => window.print()}>{m.print}</Button>
      </div>
      <h1 className="adm-h1" id="aim-r-h">{m.title}</h1>
      <p className="adm-muted">{format(m.periodLine, {
        kind: m[r.kind], from: n.date(x.periodStart), to: n.date(x.periodEnd), pfrom: n.date(x.previousStart), pto: n.date(x.previousEnd),
      })}</p>

      <ul className="adm-kpis" data-testid="aim-kpis">
        <Kpi label={m.kpiBookings} value={n.num(c.bookings)} before={before((t) => n.num(t.bookings))} />
        <Kpi label={m.kpiRevenue} value={n.baht(c.revenueSatang)} before={before((t) => n.baht(t.revenueSatang))} />
        <Kpi label={m.kpiOccupancy} value={n.pct(c.occupancyPercent)} before={before((t) => n.pct(t.occupancyPercent))} />
        <Kpi label={m.kpiAdr} value={n.baht(c.adrSatang)} before={before((t) => n.baht(t.adrSatang))} />
        <Kpi label={m.kpiVisitors} value={n.num(c.visitors)} before={before((t) => n.num(t.visitors))} />
        <Kpi label={m.kpiConversion} value={n.num(c.conversionPercent)} before={before((t) => n.num(t.conversionPercent))} />
        <Kpi label={m.kpiLead} value={c.avgLeadDays === null ? "—" : format(m.days, { n: n.num(c.avgLeadDays) })} />
        <Kpi label={m.kpiStay} value={c.avgStayNights === null ? "—" : format(m.nights, { n: n.num(c.avgStayNights) })} />
      </ul>

      {r.aiSummary ? (
        <div className="adm-card aim-ai" data-testid="aim-ai">
          <h2 className="adm-h2">{m.aiTitle}</h2>
          <p className="aim-ai__note">{m.aiNote}</p>
          <p className="aim-ai__headline"><strong>{r.aiSummary.headline}</strong></p>
          <p>{r.aiSummary.summary}</p>
          {r.aiSummary.recommendations.length > 0 && (
            <>
              <h3 className="adm-h3">{m.aiRecs}</h3>
              <ol className="aim-recs">
                {r.aiSummary.recommendations.map((rec, k) => (
                  <li key={k}>
                    <strong>{rec.title}</strong>
                    <p>{rec.detail}</p>
                    {rec.basedOn && <p className="adm-small adm-muted">{format(m.aiBasedOn, { why: rec.basedOn })}</p>}
                  </li>
                ))}
              </ol>
            </>
          )}
          {r.aiModel && <p className="adm-small adm-muted">{format(m.modelLine, { model: r.aiModel })}</p>}
        </div>
      ) : r.aiError ? (
        <Alert kind="info">{r.aiError === "BUDGET_REACHED" ? m.aiBudgetReached : format(m.aiFailed, { reason: r.aiError })}</Alert>
      ) : null}

      <div className="adm-card">
        <h2 className="adm-h2">{m.insightsTitle}</h2>
        {r.insights.length === 0 ? <p className="adm-muted">{m.noInsights}</p> : (
          <ul className="aim-insights" data-testid="aim-insights">
            {r.insights.map((i, k) => <li key={k} className={`aim-insight ${levelClass[i.level]}`}>{insightText(m, n, i)}</li>)}
          </ul>
        )}
      </div>

      <div className="adm-card">
        <h2 className="adm-h2">{m.forwardTitle}</h2>
        <p>{format(m.forwardOcc, { percent: n.num(x.forward.occupancyPercent ?? 0), sold: n.num(x.forward.soldNights), open: n.num(x.forward.openNights) })}</p>
        <div className="adm-grid2 adm-grid2--gap adm-grid2--tables">
          <div>
            <h3 className="adm-h3">{m.quietRuns}</h3>
            {x.forward.quietRuns.length === 0 ? <p className="adm-muted">{m.none}</p> : (
              <ul>{x.forward.quietRuns.map((q) => <li key={q.from}>{n.date(q.from)} – {n.date(q.to)} · {format(m.nights, { n: q.nights })}</li>)}</ul>
            )}
          </div>
          <div>
            <h3 className="adm-h3">{m.emptyDays}</h3>
            <p className={x.forward.emptyDays.length ? undefined : "adm-muted"}>
              {x.forward.emptyDays.length ? dayRanges(x.forward.emptyDays).map(([a, b]) => (a === b ? n.date(a) : `${n.date(a)} – ${n.date(b)}`)).join(", ") : m.none}
            </p>
          </div>
        </div>
      </div>

      <div className="adm-card">
        <Rows title={m.unitsTitle} head={[m.colUnit, m.colSold, m.colOta, m.colOpen, m.colOccupancy]}
          rows={x.units.map((u) => [u.name, n.num(u.soldNights), n.num(u.otaNights), n.num(u.openNights), n.pct(u.occupancyPercent)])} />
      </div>

      <div className="adm-grid2 adm-grid2--gap adm-grid2--tables">
        <div className="adm-card">
          <Rows title={m.weekTitle} head={["", m.colOccupancy]}
            rows={[[m.weekday, n.pct(x.weekdayOccupancyPercent)], [m.weekend, n.pct(x.weekendOccupancyPercent)]]} />
          <Rows title={m.extrasTitle} head={["", "%"]}
            rows={[[m.food, n.pct(c.foodAttachPercent)], [m.extraBed, n.pct(c.extraBedAttachPercent)], [m.massage, n.pct(c.massageAttachPercent)]]} />
        </div>
        <div className="adm-card">
          <Rows title={m.sourcesTitle} head={[m.colSource, m.colBookings, m.colConfirmed, m.colRevenue]}
            rows={x.sources.map((s) => [s.medium ? `${s.source} / ${s.medium}` : s.source, n.num(s.bookings), n.num(s.confirmed), n.baht(s.revenueSatang)])} />
          <Rows title={m.paymentsTitle} head={["", m.colBookings]} rows={x.paymentChannels.map((pc) => [pc.name, n.num(pc.value)])} />
        </div>
      </div>

      <div className="adm-card" data-testid="aim-ga4">
        <h2 className="adm-h2">{m.ga4Title}</h2>
        {ga.status === "NOT_CONFIGURED" && <p className="adm-muted">{m.ga4Missing}</p>}
        {ga.status === "ERROR" && <p className="adm-muted">{m.ga4Failed}</p>}
        {ga.status === "OK" && (
          <>
            <Rows title={m.funnelTitle} head={["", m.colSessions]} rows={[
              [m.fView, n.num(ev.view_accommodation)], [m.fBegin, n.num(ev.begin_booking)], [m.fCheckout, n.num(ev.begin_checkout)], [m.fBooked, n.num(c.bookings)],
            ]} />
            <div className="adm-grid2 adm-grid2--gap adm-grid2--tables">
              {ga.channels && <Rows title={m.channels} head={[m.channels, m.colSessions]} rows={ga.channels.map((g) => [g.name, n.num(g.sessions)])} />}
              {ga.devices && <Rows title={m.devices} head={[m.devices, m.colSessions]} rows={ga.devices.map((g) => [g.name, n.num(g.sessions)])} />}
            </div>
            {ga.landingPages && <Rows title={m.landingPages} head={[m.landingPages, m.colSessions]} rows={ga.landingPages.map((g) => [g.name, n.num(g.sessions)])} />}
          </>
        )}
      </div>
      <p className="adm-small adm-muted">{m.footnote}</p>
    </section>
  );
}
