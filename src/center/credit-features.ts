import type { CenterCreditOverviewDto } from "../shared/credit-types.ts";
import type { CenterSite } from "./env.ts";
import { hasPayee, type CenterCreditRow, type SiteCreditView } from "./credits.ts";
import { esc } from "./html.ts";
import { multiStayFor, sameMultiStay, type MultiStayState } from "./multi-stay.ts";

/**
 * The "ฟีเจอร์" tab of the Credits page: one switch per site and feature (credit system, Theme whatever the plan,
 * one fee per booking with several stays), changed together and saved once with one reason. Plain HTML (no
 * script): a changed switch is outlined by CSS, the server works out what changed from the `was` fields.
 */

export const FEATURES = ["c", "t", "m"] as const;
export type Feature = (typeof FEATURES)[number];
export const FEATURE_NAME: Record<Feature, string> = { c: "ระบบเครดิต", t: "Theme", m: "จองหลายที่พัก" };

export interface FeatureChange {
  site: CenterSite;
  feature: Feature;
  on: boolean;
}

function sw(name: string, on: boolean, label: string, disabled: boolean): string {
  return `<label class="sw"><input type="checkbox" name="${esc(name)}" value="1" data-was="${on ? 1 : 0}"${on ? " checked" : ""}${disabled ? " disabled" : ""}>`
    + `<span class="sw-track" aria-hidden="true"></span><span class="sr">${esc(label)}</span></label>`
    + (disabled ? "" : `<input type="hidden" name="${esc(name)}.was" value="${on ? 1 : 0}">`);
}

function creditCell(slug: string, name: string, d: CenterCreditOverviewDto, row: CenterCreditRow | null, role: string, canSwitch: boolean): string {
  const st = d.status;
  // Off → on needs somewhere for top-ups to be paid: the site's own, or the shared settings the owner sends first.
  const blocked = !st.enabled && !st.payeeSet && (!hasPayee(row) || role !== "PLATFORM_OWNER");
  const note = st.enabled
    ? `<small class="${st.state === "EMPTY" ? "bad" : st.state === "LOW" ? "warn" : "muted"}">${esc(STATE[st.state])} · ${st.available.toLocaleString("en-US")}</small>`
    : blocked ? '<small class="warn">ยังไม่มีบัญชีรับเงินเติมเครดิต</small>'
      : !st.payeeSet ? '<small class="muted">เปิดแล้วจะส่งค่ากลางให้ก่อน</small>' : '<small class="muted">ปิดอยู่</small>';
  return `<div class="cell">${sw(`c.${slug}`, st.enabled, `ระบบเครดิต ${name}`, !canSwitch || blocked)}${note}</div>`;
}

const STATE: Record<CenterCreditOverviewDto["status"]["state"], string> = { OFF: "ปิด", NORMAL: "ปกติ", LOW: "ใกล้หมด", EMPTY: "หมด" };

function themeCell(slug: string, name: string, d: CenterCreditOverviewDto, canSwitch: boolean): string {
  if (d.themeUnlocked === undefined) return '<div class="cell"><small class="muted">Release เว็บนี้ก่อน</small></div>';
  const plan = d.status.plan;
  const lockedByPlan = d.status.enabled && plan === "STANDARD";
  const note = !lockedByPlan
    ? `<small class="muted">${d.themeUnlocked ? "เปิดจาก Center · " : ""}เปิดอยู่แล้ว (${plan === "PREMIUM" ? "PREMIUM" : "เครดิตปิด"})</small>`
    : d.themeUnlocked ? '<small class="ok">เปิดจาก Center</small>' : '<small class="warn">ล็อก (STANDARD)</small>';
  return `<div class="cell">${sw(`t.${slug}`, d.themeUnlocked, `Theme ${name}`, !canSwitch)}${note}</div>`;
}

function multiCell(slug: string, name: string, d: CenterCreditOverviewDto, state: MultiStayState, canSwitch: boolean): string {
  if (d.multiStay === undefined) return '<div class="cell"><small class="muted">Release เว็บนี้ก่อน</small></div>';
  const chosen = state.sites.has(slug);
  const want = multiStayFor(state, slug);
  const differs = !sameMultiStay(d.multiStay, want);
  const note = differs
    ? `<small class="warn">เว็บรายงาน: ${d.multiStay.enabled ? `เปิด ${d.multiStay.feeBaht} บาท` : "ปิด"}</small>${canSwitch ? `<button class="plain small" type="submit" name="resend" value="m.${esc(slug)}">ส่งอีกครั้ง</button>` : ""}`
    : chosen && !state.enabled ? '<small class="muted">รอเปิดค่ากลาง</small>' : "";
  return `<div class="cell">${sw(`m.${slug}`, chosen, `จองหลายที่พัก ${name}`, !canSwitch)}${note}</div>`;
}

export function featuresHtml(views: SiteCreditView[], row: CenterCreditRow | null, state: MultiStayState, role: string): string {
  const canSwitch = role === "PLATFORM_OWNER" || role === "OPERATOR";
  const rows = views.map(({ site, res }) => {
    const d = res.status === 200 ? res.data : undefined;
    const link = `<a href="/sites/${esc(site.slug)}">${esc(site.name)}</a>`;
    if (!d) {
      const why = res.status === 404 ? "ยังไม่รองรับ — Release เว็บนี้ก่อน" : res.status === 0 ? "ติดต่อเว็บไม่ได้" : `อ่านไม่ได้ (${res.status})`;
      return `<tr><td>${link}</td><td colspan="4" class="bad small">${esc(why)}</td></tr>`;
    }
    return `<tr><td>${link}</td><td>${creditCell(site.slug, site.name, d, row, role, canSwitch)}</td><td>${themeCell(site.slug, site.name, d, canSwitch)}</td>
<td>${multiCell(site.slug, site.name, d, state, canSwitch)}</td><td>${esc(d.status.plan ?? "—")}</td></tr>`;
  }).join("");
  const bulk = (f: Feature) => canSwitch
    ? `<div class="bulk"><button class="plain small" type="submit" name="bulk" value="${f}:on">เปิดทุกเว็บ</button> · <button class="plain small" type="submit" name="bulk" value="${f}:off">ปิดทุกเว็บ</button></div>`
    : "";
  const multiHead = state.enabled ? `คิดครั้งเดียว ${state.feeBaht.toLocaleString("en-US")} บาท/การจอง` : "ค่ากลางปิดอยู่ — เปิดที่แท็บค่ากลาง";
  const table = `<div class="card scroll flush"><table class="features"><thead><tr><th>เว็บ</th>
<th>ระบบเครดิต<br><span class="sub">เก็บค่าธรรมเนียม App</span>${bulk("c")}</th>
<th>Theme<br><span class="sub">เมนู Theme สำหรับ STANDARD</span>${bulk("t")}</th>
<th>จองหลายที่พัก<br><span class="sub">${esc(multiHead)}</span>${bulk("m")}</th><th>แพ็กเกจ</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">ยังไม่มีเว็บ</td></tr>'}</tbody></table></div>`;
  if (!canSwitch) return `${table}<p class="muted small">บทบาทของคุณดูได้อย่างเดียว</p>`;
  return `<form method="post" action="/credits/features">${table}
<div class="savebar"><div><strong>บันทึกการเปลี่ยนแปลง</strong><div class="muted small">สวิตช์ที่เปลี่ยนจะมีกรอบสีส้ม · ส่งให้เฉพาะเว็บที่เปลี่ยน</div></div>
<label for="f-reason">เหตุผล</label><input id="f-reason" name="reason" required minlength="3" maxlength="300" placeholder="เช่น ปรับตามคำขอเจ้าของเว็บ">
<button type="reset" class="plain">ล้าง</button><button type="submit">บันทึกและส่งให้เว็บ</button></div></form>`;
}

/**
 * What the form asks to change: each switch that was shown (`<name>.was`) and now differs, a whole column for a
 * "เปิด / ปิดทุกเว็บ" button, or one site's re-send. Unknown sites or values: null (a forged form).
 */
export function parseFeatureForm(form: URLSearchParams | FormData, sites: CenterSite[]): { changes: FeatureChange[]; resend: CenterSite | null } | null {
  const get = (k: string) => { const v = form.get(k); return typeof v === "string" ? v : null; };
  const bulk = get("bulk");
  let bulkFeature: Feature | null = null;
  let bulkOn = false;
  if (bulk !== null) {
    const m = /^([ctm]):(on|off)$/.exec(bulk);
    if (!m) return null;
    bulkFeature = m[1] as Feature;
    bulkOn = m[2] === "on";
  }
  let resend: CenterSite | null = null;
  const r = get("resend");
  if (r !== null) {
    const m = /^m\.([a-z0-9-]{2,31})$/.exec(r);
    resend = m ? sites.find((s) => s.slug === m[1]) ?? null : null;
    if (!resend) return null;
  }
  const changes: FeatureChange[] = [];
  for (const site of sites) {
    for (const f of FEATURES) {
      const was = get(`${f}.${site.slug}.was`);
      if (was === null) continue;
      if (was !== "0" && was !== "1") return null;
      const now = get(`${f}.${site.slug}`);
      if (now !== null && now !== "1") return null;
      const want = bulkFeature === f ? bulkOn : now === "1";
      if (want !== (was === "1")) changes.push({ site, feature: f, on: want });
    }
  }
  return { changes, resend };
}
