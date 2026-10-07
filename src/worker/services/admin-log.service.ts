import type { AuditLogDto, PageDto, SecurityEventDto } from "../../shared/auth-types.ts";
import type { LogRepository } from "../repositories/log.repository.ts";
import type { AuthContext, RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Read access to security events and the audit log (cursor-paginated, newest first). */
export class AdminLogService {
  constructor(
    private readonly repo: LogRepository,
    private readonly authz: AuthorizationService,
  ) {}

  async securityEvents(
    actor: AuthContext,
    opts: { type?: string; userId?: string; before?: string; limit: number },
    meta: RequestMeta,
  ): Promise<PageDto<SecurityEventDto>> {
    await this.authz.requirePermission(actor, "security_events.view", meta);
    const rows = await this.repo.listSecurityEvents({ ...opts, limit: opts.limit + 1 });
    const items = rows.slice(0, opts.limit).map((r) => ({
      id: r.id,
      eventType: r.event_type,
      severity: r.severity,
      userId: r.user_id,
      userEmail: r.user_email,
      identifier: r.identifier,
      ip: r.ip,
      userAgent: r.user_agent,
      details: parseJson(r.details_json) as Record<string, unknown> | null,
      createdAt: r.created_at,
    }));
    return { items, nextCursor: rows.length > opts.limit ? items[items.length - 1]!.createdAt : null };
  }

  async auditLogs(
    actor: AuthContext,
    opts: { module?: string; recordId?: string; before?: string; limit: number },
    meta: RequestMeta,
  ): Promise<PageDto<AuditLogDto>> {
    await this.authz.requirePermission(actor, "audit_logs.view", meta);
    const rows = await this.repo.listAuditLogs({ ...opts, limit: opts.limit + 1 });
    const items = rows.slice(0, opts.limit).map((r) => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      action: r.action,
      module: r.module,
      recordId: r.record_id,
      oldValue: parseJson(r.old_value),
      newValue: parseJson(r.new_value),
      ip: r.ip,
      createdAt: r.created_at,
    }));
    return { items, nextCursor: rows.length > opts.limit ? items[items.length - 1]!.createdAt : null };
  }
}
