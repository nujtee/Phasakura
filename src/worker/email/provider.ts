import { ResendClient } from "./resend.ts";
import type { EmailSender, FetchLike } from "./sender.ts";
import { ZohoMailClient, zohoRegion } from "./zoho.ts";

export interface EmailProviderEnv {
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_REFRESH_TOKEN?: string;
  ZOHO_REGION?: string;
  RESEND_API_KEY?: string;
}

/** All three Zoho secrets present? (A partial set is treated as not configured.) */
export function zohoConfigured(env: EmailProviderEnv): boolean {
  return !!(env.ZOHO_CLIENT_ID?.trim() && env.ZOHO_CLIENT_SECRET?.trim() && env.ZOHO_REFRESH_TOKEN?.trim());
}

/**
 * The e-mail provider from Cloudflare Secrets: Zoho Mail when its three secrets are set, otherwise Resend when
 * RESEND_API_KEY is set, otherwise none (e-mail notifications cannot be switched on).
 */
export function createEmailSender(env: EmailProviderEnv, fetchImpl?: FetchLike): EmailSender | null {
  if (zohoConfigured(env)) {
    const region = zohoRegion(env.ZOHO_REGION);
    if (!region) {
      // A typo in ZOHO_REGION must not send the secrets to a guessed server: every send fails, visibly, in the log.
      return { provider: "ZOHO", send: async () => ({ ok: false, retryable: false, error: "ZOHO_REGION_INVALID", retryAfterSeconds: null }) };
    }
    return new ZohoMailClient(env.ZOHO_CLIENT_ID!.trim(), env.ZOHO_CLIENT_SECRET!.trim(), env.ZOHO_REFRESH_TOKEN!.trim(), region, fetchImpl);
  }
  const key = env.RESEND_API_KEY?.trim();
  return key ? new ResendClient(key, fetchImpl) : null;
}
