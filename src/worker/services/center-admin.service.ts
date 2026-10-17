import type { CenterActor, CenterRole } from "../../shared/center-protocol.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ForbiddenError, HttpError, ValidationError } from "../http/errors.ts";
import { CENTER_USER_PREFIX, type CenterAccessLevel, type CenterAdminRepository } from "../repositories/center.repository.ts";
import { randomToken, sha256Hex } from "../security/tokens.ts";
import { addMs, iso, type Clock, type RequestMeta } from "./auth-context.ts";
import type { CenterRequest } from "./center-access.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import { CENTER_SESSION_TTL_MS, type NewSession, type SessionService } from "./session.service.ts";

/** How long an SSO ticket can be used (Center posts it straight away). */
export const CENTER_SSO_TICKET_TTL_MS = 60_000;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const MODULE = "center";

export interface CenterSuspensionDto {
  suspended: boolean;
  reasonCode: "UNPAID_FEES" | null;
  note: string | null;
  since: string | null;
}

export interface CenterSiteUserDto {
  id: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
}

/** Thrown for new public bookings while Center has suspended the site (unpaid service fees). */
export class SiteSuspendedError extends HttpError {
  constructor() {
    super(423, "SITE_SUSPENDED", "Online booking is temporarily unavailable");
  }
}

/**
 * What Center may change on a site (phase C3). Every write is a signed request (CenterAccessService) that must
 * carry a reason, is limited by the Center role, and is written to this site's Audit logs under the Center user
 * ("Center · <email>") together with the role, key and reason — in the same batch as the change itself.
 *
 *  - SSO: a one-time ticket (60 s) that opens a short session (2 h) in the back office as that Center user:
 *    PLATFORM_OWNER / OPERATOR = SUPER_ADMIN, SUPPORT_READONLY = every *.view permission only.
 *  - Sign out Center users (when someone leaves Center).
 *  - Suspend / resume the site — PLATFORM_OWNER only, and only for unpaid service fees: new public bookings stop,
 *    everything else (existing bookings, slips, the back office, exports) keeps working.
 */
export class CenterAdminService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: CenterAdminRepository,
    private readonly sessions: SessionService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------- SSO

  async issueSso(req: CenterRequest, meta: RequestMeta): Promise<{ ticket: string; expiresAt: string }> {
    const reason = requireReason(req.actor);
    const now = this.clock();
    const user = centerUser(req.actor);
    const ticket = randomToken(32);
    const expiresAt = iso(addMs(now, CENTER_SSO_TICKET_TTL_MS));
    await this.db.batch([
      ...this.repo.upsertUserStatements({ ...user, now: iso(now) }),
      this.repo.insertTicketStatement(await sha256Hex(ticket), user.id, expiresAt, iso(now)),
      this.audit(user.id, "CENTER_SSO", user.id, null, { access: user.access }, req, reason, meta),
    ]);
    return { ticket, expiresAt };
  }

  /** null when the ticket is unknown, used, expired or its Center user was signed out (logged). */
  async consumeSso(ticket: string, meta: RequestMeta): Promise<NewSession | null> {
    const now = iso(this.clock());
    const row = TICKET.test(ticket) ? await this.repo.useTicket(await sha256Hex(ticket), now) : null;
    if (!row) {
      await this.log.event("CENTER_SSO_REFUSED", "WARNING", meta, {});
      return null;
    }
    const session = await this.sessions.prepare(row.user_id, false, meta, null, CENTER_SESSION_TTL_MS);
    await this.db.batch([session.statement, this.log.eventStatement("CENTER_SSO_LOGIN", "INFO", meta, { userId: row.user_id })]);
    return session;
  }

  // ---------------------------------------------------------------- writes

  /** Signs out one Center user (actorId) or every Center user on this site. */
  async revokeSessions(req: CenterRequest, actorId: string | null, meta: RequestMeta): Promise<{ revoked: number }> {
    requireRole(req.actor, ["PLATFORM_OWNER", "OPERATOR"]);
    const reason = requireReason(req.actor);
    const now = iso(this.clock());
    const caller = centerUser(req.actor);
    const target = actorId === null ? null : `${CENTER_USER_PREFIX}${actorId}`;
    const revoked = await this.repo.activeCenterSessions(target, now);
    await this.db.batch([
      ...this.repo.upsertUserStatements({ ...caller, now }),
      ...this.repo.revokeStatements(target, now),
      this.audit(caller.id, "CENTER_REVOKE_SESSIONS", target, null, { target: actorId ?? "ALL", revoked }, req, reason, meta),
    ]);
    return { revoked };
  }

  async setSuspension(req: CenterRequest, suspended: boolean, note: string | null, meta: RequestMeta): Promise<CenterSuspensionDto> {
    requireRole(req.actor, ["PLATFORM_OWNER"]);
    const reason = requireReason(req.actor);
    const now = iso(this.clock());
    const caller = centerUser(req.actor);
    const before = await this.suspension();
    const statements: D1PreparedStatementLike[] = [
      ...this.repo.upsertUserStatements({ ...caller, now }),
      suspended ? this.repo.suspendStatement(note, caller.id, now) : this.repo.resumeStatement(),
      this.audit(caller.id, suspended ? "CENTER_SUSPEND" : "CENTER_RESUME", "site", before,
        suspended ? { suspended: true, reasonCode: "UNPAID_FEES", note } : { suspended: false }, req, reason, meta),
    ];
    await this.db.batch(statements);
    return this.suspension();
  }

  // ---------------------------------------------------------------- reads

  async suspension(): Promise<CenterSuspensionDto> {
    const row = await this.repo.suspension();
    return { suspended: !!row, reasonCode: row?.reason_code ?? null, note: row?.note ?? null, since: row?.suspended_at ?? null };
  }

  async siteUsers(): Promise<CenterSiteUserDto[]> {
    return (await this.repo.siteUsers()).map((u) => ({
      id: u.id, email: u.email, displayName: u.display_name, status: u.status,
      roles: u.roles ? u.roles.split(",").sort() : [], lastLoginAt: u.last_login_at, createdAt: u.created_at,
    }));
  }

  /** New public bookings (quote / create) stop while Center has suspended the site. */
  async assertOpenForBooking(): Promise<void> {
    if (await this.repo.suspension()) throw new SiteSuspendedError();
  }

  async purgeTickets(): Promise<void> {
    await this.repo.purgeTickets(iso(this.clock()));
  }

  private audit(
    userId: string, action: string, recordId: string | null, oldValue: unknown, newValue: Record<string, unknown>,
    req: CenterRequest, reason: string, meta: RequestMeta,
  ): D1PreparedStatementLike {
    const center = { email: req.actor.email, role: req.actor.role, keyId: req.keyId, reason };
    return this.log.auditStatement(userId, action, MODULE, recordId, oldValue, { ...newValue, center }, meta);
  }
}

/** The site account that stands for this Center user. */
export function centerUser(actor: CenterActor): { id: string; email: string; displayName: string; access: CenterAccessLevel } {
  return {
    id: `${CENTER_USER_PREFIX}${actor.id}`,
    // Not a real mailbox (.invalid never resolves): nothing is ever sent to it, and it can never clash with a site account.
    email: `${actor.id.toLowerCase()}@center.invalid`,
    displayName: `Center · ${actor.email}`.slice(0, 120),
    access: actor.role === "SUPPORT_READONLY" ? "READ_ONLY" : "SUPER_ADMIN",
  };
}

function requireReason(actor: CenterActor): string {
  const reason = actor.reason?.trim() ?? "";
  if (reason.length < 3) throw new ValidationError({ reason: "CENTER_REASON_REQUIRED" }, "Center writes must say why");
  return reason;
}

function requireRole(actor: CenterActor, roles: readonly CenterRole[]): void {
  if (!roles.includes(actor.role)) throw new ForbiddenError("This Center role cannot do that", "CENTER_ROLE_REQUIRED");
}
