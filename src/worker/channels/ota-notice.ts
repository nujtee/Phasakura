import { formatBaht } from "../../shared/booking-rules.ts";
import { addDays } from "../../shared/dates.ts";
import { parseLocale } from "../../shared/i18n/locales.ts";

/**
 * "A booking came in from an OTA" — LINE and e-mail to staff who want booking news (notify_booking), for nights an
 * OTA calendar (iCal) took or gave back and for bookings that came through Channex. Built at send time from the
 * payload written when the change was saved (no guest data beyond what the OTA sent: Channex name and amount).
 */
export const OTA_BOOKING_NOTICE = "OTA_BOOKING";

export interface OtaNoticePayload {
  /** NEW = nights / a booking came in; CANCELLED = the OTA gave the nights back / cancelled; CONFLICT = could not be placed here. */
  event: "NEW" | "CANCELLED" | "CONFLICT";
  source: "ICAL" | "CHANNEX";
  /** Booking.com, Agoda, … (display name). */
  channel: string;
  /** "HOUSE-01 · บ้านซากุระ" (empty when a Channex booking could not be placed). */
  units: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  /** iCal: the event's summary ("Reserved", "CLOSED – Not available"…). */
  summary?: string | null;
  guestName?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  bookingCode?: string | null;
}

export interface OtaNotice {
  subject: string;
  title: string;
  body: string;
  linkLabel: string;
  /** Admin path (under /{lang}/admin/). */
  path: string;
}

const TEXTS = {
  th: {
    NEW: "การจองใหม่จาก {channel}", CANCELLED: "{channel} ยกเลิก / คืนวันว่าง", CONFLICT: "⚠️ การจองจาก {channel} ชนกับการจองในเว็บ",
    unit: "ที่พัก: {units}", stay: "เข้าพัก: {from} → {to} ({n} คืน)", guest: "ผู้จอง: {name}", amount: "ยอด: {amount}",
    code: "Booking ID: {code}", summary: "จากปฏิทิน OTA: {summary}", ical: "ข้อมูลจากปฏิทิน iCal ของ OTA (ไม่มีชื่อผู้จอง) — ดูรายละเอียดในระบบของ OTA",
    blocked: "ระบบปิดวันเหล่านี้ในเว็บแล้ว ไม่ให้จองซ้ำ", freed: "วันเหล่านี้กลับมาว่างในเว็บแล้ว", conflict: "ต้องจัดการเอง: ติดต่อ OTA หรือย้ายการจอง",
    link: "เปิดหน้าเชื่อมต่อ OTA", linkBooking: "เปิดการจอง",
  },
  en: {
    NEW: "New booking from {channel}", CANCELLED: "{channel} cancelled / gave the nights back", CONFLICT: "⚠️ A {channel} booking clashes with a booking here",
    unit: "Unit: {units}", stay: "Stay: {from} → {to} ({n} nights)", guest: "Guest: {name}", amount: "Amount: {amount}",
    code: "Booking ID: {code}", summary: "OTA calendar says: {summary}", ical: "From the OTA's iCal calendar (no guest details) — see the OTA's extranet",
    blocked: "These nights are now closed on the site (no double booking).", freed: "These nights are open again on the site.", conflict: "Needs action: contact the OTA or move a booking.",
    link: "Open OTA channels", linkBooking: "Open the booking",
  },
  "zh-CN": {
    NEW: "来自 {channel} 的新预订", CANCELLED: "{channel} 已取消 / 释放日期", CONFLICT: "⚠️ 来自 {channel} 的预订与本站预订冲突",
    unit: "住宿：{units}", stay: "入住：{from} → {to}（{n} 晚）", guest: "客人：{name}", amount: "金额：{amount}",
    code: "预订编号：{code}", summary: "OTA 日历：{summary}", ical: "来自 OTA 的 iCal 日历（无客人信息）— 详情请查看 OTA 后台",
    blocked: "这些日期已在本站关闭（防止重复预订）。", freed: "这些日期已在本站重新开放。", conflict: "需要处理：联系 OTA 或调整预订。",
    link: "打开 OTA 渠道", linkBooking: "打开预订",
  },
} as const;

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

export function renderOtaNotice(p: Partial<OtaNoticePayload>, lang: string): OtaNotice | { skip: string } {
  if (!p.event || !p.checkIn || !p.checkOut || !p.channel) return { skip: "NOT_RELEVANT" };
  const code = parseLocale(lang)?.code ?? "th";
  const t = TEXTS[code as keyof typeof TEXTS] ?? TEXTS.th;
  const day = new Intl.DateTimeFormat(code, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const d = (iso: string) => day.format(new Date(`${iso}T00:00:00Z`));
  const title = fill(t[p.event], { channel: p.channel });
  const amount = p.amountMinor !== null && p.amountMinor !== undefined && p.currency
    ? (p.currency === "THB" ? formatBaht(p.amountMinor, code) : `${(p.amountMinor / 100).toLocaleString(code)} ${p.currency}`) : null;
  const lines = [
    p.units ? fill(t.unit, { units: p.units }) : null,
    fill(t.stay, { from: d(p.checkIn), to: d(p.checkOut), n: p.nights ?? 1 }),
    p.guestName ? fill(t.guest, { name: p.guestName }) : null,
    amount ? fill(t.amount, { amount }) : null,
    p.bookingCode ? fill(t.code, { code: p.bookingCode }) : null,
    p.source === "ICAL" && p.summary ? fill(t.summary, { summary: p.summary.slice(0, 120) }) : null,
    p.source === "ICAL" ? t.ical : null,
    p.event === "CONFLICT" ? t.conflict : p.source === "ICAL" ? (p.event === "NEW" ? t.blocked : t.freed) : null,
  ].filter((x): x is string => !!x);
  const toBooking = p.bookingCode && p.event !== "CONFLICT";
  return {
    subject: `${title} · ${p.units ? `${p.units.split(" · ")[0]} · ` : ""}${d(p.checkIn)}`,
    title: `🌐 ${title}`,
    body: lines.join("\n"),
    linkLabel: toBooking ? t.linkBooking : t.link,
    path: toBooking ? `bookings/${p.bookingCode}` : "channels",
  };
}

export function otaNoticeLineText(n: OtaNotice, link: string | null): string {
  return [n.title, n.body, link ? `${n.linkLabel}: ${link}` : null].filter(Boolean).join("\n");
}

/** Sorted dates → runs of consecutive nights: [checkIn, checkOut (exclusive), nights]. */
export function nightRuns(dates: string[]): { checkIn: string; checkOut: string; nights: number }[] {
  const out: { checkIn: string; checkOut: string; nights: number }[] = [];
  for (const d of [...dates].sort()) {
    const last = out[out.length - 1];
    if (last && last.checkOut === d) { last.checkOut = addDays(d, 1); last.nights++; }
    else out.push({ checkIn: d, checkOut: addDays(d, 1), nights: 1 });
  }
  return out;
}
