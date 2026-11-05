import { CREDIT_PLANS, type CreditTopupDto } from "../shared/credit-types.ts";
import { creditTh, fill } from "../shared/i18n/admin-credit-messages.ts";
import { createLineApi, type FetchLike } from "../worker/line/line-api.ts";
import { parseSites, type CenterEnv, type CenterSite } from "./env.ts";
import { bkk, esc } from "./html.ts";
import { bangkokTime, loadSettings, MONITOR_ACTOR } from "./monitor.ts";
import { SiteClient, type SiteResponse } from "./site-client.ts";

/**
 * Credit top-up requests of every site, decided in Center (central credits, stage 3; Center migration 0007).
 * The site keeps the request, the slip and the ledger; Center reads them over the signed API, shows the slip
 * through its own origin, and approves / rejects as the Center user (audited on both sides).
 * New requests are announced once in the LINE group by the 5-minute check ("topups" notice).
 */

export interface SiteTopups {
  pending: CreditTopupDto[];
  recent: CreditTopupDto[];
}

export interface SiteTopupView {
  site: CenterSite;
  res: SiteResponse<SiteTopups>;
}

/** How long announced requests are remembered (a request is never pending this long). */
const SEEN_RETENTION_DAYS = 60;
const TOPUP_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function validTopupId(id: string): boolean {
  return TOPUP_ID.test(id);
}

const n = (v: number) => v.toLocaleString("en-US");

function verifyText(t: CreditTopupDto): string {
  if (!t.verifyResult) return "ยังไม่ได้ตรวจอัตโนมัติ";
  const reasons = t.verifyReasons.map((r) => r.startsWith("receiver:")
    ? fill(creditTh.reasons.RECEIVER_READ, { value: r.slice("receiver:".length) })
    : (creditTh.reasons as Record<string, string>)[r] ?? r);
  return `${creditTh.verify[t.verifyResult]}${reasons.length ? ` — ${reasons.join(", ")}` : ""}`;
}

/** One message for every new request of a round. */
export function topupText(items: { site: CenterSite; t: CreditTopupDto }[], now: Date, centerHost: string): string {
  const lines = items.map(({ site, t }) => `💰 ${site.name} — ${n(t.amountRequested)} บาท (${creditTh.plans[t.plan]}) โดย ${t.requestedBy.name} · ${verifyText(t)}`);
  return [`คำขอเติมเครดิตใหม่ · ${bangkokTime(now)}`, "", ...lines, "", `อนุมัติได้ที่ ${centerHost}/topups`].join("\n").slice(0, 4800);
}

/**
 * Every 5 minutes: requests not announced yet go to the LINE group in ONE message (when "topups" is switched on).
 * A site that cannot be read is skipped (its requests are announced once it answers).
 */
export async function announceTopups(env: CenterEnv, options: { clock?: () => Date; lineFetch?: FetchLike } = {}): Promise<number> {
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const db = env.DB;
  const sites = parseSites(env.CENTER_SITES);
  const client = new SiteClient(env, 8000, clock);
  const answers = await Promise.all(sites.map((s) => client.call<SiteTopups>(s, "GET", "/api/center/topups", MONITOR_ACTOR)));
  const { results: seenRows } = await db.prepare("SELECT site, topup_id FROM center_topup_seen").all<{ site: string; topup_id: string }>();
  const seen = new Set(seenRows.map((r) => `${r.site}/${r.topup_id}`));
  const fresh: { site: CenterSite; t: CreditTopupDto }[] = [];
  sites.forEach((site, i) => {
    const res = answers[i]!;
    if (res.status !== 200 || !res.data) return;
    for (const t of res.data.pending) if (validTopupId(t.id) && !seen.has(`${site.slug}/${t.id}`)) fresh.push({ site, t });
  });
  const cutoff = new Date(now.getTime() - SEEN_RETENTION_DAYS * 86_400_000).toISOString();
  if (!fresh.length) {
    await db.prepare("DELETE FROM center_topup_seen WHERE seen_at < ?1").bind(cutoff).run();
    return 0;
  }
  const settings = await loadSettings(db);
  const token = env.CENTER_LINE_TOKEN?.trim();
  let delivery: "SENT" | "FAILED" | "OFF" | "NO_GROUP" | "NO_TOKEN" = "OFF";
  if (settings.alertTypes.has("topups")) {
    if (!token) delivery = "NO_TOKEN";
    else if (!settings.lineGroupId) delivery = "NO_GROUP";
    else {
      const host = new URL(env.APP_BASE_URL?.trim() || "https://center.invalid").host;
      const res = await createLineApi(token, options.lineFetch).push(settings.lineGroupId, [{ type: "text", text: topupText(fresh, now, host) }], crypto.randomUUID());
      delivery = res.ok ? "SENT" : "FAILED";
      if (!res.ok) console.error(JSON.stringify({ level: "error", message: "center_topup_line_failed", error: res.error.slice(0, 200) }));
    }
  }
  const at = now.toISOString();
  await db.batch([
    ...fresh.map(({ site, t }) => db.prepare("INSERT OR IGNORE INTO center_topup_seen (site, topup_id, delivery, seen_at) VALUES (?1, ?2, ?3, ?4)").bind(site.slug, t.id, delivery, at)),
    db.prepare("DELETE FROM center_topup_seen WHERE seen_at < ?1").bind(cutoff),
  ]);
  return fresh.length;
}

// ---------------------------------------------------------------- rendering

const STATUS_LABEL: Record<string, string> = { PENDING: "รอตรวจ", APPROVED: "อนุมัติแล้ว", REJECTED: "ไม่อนุมัติ" };

function pendingRow(site: CenterSite, t: CreditTopupDto, canDecide: boolean): string {
  const base = `/topups/${esc(site.slug)}/${esc(t.id)}`;
  const amount = t.verifiedAmount ?? t.amountRequested;
  const planOptions = CREDIT_PLANS.map((p) => `<option value="${p}"${p === t.plan ? " selected" : ""}>${esc(creditTh.plans[p])}</option>`).join("");
  const actions = canDecide
    ? `<form method="post" action="${base}/approve" class="stack" style="margin:0 0 8px">
<div style="display:flex;gap:8px;flex-wrap:wrap"><label style="margin:0">เครดิตที่จะเติม <input name="amount" inputmode="numeric" required value="${amount}" style="width:120px"></label>
<label style="margin:0">แพ็กเกจ <select name="plan" style="width:auto">${planOptions}</select></label></div>
<input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผล เช่น ตรวจยอดเข้าบัญชีแล้ว" aria-label="เหตุผลที่อนุมัติ">
<button type="submit">อนุมัติ</button></form>
<form method="post" action="${base}/reject" class="stack" style="margin:0">
<input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผลที่ไม่อนุมัติ (ผู้ขอจะเห็น)" aria-label="เหตุผลที่ไม่อนุมัติ">
<button class="plain" type="submit">ไม่อนุมัติ</button></form>`
    : '<span class="muted small">ดูได้อย่างเดียว</span>';
  return `<tr><td><strong>${esc(site.name)}</strong><div class="muted small">${esc(bkk(t.createdAt))}</div></td>
<td>${n(t.amountRequested)} บาท<div class="small">${esc(creditTh.plans[t.plan])} · โดย ${esc(t.requestedBy.name)}</div></td>
<td class="small">${esc(verifyText(t))}${t.verifiedAmount !== null ? `<div>ยอดบนสลิป ${n(t.verifiedAmount)} บาท</div>` : ""}${t.transactionRef ? `<div class="mono">${esc(t.transactionRef)}</div>` : ""}</td>
<td>${canDecide ? `<a href="${base}/slip" target="_blank" rel="noopener">ดูสลิป</a>` : '<span class="muted small">—</span>'}</td>
<td style="min-width:280px">${actions}</td></tr>`;
}

function recentRow(site: CenterSite, t: CreditTopupDto): string {
  const status = STATUS_LABEL[t.status] ?? t.status;
  const by = t.decidedVia === "EASYSLIP" ? "ระบบตรวจสลิป" : t.decidedBy?.name ?? "-";
  return `<tr><td>${esc(site.name)}</td><td>${esc(bkk(t.decidedAt ?? t.createdAt))}</td><td>${n(t.amountRequested)}</td>
<td>${t.status === "APPROVED" ? `<span class="ok">${esc(status)}</span> ${t.amountCredited !== null ? `${n(t.amountCredited)} เครดิต` : ""}` : `<span class="bad">${esc(status)}</span>${t.rejectReason ? ` — ${esc(t.rejectReason)}` : ""}`}</td>
<td class="small">${esc(by)}</td></tr>`;
}

export function topupsBody(views: SiteTopupView[], canDecide: boolean): string {
  const pending = views.flatMap((v) => (v.res.data?.pending ?? []).map((t) => ({ site: v.site, t })))
    .sort((a, b) => a.t.createdAt.localeCompare(b.t.createdAt));
  const recent = views.flatMap((v) => (v.res.data?.recent ?? []).map((t) => ({ site: v.site, t })))
    .sort((a, b) => (b.t.decidedAt ?? b.t.createdAt).localeCompare(a.t.decidedAt ?? a.t.createdAt)).slice(0, 30);
  const unreadable = views.filter((v) => v.res.status !== 200)
    .map((v) => `<li>${esc(v.site.name)} — อ่านไม่ได้ (HTTP ${v.res.status}${v.res.error?.code ? ` ${esc(v.res.error.code)}` : ""})${v.res.status === 404 ? " — Release เว็บนี้ก่อน" : ""}</li>`).join("");
  return `<h1>คำขอเติมเครดิต — ทุกเว็บ</h1>
<p class="muted">คำขอที่ระบบตรวจสลิปอัตโนมัติไม่ผ่าน หรือเว็บที่อนุมัติเอง จะรอที่นี่ · อนุมัติ / ไม่อนุมัติได้เฉพาะเจ้าของแพลตฟอร์มและผู้ดูแลระบบ (บันทึกในทั้ง Center และเว็บ) · คำขอใหม่แจ้งในกลุ่ม LINE ของ Center</p>
${unreadable ? `<div class="card"><ul class="warn">${unreadable}</ul></div>` : ""}
<div class="card scroll"><h2 style="margin-top:0">รอตรวจ (${pending.length})</h2>
${pending.length ? `<table><thead><tr><th>เว็บ</th><th>ยอดที่ขอ</th><th>ตรวจอัตโนมัติ</th><th>สลิป</th><th></th></tr></thead><tbody>${pending.map((p) => pendingRow(p.site, p.t, canDecide)).join("")}</tbody></table>` : '<p class="muted">ไม่มีคำขอที่รอตรวจ</p>'}</div>
<div class="card scroll"><h2 style="margin-top:0">ตัดสินล่าสุด</h2>
${recent.length ? `<table><thead><tr><th>เว็บ</th><th>เมื่อ</th><th>ยอดที่ขอ</th><th>ผล</th><th>โดย</th></tr></thead><tbody>${recent.map((r) => recentRow(r.site, r.t)).join("")}</tbody></table>` : '<p class="muted">ยังไม่มี</p>'}</div>`;
}
