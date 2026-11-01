import {
  REPORT_HOUR, USER_REPORTS_PER_DAY,
  type AiMarketingSettingsDto, type AiMarketingSettingsInput, type InsightDto, type MarketingMetrics, type MarketingReportDto,
  type MarketingReportListItemDto, type ReportKind,
} from "../../shared/ai-marketing-types.ts";
import { addDays, DEFAULT_TIMEZONE, localDateTimeIn, todayIn, utcOffsetMinutes } from "../../shared/dates.ts";
import { ConflictError, HttpError, NotFoundError, TooManyRequestsError, ValidationError } from "../http/errors.ts";
import { parseUnitDraft, unitSystemPrompt, unitUserPrompt, type UnitDraftInput } from "../ai-marketing/content-writer.ts";
import { AI_DRAFTS_PER_DAY, type UnitTextDraftDto } from "../../shared/ai-content-types.ts";
import { buildMetrics, forward, lastPeriod, periodStarting } from "../ai-marketing/metrics.ts";
import { parsePostDraft, postSystemPrompt, postUserPrompt, type PostFacts } from "../ai-marketing/post-writer.ts";
import type { PostChannel, PostDraftDto, QuietDatesDto } from "../../shared/ai-post-types.ts";
import type { LocaleCode } from "../../shared/i18n/locales.ts";
import { insights } from "../ai-marketing/insights.ts";
import type { AiMarketingRepository, ReportRow, SettingsRow } from "../repositories/ai-marketing.repository.ts";
import type { AttributionRepository } from "../repositories/attribution.repository.ts";
import type { InventoryRepository } from "../repositories/inventory.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { Ga4DashboardResult } from "./ga4-report.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import { aiInput, parseSummary, SYSTEM_PROMPT, userPrompt } from "../ai-marketing/ai-writer.ts";
import { anthropicMessage, costSatang, DEFAULT_AI_MODEL } from "../ai-marketing/llm-client.ts";
import type { FetchLike } from "../line/line-api.ts";

const LIST_LIMIT = 60;
const DAY_MS = 86_400_000;
const REPORT_REQUESTED = "MARKETING_REPORT_REQUESTED";
const AI_DRAFT_REQUESTED = "AI_DRAFT_REQUESTED";
/** Days ahead the post helper looks for quiet dates. */
const QUIET_DAYS = 60;

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * AI marketing report (migration 0053, Module A). Weekly (Monday 07:00) and monthly (the 1st, 07:00) reports when
 * switched on; staff may also ask for one. Reading needs `reports.view` (money); settings / asking need `marketing.edit`.
 * Numbers + fixed-rule findings (A2); when the AI is switched on, the key is set and the month's budget allows,
 * the AI writes a summary and recommendations from the numbers only (A3).
 */
export class AiMarketingService {
  constructor(
    private readonly repo: AiMarketingRepository,
    private readonly attribution: AttributionRepository,
    private readonly inventory: InventoryRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly ga4: ((from: string, to: string) => Promise<Ga4DashboardResult>) | null,
    private readonly config: {
      aiKeyConfigured: boolean; apiKey?: string | null; model?: string | null; fetch?: FetchLike;
      /** Does this user (now) hold reports.view? Notices go only to people who may read the report (A4). */
      mayReadReports?: (userId: string) => Promise<boolean>;
    },
  ) {}

  private async zone() {
    const tz = (await this.inventory.siteTimezone()) ?? DEFAULT_TIMEZONE;
    const now = this.clock();
    const minutes = utcOffsetMinutes(tz, now);
    return { tz, now, today: todayIn(tz, now), local: localDateTimeIn(tz, now), offset: `${minutes >= 0 ? "+" : ""}${minutes} minutes` };
  }

  private async settingsDto(s: SettingsRow): Promise<AiMarketingSettingsDto> {
    const z = await this.zone();
    const usage = await this.repo.monthUsage(`${z.today.slice(0, 7)}-01`, z.offset);
    return {
      enabled: s.is_enabled === 1, aiEnabled: s.ai_enabled === 1, aiKeyConfigured: this.config.aiKeyConfigured, model: this.model(),
      monthlyBudgetSatang: s.monthly_budget_satang, notifyEmail: s.notify_email === 1, notifyLine: s.notify_line === 1, updatedAt: s.updated_at,
      monthSpentSatang: usage.spent, monthAiCalls: usage.calls,
    };
  }

  private model(): string {
    return this.config.model?.trim() || DEFAULT_AI_MODEL;
  }

  async settings(actor: AuthContext, meta: RequestMeta): Promise<AiMarketingSettingsDto> {
    await this.authz.requirePermission(actor, "marketing.view", meta);
    return await this.settingsDto(await this.repo.settings());
  }

  async updateSettings(actor: AuthContext, input: AiMarketingSettingsInput, meta: RequestMeta): Promise<AiMarketingSettingsDto> {
    await this.authz.requirePermission(actor, "marketing.edit", meta);
    const before = await this.repo.settings();
    if (input.aiEnabled && !this.config.aiKeyConfigured) throw new ValidationError({ aiEnabled: "AI_KEY_MISSING" });
    const next = {
      is_enabled: input.enabled === undefined ? before.is_enabled : input.enabled ? 1 : 0,
      ai_enabled: input.aiEnabled === undefined ? before.ai_enabled : input.aiEnabled ? 1 : 0,
      monthly_budget_satang: input.monthlyBudgetSatang ?? before.monthly_budget_satang,
      notify_email: input.notifyEmail === undefined ? before.notify_email : input.notifyEmail ? 1 : 0,
      notify_line: input.notifyLine === undefined ? before.notify_line : input.notifyLine ? 1 : 0,
    };
    const now = iso(this.clock());
    await this.repo.saveSettings(next, actor.userId, now);
    const pick = (s: Omit<SettingsRow, "updated_at" | "provider" | "model">) => ({
      enabled: s.is_enabled === 1, aiEnabled: s.ai_enabled === 1, monthlyBudgetSatang: s.monthly_budget_satang,
      notifyEmail: s.notify_email === 1, notifyLine: s.notify_line === 1,
    });
    await this.log.auditStatement(actor.userId, "UPDATE_AI_MARKETING_SETTINGS", "ai_marketing", null, pick(before), pick(next), meta).run();
    return await this.settingsDto(await this.repo.settings());
  }

  private listItem(r: ReportRow): MarketingReportListItemDto {
    const m = parse<Partial<MarketingMetrics>>(r.metrics_json, {});
    return {
      id: r.id, kind: r.period_kind, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, trigger: r.trigger, createdAt: r.created_at,
      bookings: m.current?.bookings ?? 0, revenueSatang: m.current?.revenueSatang ?? null, occupancyPercent: m.current?.occupancyPercent ?? null,
    };
  }

  private dto(r: ReportRow): MarketingReportDto {
    const { bookings: _b, revenueSatang: _r, occupancyPercent: _o, ...base } = this.listItem(r);
    return {
      ...base,
      metrics: parse<MarketingMetrics>(r.metrics_json, {} as MarketingMetrics),
      insights: parse<InsightDto[]>(r.insights_json, []),
      aiSummary: r.ai_summary ? parse(r.ai_summary, null) : null,
      aiModel: r.ai_model,
      aiError: r.ai_error,
    };
  }

  async list(actor: AuthContext, meta: RequestMeta): Promise<MarketingReportListItemDto[]> {
    await this.authz.requirePermission(actor, "reports.view", meta);
    return (await this.repo.list(LIST_LIMIT)).map((r) => this.listItem(r));
  }

  async get(actor: AuthContext, id: string, meta: RequestMeta): Promise<MarketingReportDto> {
    await this.authz.requirePermission(actor, "reports.view", meta);
    const row = await this.repo.find(id);
    if (!row) throw new NotFoundError("Report not found", "REPORT_NOT_FOUND");
    return this.dto(row);
  }

  /** Staff ask for a report: the last complete period, or the one starting on `periodStart`; rewritten if it exists. */
  async generate(actor: AuthContext, input: { kind: ReportKind; periodStart?: string }, meta: RequestMeta): Promise<MarketingReportDto> {
    await this.authz.requirePermission(actor, "marketing.edit", meta);
    await this.authz.requirePermission(actor, "reports.view", meta);
    const z = await this.zone();
    let period = lastPeriod(input.kind, z.today);
    if (input.periodStart) {
      const p = periodStarting(input.kind, input.periodStart);
      if (!p) throw new ValidationError({ periodStart: input.kind === "WEEKLY" ? "MUST_BE_MONDAY" : "MUST_BE_FIRST_OF_MONTH" });
      if (p.end >= z.today) throw new ValidationError({ periodStart: "PERIOD_NOT_OVER" });
      period = p;
    }
    // Each request reads GA4 (and from A3 may call the AI): at most a few a day for the whole site.
    if ((await this.log.countRecent([REPORT_REQUESTED], DAY_MS)) >= USER_REPORTS_PER_DAY) {
      throw new TooManyRequestsError(60 * 60, "Too many reports today");
    }
    await this.log.event(REPORT_REQUESTED, "INFO", meta, { userId: actor.userId, details: { kind: input.kind, periodStart: period.start } });
    const row = await this.write(input.kind, period, "USER", actor.userId, z);
    await this.log.auditStatement(actor.userId, "GENERATE_MARKETING_REPORT", "ai_marketing", row.id, null,
      { kind: input.kind, periodStart: period.start, periodEnd: period.end }, meta).run();
    return this.dto(row);
  }

  private async write(kind: ReportKind, period: { start: string; end: string }, trigger: "CRON" | "USER", userId: string | null,
    z: Awaited<ReturnType<AiMarketingService["zone"]>>): Promise<ReportRow> {
    const metrics = await buildMetrics({ repo: this.repo, attribution: this.attribution, ga4: this.ga4 },
      { kind, start: period.start, end: period.end, today: z.today, offset: z.offset, timezone: z.tz });
    const found = insights(metrics);
    const existing = await this.repo.findPeriod(kind, period.start);
    await this.repo.upsert({
      id: existing?.id ?? newId(), kind, periodStart: period.start, periodEnd: period.end, status: "READY_NO_AI",
      metricsJson: JSON.stringify(metrics), insightsJson: JSON.stringify(found), aiSummary: null, aiModel: null, aiError: null,
      trigger, userId, now: iso(z.now),
    });
    const saved = await this.repo.findPeriod(kind, period.start);
    if (saved) await this.writeAi(saved.id, metrics, found, z);
    const row = await this.repo.findPeriod(kind, period.start);
    if (!row) throw new HttpError(500, "REPORT_NOT_SAVED", "The report could not be saved");
    return row;
  }

  /**
   * The AI's summary of a saved report (A3): only when switched on with a key, and while this month's estimated cost
   * is under the budget. Every call (and every call skipped for the budget) is recorded. Never throws: without an
   * answer the report simply stays "ready without AI" with the reason.
   */
  private async writeAi(reportId: string, metrics: MarketingMetrics, found: InsightDto[], z: Awaited<ReturnType<AiMarketingService["zone"]>>): Promise<void> {
    const now = () => iso(this.clock());
    try {
      const res = await this.callAi(reportId, SYSTEM_PROMPT, userPrompt(aiInput(metrics, found)), 1500, parseSummary, z);
      if (res === null) return;
      await this.repo.setAi(reportId, res.ok
        ? { status: "READY", summaryJson: JSON.stringify(res.value), model: res.model, error: null, now: now() }
        : { status: "READY_NO_AI", summaryJson: null, model: null, error: res.error, now: now() });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", message: "ai_marketing_summary_failed", error: String(e).slice(0, 200) }));
    }
  }

  /**
   * One call to the AI under the site's switch, key and monthly budget; every call (and every call refused for the
   * budget) is recorded in ai_usage with its estimated cost. null = AI off / no key (nothing recorded).
   * `read` turns the answer into the value wanted (null = not what was asked → UNREADABLE_ANSWER).
   */
  private async callAi<T>(reportId: string | null, system: string, user: string, maxTokens: number, read: (text: string) => T | null,
    z?: Awaited<ReturnType<AiMarketingService["zone"]>>): Promise<{ ok: true; value: T; model: string } | { ok: false; error: string } | null> {
    const s = await this.repo.settings();
    const apiKey = this.config.apiKey?.trim();
    if (s.ai_enabled !== 1 || !apiKey) return null;
    const zone = z ?? await this.zone();
    const model = this.model();
    const now = () => iso(this.clock());
    const usage = await this.repo.monthUsage(`${zone.today.slice(0, 7)}-01`, zone.offset);
    if (usage.spent >= s.monthly_budget_satang) {
      await this.repo.insertUsage({ id: newId(), reportId, provider: "ANTHROPIC", model, inputTokens: 0, outputTokens: 0, costSatang: 0, status: "SKIPPED_BUDGET", error: null, now: now() });
      return { ok: false, error: "BUDGET_REACHED" };
    }
    const res = await anthropicMessage({ apiKey, model, system, user, maxTokens, fetch: this.config.fetch });
    const value = res.ok ? read(res.text) : null;
    const error = !res.ok ? res.error : value !== null ? null : "UNREADABLE_ANSWER";
    await this.repo.insertUsage({
      id: newId(), reportId, provider: "ANTHROPIC", model: res.ok ? res.model : model, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
      costSatang: costSatang(res.inputTokens, res.outputTokens), status: value !== null ? "OK" : "FAILED", error, now: now(),
    });
    return value !== null ? { ok: true, value, model: res.ok ? res.model : model } : { ok: false, error: error ?? "UNREADABLE_ANSWER" };
  }

  /** Module C: quiet dates of the next 60 days (runs of 3+ nights with at least half the units free; empty days). */
  async quietDates(actor: AuthContext, lang: LocaleCode, meta: RequestMeta): Promise<QuietDatesDto> {
    await this.authz.requirePermission(actor, "marketing.view", meta);
    const z = await this.zone();
    const to = addDays(z.today, QUIET_DAYS - 1);
    const [units, rows] = await Promise.all([this.repo.activeUnits(lang), this.repo.dateNights(z.today, to)]);
    return { ...forward(rows, units.length, z.today, QUIET_DAYS), units: units.map((u) => ({ id: u.id, name: u.name, slug: u.slug })) };
  }

  /** Facts for a post (Module C): active units (or the one featured), in the post's language. */
  async postUnits(lang: LocaleCode, unitId: string | null) {
    const all = await this.repo.activeUnits(lang);
    return unitId ? all.filter((u) => u.id === unitId) : all.slice(0, 12);
  }

  async today(): Promise<string> {
    return (await this.zone()).today;
  }

  /**
   * Module C: three drafts of a post / LINE message selling quiet dates, with the tracked booking link put in.
   * Nothing is posted or sent. Same AI switch / budget / daily draft limit as Module B; audited.
   */
  async draftPost(actor: AuthContext, input: { channel: PostChannel; lang: LocaleCode; link: string; facts: PostFacts }, meta: RequestMeta): Promise<PostDraftDto> {
    await this.authz.requirePermission(actor, "marketing.edit", meta);
    const s = await this.repo.settings();
    if (s.ai_enabled !== 1 || !this.config.apiKey?.trim()) throw new ConflictError("The AI is not switched on", "AI_OFF");
    if ((await this.log.countRecent([AI_DRAFT_REQUESTED], DAY_MS)) >= AI_DRAFTS_PER_DAY) throw new TooManyRequestsError(60 * 60, "Too many AI drafts today");
    await this.log.event(AI_DRAFT_REQUESTED, "INFO", meta, { userId: actor.userId, details: { kind: "POST", channel: input.channel, lang: input.lang } });
    const res = await this.callAi(null, postSystemPrompt(input.channel, input.lang), postUserPrompt(input.facts), 2000, (text) => parsePostDraft(text, input.link));
    if (res === null) throw new ConflictError("The AI is not switched on", "AI_OFF");
    if (!res.ok) throw new HttpError(res.error === "BUDGET_REACHED" ? 409 : 502, res.error === "BUDGET_REACHED" ? "AI_BUDGET_REACHED" : "AI_FAILED",
      res.error === "BUDGET_REACHED" ? "This month's AI budget is used up" : "The AI could not write a draft", { reason: res.error });
    await this.log.auditStatement(actor.userId, "AI_DRAFT_POST", "ai_content", null, null,
      { channel: input.channel, lang: input.lang, dates: input.facts.dates, offer: input.facts.offer, model: res.model }, meta).run();
    return { variants: res.value, link: input.link, model: res.model };
  }

  /**
   * Module B: the AI drafts the texts of a house / VIP tent in one language — written fresh from the facts, or
   * translated from the Thai text. Nothing is saved: staff put the draft in the form, check it and press Save.
   * Facts only (no guest data). At most AI_DRAFTS_PER_DAY drafts a day for the whole site.
   */
  async draftUnitText(actor: AuthContext, input: UnitDraftInput, meta: RequestMeta): Promise<UnitTextDraftDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const s = await this.repo.settings();
    if (s.ai_enabled !== 1 || !this.config.apiKey?.trim()) throw new ConflictError("The AI is not switched on", "AI_OFF");
    if ((await this.log.countRecent([AI_DRAFT_REQUESTED], DAY_MS)) >= AI_DRAFTS_PER_DAY) throw new TooManyRequestsError(60 * 60, "Too many AI drafts today");
    await this.log.event(AI_DRAFT_REQUESTED, "INFO", meta, { userId: actor.userId, details: { kind: "UNIT_TEXT", unitId: input.facts.unitId, lang: input.lang, mode: input.mode } });
    const res = await this.callAi(null, unitSystemPrompt(input.lang, input.mode), unitUserPrompt(input), 2500, (text) => parseUnitDraft(text, input.lang));
    if (res === null) throw new ConflictError("The AI is not switched on", "AI_OFF");
    if (!res.ok) throw new HttpError(res.error === "BUDGET_REACHED" ? 409 : 502, res.error === "BUDGET_REACHED" ? "AI_BUDGET_REACHED" : "AI_FAILED",
      res.error === "BUDGET_REACHED" ? "This month's AI budget is used up" : "The AI could not write a draft", { reason: res.error });
    await this.log.auditStatement(actor.userId, "AI_DRAFT_UNIT_TEXT", "ai_content", input.facts.unitId, null, { lang: input.lang, mode: input.mode, model: res.model }, meta).run();
    return { ...res.value, model: res.model };
  }

  /**
   * "Report ready" (A4), for reports the cron wrote: e-mail and / or the user's own LINE, as switched on in the
   * settings, to every active user who may read reports. Best effort — a failure never undoes the report.
   */
  private async notify(reportId: string, now: Date): Promise<number> {
    try {
      const s = await this.repo.settings();
      const channels = { email: s.notify_email === 1, line: s.notify_line === 1 };
      if ((!channels.email && !channels.line) || !this.config.mayReadReports) return 0;
      const readers: string[] = [];
      for (const id of await this.repo.activeUserIds()) if (await this.config.mayReadReports(id)) readers.push(id);
      const statements = readers.flatMap((id) => this.repo.noticeStatements(reportId, id, channels, iso(now)));
      if (statements.length) await this.repo.batch(statements);
      return readers.length;
    } catch (e) {
      console.error(JSON.stringify({ level: "error", message: "marketing_report_notice_failed", error: String(e).slice(0, 200) }));
      return 0;
    }
  }

  /**
   * Cron (every 5 minutes): when switched on and it is 07:00 or later (property time), writes last week's report
   * (and on / after the 1st, last month's) if it is not there yet. Returns how many reports it wrote.
   */
  async tick(): Promise<number> {
    const s = await this.repo.settings();
    if (s.is_enabled !== 1) return 0;
    const z = await this.zone();
    if (Number(z.local.slice(11, 13)) < REPORT_HOUR) return 0;
    let written = 0;
    for (const kind of ["WEEKLY", "MONTHLY"] as const) {
      const period = lastPeriod(kind, z.today);
      if (await this.repo.findPeriod(kind, period.start)) continue;
      const row = await this.write(kind, period, "CRON", null, z);
      await this.notify(row.id, z.now);
      written += 1;
    }
    return written;
  }
}
