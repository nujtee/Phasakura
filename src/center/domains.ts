import { createLineApi, type FetchLike } from "../worker/line/line-api.ts";
import { parseSites, type CenterEnv, type CenterSite } from "./env.ts";
import { bangkokTime, loadSettings, MONITOR_ACTOR } from "./monitor.ts";
import { SiteClient } from "./site-client.ts";

/**
 * Domain expiry of every site (Center migration 0009). The date comes from RDAP (the registries' public
 * replacement for WHOIS), read at most every 12 hours. Reminders: 15 days before (once), 7 days before (twice),
 * 3 days before (morning, noon, evening) — to the Center LINE group ("domains" notice) and, through the site, to its
 * Super Admins / Managers (e-mail, LINE) and the Center users' e-mail. Times are Bangkok time.
 */

export interface DomainRow {
  domain: string;
  expires_at: string | null;
  registrar: string | null;
  error: string | null;
  checked_at: string;
}

const RECHECK_MS = 12 * 3_600_000;
/**
 * Where each TLD's registry answers RDAP: IANA's bootstrap file (read once per round), with the common ones built in.
 * Asked directly, not through rdap.org (which refuses requests from Cloudflare Workers: 403).
 */
const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const KNOWN_RDAP: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/",
  net: "https://rdap.verisign.com/net/v1/",
};
const HEADERS = { accept: "application/rdap+json, application/json", "user-agent": "PhasakuraCenter/1.0 (domain expiry check)" };

/** TLD → RDAP base URL (ending in "/"), from IANA's bootstrap answer. */
export function parseBootstrap(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const services = (json as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) return out;
  for (const s of services) {
    if (!Array.isArray(s) || !Array.isArray(s[0]) || !Array.isArray(s[1])) continue;
    const url = (s[1] as unknown[]).find((u): u is string => typeof u === "string" && u.startsWith("https://"));
    if (!url) continue;
    for (const tld of s[0] as unknown[]) if (typeof tld === "string") out.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
  }
  return out;
}

/** Stages from the furthest: days left at most `days` → these Bangkok times. */
export const DOMAIN_STAGES = [
  { stage: "D15", days: 15, times: ["09:00"] },
  { stage: "D7", days: 7, times: ["09:00", "18:00"] },
  { stage: "D3", days: 3, times: ["09:00", "12:00", "18:00"] },
] as const;

function bangkok(now: Date): { date: string; time: string } {
  const local = new Date(now.getTime() + 7 * 3_600_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

/** Whole days from today (Bangkok) to the expiry date. */
export function daysLeft(expiresAt: string, now: Date): number {
  return Math.round((Date.parse(`${expiresAt}T00:00:00Z`) - Date.parse(`${bangkok(now).date}T00:00:00Z`)) / 86_400_000);
}

/** The stage a domain is in (the nearest one it has reached), or null when it is further than 15 days / expired. */
export function stageOf(left: number): (typeof DOMAIN_STAGES)[number] | null {
  if (left < 0) return null;
  let found: (typeof DOMAIN_STAGES)[number] | null = null;
  for (const s of DOMAIN_STAGES) if (left <= s.days) found = s;
  return found;
}

/** Expiry date (YYYY-MM-DD, as the registry states it in UTC) and registrar from an RDAP answer. */
export function parseRdap(json: unknown): { expiresAt: string | null; registrar: string | null } {
  const o = (json ?? {}) as { events?: { eventAction?: unknown; eventDate?: unknown }[]; entities?: { roles?: unknown; vcardArray?: unknown }[] };
  const ev = (o.events ?? []).find((e) => e.eventAction === "expiration" && typeof e.eventDate === "string");
  const at = ev ? Date.parse(ev.eventDate as string) : NaN;
  let registrar: string | null = null;
  for (const e of o.entities ?? []) {
    if (!Array.isArray(e.roles) || !e.roles.includes("registrar") || !Array.isArray(e.vcardArray)) continue;
    const fn = (e.vcardArray[1] as unknown[] | undefined)?.find((p) => Array.isArray(p) && p[0] === "fn") as unknown[] | undefined;
    if (fn && typeof fn[3] === "string") registrar = fn[3].slice(0, 200);
  }
  return { expiresAt: Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : null, registrar };
}

export async function loadDomains(db: CenterEnv["DB"]): Promise<Map<string, DomainRow>> {
  const { results } = await db.prepare("SELECT domain, expires_at, registrar, error, checked_at FROM center_domains").all<DomainRow>()
    .catch(() => ({ results: [] as DomainRow[] }));
  return new Map(results.map((r) => [r.domain, r]));
}

/** Reads the expiry of domains not read for 12 hours (or every one with `force`). Returns how many were read. */
export async function refreshDomains(env: CenterEnv, options: { clock?: () => Date; fetcher?: FetchLike; force?: boolean } = {}): Promise<number> {
  const now = (options.clock ?? (() => new Date()))();
  const fetcher: FetchLike = options.fetcher ?? ((url, init) => fetch(url, init));
  const known = await loadDomains(env.DB);
  const due = parseSites(env.CENTER_SITES).filter((s) => {
    const r = known.get(s.domain);
    return options.force || !r || now.getTime() - Date.parse(r.checked_at) >= RECHECK_MS;
  });
  let bootstrap: Map<string, string> | null = null;
  const baseFor = async (domain: string): Promise<string | null> => {
    const tld = domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
    if (KNOWN_RDAP[tld]) return KNOWN_RDAP[tld]!;
    if (!bootstrap) {
      try {
        const res = await fetcher(IANA_BOOTSTRAP, { headers: HEADERS });
        bootstrap = res.ok ? parseBootstrap(await res.json()) : new Map();
      } catch {
        bootstrap = new Map();
      }
    }
    return bootstrap.get(tld) ?? null;
  };
  for (const site of due) {
    let row: { expiresAt: string | null; registrar: string | null; error: string | null };
    try {
      const base = await baseFor(site.domain);
      const res = base ? await fetcher(`${base}domain/${encodeURIComponent(site.domain)}`, { headers: HEADERS }) : null;
      if (!res) row = { expiresAt: null, registrar: null, error: "ไม่พบ RDAP ของ registry นี้" };
      else if (!res.ok) row = { expiresAt: null, registrar: null, error: `RDAP ${res.status}` };
      else {
        const parsed = parseRdap(await res.json());
        row = { ...parsed, error: parsed.expiresAt ? null : "ไม่พบวันหมดอายุในข้อมูลของ registry" };
      }
    } catch (e) {
      row = { expiresAt: null, registrar: null, error: `อ่านไม่ได้: ${String(e).slice(0, 200)}` };
    }
    // A failed read keeps the date read before (and says why the new one failed).
    const before = known.get(site.domain);
    await env.DB.prepare(
      `INSERT INTO center_domains (domain, expires_at, registrar, error, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (domain) DO UPDATE SET expires_at = excluded.expires_at, registrar = excluded.registrar, error = excluded.error, checked_at = excluded.checked_at`,
    ).bind(site.domain, row.expiresAt ?? before?.expires_at ?? null, row.registrar ?? before?.registrar ?? null, row.error, now.toISOString()).run();
  }
  return due.length;
}

/** LINE text of one round. */
export function domainText(items: { site: CenterSite; expiresAt: string; left: number }[], now: Date, host: string): string {
  const lines = items.map(({ site, expiresAt, left }) => `🌐 ${site.name} — ${site.domain} หมดอายุ ${thaiDate(expiresAt)} (อีก ${left} วัน)`);
  return [`โดเมนใกล้หมดอายุ · ${bangkokTime(now)}`, "", ...lines, "", "กรุณาต่ออายุที่ผู้ให้บริการจดโดเมน", host].join("\n").slice(0, 4800);
}

export function thaiDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Every 5 minutes: for each domain in a stage, the latest reminder time passed and not sent yet goes out ONCE (one
 * that was missed meanwhile counts as sent with it). Center LINE group (when "domains" is on) + the site.
 */
export async function domainReminders(env: CenterEnv, options: { clock?: () => Date; lineFetch?: FetchLike } = {}): Promise<number> {
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const { time } = bangkok(now);
  const sites = parseSites(env.CENTER_SITES);
  const domains = await loadDomains(env.DB);
  const { results: sentRows } = await env.DB.prepare("SELECT domain, expires_at, slot FROM center_domain_notices").all<{ domain: string; expires_at: string; slot: string }>()
    .catch(() => ({ results: [] as { domain: string; expires_at: string; slot: string }[] }));
  const sent = new Set(sentRows.map((r) => `${r.domain}|${r.expires_at}|${r.slot}`));
  const due: { site: CenterSite; expiresAt: string; left: number; slot: string; covers: string[] }[] = [];
  for (const site of sites) {
    const d = domains.get(site.domain);
    if (!d?.expires_at) continue;
    const left = daysLeft(d.expires_at, now);
    const stage = stageOf(left);
    if (!stage) continue;
    const passed = stage.times.map((t, i) => ({ t, slot: `${stage.stage}:${i + 1}` })).filter((x) => x.t <= time);
    // Reminder times of the stage passed today and not sent (a stage reached late in the day: one message for them).
    const open = passed.filter((x) => !sent.has(`${site.domain}|${d.expires_at}|${x.slot}`));
    if (!open.length) continue;
    due.push({ site, expiresAt: d.expires_at, left, slot: open[open.length - 1]!.slot, covers: open.map((x) => x.slot) });
  }
  if (!due.length) return 0;

  const settings = await loadSettings(env.DB);
  const token = env.CENTER_LINE_TOKEN?.trim();
  let line = "OFF";
  if (settings.alertTypes.has("domains")) {
    if (!token) line = "NO_TOKEN";
    else if (!settings.lineGroupId) line = "NO_GROUP";
    else {
      const host = env.APP_BASE_URL?.trim() || "";
      const res = await createLineApi(token, options.lineFetch).push(settings.lineGroupId, [{ type: "text", text: domainText(due, now, host) }], crypto.randomUUID());
      line = res.ok ? "SENT" : "FAILED";
      if (!res.ok) console.error(JSON.stringify({ level: "error", message: "center_domain_line_failed", error: res.error.slice(0, 200) }));
    }
  }
  const { results: users } = await env.DB.prepare("SELECT email FROM center_users WHERE status = 'ACTIVE' ORDER BY created_at LIMIT 20").all<{ email: string }>();
  const centerEmails = users.map((u) => u.email.toLowerCase());
  const client = new SiteClient(env, 8000, clock);
  const at = now.toISOString();
  const statements = [];
  for (const d of due) {
    const res = await client.call<{ queued: number }>(d.site, "POST", "/api/center/notices/domain", MONITOR_ACTOR,
      { domain: d.site.domain, expiresAt: d.expiresAt, daysLeft: d.left, slot: d.slot, centerEmails });
    const delivery = `line ${line} · site ${res.status === 200 ? `queued ${res.data?.queued ?? 0}` : `failed ${res.status}`}`;
    for (const slot of d.covers) {
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO center_domain_notices (domain, expires_at, slot, delivery, sent_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(d.site.domain, d.expiresAt, slot, delivery, at));
    }
  }
  await env.DB.batch(statements);
  return due.length;
}
