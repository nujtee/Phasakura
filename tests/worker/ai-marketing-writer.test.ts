import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiMarketingSettingsDto, MarketingReportDto } from "../../src/shared/ai-marketing-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { parseSummary } from "../../src/worker/ai-marketing/ai-writer.ts";
import { costSatang, scrubError } from "../../src/worker/ai-marketing/llm-client.ts";
import { AI_SUMMARY, jsonResponse } from "../helpers/fake-http.ts";
import { Harness } from "../helpers/harness.ts";

// AI summary of the marketing report (AI Marketing A3): numbers only to the AI, key never shown, monthly budget.
// Harness clock: 2027-01-10T03:00Z = Sunday 10:00 in Bangkok.

const KEY = "sk-ant-test-0123456789abcdefghijklmnopqrstuvwxyz";

describe("AI answer and cost (pure)", () => {
  it("reads the JSON answer (even wrapped in text), cuts it to size, refuses anything else", () => {
    assert.deepEqual(parseSummary(`Here you go:\n${JSON.stringify(AI_SUMMARY)}\nThanks`), AI_SUMMARY);
    const long = parseSummary(JSON.stringify({
      headline: "x".repeat(500), summary: "ok", recommendations: [...Array(9)].map((_, i) => ({ title: `t${i}`, detail: "d" })).concat([{ title: "", detail: "" }] as never),
    }))!;
    assert.equal(long.headline.length, 200);
    assert.equal(long.recommendations.length, 5);
    assert.equal(long.recommendations[0]!.basedOn, "");
    for (const bad of ["no json", "{not json}", JSON.stringify({ headline: "only" }), JSON.stringify([1, 2])]) assert.equal(parseSummary(bad), null, bad);
  });

  it("estimates the cost on the high side; error texts never carry a key", () => {
    assert.equal(costSatang(4000, 800), Math.ceil(((4000 * 3 + 800 * 15) / 1e6) * 37 * 100));
    assert.equal(costSatang(0, 0), 0);
    assert.doesNotMatch(scrubError(`invalid x-api-key ${KEY}`), /sk-ant|abcdefghij/);
  });
});

let keySeq = 0;
async function book(h: Harness, checkIn: string, checkOut: string) {
  const stay = { checkIn, checkOut, adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: stay });
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: {
      ...stay, customer: { name: "Somsri Hiddenname", phone: "0861234567", email: "somsri@example.test", note: "allergic to peanuts" },
      privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `aiw-key-${String(++keySeq).padStart(8, "0")}`,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function setup() {
  const h = new Harness({ seed: true });
  const root = await h.login(await h.user({ id: `root_aiw_${++keySeq}`, roles: ["SUPER_ADMIN"] }));
  const settings = (body: Record<string, unknown>) => h.api<AiMarketingSettingsDto>("PUT", "/api/admin/ai-marketing/settings", { token: root, body });
  const write = (body: Record<string, unknown> = { kind: "WEEKLY", periodStart: "2026-12-28" }) =>
    h.api<MarketingReportDto>("POST", "/api/admin/ai-marketing/reports", { token: root, body });
  return { h, root, settings, write };
}

describe("AI summary in the report", () => {
  it("cannot be switched on without the secret; with it, the report carries the summary and the cost is counted", async () => {
    const { h, root, settings, write } = await setup();
    const off = await settings({ aiEnabled: true });
    assert.equal(off.status, 422);
    assert.equal(off.body.error?.details?.aiEnabled, "AI_KEY_MISSING");

    h.env.AI_API_KEY = KEY;
    const on = await settings({ aiEnabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual([on.data.aiEnabled, on.data.aiKeyConfigured, on.data.model, on.data.monthSpentSatang], [true, true, "claude-sonnet-5-5", 0]);
    assert.doesNotMatch(JSON.stringify(on.body), /sk-ant/);

    const b = await book(h, "2027-01-11", "2027-01-13");
    const r = await write();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.status, "READY");
    assert.deepEqual(r.data.aiSummary, AI_SUMMARY);
    assert.equal(r.data.aiModel, "claude-sonnet-5-5");

    // The call: right endpoint and headers, the key only in its header, numbers only in the body.
    const call = h.ai.requests[0]!;
    assert.equal(call.url, "https://api.anthropic.com/v1/messages");
    assert.equal(call.headers.get("x-api-key"), KEY);
    assert.equal(call.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(call.json!.model, "claude-sonnet-5-5");
    for (const secret of [KEY, "Somsri", "Hiddenname", "0861234567", "861234567", "somsri@example.test", "peanuts", b.bookingCode]) {
      assert.ok(!call.body.includes(secret), `sent to the AI: ${secret}`);
    }
    assert.match(call.body, /next30Days/);

    const usage = h.db.all<{ status: string; cost_satang: number; input_tokens: number }>("SELECT status, cost_satang, input_tokens FROM ai_usage");
    assert.deepEqual(usage.map((u) => ({ ...u })), [{ status: "OK", cost_satang: costSatang(4000, 800), input_tokens: 4000 }]);
    const s = (await h.api<AiMarketingSettingsDto>("GET", "/api/admin/ai-marketing/settings", { token: root })).data;
    assert.deepEqual([s.monthSpentSatang, s.monthAiCalls], [costSatang(4000, 800), 1]);
    assert.doesNotMatch(JSON.stringify(h.db.all("SELECT * FROM ai_usage")) + JSON.stringify(h.db.all("SELECT * FROM marketing_reports")), /sk-ant/);
  });

  it("budget reached → no call, report without AI and the reason; AI switched off → no call at all", async () => {
    const { h, settings, write } = await setup();
    h.env.AI_API_KEY = KEY;
    await settings({ aiEnabled: true, monthlyBudgetSatang: 50 }); // ฿0.50: the first call (≈ ฿0.89) uses it up
    assert.equal((await write()).data.status, "READY");
    const second = await write({ kind: "MONTHLY" });
    assert.equal(second.data.status, "READY_NO_AI");
    assert.equal(second.data.aiError, "BUDGET_REACHED");
    assert.equal(h.ai.requests.length, 1);
    assert.deepEqual(h.db.all<{ status: string }>("SELECT status FROM ai_usage ORDER BY created_at, status").map((u) => u.status).sort(), ["OK", "SKIPPED_BUDGET"]);

    await settings({ aiEnabled: false });
    const plain = await write({ kind: "WEEKLY", periodStart: "2026-12-21" });
    assert.equal(plain.data.status, "READY_NO_AI");
    assert.equal(plain.data.aiError, null);
    assert.equal(h.ai.requests.length, 1);
  });

  it("provider errors, garbage answers and dropped connections leave the numbers, with the reason; key never echoed", async () => {
    const { h, settings, write } = await setup();
    h.env.AI_API_KEY = KEY;
    await settings({ aiEnabled: true });
    h.ai.next.push(jsonResponse({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }, 401));
    const denied = await write();
    assert.equal(denied.status, 201);
    assert.equal(denied.data.status, "READY_NO_AI");
    assert.match(denied.data.aiError!, /^HTTP 401 invalid x-api-key/);
    assert.doesNotMatch(denied.data.aiError!, /sk-ant/);
    assert.ok(denied.data.metrics.current, "numbers still there");

    h.ai.respond = () => jsonResponse({ content: [{ type: "text", text: "Sorry, I cannot help." }], usage: { input_tokens: 10, output_tokens: 5 } });
    assert.equal((await write({ kind: "MONTHLY" })).data.aiError, "UNREADABLE_ANSWER");
    h.ai.next.push("network");
    assert.match((await write({ kind: "WEEKLY", periodStart: "2026-12-21" })).data.aiError!, /^NETWORK/);
    assert.deepEqual(h.db.all<{ status: string }>("SELECT status FROM ai_usage").map((u) => u.status), ["FAILED", "FAILED", "FAILED"]);
  });

  it("the cron's reports get the summary too", async () => {
    const { h, root, settings } = await setup();
    h.env.AI_API_KEY = KEY;
    await settings({ enabled: true, aiEnabled: true });
    h.advance(24 * 3600_000); // Monday 10:00
    await h.app.scheduled(h.env);
    const rows = h.db.all<{ status: string }>("SELECT status FROM marketing_reports");
    assert.deepEqual(rows.map((r) => r.status), ["READY", "READY"]);
    assert.equal(h.ai.requests.length, 2);
    void root;
  });
});
