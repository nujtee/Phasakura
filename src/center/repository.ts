import type { CenterRole } from "../shared/center-protocol.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../worker/env.ts";

export interface CenterUserRow {
  id: string;
  email: string;
  display_name: string;
  role: CenterRole;
  password_hash: string | null;
  status: "ACTIVE" | "DISABLED";
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
}

export interface CenterAuditRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  site: string | null;
  reason: string | null;
  detail_json: string | null;
  created_at: string;
}

const USER = "id, email, display_name, role, password_hash, status, failed_login_count, locked_until, last_login_at, created_at";

/** Everything Center keeps in center-db (center/migrations). Writes that belong together return statements to batch. */
export class CenterRepository {
  constructor(readonly db: D1DatabaseLike) {}

  // ---------------------------------------------------------------- people

  userByEmail(email: string): Promise<CenterUserRow | null> {
    return this.db.prepare(`SELECT ${USER} FROM center_users WHERE email = ?1`).bind(email).first<CenterUserRow>();
  }

  userById(id: string): Promise<CenterUserRow | null> {
    return this.db.prepare(`SELECT ${USER} FROM center_users WHERE id = ?1`).bind(id).first<CenterUserRow>();
  }

  async users(): Promise<CenterUserRow[]> {
    const { results } = await this.db.prepare(`SELECT ${USER} FROM center_users ORDER BY status, created_at, id`).all<CenterUserRow>();
    return results;
  }

  insertUserStatement(u: { id: string; email: string; displayName: string; role: CenterRole; createdBy: string | null; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(`INSERT INTO center_users (id, email, display_name, role, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`)
      .bind(u.id, u.email, u.displayName, u.role, u.createdBy, u.now);
  }

  setPasswordStatement(id: string, hash: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE center_users SET password_hash = ?2, failed_login_count = 0, locked_until = NULL, updated_at = ?3 WHERE id = ?1")
      .bind(id, hash, now);
  }

  async recordLoginFailure(id: string, count: number, lockedUntil: string | null, now: string): Promise<void> {
    await this.db.prepare("UPDATE center_users SET failed_login_count = ?2, locked_until = ?3, updated_at = ?4 WHERE id = ?1").bind(id, count, lockedUntil, now).run();
  }

  recordLoginStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE center_users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?2 WHERE id = ?1").bind(id, now);
  }

  setRoleStatement(id: string, role: CenterRole, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE center_users SET role = ?2, updated_at = ?3 WHERE id = ?1").bind(id, role, now);
  }

  setStatusStatement(id: string, status: "ACTIVE" | "DISABLED", now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE center_users SET status = ?2, updated_at = ?3 WHERE id = ?1").bind(id, status, now);
  }

  // ---------------------------------------------------------------- sessions

  insertSessionStatement(s: { id: string; userId: string; tokenHash: string; now: string; expiresAt: string; ip: string | null; userAgent: string | null }): D1PreparedStatementLike {
    return this.db
      .prepare(`INSERT INTO center_sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7)`)
      .bind(s.id, s.userId, s.tokenHash, s.now, s.expiresAt, s.ip, s.userAgent);
  }

  sessionByTokenHash(tokenHash: string, now: string): Promise<(CenterUserRow & { session_id: string; last_seen_at: string; expires_at: string }) | null> {
    return this.db
      .prepare(
        `SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.id, u.email, u.display_name, u.role, u.password_hash, u.status,
                u.failed_login_count, u.locked_until, u.last_login_at, u.created_at
           FROM center_sessions s JOIN center_users u ON u.id = s.user_id
          WHERE s.token_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2 AND u.status = 'ACTIVE'`,
      )
      .bind(tokenHash, now)
      .first();
  }

  async touchSession(id: string, now: string): Promise<void> {
    await this.db.prepare("UPDATE center_sessions SET last_seen_at = ?2 WHERE id = ?1").bind(id, now).run();
  }

  revokeSessionStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE center_sessions SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL").bind(id, now);
  }

  revokeUserSessionsStatement(userId: string, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE center_sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL").bind(userId, now);
  }

  // ---------------------------------------------------------------- setup links

  insertTokenStatement(t: { tokenHash: string; userId: string; purpose: "INVITE" | "RESET"; expiresAt: string; createdBy: string | null; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare("INSERT INTO center_setup_tokens (token_hash, user_id, purpose, expires_at, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(t.tokenHash, t.userId, t.purpose, t.expiresAt, t.createdBy, t.now);
  }

  /** A usable token's person (unused, not expired, person active). */
  tokenUser(tokenHash: string, now: string): Promise<(CenterUserRow & { purpose: string }) | null> {
    return this.db
      .prepare(
        `SELECT t.purpose, u.id, u.email, u.display_name, u.role, u.password_hash, u.status, u.failed_login_count, u.locked_until, u.last_login_at, u.created_at
           FROM center_setup_tokens t JOIN center_users u ON u.id = t.user_id
          WHERE t.token_hash = ?1 AND t.used_at IS NULL AND t.expires_at > ?2 AND u.status = 'ACTIVE'`,
      )
      .bind(tokenHash, now)
      .first();
  }

  /** Uses every open link of the person (the one just used, and any older one). */
  closeTokensStatement(userId: string, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE center_setup_tokens SET used_at = ?2 WHERE user_id = ?1 AND used_at IS NULL").bind(userId, now);
  }

  // ---------------------------------------------------------------- audit

  auditStatement(a: { id: string; userId: string | null; action: string; site: string | null; reason: string | null; detail: unknown; ip: string | null; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare("INSERT INTO center_audit (id, user_id, action, site, reason, detail_json, ip, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(a.id, a.userId, a.action, a.site, a.reason, a.detail === undefined || a.detail === null ? null : JSON.stringify(a.detail), a.ip, a.now);
  }

  async recentAudit(limit: number): Promise<CenterAuditRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.id, a.user_id, u.display_name AS user_name, a.action, a.site, a.reason, a.detail_json, a.created_at
           FROM center_audit a LEFT JOIN center_users u ON u.id = a.user_id
          ORDER BY a.created_at DESC, a.id DESC LIMIT ?1`,
      )
      .bind(limit)
      .all<CenterAuditRow>();
    return results;
  }
}
