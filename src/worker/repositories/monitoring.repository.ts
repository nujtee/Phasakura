import type { D1DatabaseLike } from "../env.ts";

export interface HeartbeatRow {
  name: string;
  last_run_at: string;
  last_ok_at: string | null;
  last_status: "OK" | "ERROR";
  last_error: string | null;
  duration_ms: number;
  runs: number;
}

export interface ErrorEventRow {
  id: string;
  occurred_at: string;
  source: "API" | "PAGE" | "CRON";
  request_id: string | null;
  method: string | null;
  path: string | null;
  error_name: string | null;
  message: string;
}

/** Facts for the System status page, each read on its own so one missing table never hides the rest. */
export interface StatusFacts {
  superAdmins: number | null;
  superAdminsMustChange: number | null;
  siteName: string | null;
  primaryAccount: boolean | null;
  lineEnabled: boolean | null;
  marketing: { ga4_enabled: number; ga4_measurement_id: string | null; ga4_property_id: string | null; meta_pixel_enabled: number; meta_capi_enabled: number; gsc_verification: string | null } | null;
  privacyPolicyTh: boolean | null;
  linePending: number;
  lineFailed24h: number;
  capiPending: number;
  capiFailed24h: number;
  slipsWaiting: number;
  errorCount24h: number;
}

/** Heartbeats, server error log and status facts (Phase 16). Static SQL, bound parameters only. */
export class MonitoringRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async beat(name: string, ok: boolean, at: string, durationMs: number, error: string | null): Promise<void> {
    await this.db.prepare(
      `INSERT INTO system_heartbeats (name, last_run_at, last_ok_at, last_status, last_error, duration_ms, runs)
       VALUES (?1, ?2, CASE WHEN ?3 = 1 THEN ?2 END, CASE WHEN ?3 = 1 THEN 'OK' ELSE 'ERROR' END, ?4, ?5, 1)
       ON CONFLICT (name) DO UPDATE SET last_run_at = excluded.last_run_at,
         last_ok_at = COALESCE(excluded.last_ok_at, system_heartbeats.last_ok_at), last_status = excluded.last_status,
         last_error = excluded.last_error, duration_ms = excluded.duration_ms, runs = system_heartbeats.runs + 1`,
    ).bind(name, at, ok ? 1 : 0, error, Math.max(0, Math.round(durationMs))).run();
  }

  async insertError(e: ErrorEventRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO error_events (id, occurred_at, source, request_id, method, path, error_name, message)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(e.id, e.occurred_at, e.source, e.request_id, e.method, e.path, e.error_name, e.message).run();
  }

  async purgeErrors(before: string): Promise<void> {
    await this.db.prepare("DELETE FROM error_events WHERE occurred_at < ?1").bind(before).run();
  }

  async heartbeats(): Promise<HeartbeatRow[]> {
    try {
      return (await this.db.prepare("SELECT name, last_run_at, last_ok_at, last_status, last_error, duration_ms, runs FROM system_heartbeats ORDER BY name").all<HeartbeatRow>()).results;
    } catch {
      return [];
    }
  }

  async recentErrors(limit: number): Promise<ErrorEventRow[]> {
    try {
      return (await this.db.prepare(
        "SELECT id, occurred_at, source, request_id, method, path, error_name, message FROM error_events ORDER BY occurred_at DESC LIMIT ?1",
      ).bind(limit).all<ErrorEventRow>()).results;
    } catch {
      return [];
    }
  }

  private async one<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
    try {
      return await this.db.prepare(sql).bind(...binds).first<T>();
    } catch {
      return null;
    }
  }

  async facts(now: string, since24h: string): Promise<StatusFacts> {
    const n = async (sql: string, ...b: unknown[]) => (await this.one<{ n: number }>(sql, ...b))?.n ?? 0;
    const [admins, mustChange, site, account, line, marketing, policy] = await Promise.all([
      this.one<{ n: number }>(
        `SELECT count(*) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
          WHERE r.code = 'SUPER_ADMIN' AND u.status = 'ACTIVE'`),
      this.one<{ n: number }>(
        `SELECT count(*) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
          WHERE r.code = 'SUPER_ADMIN' AND u.status = 'ACTIVE' AND u.must_change_password = 1`),
      this.one<{ site_name: string | null }>(
        `SELECT t.site_name FROM site_settings s LEFT JOIN site_setting_translations t ON t.language_code = s.default_language WHERE s.id = 1`),
      this.one<{ n: number }>("SELECT count(*) AS n FROM receiving_accounts WHERE is_primary = 1 AND status = 'ACTIVE'"),
      this.one<{ enabled: number }>("SELECT enabled FROM line_settings WHERE id = 1"),
      this.one<StatusFacts["marketing"]>(
        "SELECT ga4_enabled, ga4_measurement_id, ga4_property_id, meta_pixel_enabled, meta_capi_enabled, gsc_verification FROM marketing_settings WHERE id = 1"),
      this.one<{ n: number }>("SELECT count(*) AS n FROM privacy_setting_translations WHERE language_code = 'th' AND policy_body IS NOT NULL AND trim(policy_body) <> ''"),
    ]);
    return {
      superAdmins: admins?.n ?? null,
      superAdminsMustChange: mustChange?.n ?? null,
      siteName: site?.site_name?.trim() || null,
      primaryAccount: account ? account.n > 0 : null,
      lineEnabled: line ? line.enabled === 1 : null,
      marketing,
      privacyPolicyTh: policy ? policy.n > 0 : null,
      linePending: await n("SELECT count(*) AS n FROM notification_logs WHERE status = 'PENDING' AND scheduled_for <= ?1", now),
      lineFailed24h: await n("SELECT count(*) AS n FROM notification_logs WHERE status = 'FAILED' AND updated_at >= ?1", since24h),
      capiPending: await n("SELECT count(*) AS n FROM marketing_events WHERE status = 'PENDING'"),
      capiFailed24h: await n("SELECT count(*) AS n FROM marketing_events WHERE status = 'FAILED' AND created_at >= ?1", since24h),
      slipsWaiting: await n("SELECT count(*) AS n FROM payments WHERE status = 'PENDING_VERIFICATION'"),
      errorCount24h: await n("SELECT count(*) AS n FROM error_events WHERE occurred_at >= ?1", since24h),
    };
  }
}
