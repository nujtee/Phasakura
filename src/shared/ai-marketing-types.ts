/**
 * AI marketing report (migration 0053, AI Marketing Module A). The numbers are computed from the booking database
 * (money, occupancy, bookings) and GA4 (visits); the findings come from fixed rules; from PR A3 an AI writes a
 * summary from those numbers only. No guest names, phones, e-mails or booking codes anywhere in a report.
 */
export const REPORT_KINDS = ["WEEKLY", "MONTHLY"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportStatus = "READY" | "READY_NO_AI" | "FAILED";

export interface PeriodTotals {
  bookings: number;
  confirmed: number;
  cancelled: number;
  /** Unpaid holds that ran out. */
  expired: number;
  /** Paid & confirmed bookings, by the day they were confirmed (same as the dashboard). */
  revenueSatang: number;
  /** Accommodation price per sold unit-night, for stays checking in during the period; null without stays. */
  adrSatang: number | null;
  /** Sold unit-nights (web bookings) + OTA-held nights, out of open unit-nights (blocked nights left out). */
  occupancyPercent: number | null;
  soldNights: number;
  otaNights: number;
  openNights: number;
  /** Average days between booking and check-in, and nights per booking (bookings made in the period). */
  avgLeadDays: number | null;
  avgStayNights: number | null;
  /** Share of bookings made in the period that took food / extra bed / massage (percent). */
  foodAttachPercent: number | null;
  extraBedAttachPercent: number | null;
  massageAttachPercent: number | null;
  /** Visitors / page views from GA4 (null when GA4 is not connected or failed). */
  visitors: number | null;
  pageViews: number | null;
  /** Bookings made per 100 visitors. */
  conversionPercent: number | null;
}

export interface UnitMetrics {
  unitId: string;
  name: string;
  type: "HOUSE" | "VIP_TENT";
  soldNights: number;
  otaNights: number;
  openNights: number;
  occupancyPercent: number | null;
}

export interface CountRow {
  name: string;
  value: number;
}

export interface SourceMetricsRow {
  source: string;
  medium: string;
  bookings: number;
  confirmed: number;
  revenueSatang: number;
}

export interface ForwardMetrics {
  /** From tomorrow, 30 days. */
  from: string;
  days: number;
  occupancyPercent: number | null;
  soldNights: number;
  openNights: number;
  /** Days with no house / VIP tent booked at all (next 30 days). */
  emptyDays: string[];
  /** Runs of 3+ nights in a row where at least half of the units are free (next 30 days). */
  quietRuns: { from: string; to: string; nights: number; freeUnits: number }[];
}

export interface MarketingMetrics {
  kind: ReportKind;
  periodStart: string;
  periodEnd: string;
  previousStart: string;
  previousEnd: string;
  timezone: string;
  current: PeriodTotals;
  previous: PeriodTotals;
  units: UnitMetrics[];
  weekdayOccupancyPercent: number | null;
  weekendOccupancyPercent: number | null;
  sources: SourceMetricsRow[];
  paymentChannels: CountRow[];
  ga4: {
    status: "OK" | "NOT_CONFIGURED" | "ERROR";
    events: Record<string, number> | null;
    channels: { name: string; sessions: number; users: number }[] | null;
    sources: { name: string; sessions: number; users: number }[] | null;
    landingPages: { name: string; sessions: number; users: number }[] | null;
    devices: { name: string; sessions: number; users: number }[] | null;
  };
  forward: ForwardMetrics;
}

export const INSIGHT_LEVELS = ["GOOD", "INFO", "WARN"] as const;
export type InsightLevel = (typeof INSIGHT_LEVELS)[number];

/**
 * A finding of the fixed rules: a code and its numbers; the admin page words it in the reader's language.
 * `params` hold numbers, dates and names of houses / channels only.
 */
export interface InsightDto {
  code: string;
  level: InsightLevel;
  params: Record<string, string | number>;
}

export interface MarketingReportListItemDto {
  id: string;
  kind: ReportKind;
  periodStart: string;
  periodEnd: string;
  status: ReportStatus;
  trigger: "CRON" | "USER";
  createdAt: string;
  bookings: number;
  revenueSatang: number | null;
  occupancyPercent: number | null;
}

export interface MarketingReportDto extends Omit<MarketingReportListItemDto, "bookings" | "revenueSatang" | "occupancyPercent"> {
  metrics: MarketingMetrics;
  insights: InsightDto[];
  /** AI summary (PR A3); null without AI. */
  aiSummary: AiSummaryDto | null;
  aiModel: string | null;
  aiError: string | null;
}

export interface AiSummaryDto {
  headline: string;
  summary: string;
  recommendations: { title: string; detail: string; basedOn: string }[];
}

export interface AiMarketingSettingsDto {
  enabled: boolean;
  aiEnabled: boolean;
  /** Whether the AI API key secret is set (never the key). */
  aiKeyConfigured: boolean;
  model: string | null;
  monthlyBudgetSatang: number;
  notifyEmail: boolean;
  notifyLine: boolean;
  updatedAt: string | null;
}

export interface AiMarketingSettingsInput {
  enabled?: boolean;
  aiEnabled?: boolean;
  monthlyBudgetSatang?: number;
  notifyEmail?: boolean;
  notifyLine?: boolean;
}

/** Report that runs on its own: weekly on Monday 07:00, monthly on the 1st 07:00 (property time zone). */
export const REPORT_HOUR = 7;
/** Reports staff may ask for per day (each one reads GA4 and, from A3, may call the AI). */
export const USER_REPORTS_PER_DAY = 5;
