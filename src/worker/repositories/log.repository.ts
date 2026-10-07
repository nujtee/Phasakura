import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export type SecuritySeverity = "INFO" | "WARNING" | "CRITICAL";

export interface SecurityEventInput {
  id: string;
  eventType: string;
  severity: SecuritySeverity;
  userId: string | null;
  identifier: string | null;
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
  now: string;
}

export interface AuditInput {
  id: string;
  userId: string | null;
  action: string;
  module: string;
  recordId: string | null;
  oldValue: unknown;
  newValue: unknown;
  ip: string | null;
  userAgent: string | null;
  now: string;
}

/** Keys that must never reach the audit or security log. */
const SENSITIVE_KEY = /pass(word)?|token|secret|hash|authorization|cookie|api[_-]?key/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v)]),
    );
  }
  return value;
}

export interface SecurityEventRow {
  id: string;
  event_type: string;
  severity: SecuritySeverity;
  user_id: string | null;
  user_email: string | null;
  identifier: string | null;
  ip: string | null;
  user_agent: string | null;
  details_json: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  module: string;
  record_id: string | null;
  old_value: string | null;
  new_value: string | null;
  ip: string | null;
  created_at: string;
}

export class LogRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  securityEventStatement(e: SecurityEventInput): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO security_events (id, event_type, severity, user_id, identifier, ip, user_agent, details_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        e.id, e.eventType, e.severity, e.userId, e.identifier?.slice(0, 254) ?? null, e.ip, e.userAgent,
        e.details ? JSON.stringify(redact(e.details)) : null, e.now,
      );
  }

  auditStatement(a: AuditInput): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO audit_logs (id, user_id, action, module, record_id, old_value, new_value, ip, user_agent, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        a.id, a.userId, a.action, a.module, a.recordId,
        a.oldValue === undefined ? null : JSON.stringify(redact(a.oldValue)),
        a.newValue === undefined ? null : JSON.stringify(redact(a.newValue)),
        a.ip, a.userAgent, a.now,
      );
  }

  async countSecurityEvents(filter: { types: string[]; ip?: string | null; userId?: string; identifier?: string; since: string }): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM security_events
          WHERE event_type IN (SELECT value FROM json_each(?1)) AND created_at > ?2
            AND (?3 IS NULL OR ip = ?3) AND (?4 IS NULL OR user_id = ?4) AND (?5 IS NULL OR identifier = ?5)`,
      )
      .bind(JSON.stringify(filter.types), filter.since, filter.ip ?? null, filter.userId ?? null, filter.identifier ?? null)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async listSecurityEvents(opts: { type?: string; userId?: string; before?: string; limit: number }): Promise<SecurityEventRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT e.id, e.event_type, e.severity, e.user_id, u.email AS user_email, e.identifier, e.ip, e.user_agent,
                e.details_json, e.created_at
           FROM security_events e LEFT JOIN users u ON u.id = e.user_id
          WHERE (?1 IS NULL OR e.event_type = ?1) AND (?2 IS NULL OR e.user_id = ?2) AND (?3 IS NULL OR e.created_at < ?3)
          ORDER BY e.created_at DESC, e.id DESC LIMIT ?4`,
      )
      .bind(opts.type ?? null, opts.userId ?? null, opts.before ?? null, opts.limit)
      .all<SecurityEventRow>();
    return results;
  }

  async listAuditLogs(opts: { module?: string; recordId?: string; before?: string; limit: number }): Promise<AuditRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.id, a.user_id, u.email AS user_email, a.action, a.module, a.record_id, a.old_value, a.new_value, a.ip, a.created_at
           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
          WHERE (?1 IS NULL OR a.module = ?1) AND (?2 IS NULL OR a.record_id = ?2) AND (?3 IS NULL OR a.created_at < ?3)
          ORDER BY a.created_at DESC, a.id DESC LIMIT ?4`,
      )
      .bind(opts.module ?? null, opts.recordId ?? null, opts.before ?? null, opts.limit)
      .all<AuditRow>();
    return results;
  }
}
