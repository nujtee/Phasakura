import type { InsightDto, MarketingMetrics } from "../../shared/ai-marketing-types.ts";

/**
 * Findings of fixed rules (no AI): what changed, what is weak, what to look at. Each is a code + numbers; the admin
 * page words it. Thresholds are deliberately plain so the owner can follow them.
 */
export const INSIGHT_CODES = [
  "NO_DATA", "BOOKINGS_UP", "BOOKINGS_DOWN", "REVENUE_UP", "REVENUE_DOWN", "OCCUPANCY_LOW", "OCCUPANCY_HIGH", "WEEKDAY_SOFT",
  "UNIT_LAGGING", "FORWARD_QUIET", "FORWARD_EMPTY_DAYS", "FORWARD_STRONG", "HOLDS_EXPIRE", "CHECKOUT_DROP", "TOP_SOURCE",
  "TAG_LINKS", "GA4_NOT_CONNECTED", "GA4_ERROR", "MOBILE_FIRST", "LAST_MINUTE",
] as const;
export type InsightCode = (typeof INSIGHT_CODES)[number];

const CHANGE = 30; // percent
const change = (now: number, before: number) => Math.round(((now - before) * 100) / before);

export function insights(m: MarketingMetrics): InsightDto[] {
  const out: InsightDto[] = [];
  const add = (code: InsightCode, level: InsightDto["level"], params: InsightDto["params"] = {}) => out.push({ code, level, params });
  const c = m.current;
  const p = m.previous;

  if (c.bookings === 0 && !c.visitors && c.soldNights === 0) add("NO_DATA", "INFO");

  if (p.bookings >= 3) {
    const ch = change(c.bookings, p.bookings);
    if (ch >= CHANGE) add("BOOKINGS_UP", "GOOD", { now: c.bookings, before: p.bookings, change: ch });
    else if (ch <= -CHANGE) add("BOOKINGS_DOWN", "WARN", { now: c.bookings, before: p.bookings, change: ch });
  }
  if (p.revenueSatang > 0) {
    const ch = change(c.revenueSatang, p.revenueSatang);
    if (ch >= CHANGE) add("REVENUE_UP", "GOOD", { now: c.revenueSatang, before: p.revenueSatang, change: ch });
    else if (ch <= -CHANGE) add("REVENUE_DOWN", "WARN", { now: c.revenueSatang, before: p.revenueSatang, change: ch });
  }

  if (c.occupancyPercent !== null && c.openNights >= 7) {
    if (c.occupancyPercent < 30) add("OCCUPANCY_LOW", "WARN", { percent: c.occupancyPercent });
    else if (c.occupancyPercent >= 80) add("OCCUPANCY_HIGH", "GOOD", { percent: c.occupancyPercent });
  }
  if (m.weekdayOccupancyPercent !== null && m.weekendOccupancyPercent !== null && m.weekendOccupancyPercent - m.weekdayOccupancyPercent >= 30) {
    add("WEEKDAY_SOFT", "INFO", { weekday: m.weekdayOccupancyPercent, weekend: m.weekendOccupancyPercent });
  }

  // Houses well below the others (only when the others are doing something).
  if (c.occupancyPercent !== null && c.occupancyPercent >= 20 && m.units.length >= 2) {
    m.units
      .filter((u) => u.occupancyPercent !== null && u.openNights >= 3 && u.occupancyPercent < c.occupancyPercent! / 2)
      .sort((a, b) => a.occupancyPercent! - b.occupancyPercent!)
      .slice(0, 2)
      .forEach((u) => add("UNIT_LAGGING", "WARN", { unit: u.name, percent: u.occupancyPercent!, average: c.occupancyPercent! }));
  }

  const f = m.forward;
  const run = f.quietRuns[0];
  if (run) add("FORWARD_QUIET", "WARN", { from: run.from, to: run.to, nights: run.nights, free: run.freeUnits, runs: f.quietRuns.length });
  if (f.emptyDays.length >= 5) add("FORWARD_EMPTY_DAYS", "WARN", { days: f.emptyDays.length, first: f.emptyDays[0]! });
  if (f.occupancyPercent !== null && f.occupancyPercent >= 70) add("FORWARD_STRONG", "GOOD", { percent: f.occupancyPercent });

  if (c.bookings >= 3 && c.expired * 100 >= c.bookings * 30) add("HOLDS_EXPIRE", "WARN", { expired: c.expired, bookings: c.bookings });

  const checkout = m.ga4.events?.begin_checkout ?? 0;
  if (checkout >= 10 && c.bookings * 100 < checkout * 30) add("CHECKOUT_DROP", "WARN", { checkout, bookings: c.bookings });

  const top = m.sources.find((s) => s.source !== "(direct)" && s.source !== "(other)");
  if (top && top.bookings >= 2) add("TOP_SOURCE", "GOOD", { source: top.medium ? `${top.source} / ${top.medium}` : top.source, bookings: top.bookings });
  const direct = m.sources.find((s) => s.source === "(direct)")?.bookings ?? 0;
  if (c.bookings >= 5 && direct * 100 >= c.bookings * 70) add("TAG_LINKS", "INFO", { direct, bookings: c.bookings });

  if (m.ga4.status === "NOT_CONFIGURED") add("GA4_NOT_CONNECTED", "INFO");
  else if (m.ga4.status === "ERROR") add("GA4_ERROR", "WARN");

  const devices = m.ga4.devices ?? [];
  const sessions = devices.reduce((a, d) => a + d.sessions, 0);
  const mobile = devices.find((d) => d.name.toLowerCase() === "mobile")?.sessions ?? 0;
  if (sessions >= 20 && mobile * 100 >= sessions * 70) add("MOBILE_FIRST", "INFO", { percent: Math.round((mobile * 100) / sessions) });

  if (c.avgLeadDays !== null && c.bookings >= 3 && c.avgLeadDays <= 3) add("LAST_MINUTE", "INFO", { days: c.avgLeadDays });

  // Warnings first, then good news, then the rest.
  const rank = { WARN: 0, GOOD: 1, INFO: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
