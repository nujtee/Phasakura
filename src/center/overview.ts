import type { CenterSite } from "./env.ts";
import { daysLeft, thaiDate, type DomainRow } from "./domains.ts";
import { bkk, esc } from "./html.ts";

/**
 * The "เว็บทั้งหมด" dashboard: four totals, a "ต้องดูแล" list (most urgent first, hidden when nothing is open), then
 * every site in one row. Plain HTML (no script): "เข้าหลังบ้าน" opens a small form for the reason (<details>), the
 * search box is a GET form.
 */

export interface CheckRow {
  site: string; checked_at: string; http_status: number; schema_state: string | null; cron_state: string | null;
  errors_24h: number | null; slips_waiting: number | null; suspended: number | null; detail: string | null;
}

export interface OpenAlert { site: string; type: string; open_since: string; detail: string | null }

/** 3 = broken, 2 = needs a look, 1 = to do (slips, not read yet). */
type Severity = 1 | 2 | 3;
interface Issue { sev: Severity; text: string }

export interface OverviewInput {
  sites: CenterSite[];
  checks: Map<string, CheckRow>;
  alerts: OpenAlert[];
  domains: Map<string, DomainRow>;
  alertLabel: (type: string) => string;
  now: Date;
  query: string;
  readOnly: boolean;
  canAdd: boolean;
  canRun: boolean;
}

/** Domains this close to expiry count as "ใกล้หมดอายุ" (same as the first reminder). */
export const DOMAIN_SOON_DAYS = 15;

const SEV_CLASS: Record<Severity, string> = { 3: "bad", 2: "warn", 1: "info" };

function issuesOf(site: CenterSite, c: CheckRow | undefined, alerts: OpenAlert[], domain: DomainRow | undefined, input: OverviewInput): Issue[] {
  const out: Issue[] = [];
  for (const a of alerts) out.push({ sev: 3, text: `${input.alertLabel(a.type)}${a.detail ? `: ${a.detail}` : ""} — ตั้งแต่ ${bkk(a.open_since)}` });
  if (!c) out.push({ sev: 1, text: "ยังไม่เคยตรวจ" });
  else if (c.http_status !== 200) {
    if (!alerts.length) out.push({ sev: 3, text: `ติดต่อไม่ได้${c.detail ? ` — ${c.detail}` : ""}` });
  } else {
    if (c.suspended) out.push({ sev: 2, text: "พักการรับจองออนไลน์อยู่" });
    if (c.schema_state !== "ok") out.push({ sev: 2, text: `ฐานข้อมูล ${c.schema_state ?? "—"}` });
    if (c.cron_state !== "ok") out.push({ sev: 2, text: `cron ${c.cron_state ?? "—"}` });
    if ((c.errors_24h ?? 0) > 0) out.push({ sev: 2, text: `มี error ${c.errors_24h} ครั้งใน 24 ชม.` });
  }
  if (domain?.expires_at) {
    const left = daysLeft(domain.expires_at, input.now);
    if (left <= DOMAIN_SOON_DAYS) {
      out.push({ sev: left <= 3 ? 3 : 2, text: `โดเมน ${site.domain} ${left < 0 ? `หมดอายุแล้ว ${-left} วัน` : left === 0 ? "หมดอายุวันนี้" : `หมดอายุใน ${left} วัน`} (${thaiDate(domain.expires_at)})` });
    }
  } else if (domain) {
    out.push({ sev: 1, text: `อ่านวันหมดอายุโดเมนไม่ได้${domain.error ? ` (${domain.error})` : ""}` });
  }
  if (c?.http_status === 200 && (c.slips_waiting ?? 0) > 0) out.push({ sev: 1, text: `สลิปรอตรวจ ${c.slips_waiting} รายการ` });
  return out.sort((a, b) => b.sev - a.sev);
}

function ssoForm(site: CenterSite, idPrefix: string, primary: boolean, readOnly: boolean): string {
  const id = `${idPrefix}-${site.slug}`;
  return `<details class="sso"><summary class="btn${primary ? " primary" : ""}">เข้าหลังบ้าน</summary>
<form method="post" action="/sites/${esc(site.slug)}/sso" class="sso-pop">
<label for="${esc(id)}">เหตุผลที่เข้าหลังบ้าน ${esc(site.name)}</label>
<input id="${esc(id)}" name="reason" required minlength="3" maxlength="300" placeholder="เช่น ช่วยตั้งค่าห้องพัก">
${readOnly ? '<p class="small muted">บทบาทของคุณเข้าได้แบบดูอย่างเดียว</p>' : ""}<button type="submit">เข้าหลังบ้าน</button></form></details>`;
}

function statusPill(c: CheckRow | undefined, issues: Issue[]): string {
  if (!c) return '<span class="pill off">ยังไม่เคยตรวจ</span>';
  if (c.http_status !== 200) return '<span class="pill empty">ติดต่อไม่ได้</span>';
  if (c.suspended) return '<span class="pill low">พักการรับจอง</span>';
  const worst = issues[0]?.sev ?? 0;
  if (worst === 3) return '<span class="pill empty">ผิดพลาด</span>';
  if (worst === 2) return '<span class="pill low">ต้องดูแล</span>';
  return '<span class="pill good">ออนไลน์</span>';
}

function systemCell(c: CheckRow | undefined): string {
  if (!c) return '<span class="muted small">—</span>';
  if (c.http_status !== 200) return `<span class="small bad">${esc(c.detail ?? `HTTP ${c.http_status}`)}</span><div class="small muted">ตรวจล่าสุด ${esc(bkk(c.checked_at))}</div>`;
  const chk = (label: string, value: string | number | null, bad: boolean) => `<span class="chk${bad ? " w" : ""}">${label} <b>${esc(value ?? "—")}</b></span>`;
  return `<div class="chks">${chk("DB", c.schema_state, c.schema_state !== "ok")}${chk("cron", c.cron_state, c.cron_state !== "ok")}`
    + `${chk("error", c.errors_24h ?? 0, (c.errors_24h ?? 0) > 0)}${chk("สลิป", c.slips_waiting ?? 0, (c.slips_waiting ?? 0) > 0)}</div>`
    + `<div class="small muted">ตรวจล่าสุด ${esc(bkk(c.checked_at))}</div>`;
}

function domainCell(row: DomainRow | undefined, now: Date): string {
  if (!row) return '<span class="small muted">ยังไม่ได้อ่านวันหมดอายุ</span>';
  if (!row.expires_at) return `<span class="small warn">อ่านไม่ได้${row.error ? ` (${esc(row.error)})` : ""}</span>`;
  const left = daysLeft(row.expires_at, now);
  const cls = left <= 3 ? "bad" : left <= DOMAIN_SOON_DAYS ? "warn" : "ok";
  const when = left < 0 ? `หมดอายุแล้ว ${-left} วัน` : left === 0 ? "หมดอายุวันนี้" : `อีก ${left} วัน`;
  const pct = Math.max(3, Math.min(100, Math.round((Math.max(left, 0) / 365) * 100)));
  return `<div>${esc(thaiDate(row.expires_at))} <span class="small ${cls === "ok" ? "muted" : cls}">· ${when}</span></div>`
    + `<div class="exp ${cls}" aria-hidden="true"><span style="width:${pct}%"></span></div>`
    + (row.registrar ? `<div class="small muted">${esc(row.registrar)}</div>` : "");
}

export function overviewHtml(input: OverviewInput): string {
  const { sites, checks, domains, now } = input;
  const views = sites.map((site) => {
    const c = checks.get(site.slug);
    const domain = domains.get(site.domain);
    const issues = issuesOf(site, c, input.alerts.filter((a) => a.site === site.slug), domain, input);
    return { site, c, domain, issues };
  });

  const online = views.filter((v) => v.c?.http_status === 200).length;
  const attention = views.filter((v) => v.issues.length)
    .sort((a, b) => (b.issues[0]!.sev - a.issues[0]!.sev) || (b.issues.length - a.issues.length));
  const slips = views.reduce((n, v) => n + (v.c?.http_status === 200 ? v.c.slips_waiting ?? 0 : 0), 0);
  const soon = views.filter((v) => v.domain?.expires_at && daysLeft(v.domain.expires_at, now) <= DOMAIN_SOON_DAYS).length;
  const tile = (label: string, value: string, cls = "") => `<div class="tile"><div class="small muted">${label}</div><div class="tile-v ${cls}">${value}</div></div>`;
  const tiles = `<div class="tiles">${tile("ออนไลน์", `${online} <span class="small muted">/ ${sites.length}</span>`, online < sites.length ? "bad" : "")}`
    + `${tile("ต้องดูแล", String(attention.length), attention.length ? "bad" : "")}`
    + `${tile("สลิปรอตรวจ", String(slips), slips ? "warn" : "")}`
    + `${tile(`โดเมนใกล้หมดอายุ (≤ ${DOMAIN_SOON_DAYS} วัน)`, String(soon), soon ? "warn" : "")}</div>`;

  const issueList = attention.length
    ? `<section class="card flush" aria-labelledby="h-attn"><div class="sec-head"><h2 id="h-attn">ต้องดูแล</h2><span class="small muted">เรียงจากเร่งด่วนที่สุด</span></div>
${attention.map(({ site, issues }) => `<div class="attn"><span class="sev ${SEV_CLASS[issues[0]!.sev]}" aria-hidden="true"></span>
<div class="attn-body"><div><a href="/sites/${esc(site.slug)}"><strong>${esc(site.name)}</strong></a> <span class="small muted">· ${esc(site.domain)}</span></div>
${issues.map((i) => `<div class="small ${SEV_CLASS[i.sev]}">${esc(i.text)}</div>`).join("")}</div>
<div class="acts"><a class="btn" href="/sites/${esc(site.slug)}">รายละเอียด</a>${ssoForm(site, "a", true, input.readOnly)}</div></div>`).join("")}</section>`
    : "";

  const q = input.query.trim().toLowerCase();
  const shown = q ? views.filter((v) => [v.site.name, v.site.domain, v.site.slug].some((s) => s.toLowerCase().includes(q))) : views;
  const rows = shown.map(({ site, c, domain, issues }) => `<tr>
<td><a href="/sites/${esc(site.slug)}"><strong>${esc(site.name)}</strong></a><div><a class="small muted" href="https://${esc(site.domain)}" rel="noopener noreferrer" target="_blank">${esc(site.domain)}</a></div></td>
<td>${statusPill(c, issues)}</td><td>${systemCell(c)}</td><td>${domainCell(domain, now)}</td>
<td class="num">${ssoForm(site, "t", false, input.readOnly)}</td></tr>`).join("");
  const empty = q
    ? `<tr><td colspan="5" class="muted">ไม่พบเว็บที่ตรงกับ “${esc(input.query.trim())}” · <a href="/">ล้างการค้นหา</a></td></tr>`
    : '<tr><td colspan="5" class="muted">ยังไม่มีเว็บ</td></tr>';
  const table = `<section class="card flush" aria-labelledby="h-all"><div class="sec-head"><h2 id="h-all">ทุกเว็บ</h2><span class="small muted">${sites.length} เว็บ</span>
<form method="get" action="/" class="search" role="search"><label class="sr" for="site-q">ค้นหาเว็บ</label><input id="site-q" type="search" name="q" value="${esc(input.query)}" placeholder="ค้นหาเว็บ"><button class="plain" type="submit">ค้นหา</button></form></div>
<div class="scroll"><table class="sites"><thead><tr><th>เว็บ</th><th>สถานะ</th><th>ระบบ</th><th>โดเมนหมดอายุ</th><th class="num"><span class="sr">หลังบ้าน</span></th></tr></thead>
<tbody>${rows || empty}</tbody></table></div></section>`;

  const last = views.map((v) => v.c?.checked_at).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const buttons = (input.canAdd ? '<a class="btn" href="/sites/new">+ เพิ่มเว็บใหม่</a>' : "")
    + (input.canRun ? '<form method="post" action="/checks/run" class="inline"><button type="submit">ตรวจตอนนี้</button></form>' : "");
  return `<div class="page-head"><div><h1>เว็บทั้งหมด</h1><p class="small muted">ตรวจอัตโนมัติทุก 5 นาที · ล่าสุด ${esc(bkk(last))} · ปัญหาที่เห็น 2 รอบติดกันจะแจ้งเตือนเข้ากลุ่ม LINE</p></div>
<div class="head-acts">${buttons}</div></div>
${tiles}${issueList}${table}
<p class="muted small">กด “เข้าหลังบ้าน” แล้วใส่เหตุผลก่อนเข้า · การเข้าหลังบ้านทุกครั้งถูกบันทึกทั้งใน Center และใน Audit logs ของเว็บนั้น${input.readOnly ? " — บทบาทของคุณเข้าได้แบบดูอย่างเดียว" : ""}</p>`;
}
