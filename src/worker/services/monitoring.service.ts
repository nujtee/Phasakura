import type { ErrorEventDto, HeartbeatDto, SystemCheckDto, SystemStatusDto } from "../../shared/system-types.ts";
import type { Env } from "../env.ts";
import { HttpError } from "../http/errors.ts";
import { parseServiceAccountKey } from "../marketing/ga4-data.ts";
import type { ErrorEventRow, MonitoringRepository } from "../repositories/monitoring.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { HealthService } from "./health.service.ts";

const ERROR_DAYS = 30;
/** At most this many error rows per isolate per minute: an error storm must not become a D1 write storm. */
const MAX_ERRORS_PER_MINUTE = 20;
const recent: number[] = [];
/** Test hook: forget the per-isolate error throttle. */
export function resetErrorThrottle(): void {
  recent.length = 0;
}

/** Error text without anything personal or secret: e-mails, phone numbers, long tokens, query strings. */
export function scrubMessage(text: string): string {
  return text
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g, "[email]")
    .replace(/\b(?:ya29\.|EAA|eyJ)[A-Za-z0-9._-]{10,}/g, "[token]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[token]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[number]")
    .replace(/\?[^\s"']*/g, "?…")
    .replace(/\s+/g, " ")
    .slice(0, 300)
    .trim();
}

export interface ErrorInput {
  source: "API" | "PAGE" | "CRON";
  error: unknown;
  requestId?: string | null;
  method?: string | null;
  /** Path only — the query string can carry personal data and is never stored. */
  path?: string | null;
  /** What was being done, e.g. "page_meta_failed". */
  context?: string;
}

/**
 * Production monitoring (spec Phase 16): cron heartbeats, a small server-error log for the owner,
 * and the "System status" page that lists what is not ready yet. Full logs: Workers Observability.
 */
export class MonitoringService {
  constructor(
    private readonly repo: MonitoringRepository,
    private readonly health: HealthService,
    private readonly authz: AuthorizationService,
    private readonly clock: Clock,
    private readonly env: Pick<Env, "APP_ENV" | "APP_BASE_URL" | "SLIP_VERIFY_PROVIDER" | "SLIP_VERIFICATION_API_KEY" | "LINE_CHANNEL_ACCESS_TOKEN"
      | "LINE_CHANNEL_SECRET" | "META_CAPI_ACCESS_TOKEN" | "META_TEST_EVENT_CODE" | "GA4_SERVICE_ACCOUNT_KEY" | "RL_PUBLIC" | "RL_WRITE" | "RL_AUTH" | "RL_ADMIN">,
  ) {}

  /** Best effort: never throws (monitoring must not break the request it reports on). */
  async recordError(input: ErrorInput): Promise<void> {
    try {
      const now = this.clock().getTime();
      while (recent.length && now - recent[0]! > 60_000) recent.shift();
      if (recent.length >= MAX_ERRORS_PER_MINUTE) return;
      recent.push(now);
      const e = input.error;
      const row: ErrorEventRow = {
        id: newId(),
        occurred_at: iso(this.clock()),
        source: input.source,
        request_id: input.requestId?.slice(0, 64) ?? null,
        method: input.method?.slice(0, 10) ?? null,
        path: input.path ? input.path.split("?")[0]!.slice(0, 200) : null,
        error_name: e instanceof Error ? e.name.slice(0, 60) : null,
        message: scrubMessage(`${input.context ? `${input.context}: ` : ""}${e instanceof Error ? e.message : String(e)}${
          e instanceof HttpError && e.logDetail ? ` [${e.logDetail}]` : ""}`) || "(no message)",
      };
      await this.repo.insertError(row);
    } catch {
      // table missing (before migration 0020) or D1 down: the console log is still there
    }
  }

  async heartbeat(name: string, ok: boolean, durationMs: number, error: unknown = null): Promise<void> {
    try {
      await this.repo.beat(name, ok, iso(this.clock()), durationMs, error ? scrubMessage(error instanceof Error ? error.message : String(error)) : null);
    } catch {
      // before migration 0020
    }
  }

  async retention(): Promise<void> {
    try {
      await this.repo.purgeErrors(iso(new Date(this.clock().getTime() - ERROR_DAYS * 86_400_000)));
    } catch {
      // before migration 0020
    }
  }

  /** Admin "System status" (`system.view`). Booleans only for secrets — never their values. */
  async status(actor: AuthContext, meta: RequestMeta): Promise<SystemStatusDto> {
    await this.authz.requirePermission(actor, "system.view", meta);
    const now = this.clock();
    const since = iso(new Date(now.getTime() - 86_400_000));
    const [health, facts, beats, errors] = await Promise.all([
      this.health.check(), this.repo.facts(iso(now), since), this.repo.heartbeats(), this.repo.recentErrors(50),
    ]);
    const env = this.env;
    const has = (v: string | undefined) => !!v?.trim();
    const production = env.APP_ENV === "production";
    const base = env.APP_BASE_URL?.trim() || null;
    const m = facts.marketing;
    const trackers = !!m && ((m.ga4_enabled === 1 && !!m.ga4_measurement_id) || m.meta_pixel_enabled === 1);
    const lineSecrets = has(env.LINE_CHANNEL_ACCESS_TOKEN) && has(env.LINE_CHANNEL_SECRET);
    const rateLimits = [env.RL_PUBLIC, env.RL_WRITE, env.RL_AUTH, env.RL_ADMIN].filter(Boolean).length;

    const c = (key: SystemCheckDto["key"], level: SystemCheckDto["level"], value: string | null = null): SystemCheckDto => ({ key, level, value });
    const checks: SystemCheckDto[] = [
      c("environment", production ? "ok" : "warning", env.APP_ENV ?? "—"),
      c("baseUrl", base && /^https:\/\/[^/]+$/.test(base) && !/localhost|example\./.test(base) ? "ok" : production ? "error" : "warning", base),
      c("schema", health.schema === "ok" ? "ok" : health.schema === "outdated" ? "error" : "warning", health.schema),
      c("cron", health.cron === "ok" ? "ok" : health.cron === "stale" ? "error" : "warning", health.cron),
      c("superAdmins", facts.superAdmins === null ? "warning" : facts.superAdmins >= 2 ? "ok" : "warning", facts.superAdmins === null ? null : String(facts.superAdmins)),
      c("bootstrapPassword", facts.superAdminsMustChange ? "warning" : "ok", facts.superAdminsMustChange ? String(facts.superAdminsMustChange) : null),
      c("siteName", facts.siteName ? "ok" : "error", facts.siteName),
      c("primaryAccount", facts.primaryAccount ? "ok" : "error", facts.primaryAccount ? "yes" : "no"),
      // A key alone means EasySlip (the supported service).
      c("slipVerification", has(env.SLIP_VERIFICATION_API_KEY) ? "ok" : "warning",
        has(env.SLIP_VERIFICATION_API_KEY) ? env.SLIP_VERIFY_PROVIDER?.trim() || "easyslip" : "manual"),
      c("line", facts.lineEnabled ? (lineSecrets ? "ok" : "error") : "ok", facts.lineEnabled ? "on" : "off"),
      c("ga4", "ok", m?.ga4_enabled === 1 ? m.ga4_measurement_id : "off"),
      c("ga4Data", m?.ga4_property_id ? (parseServiceAccountKey(env.GA4_SERVICE_ACCOUNT_KEY) ? "ok" : "warning") : "ok", m?.ga4_property_id ? "on" : "off"),
      c("metaCapi", m?.meta_capi_enabled === 1 ? (has(env.META_CAPI_ACCESS_TOKEN) ? "ok" : "error") : "ok", m?.meta_capi_enabled === 1 ? "on" : "off"),
      c("metaTestCode", has(env.META_TEST_EVENT_CODE) && production ? "warning" : "ok", has(env.META_TEST_EVENT_CODE) ? "set" : null),
      c("privacyPolicy", trackers && !facts.privacyPolicyTh ? "warning" : "ok", facts.privacyPolicyTh ? "yes" : "no"),
      c("searchConsole", m?.gsc_verification ? "ok" : "warning", m?.gsc_verification ? "meta tag" : null),
      c("rateLimits", rateLimits === 4 ? "ok" : production ? "warning" : "ok", `${rateLimits}/4`),
      c("recentErrors", facts.errorCount24h > 0 ? "warning" : "ok", String(facts.errorCount24h)),
      c("deliveries", facts.lineFailed24h + facts.capiFailed24h > 0 ? "warning" : "ok", String(facts.lineFailed24h + facts.capiFailed24h)),
    ];

    const toBeat = (b: Awaited<ReturnType<MonitoringRepository["heartbeats"]>>[number]): HeartbeatDto => ({
      name: b.name, lastRunAt: b.last_run_at, lastOkAt: b.last_ok_at, lastStatus: b.last_status, lastError: b.last_error, durationMs: b.duration_ms, runs: b.runs,
    });
    const toError = (e: ErrorEventRow): ErrorEventDto => ({
      id: e.id, occurredAt: e.occurred_at, source: e.source, requestId: e.request_id, method: e.method, path: e.path, errorName: e.error_name, message: e.message,
    });
    return {
      environment: env.APP_ENV ?? "unknown",
      baseUrl: base,
      health,
      checks,
      heartbeats: beats.map(toBeat),
      backlog: { linePending: facts.linePending, lineFailed24h: facts.lineFailed24h, capiPending: facts.capiPending, capiFailed24h: facts.capiFailed24h, slipsWaiting: facts.slipsWaiting },
      errorCount24h: facts.errorCount24h,
      errors: errors.map(toError),
    };
  }
}

