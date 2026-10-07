/**
 * Reports (spec §50) — one tabular contract for the screen, Excel and the printable PDF view.
 * Money is integer satang; labels are keys into `report-messages.ts` (TH / EN / ZH-CN).
 */
export const REPORT_TYPES = ["revenue", "booking", "accommodation", "camping", "food", "kitchen", "payment"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_GROUPS = ["day", "month", "year"] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

/** How a cell is shown: `code` values are translated (statuses, methods, types). */
export type CellKind = "text" | "period" | "date" | "datetime" | "int" | "money" | "percent" | "code";
export type Cell = string | number | null;

export interface ReportColumn {
  key: string;
  kind: CellKind;
}

export interface ReportTable {
  /** Title key (report-messages `tables`). */
  key: string;
  columns: ReportColumn[];
  rows: Record<string, Cell>[];
  totals: Record<string, Cell> | null;
  /** More rows exist than were returned (details tables are capped). */
  truncated: boolean;
  /** Numeric column to draw as bars on screen (period tables). */
  chart?: string;
}

export interface ReportDto {
  type: ReportType;
  /** Inclusive business dates in the property time zone. */
  from: string;
  to: string;
  group: ReportGroup;
  timezone: string;
  generatedAt: string;
  /** Keys of explanatory notes (what counts, which date basis). */
  notes: string[];
  tables: ReportTable[];
}

/** Maximum span per grouping (days). */
export const REPORT_LIMITS: Record<ReportGroup, number> = { day: 366, month: 3660, year: 3660 };
export const KITCHEN_MAX_DAYS = 31;
export const DETAIL_ROW_LIMIT = 2000;

/** Who may run / export each report. Kitchen is an operational sheet (no money). */
export const REPORT_VIEW_PERMISSION: Record<ReportType, "reports.view" | "kitchen.view"> = {
  revenue: "reports.view", booking: "reports.view", accommodation: "reports.view", camping: "reports.view",
  food: "reports.view", kitchen: "kitchen.view", payment: "reports.view",
};
export const REPORT_EXPORT_PERMISSION: Record<ReportType, "reports.export" | "kitchen.view"> = {
  revenue: "reports.export", booking: "reports.export", accommodation: "reports.export", camping: "reports.export",
  food: "reports.export", kitchen: "kitchen.view", payment: "reports.export",
};

/** Period key of a business date: 2026-10-07 → "2026-10-07" | "2026-10" | "2026". */
export function periodKey(date: string, group: ReportGroup): string {
  return group === "day" ? date : group === "month" ? date.slice(0, 7) : date.slice(0, 4);
}
