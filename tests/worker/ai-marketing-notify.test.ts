import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiMarketingSettingsDto } from "../../src/shared/ai-marketing-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { Harness } from "../helpers/harness.ts";

// "Marketing report ready" notices (AI Marketing A4): e-mail / own LINE, only for reports the cron wrote, only to
// users who may read reports. Harness clock: 2027-01-10T03:00Z = Sunday 10:00 in Bangkok.

async function setup() {
  const h = new Harness({ seed: true });
  h.env.APP_BASE_URL = "https://phasakura.test";
  const root = await h.login(await h.user({ id: "root_notify", roles: ["SUPER_ADMIN"] }));
  const readerEmail = await h.user({ id: "reader_notify" });
  h.grant("reader_notify", "reports.view");
  await h.user({ id: "frontdesk_notify" });
  h.grant("frontdesk_notify", "dashboard.view");
  h.emailKey();
  await h.api("PUT", "/api/admin/email/settings", { token: root, body: { enabled: true, guestEnabled: false, fromEmail: "booking@phasakura.test" } });
  h.lineSecrets();
  await h.api("PUT", "/api/admin/line/settings", { token: root, body: { enabled: true, guestEnabled: false, publicButton: false, reminderDaysBefore: 1, reminderTime: "18:00", sendWhenEmpty: false } });
  h.db.run("INSERT INTO user_line_links (user_id, line_user_id, linked_at) VALUES ('reader_notify', ?, '2027-01-01T00:00:00Z')", `U${"a".repeat(32)}`);
  h.db.run("INSERT INTO user_line_links (user_id, line_user_id, linked_at) VALUES ('frontdesk_notify', ?, '2027-01-01T00:00:00Z')", `U${"b".repeat(32)}`);
  const settings = (body: Record<string, unknown>) => h.api<AiMarketingSettingsDto>("PUT", "/api/admin/ai-marketing/settings", { token: root, body });
  return { h, root, readerEmail, settings };
}

const rows = (h: Harness, table: "email_logs" | "notification_logs") => h.db.all<{ recipient: string; idempotency_key: string }>(
  `SELECT recipient, idempotency_key FROM ${table} WHERE notification_type = 'MARKETING_REPORT' ORDER BY idempotency_key`);

describe("marketing report ready notices", () => {
  it("cron reports: e-mail to everyone who may read reports, LINE to those of them who linked it; once; sent with totals + link", async () => {
    const { h, root, readerEmail, settings } = await setup();
    const stay = { checkIn: "2027-01-10", checkOut: "2027-01-12", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th" };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: stay });
    const b = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...stay, customer: { name: "Wanida Privatename", phone: "0877776666", email: "wanida@example.test" }, privacyAccepted: true,
        expectedTotalSatang: q.data.totalSatang, idempotencyKey: "notify-key-00000001" },
    });
    assert.equal(b.status, 201);
    assert.equal((await settings({ enabled: true, notifyEmail: true, notifyLine: true })).status, 200);

    h.advance(24 * 3600_000); // Monday 10:00
    await h.app.scheduled(h.env, h.now.getTime() + 2 * 60_000); // the report minute (… :02, :07, …)
    const reports = h.db.all<{ id: string; period_kind: string }>("SELECT id, period_kind FROM marketing_reports ORDER BY period_kind");
    assert.equal(reports.length, 2);
    const mails = rows(h, "email_logs");
    assert.deepEqual(mails.map((r) => r.recipient).sort(), ["user:reader_notify", "user:reader_notify", "user:root_notify", "user:root_notify"],
      "front desk (no reports.view) gets nothing");
    assert.deepEqual(rows(h, "notification_logs").map((r) => r.recipient), ["user:reader_notify", "user:reader_notify"], "LINE only where linked");

    await h.app.scheduled(h.env, h.now.getTime() + 60_000);
    assert.equal(rows(h, "email_logs").length, 4, "no second notice");
    const mail = h.resend.requests.find((x) => (x.json!.to as string[])[0] === readerEmail && /รายงานการตลาดรายสัปดาห์/.test(String(x.json!.subject)));
    assert.ok(mail, `reader e-mailed: ${h.resend.requests.map((x) => x.json!.subject).join(" | ")}`);
    const weekly = reports.find((r) => r.period_kind === "WEEKLY")!;
    const all = JSON.stringify(h.resend.requests.map((x) => x.json)) + JSON.stringify(h.line.pushes);
    assert.match(String(mail.json!.text), /การจอง: 1 \(ช่วงก่อน 0\)/);
    assert.ok(all.includes(`https://phasakura.test/th/admin/ai-marketing/${weekly.id}`), "link to the report");
    for (const pii of ["Wanida", "Privatename", "0877776666", "wanida@example.test", b.data.bookingCode]) assert.ok(!all.includes(pii), `notice holds ${pii}`);
    assert.equal(h.line.pushes.filter((p) => p.to === `U${"a".repeat(32)}`).length, 2);
    assert.equal(h.line.pushes.filter((p) => p.to === `U${"b".repeat(32)}`).length, 0);
    void root;
  });

  it("nothing for reports staff asked for, or when notices are off", async () => {
    const { h, root, settings } = await setup();
    await settings({ notifyEmail: true, notifyLine: true });
    const made = await h.api("POST", "/api/admin/ai-marketing/reports", { token: root, body: { kind: "WEEKLY" } });
    assert.equal(made.status, 201);
    assert.equal(rows(h, "email_logs").length, 0, "asked for: the asker is looking at it");

    await settings({ enabled: true, notifyEmail: false, notifyLine: false });
    h.advance(24 * 3600_000);
    await h.app.scheduled(h.env, h.now.getTime() + 2 * 60_000);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM marketing_reports WHERE trigger = 'CRON'")!.n, 2, "written by the cron");
    assert.equal(rows(h, "email_logs").length + rows(h, "notification_logs").length, 0);
  });
});
