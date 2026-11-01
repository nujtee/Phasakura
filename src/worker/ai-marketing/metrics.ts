import type { ForwardMetrics, MarketingMetrics, PeriodTotals, ReportKind, UnitMetrics } from "../../shared/ai-marketing-types.ts";
import { addDays, dayOfWeek, diffDays } from "../../shared/dates.ts";
import type { AiMarketingRepository, DateNightsRow, UnitNightsRow } from "../repositories/ai-marketing.repository.ts";
import type { AttributionRepository } from "../repositories/attribution.repository.ts";
import { bookingSources } from "../services/dashboard.service.ts";
import type { Ga4DashboardResult } from "../services/ga4-report.service.ts";

/**
 * The numbers of a marketing report (AI Marketing Module A), computed from D1 (bookings, nights, payments, sources)
 * and GA4 (visits). Money only from D1. Aggregates only: no guest data leaves the queries.
 */

export const FORWARD_DAYS = 30;
const LIST_MAX = 10;

/** One decimal place; null when there is nothing to divide by. */
export const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part * 1000) / whole) / 10 : null);
const round1 = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/** The last complete period before `today`: Monday–Sunday, or the previous calendar month. */
export function lastPeriod(kind: ReportKind, today: string): { start: string; end: string } {
  if (kind === "WEEKLY") {
    const monday = addDays(today, -((dayOfWeek(today) + 6) % 7));
    return { start: addDays(monday, -7), end: addDays(monday, -1) };
  }
  const firstOfThisMonth = `${today.slice(0, 7)}-01`;
  const end = addDays(firstOfThisMonth, -1);
  return { start: `${end.slice(0, 7)}-01`, end };
}

/** The period that starts on `start` (a Monday / the 1st), or null when `start` does not start one. */
export function periodStarting(kind: ReportKind, start: string): { start: string; end: string } | null {
  if (kind === "WEEKLY") return dayOfWeek(start) === 1 ? { start, end: addDays(start, 6) } : null;
  if (!start.endsWith("-01")) return null;
  const next = addDays(start, 32).slice(0, 7);
  return { start, end: addDays(`${next}-01`, -1) };
}

/** The period just before. */
export function previousPeriod(kind: ReportKind, start: string): { start: string; end: string } {
  if (kind === "WEEKLY") return { start: addDays(start, -7), end: addDays(start, -1) };
  const end = addDays(start, -1);
  return { start: `${end.slice(0, 7)}-01`, end };
}

const dates = (from: string, to: string): string[] => Array.from({ length: diffDays(from, to) + 1 }, (_, i) => addDays(from, i));

/** Fri / Sat nights are the weekend for a stay. */
const isWeekendNight = (date: string) => [5, 6].includes(dayOfWeek(date));

interface NightCounts { sold: number; ota: number; open: number }

/** Occupied / open unit-nights per date (all active units; blocked nights are not open). */
function perDate(rows: DateNightsRow[], unitCount: number, from: string, to: string): Map<string, NightCounts> {
  const byDate = new Map(rows.map((r) => [r.stay_date, r]));
  return new Map(dates(from, to).map((d) => {
    const r = byDate.get(d);
    return [d, { sold: r?.sold ?? 0, ota: r?.ota ?? 0, open: Math.max(0, unitCount - (r?.blocked ?? 0)) }];
  }));
}

function sumNights(m: Map<string, NightCounts>, keep: (d: string) => boolean = () => true): NightCounts {
  let sold = 0, ota = 0, open = 0;
  for (const [d, c] of m) {
    if (!keep(d)) continue;
    sold += c.sold; ota += c.ota; open += c.open;
  }
  return { sold, ota, open };
}

function units(rows: UnitNightsRow[], days: number): UnitMetrics[] {
  return rows.map((u) => {
    const open = Math.max(0, days - u.blocked);
    return { unitId: u.unit_id, name: u.name, type: u.unit_type, soldNights: u.sold, otaNights: u.ota, openNights: open, occupancyPercent: pct(u.sold + u.ota, open) };
  });
}

export function forward(rows: DateNightsRow[], unitCount: number, today: string, days = FORWARD_DAYS): ForwardMetrics {
  const to = addDays(today, days - 1);
  const m = perDate(rows, unitCount, today, to);
  const total = sumNights(m);
  const emptyDays: string[] = [];
  const quietRuns: ForwardMetrics["quietRuns"] = [];
  const half = Math.max(1, Math.ceil(unitCount / 2));
  type Run = ForwardMetrics["quietRuns"][number];
  const state: { run: Run | null } = { run: null };
  const close = () => {
    if (state.run && state.run.nights >= 3 && quietRuns.length < LIST_MAX) quietRuns.push(state.run);
    state.run = null;
  };
  for (const [d, c] of m) {
    const free = c.open - c.sold - c.ota;
    if (unitCount > 0 && c.sold + c.ota === 0 && c.open > 0 && emptyDays.length < LIST_MAX * 3) emptyDays.push(d);
    if (unitCount > 0 && free >= half) {
      const r = state.run;
      state.run = r ? { from: r.from, to: d, nights: r.nights + 1, freeUnits: Math.min(r.freeUnits, free) } : { from: d, to: d, nights: 1, freeUnits: free };
    } else {
      close();
    }
  }
  close();
  return { from: today, days, occupancyPercent: pct(total.sold + total.ota, total.open), soldNights: total.sold + total.ota, openNights: total.open, emptyDays, quietRuns };
}

export interface MetricsSources {
  repo: AiMarketingRepository;
  attribution: AttributionRepository;
  ga4: ((from: string, to: string) => Promise<Ga4DashboardResult>) | null;
}

async function totals(s: MetricsSources, from: string, to: string, offset: string, unitCount: number): Promise<{ t: PeriodTotals; nights: Map<string, NightCounts>; ga: Ga4DashboardResult }> {
  const [row, adr, nightRows, ga] = await Promise.all([
    s.repo.totals(from, to, offset),
    s.repo.adr(from, to),
    s.repo.dateNights(from, to),
    s.ga4 ? s.ga4(from, to).catch((): Ga4DashboardResult => ({ status: "ERROR", fetchedAt: null, numbers: null }))
      : Promise.resolve<Ga4DashboardResult>({ status: "NOT_CONFIGURED", fetchedAt: null, numbers: null }),
  ]);
  const nights = perDate(nightRows, unitCount, from, to);
  const n = sumNights(nights);
  const made = row.bookings - row.expired;
  const visitors = ga.numbers?.visitors ?? null;
  return {
    nights,
    ga,
    t: {
      bookings: row.bookings,
      confirmed: row.confirmed,
      cancelled: row.cancelled,
      expired: row.expired,
      revenueSatang: row.revenue,
      adrSatang: adr.unit_nights > 0 ? Math.round(adr.acc_satang / adr.unit_nights) : null,
      occupancyPercent: pct(n.sold + n.ota, n.open),
      soldNights: n.sold,
      otaNights: n.ota,
      openNights: n.open,
      avgLeadDays: round1(row.avg_lead),
      avgStayNights: round1(row.avg_nights),
      foodAttachPercent: pct(row.with_food, made),
      extraBedAttachPercent: pct(row.with_extra_bed, made),
      massageAttachPercent: pct(row.with_massage, made),
      visitors,
      pageViews: ga.numbers?.pageViews ?? null,
      conversionPercent: visitors === null ? null : pct(row.bookings, visitors),
    },
  };
}

/** All numbers of one report. `today` = the property's date now (the forward view starts there). */
export async function buildMetrics(s: MetricsSources, opts: {
  kind: ReportKind; start: string; end: string; today: string; offset: string; timezone: string;
}): Promise<MarketingMetrics> {
  const prev = previousPeriod(opts.kind, opts.start);
  const days = diffDays(opts.start, opts.end) + 1;
  const unitRows = await s.repo.unitNights(opts.start, opts.end);
  const unitCount = unitRows.length;
  const [cur, before, sourceRows, payments, forwardRows] = await Promise.all([
    totals(s, opts.start, opts.end, opts.offset, unitCount),
    totals(s, prev.start, prev.end, opts.offset, unitCount),
    s.attribution.sourceGroups(opts.start, opts.offset, opts.end),
    s.repo.paymentChannels(opts.start, opts.end, opts.offset),
    s.repo.dateNights(opts.today, addDays(opts.today, FORWARD_DAYS - 1)),
  ]);
  const weekday = sumNights(cur.nights, (d) => !isWeekendNight(d));
  const weekend = sumNights(cur.nights, isWeekendNight);
  const b = cur.ga.numbers?.breakdown ?? null;
  return {
    kind: opts.kind,
    periodStart: opts.start,
    periodEnd: opts.end,
    previousStart: prev.start,
    previousEnd: prev.end,
    timezone: opts.timezone,
    current: cur.t,
    previous: before.t,
    units: units(unitRows, days),
    weekdayOccupancyPercent: pct(weekday.sold + weekday.ota, weekday.open),
    weekendOccupancyPercent: pct(weekend.sold + weekend.ota, weekend.open),
    sources: bookingSources(sourceRows, true).map((r) => ({ ...r, revenueSatang: r.revenueSatang ?? 0 })),
    paymentChannels: payments.slice(0, LIST_MAX),
    ga4: {
      status: cur.ga.status,
      events: cur.ga.numbers?.events ?? null,
      channels: b?.channels ?? null,
      sources: b?.sources ?? null,
      landingPages: b?.landingPages ?? null,
      devices: b?.devices ?? null,
    },
    forward: forward(forwardRows, unitCount, opts.today),
  };
}
