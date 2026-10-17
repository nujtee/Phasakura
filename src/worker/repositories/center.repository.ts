/**
 * Center users (phase C3) are rows in `users` whose id starts with this prefix (site ids are UUIDs).
 * Only the signed Center API creates them; the site's own lists, counts, logins and notifications skip them.
 */
export const CENTER_USER_PREFIX = "center_";
/** SQL: the row aliased `alias` is one of the site's own accounts (not a Center user). */
export const siteUser = (alias = "u") => `substr(${alias}.id, 1, 7) <> 'center_'`;
export const isCenterUserId = (id: string) => id.startsWith(CENTER_USER_PREFIX);

import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { isMissingSchema } from "./inventory.repository.ts";

/** Nonces of signed Center requests (migration 0030). */
export class CenterNonceRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** true = first time this nonce is seen; false = a replay. */
  async remember(nonce: string, keyId: string, expiresAt: string): Promise<boolean> {
    const row = await this.db
      .prepare("INSERT INTO center_nonces (nonce, key_id, expires_at) VALUES (?, ?, ?) ON CONFLICT (nonce) DO NOTHING RETURNING nonce")
      .bind(nonce, keyId, expiresAt)
      .first<{ nonce: string }>();
    return row !== null;
  }

  async purge(before: string): Promise<void> {
    await this.db.prepare("DELETE FROM center_nonces WHERE expires_at < ?").bind(before).run();
  }
}

/** What a Center user may do inside the site's back office (phase C3). */
export type CenterAccessLevel = "SUPER_ADMIN" | "READ_ONLY";

export interface SiteUserRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  last_login_at: string | null;
  created_at: string;
  roles: string | null;
}

export interface SuspensionRow {
  reason_code: "UNPAID_FEES";
  note: string | null;
  suspended_by: string;
  suspended_at: string;
}

/** Center users, SSO tickets and site suspension (migration 0031). Every write returns a statement to batch with its audit row. */
export class CenterAdminRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /**
   * The Center user's row and access: inserted on first use, display name / access refreshed every time.
   * The password hash is not a PHC string, so no password ever matches (and login by identifier skips Center users).
   */
  upsertUserStatements(u: { id: string; email: string; displayName: string; access: CenterAccessLevel; now: string }): D1PreparedStatementLike[] {
    const db = this.db;
    const statements = [
      db.prepare(
        `INSERT INTO users (id, email, username, display_name, password_hash, must_change_password, status, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, '!center-sso-only', 0, 'ACTIVE', ?4, ?4)
         ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, status = 'ACTIVE', updated_at = excluded.updated_at`,
      ).bind(u.id, u.email, u.displayName, u.now),
      db.prepare("DELETE FROM user_permissions WHERE user_id = ?1").bind(u.id),
    ];
    if (u.access === "SUPER_ADMIN") {
      statements.push(db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?1, 'role_super_admin', NULL, ?2)").bind(u.id, u.now));
    } else {
      statements.push(
        db.prepare("DELETE FROM user_roles WHERE user_id = ?1").bind(u.id),
        db.prepare(
          `INSERT INTO user_permissions (user_id, permission_id, effect, granted_by, granted_at)
           SELECT ?1, p.id, 'GRANT', NULL, ?2 FROM permissions p WHERE p.code LIKE '%.view'`,
        ).bind(u.id, u.now),
      );
    }
    return statements;
  }

  insertTicketStatement(ticketHash: string, userId: string, expiresAt: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("INSERT INTO center_sso_tickets (ticket_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(ticketHash, userId, expiresAt, now);
  }

  /** Marks the ticket used and returns its Center user — once, before it expires, while that user is active. */
  async useTicket(ticketHash: string, now: string): Promise<{ user_id: string } | null> {
    return this.db
      .prepare(
        `UPDATE center_sso_tickets SET used_at = ?2
          WHERE ticket_hash = ?1 AND used_at IS NULL AND expires_at > ?2
            AND EXISTS (SELECT 1 FROM users u WHERE u.id = center_sso_tickets.user_id AND u.status = 'ACTIVE')
          RETURNING user_id`,
      )
      .bind(ticketHash, now)
      .first<{ user_id: string }>();
  }

  async purgeTickets(before: string): Promise<void> {
    await this.db.prepare("DELETE FROM center_sso_tickets WHERE expires_at < ?1").bind(before).run();
  }

  /** Signs out Center users (one, or all) and voids their unused tickets. */
  revokeStatements(userId: string | null, now: string): D1PreparedStatementLike[] {
    if (userId === null) {
      return [
        this.db.prepare("UPDATE sessions SET revoked_at = ?1, revoke_reason = 'SECURITY' WHERE revoked_at IS NULL AND substr(user_id, 1, 7) = 'center_'").bind(now),
        this.db.prepare("UPDATE center_sso_tickets SET used_at = ?1 WHERE used_at IS NULL").bind(now),
      ];
    }
    return [
      this.db.prepare("UPDATE sessions SET revoked_at = ?1, revoke_reason = 'SECURITY' WHERE revoked_at IS NULL AND user_id = ?2").bind(now, userId),
      this.db.prepare("UPDATE center_sso_tickets SET used_at = ?1 WHERE used_at IS NULL AND user_id = ?2").bind(now, userId),
    ];
  }

  async activeCenterSessions(userId: string | null, now: string): Promise<number> {
    const row = userId === null
      ? await this.db.prepare("SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?1 AND substr(user_id, 1, 7) = 'center_'").bind(now).first<{ n: number }>()
      : await this.db.prepare("SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?1 AND user_id = ?2").bind(now, userId).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** The site's own accounts (never Center users), for Center's site page. No password hashes. */
  async siteUsers(): Promise<SiteUserRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT u.id, u.email, u.display_name, u.status, u.last_login_at, u.created_at,
                (SELECT group_concat(r.code, ',') FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles
           FROM users u WHERE ${siteUser()} AND u.status <> 'DELETED' ORDER BY u.created_at, u.id`,
      )
      .all<SiteUserRow>();
    return results;
  }

  /** null = open. Before migration 0031 the table does not exist: open. */
  async suspension(): Promise<SuspensionRow | null> {
    try {
      return await this.db.prepare("SELECT reason_code, note, suspended_by, suspended_at FROM site_suspension WHERE id = 1").first<SuspensionRow>();
    } catch (error) {
      if (isMissingSchema(error)) return null;
      throw error;
    }
  }

  suspendStatement(note: string | null, by: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO site_suspension (id, reason_code, note, suspended_by, suspended_at) VALUES (1, 'UNPAID_FEES', ?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET note = excluded.note, suspended_by = excluded.suspended_by, suspended_at = excluded.suspended_at`,
      )
      .bind(note, by, now);
  }

  resumeStatement(): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM site_suspension WHERE id = 1");
  }
}
