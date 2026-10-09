/**
 * Resend (https://resend.com) — transactional e-mail over HTTPS. POST /emails with a Bearer API key
 * (Cloudflare Secret RESEND_API_KEY). The Idempotency-Key header makes a retried send deliver once.
 * The sender address must be on a domain verified in Resend.
 */

import { formatFrom, type EmailSender, type FetchLike, type OutgoingEmail, type SendResult } from "./sender.ts";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export class ResendClient implements EmailSender {
  readonly provider = "RESEND" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 10_000,
  ) {}

  async send(mail: OutgoingEmail): Promise<SendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": mail.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({
          from: formatFrom(mail.fromName, mail.fromEmail),
          to: [mail.to],
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
        }),
        signal: controller.signal,
      });
    } catch {
      return { ok: false, retryable: true, error: controller.signal.aborted ? "EMAIL_TIMEOUT" : "EMAIL_UNREACHABLE", retryAfterSeconds: null };
    } finally {
      clearTimeout(timer);
    }
    type Answer = { id?: unknown; name?: unknown };
    const body: Answer | null = await res.json().then((x) => (x && typeof x === "object" ? (x as Answer) : null), () => null);
    if (res.ok) return { ok: true, id: typeof body?.id === "string" ? body.id.slice(0, 100) : null };
    // The provider's error name only (e.g. validation_error) — its message can echo addresses.
    const name = typeof body?.name === "string" ? body.name.replace(/[^a-z_]/gi, "").slice(0, 60) : "";
    const error = `RESEND_${res.status}${name ? `_${name.toUpperCase()}` : ""}`;
    const retryAfter = Number(res.headers.get("Retry-After"));
    // 409 concurrent_idempotent_requests: the same message is being sent right now — try again later.
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408 || (res.status === 409 && name === "concurrent_idempotent_requests");
    return { ok: false, retryable, error, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
  }
}
