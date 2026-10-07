import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface ResetTokenRow {
  id: string;
  user_id: string;
  expires_at: string;
  used_at: string | null;
}

export class PasswordResetRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  insertStatement(t: { id: string; userId: string; tokenHash: string; expiresAt: string; ip: string | null; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at, requested_ip)
         VALUES (?1, ?2, ?3, ?6, ?4, ?5)`,
      )
      .bind(t.id, t.userId, t.tokenHash, t.expiresAt, t.ip, t.now);
  }

  /** Invalidate every outstanding token of the user (only the newest link works). */
  invalidateAllStatement(userId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE password_reset_tokens SET used_at = ?2 WHERE user_id = ?1 AND used_at IS NULL")
      .bind(userId, now);
  }

  findUsable(tokenHash: string, now: string): Promise<ResetTokenRow | null> {
    return this.db
      .prepare(
        `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens
          WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`,
      )
      .bind(tokenHash, now)
      .first<ResetTokenRow>();
  }

  /** Marks used only if still unused — the batch fails the race check in the service. */
  markUsedStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE password_reset_tokens SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL")
      .bind(id, now);
  }
}
