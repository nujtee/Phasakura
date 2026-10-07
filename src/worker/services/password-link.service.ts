import { getLocale, parseLocale, DEFAULT_LOCALE_CODE } from "../../shared/i18n/locales.ts";
import type { D1PreparedStatementLike } from "../env.ts";
import type { PasswordResetRepository } from "../repositories/password-reset.repository.ts";
import { newId, randomToken, sha256Hex } from "../security/tokens.ts";
import { addMs, iso, type Clock, type RequestMeta } from "./auth-context.ts";

const MINUTE = 60 * 1000;
export const LINK_TTL_MS = {
  SELF_RESET: 30 * MINUTE,        // user clicked "forgot password"
  ADMIN_RESET: 24 * 60 * MINUTE,  // admin issued a reset link
  INVITE: 72 * 60 * MINUTE,       // new account: set first password
} as const;
export type LinkPurpose = keyof typeof LINK_TTL_MS;

export interface IssuedLink {
  url: string;
  expiresAt: string;
  statements: D1PreparedStatementLike[];
}

/**
 * One-time password (re)set links. Only the SHA-256 of the token is stored.
 * The token travels in the URL fragment (#token=…) so it is never sent to the
 * server in request lines, logs or Referer headers.
 */
export class PasswordLinkService {
  constructor(
    private readonly repo: PasswordResetRepository,
    private readonly baseUrl: string,
    private readonly clock: Clock,
  ) {}

  async issue(userId: string, purpose: LinkPurpose, language: string | null, meta: RequestMeta): Promise<IssuedLink> {
    const now = this.clock();
    const token = randomToken();
    const expiresAt = iso(addMs(now, LINK_TTL_MS[purpose]));
    const locale = getLocale(parseLocale(language)?.code ?? DEFAULT_LOCALE_CODE);
    const fragment = purpose === "INVITE" ? `token=${token}&invite=1` : `token=${token}`;
    return {
      url: `${this.baseUrl}/${locale.path}/admin/reset-password#${fragment}`,
      expiresAt,
      statements: [
        this.repo.invalidateAllStatement(userId, iso(now)),
        this.repo.insertStatement({ id: newId(), userId, tokenHash: await sha256Hex(token), expiresAt, ip: meta.ip, now: iso(now) }),
      ],
    };
  }
}

/** How a self-service reset link reaches the user. */
export interface PasswordResetDelivery {
  /** @returns true if the link was handed to a delivery channel. */
  deliver(input: { email: string; displayName: string; url: string; language: string | null }): Promise<boolean>;
}

/**
 * Development: prints the link to the local console so the flow can be tested.
 * Production: no delivery channel is configured yet (the spec has no email provider).
 * Admins can always issue a reset link from User Management instead.
 */
export class ConsoleOrNoopDelivery implements PasswordResetDelivery {
  constructor(private readonly isDevelopment: boolean) {}

  async deliver(input: { email: string; url: string }): Promise<boolean> {
    if (!this.isDevelopment) return false;
    console.warn(`[DEV ONLY] Password reset link for ${input.email}: ${input.url}`);
    return true;
  }
}
