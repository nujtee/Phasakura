import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiMarketingSettingsDto, MarketingMetrics, MarketingReportDto, MarketingReportListItemDto } from "../../src/shared/ai-marketing-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { forward, lastPeriod, periodStarting, previousPeriod } from "../../src/worker/ai-marketing/metrics.ts";
import { insights } from "../../src/worker/ai-marketing/insights.ts";
import { Harness } from "../helpers/harness.ts";

// AI marketing report (migration 0053, PR A2): numbers + fixed-rule findings, weekly / monthly, no guest data.
// Harness clock: 2027-01-10T03:00Z = Sunday 10:00 in Bangkok.

describe("report periods and forward view (pure)", () => {
  it("last complete week (Mon–Sun) and month; the period before; only Mondays / 1sts start one", () => {
    assert.deepEqual(lastPeriod("WEEKLY", "2027-01-11"), { start: "2027-01-04", end: "2027-01-10" });
    assert.deepEqual(lastPeriod("WEEKLY", "2027-01-10"), { start: "2026-12-28", end: "2027-01-03" });
    assert.deepEqual(lastPeriod("MONTHLY", "2027-03-01"), { start: "2027-02-01", end: "2027-02-28" });
    assert.deepEqual(lastPeriod("MONTHLY", "2027-01-15"), { start: "2026-12-01", end: "2026-12-31" });
    assert.deepEqual(previousPeriod("WEEKLY", "2027-01-04"), { start: "2026-12-28", end: "2027-01-03" });
    assert.deepEqual(previousPeriod("MONTHLY", "2027-03-01"), { start: "2027-02-01", end: "2027-02-28" });
    assert.deepEqual(periodStarting("WEEKLY", "2027-01-04"), { start: "2027-01-04", end: "2027-01-10" });
    assert.equal(periodStarting("WEEKLY", "2027-01-05"), null);
    assert.deepEqual(periodStarting("MONTHLY", "2028-02-01"), { start: "2028-02-01", end: "2028-02-29" });
    assert.equal(periodStarting("MONTHLY", "2027-02-02"), null);
  });

  it("finds days with nothing booked and quiet runs of 3+ nights", () => {
    // 4 units; 01-01 two sold; 01-02..01-05 nothing; 01-06 four sold (full); 01-07.. nothing.
    const rows = [
      { stay_date: "2027-01-01", sold: 2, ota: 0, blocked: 0 },
      { stay_date: "2027-01-06", sold: 3, ota: 1, blocked: 0 },
    ];
    const f = forward(rows, 4, "2027-01-01", 8);
    assert.deepEqual(f.emptyDays, ["2027-01-02", "2027-01-03", "2027-01-04", "2027-01-05", "2027-01-07", "2027-01-08"]);
    assert.deepEqual(f.quietRuns, [{ from: "2027-01-01", to: "2027-01-05", nights: 5, freeUnits: 2 }]);
    assert.equal(f.occupancyPercent, 18.8, "6 of 32 unit-nights");
    assert.deepEqual(forward([], 0, "2027-01-01", 5).emptyDays, [], "no units, nothing to say");
  });
});

let keySeq = 0;
async function book(h: Harness, checkIn: string, checkOut: string, unitId = "dev_house_01", attribution?: unknown) {
  const stay = { checkIn, checkOut, adults: 2, children: 0, stay: { kind: "UNIT", unitId }, food: [], lang: "th" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: stay });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: {
      ...stay, customer: { name: "Malee Secretname", phone: "0899998888", email: "malee@example.test" }, privacyAccepted: true,
      expectedTotalSatang: q.data.totalSatang, idempotencyKey: `aim-key-${String(++keySeq).padStart(8, "0")}`, ...(attribution ? { attribution } : {}),
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function pay(h: Harness, token: string, b: PublicBookingDto) {
  const res = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, {
    token, body: { amountSatang: b.totalSatang, method: "CASH", paidAt: "2027-01-10T02:00:00Z" },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function staff(h: Harness, id: string, perms: string[]) {
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

describe("marketing report API + cron", () => {
  it("off by default; switched on, the cron writes last week's and last month's report once, from 07:00", async () => {
    const h = new Harness({ seed: true });
    const rootEmail = await h.user({ id: "root_aim", roles: ["SUPER_ADMIN"] });
    let root = await h.login(rootEmail);
    const tagged = await book(h, "2027-01-10", "2027-01-12", "dev_house_01", { utmSource: "facebook", utmMedium: "cpc" });
    await pay(h, root, tagged);
    const later = await book(h, "2027-01-20", "2027-01-22");
    await pay(h, root, later);
    const s0 = (await h.api<AiMarketingSettingsDto>("GET", "/api/admin/ai-marketing/settings", { token: root })).data;
    assert.deepEqual({ enabled: s0.enabled, aiEnabled: s0.aiEnabled, aiKeyConfigured: s0.aiKeyConfigured, budget: s0.monthlyBudgetSatang },
      { enabled: false, aiEnabled: false, aiKeyConfigured: false, budget: 30000 });

    h.advance(24 * 3600_000 - 4 * 3600_000); // Monday 06:00 Bangkok
    await h.app.scheduled(h.env);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM marketing_reports")!.n, 0, "off: nothing");
    root = await h.login(rootEmail);

    const on = await h.api<AiMarketingSettingsDto>("PUT", "/api/admin/ai-marketing/settings", { token: root, body: { enabled: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(h.audits("UPDATE_AI_MARKETING_SETTINGS").length, 1);
    await h.app.scheduled(h.env);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM marketing_reports")!.n, 0, "before 07:00");

    h.advance(2 * 3600_000); // Monday 08:00
    await h.app.scheduled(h.env);
    await h.app.scheduled(h.env);
    const rows = h.db.all<{ period_kind: string; period_start: string; trigger: string }>(
      "SELECT period_kind, period_start, trigger FROM marketing_reports ORDER BY period_kind");
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { period_kind: "MONTHLY", period_start: "2026-12-01", trigger: "CRON" },
      { period_kind: "WEEKLY", period_start: "2027-01-04", trigger: "CRON" },
    ]);

    const list = (await h.api<MarketingReportListItemDto[]>("GET", "/api/admin/ai-marketing/reports", { token: root })).data;
    const weekly = list.find((r) => r.kind === "WEEKLY")!;
    assert.equal(weekly.bookings, 2);
    assert.equal(weekly.revenueSatang, tagged.totalSatang + later.totalSatang);

    const r = (await h.api<MarketingReportDto>("GET", `/api/admin/ai-marketing/reports/${weekly.id}`, { token: root })).data;
    const m: MarketingMetrics = r.metrics;
    assert.equal(r.status, "READY_NO_AI");
    assert.deepEqual([m.periodStart, m.periodEnd, m.previousStart, m.previousEnd], ["2027-01-04", "2027-01-10", "2026-12-28", "2027-01-03"]);
    assert.equal(m.current.bookings, 2);
    assert.equal(m.current.confirmed, 2);
    assert.equal(m.current.soldNights, 1, "the night of 01-10 falls in the week");
    assert.equal(m.forward.from, "2027-01-11");
    assert.equal(m.forward.soldNights, 3, "01-11, 01-20, 01-21");
    assert.equal(m.units.find((u) => u.unitId === "dev_house_01")!.soldNights, 1);
    assert.deepEqual(m.sources.map((x) => `${x.source}/${x.medium}:${x.bookings}`).sort(), ["(direct)/(none):1", "facebook/cpc:1"]);
    assert.equal(m.ga4.status, "NOT_CONFIGURED");
    assert.ok(r.insights.some((i) => i.code === "GA4_NOT_CONNECTED"));
    assert.ok(r.insights.some((i) => i.code === "FORWARD_QUIET"), JSON.stringify(r.insights));

    // Numbers only: no guest's name, phone, e-mail or booking code anywhere in the stored report.
    const stored = JSON.stringify(h.db.all("SELECT * FROM marketing_reports"));
    for (const secret of ["Malee", "Secretname", "0899998888", "899998888", "malee@example.test", tagged.bookingCode, later.bookingCode]) {
      assert.ok(!stored.includes(secret), `report holds ${secret}`);
    }
  });

  it("staff ask for a report: validated, audited, rewritten in place, at most 5 a day", async () => {
    const h = new Harness({ seed: true });
    const rootEmail = await h.user({ id: "root_aim2", roles: ["SUPER_ADMIN"] });
    let root = await h.login(rootEmail);
    const post = (body: unknown) => h.api<MarketingReportDto>("POST", "/api/admin/ai-marketing/reports", { token: root, body });

    assert.equal((await post({ kind: "WEEKLY", periodStart: "2027-01-05" })).body.error?.details?.periodStart, "MUST_BE_MONDAY");
    assert.equal((await post({ kind: "MONTHLY", periodStart: "2027-01-02" })).body.error?.details?.periodStart, "MUST_BE_FIRST_OF_MONTH");
    assert.equal((await post({ kind: "WEEKLY", periodStart: "2027-01-04" })).body.error?.details?.periodStart, "PERIOD_NOT_OVER");
    assert.equal((await post({ kind: "DAILY" })).status, 422);
    assert.equal((await post({ kind: "WEEKLY", periodStart: "x" })).status, 422);
    assert.equal((await post({ kind: "WEEKLY", extra: 1 })).status, 422);

    const first = await post({ kind: "WEEKLY" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.data.periodStart, first.data.periodEnd, first.data.trigger], ["2026-12-28", "2027-01-03", "USER"]);
    const again = await post({ kind: "WEEKLY" });
    assert.equal(again.data.id, first.data.id, "same period → same report, rewritten");
    assert.equal(h.audits("GENERATE_MARKETING_REPORT").length, 2);
    assert.equal((await post({ kind: "MONTHLY", periodStart: "2026-11-01" })).status, 201);
    assert.equal((await post({ kind: "MONTHLY" })).status, 201);
    assert.equal((await post({ kind: "WEEKLY", periodStart: "2026-12-21" })).status, 201);
    assert.equal((await post({ kind: "WEEKLY", periodStart: "2026-12-14" })).status, 429, "sixth today");
    h.advance(25 * 3600_000);
    root = await h.login(rootEmail);
    assert.equal((await post({ kind: "WEEKLY", periodStart: "2026-12-14" })).status, 201, "a day later");
  });

  it("permissions: reading needs reports.view; asking / settings need marketing.edit; unknown report → 404", async () => {
    const h = new Harness({ seed: true });
    const reader = await staff(h, "aim_reader", ["reports.view"]);
    const marketer = await staff(h, "aim_marketer", ["marketing.view", "marketing.edit"]);
    const both = await staff(h, "aim_both", ["reports.view", "marketing.view", "marketing.edit"]);

    assert.equal((await h.api("GET", "/api/admin/ai-marketing/reports", { token: reader })).status, 200);
    assert.equal((await h.api("GET", "/api/admin/ai-marketing/reports", { token: marketer })).status, 403);
    assert.equal((await h.api("GET", "/api/admin/ai-marketing/reports")).status, 401);
    assert.equal((await h.api("POST", "/api/admin/ai-marketing/reports", { token: reader, body: { kind: "WEEKLY" } })).status, 403);
    assert.equal((await h.api("POST", "/api/admin/ai-marketing/reports", { token: marketer, body: { kind: "WEEKLY" } })).status, 403, "money needs reports.view");
    assert.equal((await h.api("PUT", "/api/admin/ai-marketing/settings", { token: reader, body: { enabled: true } })).status, 403);
    assert.equal((await h.api("GET", "/api/admin/ai-marketing/settings", { token: marketer })).status, 200);
    assert.equal((await h.api("PUT", "/api/admin/ai-marketing/settings", { token: marketer, body: { monthlyBudgetSatang: -1 } })).status, 422);
    assert.equal((await h.api("PUT", "/api/admin/ai-marketing/settings", { token: marketer, body: { enabled: "yes" } })).status, 422);
    const saved = await h.api<AiMarketingSettingsDto>("PUT", "/api/admin/ai-marketing/settings", { token: marketer, body: { monthlyBudgetSatang: 50000 } });
    assert.equal(saved.data.monthlyBudgetSatang, 50000);
    assert.equal(saved.data.enabled, false, "other fields kept");
    const made = await h.api<MarketingReportDto>("POST", "/api/admin/ai-marketing/reports", { token: both, body: { kind: "WEEKLY" } });
    assert.equal(made.status, 201);
    assert.equal((await h.api("GET", `/api/admin/ai-marketing/reports/${made.data.id}`, { token: reader })).status, 200);
    assert.equal((await h.api("GET", "/api/admin/ai-marketing/reports/nope", { token: reader })).status, 404);
  });

  it("works before migration 0053: settings read as off, cron does nothing", async () => {
    const h = new Harness({ seed: true });
    h.db.exec("DROP TABLE ai_usage; DROP TABLE marketing_reports; DROP TABLE ai_marketing_settings;");
    const root = await h.login(await h.user({ id: "root_aim3", roles: ["SUPER_ADMIN"] }));
    assert.equal((await h.api<AiMarketingSettingsDto>("GET", "/api/admin/ai-marketing/settings", { token: root })).data.enabled, false);
    assert.deepEqual((await h.api("GET", "/api/admin/ai-marketing/reports", { token: root })).data, []);
    await h.app.scheduled(h.env);
  });
});

describe("findings (pure)", () => {
  const base = (): MarketingMetrics => {
    const t = {
      bookings: 10, confirmed: 8, cancelled: 0, expired: 1, revenueSatang: 1_000_000, adrSatang: 300_000, occupancyPercent: 50, soldNights: 20, otaNights: 0,
      openNights: 40, avgLeadDays: 10, avgStayNights: 2, foodAttachPercent: 20, extraBedAttachPercent: 0, massageAttachPercent: 0, visitors: 500,
      pageViews: 1500, conversionPercent: 2,
    };
    return {
      kind: "WEEKLY", periodStart: "2027-01-04", periodEnd: "2027-01-10", previousStart: "2026-12-28", previousEnd: "2027-01-03", timezone: "Asia/Bangkok",
      current: { ...t }, previous: { ...t },
      units: [], weekdayOccupancyPercent: 40, weekendOccupancyPercent: 60, sources: [], paymentChannels: [],
      ga4: { status: "OK", events: {}, channels: [], sources: [], landingPages: [], devices: [] },
      forward: { from: "2027-01-11", days: 30, occupancyPercent: 40, soldNights: 48, openNights: 120, emptyDays: [], quietRuns: [] },
    };
  };
  const codes = (m: MarketingMetrics) => insights(m).map((i) => i.code);

  it("steady numbers: nothing to say", () => assert.deepEqual(codes(base()), []));

  it("rises, drops, weak houses, quiet weeks ahead, lost checkouts — warnings first", () => {
    const m = base();
    m.current.bookings = 4;
    m.current.revenueSatang = 2_000_000;
    m.current.occupancyPercent = 25;
    m.weekdayOccupancyPercent = 10;
    m.weekendOccupancyPercent = 70;
    m.units = [
      { unitId: "a", name: "บ้านซากุระ", type: "HOUSE", soldNights: 1, otaNights: 0, openNights: 7, occupancyPercent: 5 },
      { unitId: "b", name: "บ้านริมน้ำ", type: "HOUSE", soldNights: 6, otaNights: 0, openNights: 7, occupancyPercent: 85 },
    ];
    m.forward.quietRuns = [{ from: "2027-01-12", to: "2027-01-15", nights: 4, freeUnits: 2 }];
    m.ga4.events = { begin_checkout: 40 };
    m.ga4.devices = [{ name: "mobile", sessions: 80, users: 70 }, { name: "desktop", sessions: 20, users: 20 }];
    const out = insights(m);
    assert.deepEqual(out.map((i) => i.code), [
      "BOOKINGS_DOWN", "OCCUPANCY_LOW", "UNIT_LAGGING", "FORWARD_QUIET", "CHECKOUT_DROP", "REVENUE_UP", "WEEKDAY_SOFT", "MOBILE_FIRST",
    ]);
    assert.deepEqual(out.find((i) => i.code === "UNIT_LAGGING")!.params, { unit: "บ้านซากุระ", percent: 5, average: 25 });
    assert.deepEqual(out.find((i) => i.code === "BOOKINGS_DOWN")!.params, { now: 4, before: 10, change: -60 });
  });

  it("sources, GA4 state, last-minute guests", () => {
    const m = base();
    m.sources = [
      { source: "(direct)", medium: "(none)", bookings: 8, confirmed: 6, revenueSatang: 0 },
      { source: "facebook", medium: "cpc", bookings: 2, confirmed: 2, revenueSatang: 0 },
    ];
    m.ga4.status = "NOT_CONFIGURED";
    m.current.avgLeadDays = 2;
    assert.deepEqual(codes(m), ["TOP_SOURCE", "TAG_LINKS", "GA4_NOT_CONNECTED", "LAST_MINUTE"]);
  });
});
