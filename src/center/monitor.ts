import type { CenterActor } from "../shared/center-protocol.ts";
import type { SystemStatusDto } from "../shared/system-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../worker/env.ts";
import { createLineApi, type FetchLike } from "../worker/line/line-api.ts";
import { parseSites, type CenterEnv, type CenterSite } from "./env.ts";
import { SiteClient, type SiteResponse } from "./site-client.ts";

/** Alert types a site can raise; "recovered" (in settings) switches the all-clear messages on or off. */
export const ALERT_TYPES = ["site_down", "schema_outdated", "cron_stale", "server_errors", "config_errors"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export const SETTING_TYPES = [...ALERT_TYPES, "recovered"] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

export const ALERT_LABELS: Record<SettingType, string> = {
  site_down: "เว็บล่ม / ติดต่อไม่ได้",
  schema_outdated: "ฐานข้อมูลไม่ตรงกับโค้ด (ยังไม่ migrate)",
  cron_stale: "งานเบื้องหลัง (cron) หยุด",
  server_errors: "ข้อผิดพลาดของเซิร์ฟเวอร์สูง",
  config_errors: "การตั้งค่าของเว็บผิดพลาด",
  recovered: "แจ้งเมื่อกลับมาปกติ",
};

/** A problem must be seen in this many checks in a row (5 minutes apart) before it is announced. */
export const OPEN_AFTER_CHECKS = 2;
/** Server errors in the site's last 24 h that count as "high". */
export const SERVER_ERRORS_THRESHOLD = 5;
export const CHECK_RETENTION_DAYS = 14;

/** Who the monitor is when it reads a site (read-only; reads are not audited on the site). */
export const MONITOR_ACTOR: CenterActor = { id: "center-monitor", email: "monitor@center.invalid", role: "SUPPORT_READONLY" };

/** Readiness checks already covered by their own alert type (or not a fault). */
const NOT_CONFIG = new Set(["schema", "cron", "centerSuspension"]);

export interface Evaluation {
  problems: Map<AlertType, string>;
  row: {
    http_status: number; health: string | null; database_state: string | null; schema_state: string | null; cron_state: string | null;
    errors_24h: number | null; slips_waiting: number | null; suspended: number | null; detail: string | null;
  };
}

/** What one status reading means. Unreachable / database down hides everything else (there is nothing else to read). */
export function evaluate(res: SiteResponse<SystemStatusDto>): Evaluation {
  const problems = new Map<AlertType, string>();
  const s = res.status === 200 ? res.data : undefined;
  if (!s?.health) {
    const why = res.status === 0 ? `ติดต่อไม่ได้ (${res.error?.code ?? "UNREACHABLE"})` : `ตอบ HTTP ${res.status}${res.error?.code ? ` ${res.error.code}` : ""}`;
    problems.set("site_down", why);
    return { problems, row: { http_status: res.status, health: null, database_state: null, schema_state: null, cron_state: null, errors_24h: null, slips_waiting: null, suspended: null, detail: why.slice(0, 500) } };
  }
  const h = s.health;
  if (h.database !== "ok") problems.set("site_down", "ฐานข้อมูลใช้ไม่ได้");
  else {
    if (h.schema === "outdated") problems.set("schema_outdated", "ฐานข้อมูลยังไม่ได้ migrate ให้ตรงกับโค้ด");
    if (h.cron === "stale") problems.set("cron_stale", "cron ไม่ทำงานเกิน 5 นาที (การจองค้างไม่หมดเวลา, LINE / อีเมลไม่ถูกส่ง)");
    if (s.errorCount24h >= SERVER_ERRORS_THRESHOLD) problems.set("server_errors", `${s.errorCount24h} ครั้งใน 24 ชม.`);
    const bad = s.checks.filter((c) => c.level === "error" && !NOT_CONFIG.has(c.key)).map((c) => c.key);
    if (bad.length) problems.set("config_errors", bad.join(", "));
  }
  const suspended = s.checks.some((c) => c.key === "centerSuspension" && c.level === "error");
  return {
    problems,
    row: {
      http_status: 200, health: h.status, database_state: h.database, schema_state: h.schema, cron_state: h.cron,
      errors_24h: s.errorCount24h, slips_waiting: s.backlog?.slipsWaiting ?? null, suspended: suspended ? 1 : 0,
      detail: [...problems.values()].join(" · ").slice(0, 500) || null,
    },
  };
}

export interface AlertEvent {
  site: CenterSite;
  type: AlertType;
  event: "OPENED" | "RESOLVED";
  detail: string;
  /** RESOLVED: how long it was open. */
  openSince?: string;
}

interface StateRow {
  site: string;
  type: AlertType;
  bad_checks: number;
  open_since: string | null;
  detail: string | null;
}

export interface CenterSettings {
  lineGroupId: string | null;
  alertTypes: Set<SettingType>;
}

export async function loadSettings(db: D1DatabaseLike): Promise<CenterSettings> {
  const row = await db.prepare("SELECT line_group_id, alert_types FROM center_settings WHERE id = 1").first<{ line_group_id: string | null; alert_types: string }>();
  let types: string[] = [...SETTING_TYPES];
  try {
    if (row) types = JSON.parse(row.alert_types) as string[];
  } catch {
    // keep defaults
  }
  return { lineGroupId: row?.line_group_id ?? null, alertTypes: new Set(types.filter((t): t is SettingType => (SETTING_TYPES as readonly string[]).includes(t))) };
}

export interface MonitorOptions {
  clock?: () => Date;
  lineFetch?: FetchLike;
}

export interface MonitorResult {
  checked: number;
  events: AlertEvent[];
  delivery: "SENT" | "FAILED" | "OFF" | "NO_GROUP" | "NO_TOKEN" | "NONE";
}

/**
 * One monitoring round (cron every 5 minutes, or "ตรวจตอนนี้"): read every site's status over its binding, store it,
 * move each (site, alert type) through bad → open (after OPEN_AFTER_CHECKS) → resolved, and announce what changed in
 * ONE LINE message to the chosen group (each event once; nothing while a problem simply stays open).
 */
export async function runChecks(env: CenterEnv, options: MonitorOptions = {}): Promise<MonitorResult> {
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const nowIso = now.toISOString();
  const db = env.DB;
  const sites = parseSites(env.CENTER_SITES);
  const client = new SiteClient(env, 8000, clock);
  const readings = await Promise.all(sites.map((s) => client.call<SystemStatusDto>(s, "GET", "/api/center/status", MONITOR_ACTOR)));
  const { results: stateRows } = await db.prepare("SELECT site, type, bad_checks, open_since, detail FROM center_alert_states").all<StateRow>();
  const states = new Map(stateRows.map((r) => [`${r.site}/${r.type}`, r]));

  const statements: D1PreparedStatementLike[] = [];
  const events: AlertEvent[] = [];
  sites.forEach((site, i) => {
    const { problems, row } = evaluate(readings[i]!);
    statements.push(db.prepare(
      `INSERT INTO center_site_checks (site, checked_at, http_status, health, database_state, schema_state, cron_state, errors_24h, slips_waiting, suspended, problems, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    ).bind(site.slug, nowIso, row.http_status, row.health, row.database_state, row.schema_state, row.cron_state, row.errors_24h, row.slips_waiting, row.suspended,
      JSON.stringify([...problems.keys()]), row.detail));
    // A reading without data (site unreachable / database down) says nothing about the other problems:
    // leave their state alone instead of "resolving" them for one round.
    const blind = problems.has("site_down");
    for (const type of ALERT_TYPES) {
      if (blind && type !== "site_down") continue;
      const prev = states.get(`${site.slug}/${type}`);
      const detail = problems.get(type);
      let bad = 0;
      let openSince: string | null = null;
      if (detail !== undefined) {
        bad = (prev?.bad_checks ?? 0) + 1;
        openSince = prev?.open_since ?? null;
        if (!openSince && bad >= OPEN_AFTER_CHECKS) {
          openSince = nowIso;
          events.push({ site, type, event: "OPENED", detail });
        }
      } else if (prev?.open_since) {
        events.push({ site, type, event: "RESOLVED", detail: prev.detail ?? "", openSince: prev.open_since });
      }
      if (detail === undefined && (!prev || (prev.bad_checks === 0 && !prev.open_since))) continue; // nothing changed
      statements.push(db.prepare(
        `INSERT INTO center_alert_states (site, type, bad_checks, open_since, detail, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (site, type) DO UPDATE SET bad_checks = excluded.bad_checks, open_since = excluded.open_since, detail = excluded.detail, updated_at = excluded.updated_at`,
      ).bind(site.slug, type, bad, openSince, detail ?? prev?.detail ?? null, nowIso));
    }
  });
  const cutoff = new Date(now.getTime() - CHECK_RETENTION_DAYS * 86_400_000).toISOString();
  statements.push(db.prepare("DELETE FROM center_site_checks WHERE checked_at < ?1").bind(cutoff));
  await db.batch(statements);

  const delivery = events.length ? await announce(env, events, now, options.lineFetch) : "NONE";
  return { checked: sites.length, events, delivery };
}

function duration(fromIso: string, to: Date): string {
  const minutes = Math.max(1, Math.round((to.getTime() - Date.parse(fromIso)) / 60_000));
  return minutes < 60 ? `${minutes} นาที` : minutes < 2880 ? `${Math.round(minutes / 6) / 10} ชม.` : `${Math.round(minutes / 1440)} วัน`;
}

export function bangkokTime(d: Date): string {
  return new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** The text of one alert message (every event of a round together). */
export function alertText(events: AlertEvent[], now: Date, centerHost: string): string {
  const lines = events.map((e) => e.event === "OPENED"
    ? `🔴 ${e.site.name} — ${ALERT_LABELS[e.type]}: ${e.detail}`
    : `✅ ${e.site.name} — กลับมาปกติ: ${ALERT_LABELS[e.type]}${e.openSince ? ` (นาน ${duration(e.openSince, now)})` : ""}`);
  return [`Center แจ้งเตือน · ${bangkokTime(now)}`, "", ...lines, "", centerHost].join("\n").slice(0, 4800);
}

/** Sends the round's events (those switched on) to the chosen group; logs each event with what happened. */
async function announce(env: CenterEnv, events: AlertEvent[], now: Date, lineFetch?: FetchLike): Promise<MonitorResult["delivery"]> {
  const db = env.DB;
  const settings = await loadSettings(db);
  const wanted = events.filter((e) => settings.alertTypes.has(e.type) && (e.event === "OPENED" || settings.alertTypes.has("recovered")));
  const token = env.CENTER_LINE_TOKEN?.trim();
  let delivery: MonitorResult["delivery"] = "OFF";
  let error: string | null = null;
  if (wanted.length) {
    if (!token) delivery = "NO_TOKEN";
    else if (!settings.lineGroupId) delivery = "NO_GROUP";
    else {
      const host = new URL(env.APP_BASE_URL?.trim() || "https://center.invalid").host;
      const res = await createLineApi(token, lineFetch).push(settings.lineGroupId, [{ type: "text", text: alertText(wanted, now, host) }], crypto.randomUUID());
      delivery = res.ok ? "SENT" : "FAILED";
      if (!res.ok) error = res.error.slice(0, 300);
    }
  }
  const nowIso = now.toISOString();
  await db.batch(events.map((e) => db.prepare(
    "INSERT INTO center_alert_log (id, site, type, event, message, delivery, error, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  ).bind(crypto.randomUUID(), e.site.slug, e.type, e.event, `${ALERT_LABELS[e.type]}: ${e.detail}`.slice(0, 2000), wanted.includes(e) ? delivery : "OFF", wanted.includes(e) ? error : null, nowIso)));
  if (delivery === "FAILED") console.error(JSON.stringify({ level: "error", message: "center_alert_line_failed", error }));
  return delivery;
}

/** Settings → "ส่งข้อความทดสอบ". */
export async function sendTest(env: CenterEnv, byName: string, now: Date, lineFetch?: FetchLike): Promise<{ ok: boolean; reason: string }> {
  const settings = await loadSettings(env.DB);
  const token = env.CENTER_LINE_TOKEN?.trim();
  let delivery: "SENT" | "FAILED" | "NO_GROUP" | "NO_TOKEN";
  let error: string | null = null;
  if (!token) delivery = "NO_TOKEN";
  else if (!settings.lineGroupId) delivery = "NO_GROUP";
  else {
    const res = await createLineApi(token, lineFetch).push(settings.lineGroupId, [{ type: "text", text: `✅ ทดสอบการแจ้งเตือนจาก Center\nโดย ${byName} · ${bangkokTime(now)}` }], crypto.randomUUID());
    delivery = res.ok ? "SENT" : "FAILED";
    if (!res.ok) error = res.error.slice(0, 300);
  }
  await env.DB.prepare("INSERT INTO center_alert_log (id, site, type, event, message, delivery, error, created_at) VALUES (?1, NULL, 'test', 'TEST', ?2, ?3, ?4, ?5)")
    .bind(crypto.randomUUID(), `ทดสอบโดย ${byName}`.slice(0, 2000), delivery, error, now.toISOString()).run();
  const reason = { SENT: "ส่งแล้ว", FAILED: `LINE ไม่รับ: ${error ?? ""}`, NO_GROUP: "ยังไม่ได้เลือกกลุ่ม LINE", NO_TOKEN: "ยังไม่ได้ตั้ง secret CENTER_LINE_TOKEN" }[delivery];
  return { ok: delivery === "SENT", reason };
}

/** POST /line/webhook — LINE tells Center which groups its bot joined / left. Authenticated by x-line-signature. */
export async function lineWebhook(env: CenterEnv, events: unknown[], now: Date, lineFetch?: FetchLike): Promise<number> {
  const db = env.DB;
  const token = env.CENTER_LINE_TOKEN?.trim();
  let handled = 0;
  for (const e of events) {
    const ev = e as { type?: string; source?: { type?: string; groupId?: string } };
    const groupId = ev.source?.type === "group" ? ev.source.groupId : undefined;
    if (!groupId || !/^C[0-9a-f]{32}$/.test(groupId)) continue;
    if (ev.type === "join" || ev.type === "memberJoined" || ev.type === "message") {
      let name: string | null = null;
      if (token) {
        try {
          const res = await (lineFetch ?? ((i, init) => fetch(i, init)))(`https://api.line.me/v2/bot/group/${groupId}/summary`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
          if (res.ok) name = ((await res.json()) as { groupName?: string }).groupName?.slice(0, 200) ?? null;
        } catch {
          // name stays unknown
        }
      }
      await db.prepare(
        `INSERT INTO center_line_groups (group_id, name, joined_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (group_id) DO UPDATE SET name = COALESCE(excluded.name, center_line_groups.name), left_at = NULL`,
      ).bind(groupId, name, now.toISOString()).run();
      handled++;
    } else if (ev.type === "leave") {
      await db.prepare("UPDATE center_line_groups SET left_at = ?2 WHERE group_id = ?1").bind(groupId, now.toISOString()).run();
      handled++;
    }
  }
  return handled;
}
