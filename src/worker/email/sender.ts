/**
 * What the e-mail dispatcher needs from a provider (Zoho Mail or Resend): send one message and say whether a
 * failure is worth retrying. Provider credentials are Cloudflare Secrets; nothing here is logged.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type EmailProvider = "ZOHO" | "RESEND";

export interface OutgoingEmail {
  fromEmail: string;
  fromName: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo: string | null;
  /** Unique per message (≤ 256 chars) — providers that support it deliver a retried send once. */
  idempotencyKey: string;
}

export type SendResult =
  | { ok: true; id: string | null }
  | { ok: false; retryable: boolean; error: string; retryAfterSeconds: number | null };

export interface EmailSender {
  readonly provider: EmailProvider;
  send(mail: OutgoingEmail): Promise<SendResult>;
}

/** Display form "Name <address>"; quotes and angle brackets removed from the name. */
export function formatFrom(name: string | null, email: string): string {
  const clean = (name ?? "").replace(/["<>\r\n]/g, "").trim();
  return clean ? `${clean} <${email}>` : email;
}
