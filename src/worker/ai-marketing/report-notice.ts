import type { AiSummaryDto, InsightDto, MarketingMetrics, ReportKind } from "../../shared/ai-marketing-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { aiMarketingMessages } from "../../shared/i18n/ai-marketing-messages.ts";
import { parseLocale } from "../../shared/i18n/locales.ts";
import type { AiMarketingRepository } from "../repositories/ai-marketing.repository.ts";

/**
 * "Your marketing report is ready" (AI Marketing A4): an e-mail / LINE message to the people who may read reports,
 * built at send time from the stored report. Totals only (the report holds no guest data); the full report is behind
 * the admin link.
 */
export const MARKETING_REPORT_NOTICE = "MARKETING_REPORT";

export interface ReportNotice {
  subject: string;
  title: string;
  body: string;
  linkLabel: string;
  /** Admin path (under /{lang}/admin/). */
  path: string;
}

const TEXTS = {
  th: {
    WEEKLY: "รายสัปดาห์", MONTHLY: "รายเดือน",
    subject: "รายงานการตลาด{kind} {from} – {to} พร้อมแล้ว",
    title: "📊 รายงานการตลาด{kind} {from} – {to}",
    bookings: "การจอง: {now} (ช่วงก่อน {before})",
    revenue: "รายได้: {now} (ช่วงก่อน {before})",
    occupancy: "อัตราเข้าพัก: {now} (ช่วงก่อน {before})",
    visitors: "ผู้เข้าชมเว็บ: {now}",
    ai: "สรุปจาก AI: {headline}",
    findings: "ข้อสังเกต:",
    more: "ดูรายงานฉบับเต็มใน Admin",
    link: "เปิดรายงาน",
  },
  en: {
    WEEKLY: "weekly", MONTHLY: "monthly",
    subject: "Your {kind} marketing report {from} – {to} is ready",
    title: "📊 {kind} marketing report {from} – {to}",
    bookings: "Bookings: {now} (before {before})",
    revenue: "Revenue: {now} (before {before})",
    occupancy: "Occupancy: {now} (before {before})",
    visitors: "Website visitors: {now}",
    ai: "AI summary: {headline}",
    findings: "Findings:",
    more: "The full report is in Admin.",
    link: "Open the report",
  },
  "zh-CN": {
    WEEKLY: "每周", MONTHLY: "每月",
    subject: "{kind}营销报告 {from} – {to} 已生成",
    title: "📊 {kind}营销报告 {from} – {to}",
    bookings: "预订：{now}（之前 {before}）",
    revenue: "收入：{now}（之前 {before}）",
    occupancy: "入住率：{now}（之前 {before}）",
    visitors: "网站访客：{now}",
    ai: "AI 摘要：{headline}",
    findings: "发现：",
    more: "完整报告请在后台查看。",
    link: "打开报告",
  },
} as const;

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export async function renderReportNotice(repo: AiMarketingRepository, payload: Record<string, unknown>, lang: string): Promise<ReportNotice | { skip: string }> {
  const r = typeof payload.reportId === "string" ? await repo.find(payload.reportId) : null;
  if (!r) return { skip: "NOT_RELEVANT" };
  const code = parseLocale(lang)?.code ?? "th";
  const t = TEXTS[code as keyof typeof TEXTS] ?? TEXTS.th;
  const m = parse<MarketingMetrics | null>(r.metrics_json, null);
  if (!m?.current || !m.previous) return { skip: "NOT_RELEVANT" };
  const found = parse<InsightDto[]>(r.insights_json, []);
  const ai = parse<AiSummaryDto | null>(r.ai_summary, null);
  const date = (iso: string) => new Intl.DateTimeFormat(code, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  const num = (v: number | null) => (v === null ? "—" : new Intl.NumberFormat(code).format(v));
  const pct = (v: number | null) => (v === null ? "—" : `${num(v)}%`);
  const head = { kind: t[r.period_kind as ReportKind], from: date(r.period_start), to: date(r.period_end) };

  const words = aiMarketingMessages(code as "th");
  const insightLine = (i: InsightDto) => {
    const tpl = (words.insight as Record<string, string>)[i.code];
    if (!tpl) return null;
    const p: Record<string, string | number> = { ...i.params };
    if (i.code.startsWith("REVENUE_")) {
      p.now = formatBaht(Number(i.params.now), code);
      p.before = formatBaht(Number(i.params.before), code);
    }
    for (const k of ["from", "to", "first"]) if (typeof p[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p[k] as string)) p[k] = date(p[k] as string);
    if (typeof p.change === "number") p.change = Math.abs(p.change);
    return `• ${fill(tpl, p)}`;
  };
  const top = found.filter((i) => i.level !== "INFO").slice(0, 3).map(insightLine).filter((x): x is string => !!x);

  const c = m.current;
  const p = m.previous;
  const body = [
    fill(t.bookings, { now: num(c.bookings), before: num(p.bookings) }),
    fill(t.revenue, { now: formatBaht(c.revenueSatang, code), before: formatBaht(p.revenueSatang, code) }),
    fill(t.occupancy, { now: pct(c.occupancyPercent), before: pct(p.occupancyPercent) }),
    ...(c.visitors !== null ? [fill(t.visitors, { now: num(c.visitors) })] : []),
    ...(ai?.headline ? ["", fill(t.ai, { headline: ai.headline })] : []),
    ...(top.length ? ["", t.findings, ...top] : []),
    "",
    t.more,
  ].join("\n");
  return { subject: fill(t.subject, head), title: fill(t.title, head), body, linkLabel: t.link, path: `ai-marketing/${r.id}` };
}

/** LINE text: title, body and the link on its own line. */
export function reportNoticeLineText(n: ReportNotice, link: string | null): string {
  return [n.title, n.body, ...(link ? [link] : [])].join("\n").slice(0, 4900);
}
