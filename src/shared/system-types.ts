/** Production monitoring (Phase 16): /api/health and the admin "System status" page. */

export interface HealthDto {
  status: "ok" | "degraded";
  database: "ok" | "unavailable";
  /** Latest migration applied (or unknown where D1's migration table cannot be read). */
  schema: "ok" | "outdated" | "unknown";
  /** The every-minute cron finished within the last 5 minutes. */
  cron: "ok" | "stale" | "unknown";
  time: string;
}

export const SYSTEM_CHECK_KEYS = [
  "environment", "baseUrl", "schema", "cron", "superAdmins", "bootstrapPassword", "siteName", "primaryAccount",
  "slipVerification", "line", "ga4", "ga4Data", "metaCapi", "metaTestCode", "privacyPolicy", "searchConsole",
  "rateLimits", "recentErrors", "deliveries",
] as const;
export type SystemCheckKey = (typeof SYSTEM_CHECK_KEYS)[number];

export interface SystemCheckDto {
  key: SystemCheckKey;
  level: "ok" | "warning" | "error";
  /** A short fact (count, "off", "manual", a version) — never a secret. */
  value: string | null;
}

export interface HeartbeatDto {
  name: string;
  lastRunAt: string;
  lastOkAt: string | null;
  lastStatus: "OK" | "ERROR";
  lastError: string | null;
  durationMs: number;
  runs: number;
}

export interface ErrorEventDto {
  id: string;
  occurredAt: string;
  source: "API" | "PAGE" | "CRON";
  requestId: string | null;
  method: string | null;
  path: string | null;
  errorName: string | null;
  message: string;
}

export interface SystemStatusDto {
  environment: string;
  baseUrl: string | null;
  health: HealthDto;
  checks: SystemCheckDto[];
  heartbeats: HeartbeatDto[];
  backlog: { linePending: number; lineFailed24h: number; capiPending: number; capiFailed24h: number; slipsWaiting: number };
  errorCount24h: number;
  errors: ErrorEventDto[];
}
