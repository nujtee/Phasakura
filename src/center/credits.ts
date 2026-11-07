import type { CenterActor } from "../shared/center-protocol.ts";
import { MAX_CREDIT_AMOUNT, type CenterCreditOverviewDto, type CenterCreditQr, type CenterCreditSettings, type CreditState } from "../shared/credit-types.ts";
import { ACCOUNT_NUMBER_PATTERN, PROMPTPAY_PATTERN } from "../shared/payment-types.ts";
import type { D1DatabaseLike } from "../worker/env.ts";
import { parseSites, type CenterEnv, type CenterSite } from "./env.ts";
import { bkk, esc } from "./html.ts";
import { SiteClient, type SiteResponse } from "./site-client.ts";

/**
 * Credit settings kept once in Center and sent to every site (Center migration 0006, site migration 0060).
 * On / off stays per site (the site page's switch). A send that fails is retried by the 5-minute check.
 */

export const QR_MAX_BYTES = 2 * 1024 * 1024;
const QR_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** Automatic re-sends stop after this many tries (the page still offers "ส่งอีกครั้ง"). */
const MAX_AUTO_ATTEMPTS = 50;

export interface CenterCreditRow {
  fee_per_unit: number;
  low_threshold: number;
  approval_mode: "MANUAL" | "EASYSLIP";
  standard_min: number | null;
  premium_min: number | null;
  bank_name: string | null;
  account_name: string | null;
  account_number: string | null;
  promptpay_number: string | null;
  qr_receiver: string | null;
  qr_mime: string | null;
  qr_data: string | null;
  qr_sha256: string | null;
  notify_email: string | null;
  alert_time_1: string;
  alert_time_2: string;
  version: string;
  updated_by: string | null;
  updated_at: string;
}

export interface SyncRow {
  site: string;
  version: string;
  status: "OK" | "FAILED";
  error: string | null;
  attempts: number;
  attempted_at: string;
  synced_at: string | null;
}

export function loadCredit(db: D1DatabaseLike): Promise<CenterCreditRow | null> {
  return db.prepare("SELECT * FROM center_credit_settings WHERE id = 1").first<CenterCreditRow>().catch(() => null);
}

export async function loadSync(db: D1DatabaseLike): Promise<Map<string, SyncRow>> {
  const rows = await db.prepare("SELECT * FROM center_credit_sync").all<SyncRow>().catch(() => ({ results: [] as SyncRow[] }));
  return new Map(rows.results.map((r) => [r.site, r]));
}

export function settingsOf(r: CenterCreditRow): CenterCreditSettings {
  return {
    feePerUnit: r.fee_per_unit, lowThreshold: r.low_threshold, approvalMode: r.approval_mode, standardMin: r.standard_min,
    premiumMin: r.premium_min, bankName: r.bank_name, accountName: r.account_name, accountNumber: r.account_number,
    promptpayNumber: r.promptpay_number, qrReceiver: r.qr_receiver, notifyEmail: r.notify_email,
    alertTime1: r.alert_time_1, alertTime2: r.alert_time_2,
  };
}

export function newVersion(now: Date): string {
  return `${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The form (or a site's settings) → a full row; Thai messages for what is wrong. */
export function parseCreditForm(form: { get(name: string): string | null }): { settings: CenterCreditSettings; errors: string[] } {
  const errors: string[] = [];
  const text = (name: string) => (form.get(name) ?? "").trim();
  const int = (name: string, label: string, min: number, max: number, required: boolean): number | null => {
    const raw = text(name).replace(/,/g, "");
    if (!raw) {
      if (required) errors.push(`กรุณาใส่${label}`);
      return null;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${label}ต้องเป็นจำนวนเต็ม ${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")}`);
      return null;
    }
    return n;
  };
  const opt = (name: string, max: number, label: string): string | null => {
    const v = text(name);
    if (!v) return null;
    if ([...v].length > max) errors.push(`${label}ยาวเกิน ${max} ตัวอักษร`);
    return v;
  };
  const digits = (name: string) => text(name).replace(/[\s-]/g, "");

  const feePerUnit = int("fee_per_unit", "ค่าธรรมเนียมต่อหลัง", 1, 100_000, true) ?? 0;
  const lowThreshold = int("low_threshold", "จุดแจ้งเตือนเครดิตต่ำ", 0, 100_000_000, true) ?? 0;
  const mode = text("approval_mode");
  if (mode !== "MANUAL" && mode !== "EASYSLIP") errors.push("เลือกวิธีอนุมัติการเติมเครดิต");
  const standardMin = int("standard_min", "ยอดเติมขั้นต่ำ Standard", 1, MAX_CREDIT_AMOUNT, false);
  const premiumMin = int("premium_min", "ยอดเติมขั้นต่ำ Premium", 1, MAX_CREDIT_AMOUNT, false);
  const bankName = opt("bank_name", 100, "ชื่อธนาคาร");
  const accountName = opt("account_name", 150, "ชื่อบัญชี");
  const accountNumber = text("account_number") || null;
  if (accountNumber && !ACCOUNT_NUMBER_PATTERN.test(accountNumber)) errors.push("เลขบัญชีใช้ได้เฉพาะตัวเลขและ - (5–30 ตัว)");
  if (accountNumber && !bankName) errors.push("กรุณาใส่ชื่อธนาคารของเลขบัญชี");
  const promptpay = digits("promptpay_number") || null;
  if (promptpay && !PROMPTPAY_PATTERN.test(promptpay)) errors.push("พร้อมเพย์ต้องเป็นตัวเลข 10, 13 หรือ 15 หลัก");
  const qrReceiver = digits("qr_receiver") || null;
  if (qrReceiver && !/^\d{10,20}$/.test(qrReceiver)) errors.push("เลขพร้อมเพย์ใน QR ต้องเป็นตัวเลข 10–20 หลัก");
  const notifyEmail = text("notify_email").toLowerCase() || null;
  if (notifyEmail && (!EMAIL.test(notifyEmail) || notifyEmail.length > 254)) errors.push("อีเมลแจ้งเตือนไม่ถูกต้อง");
  const alertTime1 = text("alert_time_1") || "09:00";
  const alertTime2 = text("alert_time_2") || "17:00";
  if (!TIME.test(alertTime1) || !TIME.test(alertTime2)) errors.push("เวลาแจ้งเตือนต้องเป็น HH:MM");
  else if (alertTime2 <= alertTime1) errors.push("เวลาแจ้งเตือนรอบ 2 ต้องหลังรอบ 1");
  return {
    settings: {
      feePerUnit, lowThreshold, approvalMode: mode === "EASYSLIP" ? "EASYSLIP" : "MANUAL", standardMin, premiumMin, bankName, accountName,
      accountNumber, promptpayNumber: promptpay, qrReceiver, notifyEmail, alertTime1, alertTime2,
    },
    errors,
  };
}

/** Image bytes from an upload: PNG / JPEG / WebP by their first bytes (never by the declared type). */
export function sniffQr(bytes: Uint8Array): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isQrMime(mime: string | null): mime is string {
  return !!mime && QR_MIMES.has(mime);
}

/** Sends the set to one site and records the result. */
export async function pushCredit(env: CenterEnv, site: CenterSite, row: CenterCreditRow, actor: CenterActor & { reason: string }, now: Date, clock: () => Date): Promise<SiteResponse<CenterCreditOverviewDto>> {
  const qr: CenterCreditQr | null = row.qr_data && row.qr_sha256 && row.qr_mime ? { sha256: row.qr_sha256, mime: row.qr_mime, data: row.qr_data } : null;
  const res = await new SiteClient(env, 20_000, clock).call<CenterCreditOverviewDto>(site, "PUT", "/api/center/credits", actor, {
    settings: settingsOf(row), qr, version: row.version,
  });
  const ok = res.status === 200;
  const at = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO center_credit_sync (site, version, status, error, attempts, attempted_at, synced_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
     ON CONFLICT (site) DO UPDATE SET status = excluded.status, error = excluded.error, attempted_at = excluded.attempted_at,
       attempts = CASE WHEN center_credit_sync.version = excluded.version THEN center_credit_sync.attempts + 1 ELSE 1 END,
       version = excluded.version, synced_at = COALESCE(excluded.synced_at, center_credit_sync.synced_at)`,
  ).bind(site.slug, row.version, ok ? "OK" : "FAILED", ok ? null : `${res.status}:${res.error?.code ?? "?"}`.slice(0, 300), at, ok ? at : null).run();
  return res;
}

/**
 * 5-minute check: sends the current set again to sites whose last send of it failed (not to sites never sent to —
 * a set taken over from a site and not yet sent stays unsent until the owner sends it). Signed as the person who
 * saved the set, while they are still an active PLATFORM_OWNER.
 */
export async function retryCredit(env: CenterEnv, clock: () => Date = () => new Date()): Promise<number> {
  const row = await loadCredit(env.DB);
  if (!row || !row.updated_by) return 0;
  const owner = await env.DB.prepare("SELECT id, email, role FROM center_users WHERE id = ?1 AND status = 'ACTIVE' AND role = 'PLATFORM_OWNER'")
    .bind(row.updated_by).first<{ id: string; email: string; role: "PLATFORM_OWNER" }>().catch(() => null);
  if (!owner) return 0;
  const sync = await loadSync(env.DB);
  let sent = 0;
  for (const site of parseSites(env.CENTER_SITES)) {
    const s = sync.get(site.slug);
    if (!s || s.status !== "FAILED" || (s.version === row.version && s.attempts >= MAX_AUTO_ATTEMPTS)) continue;
    const res = await pushCredit(env, site, row, { id: owner.id, email: owner.email, role: owner.role, reason: "ส่งค่าเครดิตกลางซ้ำ (อัตโนมัติ)" }, clock(), clock);
    if (res.status === 200) sent++;
  }
  return sent;
}

// ---------------------------------------------------------------- rendering

const STATE_LABEL: Record<CreditState, string> = { OFF: "ปิดอยู่", NORMAL: "ปกติ", LOW: "ใกล้หมด", EMPTY: "หมด (ปิดรับจองออนไลน์)" };

const n = (v: number) => v.toLocaleString("en-US");

export interface SiteCreditView {
  site: CenterSite;
  res: SiteResponse<CenterCreditOverviewDto>;
  sync: SyncRow | undefined;
}

export function creditFormHtml(row: CenterCreditRow | null, canEdit: boolean, values: CenterCreditSettings | null = null): string {
  const v = values ?? (row ? settingsOf(row) : null);
  const val = (x: string | number | null | undefined) => (x === null || x === undefined ? "" : esc(x));
  const dis = canEdit ? "" : " disabled";
  const qr = row?.qr_sha256
    ? `<p><img src="/credits/qr?v=${esc(row.qr_sha256.slice(0, 12))}" alt="QR รับเงินเติมเครดิต" style="max-width:160px;border:1px solid var(--line);border-radius:8px"></p>
${canEdit ? '<label class="check"><input type="checkbox" name="qr_remove" value="1"> เอา QR ออก</label>' : ""}`
    : '<p class="muted small">ยังไม่มีรูป QR</p>';
  return `<form method="post" action="/credits" enctype="multipart/form-data" class="stack">
<fieldset style="border:0;padding:0;margin:0"${dis}>
<h2 style="margin-top:0">ค่าธรรมเนียมและการแจ้งเตือน</h2>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px">
<div><label for="c-fee">ค่าธรรมเนียมต่อหลัง (เครดิต = บาท)</label><input id="c-fee" name="fee_per_unit" inputmode="numeric" required value="${val(v?.feePerUnit ?? 20)}"></div>
<div><label for="c-low">แจ้งเตือนเมื่อเครดิตใช้ได้ต่ำกว่า</label><input id="c-low" name="low_threshold" inputmode="numeric" required value="${val(v?.lowThreshold ?? 500)}"></div>
<div><label for="c-mode">อนุมัติการเติมเครดิต</label><select id="c-mode" name="approval_mode">
<option value="MANUAL"${v?.approvalMode !== "EASYSLIP" ? " selected" : ""}>เจ้าของแพลตฟอร์มตรวจเอง</option>
<option value="EASYSLIP"${v?.approvalMode === "EASYSLIP" ? " selected" : ""}>อัตโนมัติด้วย EasySlip (เว็บที่ไม่มีคีย์ = ตรวจเอง)</option></select></div>
<div><label for="c-std">ยอดเติมขั้นต่ำ Standard (บาท)</label><input id="c-std" name="standard_min" inputmode="numeric" value="${val(v?.standardMin)}"></div>
<div><label for="c-pre">ยอดเติมขั้นต่ำ Premium (บาท)</label><input id="c-pre" name="premium_min" inputmode="numeric" value="${val(v?.premiumMin)}"></div>
<div><label for="c-mail">อีเมลรับแจ้งคำขอเติม</label><input id="c-mail" name="notify_email" type="email" value="${val(v?.notifyEmail)}"></div>
<div><label for="c-t1">เวลาแจ้งเตือนรอบ 1</label><input id="c-t1" name="alert_time_1" type="time" value="${val(v?.alertTime1 ?? "09:00")}"></div>
<div><label for="c-t2">เวลาแจ้งเตือนรอบ 2 (เครดิตหมด)</label><input id="c-t2" name="alert_time_2" type="time" value="${val(v?.alertTime2 ?? "17:00")}"></div>
</div>
<p class="muted small">ว่างไว้ = แพ็กเกจนั้นยังเลือกไม่ได้ · ค่าธรรมเนียมใหม่มีผลกับการจองใหม่เท่านั้น</p>
<h2>บัญชีรับเงินเติมเครดิต</h2>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px">
<div><label for="c-bank">ธนาคาร</label><input id="c-bank" name="bank_name" value="${val(v?.bankName)}"></div>
<div><label for="c-aname">ชื่อบัญชี</label><input id="c-aname" name="account_name" value="${val(v?.accountName)}"></div>
<div><label for="c-acc">เลขบัญชี</label><input id="c-acc" name="account_number" inputmode="numeric" value="${val(v?.accountNumber)}"></div>
<div><label for="c-pp">พร้อมเพย์</label><input id="c-pp" name="promptpay_number" inputmode="numeric" value="${val(v?.promptpayNumber)}"></div>
<div><label for="c-qrr">เลขพร้อมเพย์ใน QR (ถ้าไม่ใช่เลขด้านบน)</label><input id="c-qrr" name="qr_receiver" inputmode="numeric" value="${val(v?.qrReceiver)}"></div>
<div><label for="c-qr">รูป QR (PNG / JPEG / WebP ไม่เกิน 2 MB)</label><input id="c-qr" name="qr" type="file" accept="image/png,image/jpeg,image/webp"></div>
</div>
${qr}
<p class="muted small">ต้องมีอย่างน้อยหนึ่งอย่าง: เลขบัญชี พร้อมเพย์ หรือรูป QR</p>
${canEdit ? `<label for="c-reason">เหตุผล (บันทึกในทุกเว็บ)</label><input id="c-reason" name="reason" required minlength="3" maxlength="300" placeholder="เช่น ปรับค่าธรรมเนียมเดือนใหม่">
<p><button type="submit">บันทึกและส่งให้ทุกเว็บ</button></p>` : '<p class="muted small">แก้ได้เฉพาะเจ้าของแพลตฟอร์ม</p>'}
</fieldset></form>`;
}

export function hasPayee(row: CenterCreditRow | null): boolean {
  return !!(row && (row.account_number || row.promptpay_number || row.qr_data));
}

/** What a site without a payee needs before credits can be switched on. */
export function creditPayeeNote(row: CenterCreditRow | null, me: { role: string }): string {
  if (!hasPayee(row)) return 'ยังไม่มีบัญชีรับเงินเติมเครดิต — ตั้งค่ากลางในเมนู "เครดิต" ก่อน';
  return me.role === "PLATFORM_OWNER" ? "ยังไม่ได้รับค่ากลาง — กดเปิดแล้วระบบจะส่งค่ากลางให้ก่อน" : 'ยังไม่ได้รับค่ากลาง — ให้เจ้าของแพลตฟอร์มส่งจากเมนู "เครดิต" ก่อน';
}

/**
 * The on / off switch (site page and the credits table). Off → on needs somewhere for top-ups to be paid: the
 * site's own, or Center's shared settings that the owner's click sends first; otherwise the button is disabled.
 */
export function creditSwitchForm(action: string, site: string | null, on: boolean, payeeSet: boolean, row: CenterCreditRow | null, me: { role: string }, compact = false): string {
  const blocked = !on && !payeeSet && (!hasPayee(row) || me.role !== "PLATFORM_OWNER");
  const label = compact ? (on ? "ปิด" : "เปิด") : (on ? "ปิดระบบเครดิต" : "เปิดระบบเครดิต");
  const why = on ? (compact ? "เหตุผลที่ปิด" : "เหตุผลที่ปิด (การจองจะไม่ถูกหักเครดิต)") : "เหตุผลที่เปิด";
  return `<form method="post" action="${esc(action)}" class="inline">${site ? `<input type="hidden" name="site" value="${esc(site)}">` : ""}<input type="hidden" name="credits" value="${on ? "off" : "on"}">
<input name="reason" required minlength="3" maxlength="300" placeholder="${why}" aria-label="${why}"${blocked ? " disabled" : ""}${compact ? ' style="width:180px"' : ""}>
<button type="submit"${on ? ' class="danger"' : ""}${blocked ? " disabled" : ""}>${label}</button></form>`;
}

/** The "ยอดเครดิต" tab: what each site reports (switches are on the "ฟีเจอร์" tab). */
export function siteTableHtml(views: SiteCreditView[], row: CenterCreditRow | null, canEdit: boolean, role: string): string {
  const rows = views.map(({ site, res, sync }) => {
    const d = res.status === 200 ? res.data : undefined;
    const link = `<a href="/sites/${esc(site.slug)}">${esc(site.name)}</a>`;
    if (!d) {
      const why = res.status === 404 ? "ยังไม่รองรับ — Release เว็บนี้ก่อน" : res.status === 0 ? "ติดต่อเว็บไม่ได้" : `อ่านไม่ได้ (${res.status})`;
      return `<tr><td>${link}</td><td colspan="4" class="bad small">${esc(why)}</td><td>${syncCell(row, sync, null)}</td></tr>`;
    }
    const st = d.status;
    const state = st.enabled ? `<span class="pill ${PILL[st.state]}">${esc(STATE_LABEL[st.state])}</span>` : '<span class="pill off">ปิดอยู่</span>';
    return `<tr><td>${link}</td>
<td>${state}${!st.enabled && !st.payeeSet ? `<div class="warn small">${esc(creditPayeeNote(row, { role }))}</div>` : ""}</td>
<td class="num">${st.enabled ? `<strong>${n(st.balance)}</strong><div class="muted small">กันไว้ ${n(st.held)} · ใช้ได้ ${n(st.available)}</div>` : '<span class="muted">—</span>'}</td>
<td>${esc(st.plan ?? "—")}</td>
<td>${st.pendingTopups ? `<a class="warn" href="/topups">${n(st.pendingTopups)}</a>` : "0"}${!st.verifierConfigured && row?.approval_mode === "EASYSLIP" ? '<div class="muted small">ไม่มีคีย์ EasySlip — ตรวจเอง</div>' : ""}</td>
<td>${syncCell(row, sync, d)}${canEdit && row ? `<form method="post" action="/credits/sync" class="inline"><input type="hidden" name="site" value="${esc(site.slug)}"><button class="plain small" type="submit">ส่งอีกครั้ง</button></form>` : ""}</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>เว็บ</th><th>ระบบเครดิต</th><th class="num">คงเหลือ</th><th>แพ็กเกจ</th><th>คำขอเติมรอตรวจ</th><th>ค่ากลาง</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">ยังไม่มีเว็บ</td></tr>'}</tbody></table>
<p class="muted small">ยอดและคำขอเติมอ่านจากเว็บทุกครั้งที่เปิดหน้านี้ · เปิด / ปิดระบบเครดิต, Theme และจองหลายที่พัก อยู่ที่แท็บ "ฟีเจอร์"</p>`;
}

const PILL: Record<CreditState, string> = { OFF: "off", NORMAL: "good", LOW: "low", EMPTY: "empty" };

/** The "ค่ากลางและการส่ง" tab: whether each site has the shared settings. */
export function syncListHtml(views: SiteCreditView[], row: CenterCreditRow | null): string {
  if (!row || !views.length) return "";
  const items = views.map(({ site, res, sync }) => `<li><a href="/sites/${esc(site.slug)}">${esc(site.name)}</a> — ${syncCell(row, sync, res.status === 200 ? res.data ?? null : null)}</li>`);
  return `<details class="small"><summary>การส่งค่ากลางรายเว็บ</summary><ul>${items.join("")}</ul></details>`;
}

function syncCell(row: CenterCreditRow | null, sync: SyncRow | undefined, d: CenterCreditOverviewDto | null): string {
  if (!row) return '<span class="muted small">ยังไม่มีค่ากลาง</span>';
  if (d && d.managed && d.version === row.version) return `<span class="ok small">ตรงกับค่ากลาง</span><div class="muted small">${esc(bkk(d.syncedAt))}</div>`;
  if (sync?.version === row.version && sync.status === "FAILED") return `<span class="bad small">ส่งไม่สำเร็จ (${esc(sync.error ?? "")})</span><div class="muted small">ลองแล้ว ${sync.attempts} ครั้ง · ระบบลองซ้ำเองทุก 5 นาที</div>`;
  return '<span class="warn small">ยังไม่ได้รับค่าล่าสุด</span>';
}
