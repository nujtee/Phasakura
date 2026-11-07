import type { MultiStayFeeDto } from "../shared/credit-types.ts";
import type { D1DatabaseLike } from "../worker/env.ts";
import { bkk, esc } from "./html.ts";

/**
 * One app fee per booking with several stays (Center migration 0008, site migration 0064): a centre-wide switch and
 * amount, and the sites that use it. A site charges once per booking when both switches are on.
 */

export const MULTI_STAY_DEFAULT_FEE = 20;

export interface MultiStayState {
  enabled: boolean;
  feeBaht: number;
  updatedAt: string | null;
  /** Sites switched on (slug). */
  sites: Set<string>;
}

export async function loadMultiStay(db: D1DatabaseLike): Promise<MultiStayState> {
  const [master, sites] = await Promise.all([
    db.prepare("SELECT enabled, fee_baht, updated_at FROM center_multi_stay WHERE id = 1")
      .first<{ enabled: number; fee_baht: number; updated_at: string }>().catch(() => null),
    db.prepare("SELECT site FROM center_multi_stay_sites WHERE enabled = 1").all<{ site: string }>().catch(() => ({ results: [] as { site: string }[] })),
  ]);
  return {
    enabled: master?.enabled === 1, feeBaht: master?.fee_baht ?? MULTI_STAY_DEFAULT_FEE, updatedAt: master?.updated_at ?? null,
    sites: new Set(sites.results.map((r) => r.site)),
  };
}

/** What a site should use now. */
export function multiStayFor(state: MultiStayState, slug: string): MultiStayFeeDto {
  return { enabled: state.enabled && state.sites.has(slug), feeBaht: state.feeBaht };
}

export function sameMultiStay(a: MultiStayFeeDto | undefined, b: MultiStayFeeDto): boolean {
  return !!a && a.enabled === b.enabled && (!b.enabled || a.feeBaht === b.feeBaht);
}

export function parseFee(raw: string | null): number | null {
  const s = (raw ?? "").trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 100_000 ? n : null;
}

/** The card above the site table: the centre-wide switch and amount (the owner changes it). */
export function multiStayCardHtml(state: MultiStayState, canEdit: boolean, siteCount: number): string {
  const status = state.enabled
    ? `<span class="ok">เปิด</span> · ${state.feeBaht.toLocaleString("en-US")} บาทต่อการจอง · ใช้กับ ${state.sites.size} จาก ${siteCount} เว็บ`
    : '<span class="muted">ปิด</span> — ทุกเว็บคิดค่าธรรมเนียมรายหลังตามเดิม';
  const form = canEdit ? `<form method="post" action="/credits/multi-stay" class="stack" style="margin-top:.6rem">
<label class="inline"><input type="checkbox" name="enabled" value="1"${state.enabled ? " checked" : ""}> เปิดใช้ (เฉพาะเว็บที่เลือกในแท็บฟีเจอร์)</label>
<label for="ms-fee">ค่าธรรมเนียมต่อการจอง (บาท)</label>
<input id="ms-fee" name="fee" inputmode="numeric" required pattern="[0-9]{1,6}" value="${esc(String(state.feeBaht))}" style="max-width:8rem">
<label for="ms-reason">เหตุผล</label>
<input id="ms-reason" name="reason" required minlength="3" maxlength="300">
<button type="submit">บันทึกและส่งให้เว็บ</button></form>` : "";
  return `<h2 style="margin-top:0">จองหลายที่พัก คิดเครดิตครั้งเดียว</h2>
<p class="muted small">ผู้จองคนเดียวเลือกหลายหลัง (บ้าน / เต็นท์ VIP / เต็นท์) ในการจองเดียว — คิดค่าธรรมเนียมการใช้ App ครั้งเดียวต่อการจองแทนรายหลัง · จองหลังเดียวคิดตามเดิม</p>
<p>${status}${state.updatedAt ? ` <span class="muted small">(แก้ล่าสุด ${esc(bkk(state.updatedAt))})</span>` : ""}</p>${form}`;
}
