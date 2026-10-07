import type { D1PreparedStatementLike } from "../env.ts";
import type { LogRepository, SecuritySeverity } from "../repositories/log.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type Clock, type RequestMeta } from "./auth-context.ts";

/**
 * Security events + audit log writer. Values are redacted (passwords, tokens,
 * secrets) by the repository before they reach D1.
 */
export class SecurityLogService {
  constructor(
    private readonly repo: LogRepository,
    private readonly clock: Clock,
  ) {}

  eventStatement(
    eventType: string,
    severity: SecuritySeverity,
    meta: RequestMeta,
    extra: { userId?: string | null; identifier?: string | null; details?: Record<string, unknown> } = {},
  ): D1PreparedStatementLike {
    return this.repo.securityEventStatement({
      id: newId(),
      eventType,
      severity,
      userId: extra.userId ?? null,
      identifier: extra.identifier ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: extra.details ?? null,
      now: iso(this.clock()),
    });
  }

  /** Best effort: a logging failure must not change the outcome of the request. */
  async event(...args: Parameters<SecurityLogService["eventStatement"]>): Promise<void> {
    try {
      await this.eventStatement(...args).run();
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "security_event_write_failed", error: String(error) }));
    }
  }

  auditStatement(
    actorId: string | null,
    action: string,
    module: string,
    recordId: string | null,
    oldValue: unknown,
    newValue: unknown,
    meta: RequestMeta,
  ): D1PreparedStatementLike {
    return this.repo.auditStatement({
      id: newId(),
      userId: actorId,
      action,
      module,
      recordId,
      oldValue,
      newValue,
      ip: meta.ip,
      userAgent: meta.userAgent,
      now: iso(this.clock()),
    });
  }

  countRecent(types: string[], sinceMs: number, filter: { ip?: string | null; userId?: string; identifier?: string } = {}): Promise<number> {
    return this.repo.countSecurityEvents({
      types,
      since: iso(new Date(this.clock().getTime() - sinceMs)),
      ...filter,
    });
  }
}
