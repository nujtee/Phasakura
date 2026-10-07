import type { CurrentUserDto, PermissionCode } from "../../shared/auth-types.ts";
import { parseLocale } from "../../shared/i18n/locales.ts";
import type { D1DatabaseLike } from "../env.ts";
import { ForbiddenError, TooManyRequestsError, UnauthorizedError, ValidationError } from "../http/errors.ts";
import type { PasswordResetRepository } from "../repositories/password-reset.repository.ts";
import type { UserRepository, UserRow } from "../repositories/user.repository.ts";
import { getDummyHash, hashPassword, needsRehash, validatePasswordPolicy, verifyPassword } from "../security/password.ts";
import { sha256Hex } from "../security/tokens.ts";
import { addMs, iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { PasswordLinkService, PasswordResetDelivery } from "./password-link.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import type { NewSession, SessionService } from "./session.service.ts";

const MINUTE = 60 * 1000;
export const LOGIN_POLICY = {
  maxFailedAttempts: 5,          // per account → lock
  lockDurationMs: 15 * MINUTE,
  ipWindowMs: 15 * MINUTE,       // per IP → 429
  ipMaxFailures: 20,
  resetIpWindowMs: 60 * MINUTE,
  resetIpMax: 5,
  resetUserMax: 3,
} as const;

const INVALID_CREDENTIALS = "Invalid email/username or password, or the account is temporarily locked.";

export interface LoginResult {
  session: NewSession;
  user: CurrentUserDto;
}

export class AuthService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly users: UserRepository,
    private readonly resetTokens: PasswordResetRepository,
    private readonly sessions: SessionService,
    private readonly links: PasswordLinkService,
    private readonly delivery: PasswordResetDelivery,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {}

  async login(input: { identifier: string; password: string; rememberMe: boolean }, meta: RequestMeta): Promise<LoginResult> {
    const ipFailures = await this.log.countRecent(["LOGIN_FAILED"], LOGIN_POLICY.ipWindowMs, { ip: meta.ip });
    if (meta.ip && ipFailures >= LOGIN_POLICY.ipMaxFailures) {
      await this.log.event("LOGIN_THROTTLED", "WARNING", meta, { identifier: input.identifier });
      throw new TooManyRequestsError(LOGIN_POLICY.ipWindowMs / 1000);
    }

    const now = this.clock();
    const user = await this.users.findByIdentifier(input.identifier);

    if (!user || user.status === "DELETED") {
      await verifyPassword(input.password, await getDummyHash()); // equalise timing
      await this.log.event("LOGIN_FAILED", "INFO", meta, { identifier: input.identifier, details: { reason: "unknown_user" } });
      throw new UnauthorizedError(INVALID_CREDENTIALS, "INVALID_CREDENTIALS");
    }

    if (user.locked_until && user.locked_until > iso(now)) {
      await verifyPassword(input.password, await getDummyHash());
      await this.log.event("LOGIN_FAILED", "WARNING", meta, {
        userId: user.id, identifier: input.identifier, details: { reason: "locked" },
      });
      throw new UnauthorizedError(INVALID_CREDENTIALS, "INVALID_CREDENTIALS");
    }

    if (!(await verifyPassword(input.password, user.password_hash))) {
      const failures = user.failed_login_count + 1;
      const lock = failures >= LOGIN_POLICY.maxFailedAttempts ? iso(addMs(now, LOGIN_POLICY.lockDurationMs)) : null;
      await this.users.recordLoginFailure(user.id, lock, iso(now));
      await this.log.event("LOGIN_FAILED", "INFO", meta, {
        userId: user.id, identifier: input.identifier, details: { reason: "bad_password", failures },
      });
      if (lock) await this.log.event("ACCOUNT_LOCKED", "WARNING", meta, { userId: user.id, details: { until: lock } });
      throw new UnauthorizedError(INVALID_CREDENTIALS, "INVALID_CREDENTIALS");
    }

    // Correct password from here on: safe to reveal account state.
    if (user.status === "SUSPENDED") {
      await this.log.event("LOGIN_BLOCKED_SUSPENDED", "WARNING", meta, { userId: user.id });
      throw new ForbiddenError("This account is suspended. Please contact an administrator.", "ACCOUNT_SUSPENDED");
    }

    if (needsRehash(user.password_hash)) {
      await this.users.updatePasswordHash(user.id, await hashPassword(input.password));
    }

    // New session every login (session fixation protection).
    const session = await this.sessions.prepare(user.id, input.rememberMe, meta);
    await this.db.batch([
      session.statement,
      this.log.eventStatement("LOGIN_SUCCESS", "INFO", meta, { userId: user.id, details: { rememberMe: input.rememberMe } }),
    ]);
    await this.users.recordLoginSuccess(user.id, iso(now));

    const ctx = await this.sessions.authenticate(session.token);
    if (!ctx) throw new UnauthorizedError();
    return { session, user: toCurrentUser(ctx) };
  }

  async logout(ctx: AuthContext, meta: RequestMeta): Promise<void> {
    await this.db.batch([
      this.sessions.revokeStatement(ctx.session.id, "LOGOUT"),
      this.log.eventStatement("LOGOUT", "INFO", meta, { userId: ctx.userId }),
    ]);
  }

  /** Session rotation: the old token stops working immediately. */
  async refresh(ctx: AuthContext, meta: RequestMeta): Promise<NewSession> {
    const next = await this.sessions.prepare(ctx.userId, ctx.session.rememberMe, meta, ctx.session.id);
    await this.db.batch([this.sessions.revokeStatement(ctx.session.id, "ROTATED"), next.statement]);
    return next;
  }

  /** Always resolves the same way whether or not the account exists (no enumeration). */
  async forgotPassword(email: string, language: string | null, meta: RequestMeta): Promise<void> {
    const ipCount = await this.log.countRecent(["PASSWORD_RESET_REQUESTED"], LOGIN_POLICY.resetIpWindowMs, { ip: meta.ip });
    if (meta.ip && ipCount >= LOGIN_POLICY.resetIpMax) {
      await this.log.event("PASSWORD_RESET_THROTTLED", "WARNING", meta, { identifier: email });
      return;
    }
    const user = await this.users.findByEmail(email);
    if (!user || user.status !== "ACTIVE") {
      await this.log.event("PASSWORD_RESET_REQUESTED", "INFO", meta, { identifier: email, details: { matched: false } });
      return;
    }
    const userCount = await this.log.countRecent(["PASSWORD_RESET_REQUESTED"], LOGIN_POLICY.resetIpWindowMs, { userId: user.id });
    if (userCount >= LOGIN_POLICY.resetUserMax) {
      await this.log.event("PASSWORD_RESET_THROTTLED", "WARNING", meta, { userId: user.id });
      return;
    }

    const link = await this.links.issue(user.id, "SELF_RESET", language ?? user.preferred_language, meta);
    await this.db.batch([
      ...link.statements,
      this.log.eventStatement("PASSWORD_RESET_REQUESTED", "INFO", meta, { userId: user.id, identifier: email, details: { matched: true } }),
    ]);
    const delivered = await this.delivery.deliver({
      email: user.email, displayName: user.display_name, url: link.url, language: language ?? user.preferred_language,
    });
    if (!delivered) {
      await this.log.event("PASSWORD_RESET_NOT_DELIVERED", "WARNING", meta, {
        userId: user.id, details: { reason: "no_delivery_channel_configured" },
      });
    }
  }

  async resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const now = iso(this.clock());
    const row = await this.resetTokens.findUsable(await sha256Hex(token), now);
    const user = row ? await this.users.findById(row.user_id) : null;
    if (!row || !user || user.status !== "ACTIVE") {
      await this.log.event("PASSWORD_RESET_INVALID_TOKEN", "WARNING", meta, {});
      throw new ValidationError({ token: "INVALID_OR_EXPIRED" }, "This link is invalid or has expired.");
    }
    this.assertPolicy(newPassword, user);

    await this.db.batch([
      this.resetTokens.markUsedStatement(row.id, now),
      this.users.setPasswordStatement(user.id, await hashPassword(newPassword), false, now),
      this.sessions.revokeAllStatement(user.id, "PASSWORD_CHANGED"),
      this.resetTokens.invalidateAllStatement(user.id, now),
      this.log.eventStatement("PASSWORD_RESET_COMPLETED", "INFO", meta, { userId: user.id }),
    ]);
  }

  /** Changing own password: other sessions are revoked, this one is rotated. */
  async changePassword(ctx: AuthContext, currentPassword: string, newPassword: string, meta: RequestMeta): Promise<NewSession> {
    const user = await this.users.findById(ctx.userId);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      await this.log.event("PASSWORD_CHANGE_FAILED", "WARNING", meta, { userId: ctx.userId });
      throw new ValidationError({ currentPassword: "INCORRECT" }, "Current password is incorrect.");
    }
    if (currentPassword === newPassword) throw new ValidationError({ newPassword: "SAME_AS_CURRENT" });
    this.assertPolicy(newPassword, user);

    const now = iso(this.clock());
    const next = await this.sessions.prepare(ctx.userId, ctx.session.rememberMe, meta, ctx.session.id);
    await this.db.batch([
      this.users.setPasswordStatement(user.id, await hashPassword(newPassword), false, now),
      this.sessions.revokeAllStatement(user.id, "PASSWORD_CHANGED"),
      next.statement,
      this.log.eventStatement("PASSWORD_CHANGED", "INFO", meta, { userId: user.id }),
    ]);
    return next;
  }

  private assertPolicy(password: string, user: Pick<UserRow, "email" | "username" | "display_name">): void {
    const error = validatePasswordPolicy(password, [user.email, user.username ?? "", user.display_name]);
    if (error) throw new ValidationError({ newPassword: `PASSWORD_${error}` });
  }
}

export function toCurrentUser(ctx: AuthContext): CurrentUserDto {
  return {
    id: ctx.userId,
    email: ctx.email,
    username: ctx.username,
    displayName: ctx.displayName,
    preferredLanguage: parseLocale(ctx.preferredLanguage)?.code ?? null,
    roles: [...ctx.roles],
    permissions: [...ctx.permissions].sort() as PermissionCode[],
    mustChangePassword: ctx.mustChangePassword,
    session: { expiresAt: ctx.session.expiresAt, rememberMe: ctx.session.rememberMe },
  };
}
