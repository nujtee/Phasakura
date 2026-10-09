import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { EmailLogDto, EmailRecipientDto, EmailSettingsDto } from "../../src/shared/email-types.ts";
import { emailReason } from "../../src/client/admin/settings/EmailPage.tsx";
import { getNotifyMessages } from "../../src/shared/i18n/admin-notify-messages.ts";
import { createEmailSender, zohoConfigured } from "../../src/worker/email/provider.ts";
import type { OutgoingEmail } from "../../src/worker/email/sender.ts";
import { resetZohoCache, ZohoMailClient, zohoRegion } from "../../src/worker/email/zoho.ts";
import { jsonResponse } from "../helpers/fake-http.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10T03:00Z. Fake Zoho mailbox: booking@phasakura.test (+ alias info@phasakura.test).
let seq = 0;
const PHONE = "0812345678";

async function root(h: Harness) {
  return h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
}

async function book(h: Harness, opts: { unitId?: string; name?: string } = {}) {
  const body = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, stay: { kind: "UNIT", unitId: opts.unitId ?? "dev_house_01" }, food: [], lang: "th" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer: { name: opts.name ?? "Guest Payer", phone: PHONE, email: "guest@example.test" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `zoho-key-${String(++seq).padStart(8, "0")}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

/** Zoho on, e-mail on with `from` as sender, one staff address. */
async function setup(opts: { from?: string; guests?: boolean } = {}) {
  const h = new Harness({ seed: true });
  h.zohoSecrets();
  const owner = await root(h);
  const s = await h.api<EmailSettingsDto>("PUT", "/api/admin/email/settings", {
    token: owner, body: { enabled: true, guestEnabled: opts.guests ?? true, fromEmail: opts.from ?? "booking@phasakura.test" },
  });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const r = await h.api<EmailRecipientDto>("POST", "/api/admin/email/recipients", { token: owner, body: { email: "owner@phasakura.test", name: "Owner", language: "th" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const test = () => h.api<EmailLogDto>("POST", `/api/admin/email/recipients/${r.data.id}/test`, { token: owner, body: {} });
  return { h, owner, settings: s.data, recipientId: r.data.id, test };
}

const row = (h: Harness) => ({ ...h.db.get<{ status: string; attempts: number; last_error: string | null; next_attempt_at: string | null }>(
  "SELECT status, attempts, last_error, next_attempt_at FROM email_logs ORDER BY created_at LIMIT 1")! });

describe("e-mail through Zoho Mail", () => {
  it("booking e-mails go out from the shop's Zoho mailbox: one token and one mailbox lookup for many messages", async () => {
    const { h, settings } = await setup();
    assert.equal(settings.provider, "ZOHO");
    assert.equal(settings.providerConfigured, true);
    assert.equal(/zoho-test-secret|zoho-test-refresh|ZOHOTESTCLIENT/.test(JSON.stringify(settings)), false, "secrets never returned");

    const b = await book(h, { name: "<b>Somchai</b>" });
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));

    const sent = h.zoho.sent;
    assert.deepEqual(sent.map((m) => m.toAddress).sort(), ["guest@example.test", "owner@phasakura.test"]);
    for (const m of sent) {
      assert.equal(m.fromAddress, "booking@phasakura.test");
      assert.equal(m.mailFormat, "html");
      assert.equal(m.encoding, "UTF-8");
    }
    const staffMail = sent.find((m) => m.toAddress === "owner@phasakura.test")!;
    assert.match(String(staffMail.subject), new RegExp(b.bookingCode));
    assert.doesNotMatch(String(staffMail.content), /<b>Somchai/, "names are escaped in HTML");
    assert.match(String(sent.find((m) => m.toAddress === "guest@example.test")!.subject), /ได้รับการจอง .* กรุณาชำระเงิน/);

    // OAuth: a form POST to the US accounts server — the secrets are in the body, never in a URL.
    assert.equal(h.zoho.tokenRequests.length, 1);
    const token = h.zoho.tokenRequests[0]!;
    assert.equal(token.url, "https://accounts.zoho.com/oauth/v2/token");
    assert.equal(new URLSearchParams(token.body).get("refresh_token"), "1000.zoho-test-refresh");
    assert.ok(h.zoho.requests.every((r) => !/zoho-test-secret|zoho-test-refresh/.test(r.url)));
    const mailCalls = h.zoho.requests.filter((r) => r.url.startsWith("https://mail.zoho.com/"));
    assert.ok(mailCalls.every((r) => /^Zoho-oauthtoken 1000\.fakeaccess\d+$/.test(r.headers.get("Authorization") ?? "")));
    assert.equal(mailCalls.filter((r) => r.method === "GET").length, 1, "mailbox id looked up once");
    assert.ok(mailCalls.filter((r) => r.method === "POST").every((r) => r.url === "https://mail.zoho.com/api/accounts/2560636000000008002/messages"));

    const logs = h.db.all<{ status: string; provider_message_id: string | null; recipient: string }>("SELECT status, provider_message_id, recipient FROM email_logs");
    assert.ok(logs.every((l) => l.status === "SENT" && /^\d+$/.test(l.provider_message_id ?? "")), JSON.stringify(logs));
    assert.equal(logs.filter((l) => l.recipient.includes("@")).length, 0, "addresses are not stored in the log");
  });

  it("Zoho Mail is used when both Zoho and Resend secrets are set", async () => {
    const { h, test } = await setup();
    h.emailKey();
    const s = await h.api<EmailSettingsDto>("GET", "/api/admin/email/settings", { token: await root(h) });
    assert.equal(s.data.provider, "ZOHO");
    assert.equal((await test()).data.status, "SENT");
    assert.equal(h.resend.requests.length, 0);
    assert.equal(h.zoho.sent.length, 1);
  });

  it("the sender may be an alias of the mailbox; any other address fails at once with a clear reason", async () => {
    const { h, owner, test } = await setup({ from: "Info@Phasakura.test" });
    assert.equal((await test()).data.status, "SENT");
    assert.equal(h.zoho.sent[0]!.fromAddress, "info@phasakura.test");

    await h.api("PUT", "/api/admin/email/settings", { token: owner, body: { enabled: true, guestEnabled: true, fromEmail: "someone@elsewhere.test" } });
    const failed = await test();
    assert.equal(failed.data.status, "FAILED");
    assert.equal(failed.data.lastError, "ZOHO_SENDER_NOT_IN_MAILBOX");
    assert.equal(h.zoho.sent.length, 1, "nothing was sent from a foreign address");
  });

  it("an access token Zoho no longer accepts is renewed once and the message still goes", async () => {
    const { h, test } = await setup();
    assert.equal((await test()).data.status, "SENT");
    h.zoho.expireTokens();
    assert.equal((await test()).data.status, "SENT");
    assert.equal(h.zoho.tokenRequests.length, 2);
    assert.equal(h.zoho.sent.length, 2);
  });

  it("wrong secrets fail without retrying; Zoho's token rate limit is retried after 10 minutes", async () => {
    const { h, test } = await setup({ guests: false });
    h.zoho.tokenMode = "INVALID_CLIENT";
    const failed = await test();
    assert.equal(failed.data.status, "FAILED");
    assert.equal(failed.data.lastError, "ZOHO_AUTH_INVALID_CLIENT");

    h.db.run("DELETE FROM email_logs");
    h.zoho.tokenMode = "RATE_LIMITED";
    await book(h);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));
    const r = row(h);
    assert.equal(r.status, "PENDING");
    assert.equal(r.last_error, "ZOHO_TOKEN_RATE_LIMITED");
    assert.ok(Date.parse(r.next_attempt_at!) - Date.parse("2027-01-10T03:00:00Z") >= 600_000, r.next_attempt_at!);

    h.zoho.tokenMode = "OK";
    h.advance(11 * 60_000);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:12:00Z"));
    assert.equal(row(h).status, "SENT");
  });

  it("Zoho's sending limit waits an hour; a dropped connection is retried; other refusals fail", async () => {
    const { h } = await setup({ guests: false });
    h.zoho.messageError = { status: 400, errorCode: "MAIL_SENDING_LIMIT_EXCEEDED" };
    await book(h);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));
    let r = row(h);
    assert.equal(r.status, "PENDING");
    assert.equal(r.last_error, "ZOHO_400_MAIL_SENDING_LIMIT_EXCEEDED");
    assert.ok(Date.parse(r.next_attempt_at!) - Date.parse("2027-01-10T03:00:00Z") >= 3_600_000, r.next_attempt_at!);

    h.zoho.messageError = null;
    h.zoho.next.push("network"); // the token is cached, so this is the mailbox lookup / message call
    h.advance(61 * 60_000);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T04:02:00Z"));
    r = row(h);
    assert.equal(r.status, "PENDING");
    assert.equal(r.last_error, "ZOHO_UNREACHABLE");

    h.zoho.messageError = { status: 400, errorCode: "EXTRA_KEY_FOUND_IN_JSON" };
    h.advance(30 * 60_000);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T04:32:00Z"));
    r = row(h);
    assert.equal(r.status, "FAILED");
    assert.equal(r.last_error, "ZOHO_400_EXTRA_KEY_FOUND_IN_JSON");
  });
});

describe("Zoho configuration", () => {
  const env = { ZOHO_CLIENT_ID: "1000.ID", ZOHO_CLIENT_SECRET: "secret", ZOHO_REFRESH_TOKEN: "1000.refresh" };
  const mail: OutgoingEmail = { fromEmail: "booking@phasakura.test", fromName: null, to: "a@b.test", subject: "s", html: "<p>x</p>", text: "x", replyTo: null, idempotencyKey: "k" };

  it("regions: the domain of the Zoho login; unknown values are refused", () => {
    assert.equal(zohoRegion(undefined), "com");
    assert.equal(zohoRegion(" US "), "com");
    assert.equal(zohoRegion(".eu"), "eu");
    assert.equal(zohoRegion("au"), "com.au");
    assert.equal(zohoRegion("ca"), "ca");
    assert.equal(zohoRegion("zoho.com"), null);
    assert.equal(zohoRegion("toString"), null);
  });

  it("the EU data centre is used end to end", async () => {
    resetZohoCache();
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      if (url.endsWith("/oauth/v2/token")) return jsonResponse({ access_token: "1000.eu", expires_in: 3600 });
      if (url.endsWith("/api/accounts")) return jsonResponse({ status: { code: 200 }, data: [{ accountId: "77", primaryEmailAddress: "booking@phasakura.test" }] });
      return jsonResponse({ status: { code: 200 }, data: { messageId: 42 } });
    };
    const result = await new ZohoMailClient("1000.ID", "secret", "1000.refresh", "eu", fetchImpl).send(mail);
    assert.deepEqual(result, { ok: true, id: "42" });
    assert.deepEqual(urls, ["https://accounts.zoho.eu/oauth/v2/token", "https://mail.zoho.eu/api/accounts", "https://mail.zoho.eu/api/accounts/77/messages"]);
  });

  it("which provider: all three Zoho secrets, else Resend, else none; a bad region never sends the secrets", async () => {
    assert.equal(createEmailSender(env)?.provider, "ZOHO");
    assert.equal(createEmailSender({ ...env, ZOHO_REFRESH_TOKEN: " ", RESEND_API_KEY: "re_x" })?.provider, "RESEND");
    assert.equal(zohoConfigured({ ...env, ZOHO_CLIENT_SECRET: undefined }), false);
    assert.equal(createEmailSender({ ZOHO_CLIENT_ID: "1000.ID" }), null);
    let calls = 0;
    const sender = createEmailSender({ ...env, ZOHO_REGION: "mars" }, async () => { calls++; return jsonResponse({}); })!;
    assert.deepEqual(await sender.send(mail), { ok: false, retryable: false, error: "ZOHO_REGION_INVALID", retryAfterSeconds: null });
    assert.equal(calls, 0);
  });

  it("the admin page explains Zoho errors in words and keeps the code", () => {
    const reasons = getNotifyMessages("th").email.reasons as Record<string, string>;
    assert.equal(emailReason(reasons, "ZOHO_SENDER_NOT_IN_MAILBOX"), reasons.ZOHO_SENDER_NOT_IN_MAILBOX);
    assert.match(emailReason(reasons, "ZOHO_AUTH_INVALID_CLIENT")!, /Client ID .*\(ZOHO_AUTH_INVALID_CLIENT\)$/);
    assert.match(emailReason(reasons, "ZOHO_401_INVALID_OAUTHSCOPE")!, /ZohoMail\.messages\.CREATE.*\(ZOHO_401_INVALID_OAUTHSCOPE\)$/);
    assert.match(emailReason(reasons, "ZOHO_400_MAIL_SENDING_LIMIT_EXCEEDED")!, /ขีดจำกัด/);
    assert.equal(emailReason(reasons, "SOMETHING_ELSE"), "SOMETHING_ELSE");
    assert.equal(emailReason(reasons, null), null);
  });
});
