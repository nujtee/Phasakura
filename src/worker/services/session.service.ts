import type { D1PreparedStatementLike } from "../env.ts";
import type { RbacRepository } from "../repositories/rbac.repository.ts";
import type { RevokeReason, SessionRepository } from "../repositories/session.repository.ts";
import { sessionCookie } from "../security/cookies.ts";
import { newId, randomToken, sha256Hex } from "../security/tokens.ts";
import { addMs, iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";

const HOUR = 60 * 60 * 1000;
export const SESSION_TTL_MS = 12 * HOUR;           // browser session, absolute
export const REMEMBER_ME_TTL_MS = 30 * 24 * HOUR;  // "Remember me", absolute
export const IDLE_TIMEOUT_MS = 2 * HOUR;           // browser session inactivity limit
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface NewSession {
  token: string;
  sessionId: string;
  expiresAt: string;
  rememberMe: boolean;
  statement: D1PreparedStatementLike;
}

export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly rbac: RbacRepository,
    private readonly clock: Clock,
  ) {}

  /** Returns the insert statement so callers can commit it atomically with other writes. */
  async prepare(userId: string, rememberMe: boolean, meta: RequestMeta, rotatedFrom: string | null = null): Promise<NewSession> {
    const now = this.clock();
    const token = randomToken();
    const sessionId = newId();
    const expiresAt = iso(addMs(now, rememberMe ? REMEMBER_ME_TTL_MS : SESSION_TTL_MS));
    const statement = this.sessions.insertStatement({
      id: sessionId,
      userId,
      tokenHash: await sha256Hex(token),
      rememberMe,
      expiresAt,
      rotatedFrom,
      ip: meta.ip,
      userAgent: meta.userAgent,
      now: iso(now),
    });
    return { token, sessionId, expiresAt, rememberMe, statement };
  }

  cookie(session: Pick<NewSession, "token" | "rememberMe" | "expiresAt">): string {
    if (!session.rememberMe) return sessionCookie(session.token);
    return sessionCookie(session.token, (new Date(session.expiresAt).getTime() - this.clock().getTime()) / 1000);
  }

  async authenticate(token: string | null): Promise<AuthContext | null> {
    if (!token) return null;
    const now = this.clock();
    const row = await this.sessions.findValidByTokenHash(await sha256Hex(token), iso(now));
    if (!row) return null;

    const lastSeen = new Date(row.last_seen_at).getTime();
    if (!row.remember_me && now.getTime() - lastSeen > IDLE_TIMEOUT_MS) {
      await this.sessions.revokeStatement(row.session_id, "EXPIRED", iso(now)).run();
      return null;
    }
    if (now.getTime() - lastSeen > TOUCH_INTERVAL_MS) await this.sessions.touch(row.session_id, iso(now));

    const [roles, permissions] = await Promise.all([
      this.rbac.roleCodesForUser(row.user_id),
      this.rbac.effectivePermissions(row.user_id),
    ]);
    return {
      userId: row.user_id,
      email: row.email,
      username: row.username,
      displayName: row.display_name,
      preferredLanguage: row.preferred_language,
      mustChangePassword: row.must_change_password === 1,
      roles,
      permissions: new Set(permissions),
      session: { id: row.session_id, expiresAt: row.expires_at, rememberMe: row.remember_me === 1 },
    };
  }

  revokeStatement(sessionId: string, reason: RevokeReason): D1PreparedStatementLike {
    return this.sessions.revokeStatement(sessionId, reason, iso(this.clock()));
  }

  revokeAllStatement(userId: string, reason: RevokeReason, exceptSessionId: string | null = null): D1PreparedStatementLike {
    return this.sessions.revokeAllForUserStatement(userId, reason, iso(this.clock()), exceptSessionId);
  }
}
