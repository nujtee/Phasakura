import type { PermissionCode } from "../../shared/auth-types.ts";
import { ForbiddenError } from "../http/errors.ts";
import type { AuthContext, RequestMeta } from "./auth-context.ts";
import type { SecurityLogService } from "./security-log.service.ts";

/**
 * Single authority for access decisions (spec §34).
 *
 * Code asks "may this user do X?" via permission codes. Which roles hold which
 * permissions lives in D1. The only role-specific knowledge here is the
 * SUPER_ADMIN protection rules of spec §33, kept in this one place.
 */
export class AuthorizationService {
  static readonly SUPER_ADMIN_ROLE = "SUPER_ADMIN";

  constructor(private readonly log: SecurityLogService) {}

  can(user: AuthContext, permission: PermissionCode): boolean {
    return user.permissions.has(permission);
  }

  canAll(user: AuthContext, permissions: readonly string[]): boolean {
    return permissions.every((p) => user.permissions.has(p));
  }

  /** Throws 403 and records a PERMISSION_DENIED security event. */
  async requirePermission(user: AuthContext, permission: PermissionCode, meta: RequestMeta): Promise<void> {
    if (this.can(user, permission)) return;
    await this.log.event("PERMISSION_DENIED", "WARNING", meta, {
      userId: user.userId,
      details: { permission },
    });
    throw new ForbiddenError();
  }

  isSuperAdmin(user: AuthContext): boolean {
    return user.roles.includes(AuthorizationService.SUPER_ADMIN_ROLE);
  }

  /** Only a SUPER_ADMIN may act on another SUPER_ADMIN or grant the SUPER_ADMIN role. */
  async requireSuperAdminFor(user: AuthContext, reason: string, meta: RequestMeta): Promise<void> {
    if (this.isSuperAdmin(user)) return;
    await this.log.event("PRIVILEGE_ESCALATION_BLOCKED", "CRITICAL", meta, {
      userId: user.userId,
      details: { reason },
    });
    throw new ForbiddenError("Only a SUPER_ADMIN can perform this action", "SUPER_ADMIN_REQUIRED");
  }

  /**
   * No privilege escalation: a non-SUPER_ADMIN may only hand out permissions they hold themselves.
   */
  async requireCanDelegate(user: AuthContext, permissions: readonly string[], meta: RequestMeta): Promise<void> {
    if (this.isSuperAdmin(user) || this.canAll(user, permissions)) return;
    await this.log.event("PRIVILEGE_ESCALATION_BLOCKED", "CRITICAL", meta, {
      userId: user.userId,
      details: { reason: "delegate_unheld_permission", permissions: permissions.filter((p) => !user.permissions.has(p)) },
    });
    throw new ForbiddenError("You cannot grant permissions you do not have", "CANNOT_DELEGATE");
  }
}
