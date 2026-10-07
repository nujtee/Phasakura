import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export type RevokeReason =
  | "LOGOUT" | "ROTATED" | "FORCE_LOGOUT" | "PASSWORD_CHANGED" | "USER_SUSPENDED" | "USER_DELETED" | "EXPIRED" | "SECURITY";

export interface SessionUserRow {
  session_id: string;
  remember_me: number;
  expires_at: string;
  last_seen_at: string;
  created_at: string;
  user_id: string;
  email: string;
  username: string | null;
  display_name: string;
  preferred_language: string | null;
  must_change_password: number;
  status: string;
}

export class SessionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  insertStatement(s: {
    id: string;
    userId: string;
    tokenHash: string;
    rememberMe: boolean;
    expiresAt: string;
    rotatedFrom: string | null;
    ip: string | null;
    userAgent: string | null;
    now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, remember_me, created_at, last_seen_at, expires_at,
           rotated_from, ip, user_agent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(s.id, s.userId, s.tokenHash, s.rememberMe ? 1 : 0, s.now, s.expiresAt, s.rotatedFrom, s.ip, s.userAgent);
  }

  /** Valid = not revoked, not expired, and the user is ACTIVE. */
  findValidByTokenHash(tokenHash: string, now: string): Promise<SessionUserRow | null> {
    return this.db
      .prepare(
        `SELECT s.id AS session_id, s.remember_me, s.expires_at, s.last_seen_at, s.created_at,
                u.id AS user_id, u.email, u.username, u.display_name, u.preferred_language,
                u.must_change_password, u.status
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2 AND u.status = 'ACTIVE'`,
      )
      .bind(tokenHash, now)
      .first<SessionUserRow>();
  }

  async touch(sessionId: string, now: string): Promise<void> {
    await this.db.prepare("UPDATE sessions SET last_seen_at = ?2 WHERE id = ?1").bind(sessionId, now).run();
  }

  revokeStatement(sessionId: string, reason: RevokeReason, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE sessions SET revoked_at = ?2, revoke_reason = ?3 WHERE id = ?1 AND revoked_at IS NULL")
      .bind(sessionId, now, reason);
  }

  revokeAllForUserStatement(
    userId: string,
    reason: RevokeReason,
    now: string,
    exceptSessionId: string | null = null,
  ): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE sessions SET revoked_at = ?2, revoke_reason = ?3
          WHERE user_id = ?1 AND revoked_at IS NULL AND (?4 IS NULL OR id <> ?4)`,
      )
      .bind(userId, now, reason, exceptSessionId);
  }
}
