import type { AiSummaryDto, InsightDto, MarketingMetrics } from "../../shared/ai-marketing-types.ts";

/**
 * What the AI is given and how its answer is checked (AI Marketing A3).
 *
 * Input: built field by field from the report's numbers (an allow-list, not a copy) — counts, money in baht,
 * percentages, dates, house / channel / page names and the findings' codes. Never a guest's name, phone, e-mail,
 * note or booking code (the report holds none). Output: JSON only, checked and cut to size; shown as plain text.
 */

const baht = (satang: number | null) => (satang === null ? null : Math.round(satang / 100));

export function aiInput(m: MarketingMetrics, found: InsightDto[]): Record<string, unknown> {
  const totals = (t: MarketingMetrics["current"]) => ({
    bookings: t.bookings, confirmed: t.confirmed, cancelled: t.cancelled, unpaidExpired: t.expired,
    revenueBaht: baht(t.revenueSatang), avgNightPriceBaht: baht(t.adrSatang), occupancyPercent: t.occupancyPercent,
    soldNights: t.soldNights, otaNights: t.otaNights, openNights: t.openNights, avgLeadDays: t.avgLeadDays, avgStayNights: t.avgStayNights,
    foodAttachPercent: t.foodAttachPercent, extraBedAttachPercent: t.extraBedAttachPercent, massageAttachPercent: t.massageAttachPercent,
    visitors: t.visitors, pageViews: t.pageViews, bookingsPer100Visitors: t.conversionPercent,
  });
  const rows = (list: { name: string; sessions: number }[] | null) => list?.map((r) => ({ name: r.name.slice(0, 80), sessions: r.sessions })) ?? null;
  return {
    period: { kind: m.kind, start: m.periodStart, end: m.periodEnd, previousStart: m.previousStart, previousEnd: m.previousEnd },
    current: totals(m.current),
    previous: totals(m.previous),
    units: m.units.map((u) => ({ name: u.name.slice(0, 80), type: u.type, soldNights: u.soldNights, otaNights: u.otaNights, openNights: u.openNights, occupancyPercent: u.occupancyPercent })),
    weekdayOccupancyPercent: m.weekdayOccupancyPercent,
    weekendOccupancyPercent: m.weekendOccupancyPercent,
    bookingSources: m.sources.map((s) => ({ source: s.source.slice(0, 80), medium: s.medium.slice(0, 40), bookings: s.bookings, confirmed: s.confirmed, revenueBaht: baht(s.revenueSatang) })),
    paymentChannels: m.paymentChannels.map((p) => ({ name: p.name, count: p.value })),
    ga4: {
      status: m.ga4.status,
      funnel: m.ga4.events ? { viewedUnit: m.ga4.events.view_accommodation ?? 0, startedBooking: m.ga4.events.begin_booking ?? 0, reachedPayment: m.ga4.events.begin_checkout ?? 0 } : null,
      channels: rows(m.ga4.channels), sources: rows(m.ga4.sources), landingPages: rows(m.ga4.landingPages), devices: rows(m.ga4.devices),
    },
    next30Days: {
      from: m.forward.from, occupancyPercent: m.forward.occupancyPercent, bookedUnitNights: m.forward.soldNights, openUnitNights: m.forward.openNights,
      daysWithNoBooking: m.forward.emptyDays.length, firstEmptyDays: m.forward.emptyDays.slice(0, 10), quietRuns: m.forward.quietRuns,
    },
    findings: found.map((f) => ({ code: f.code, level: f.level, ...f.params })),
  };
}

export const SYSTEM_PROMPT = `คุณคือนักการตลาดของที่พักขนาดเล็กในประเทศไทย (บ้านพัก เต็นท์ VIP ลานกางเต็นท์) เขียนให้เจ้าของที่พักอ่าน
งานของคุณ: อ่านตัวเลขรายงานการตลาดของช่วงเวลาหนึ่ง (JSON) แล้วสรุปสั้น ๆ เป็นภาษาไทยที่เข้าใจง่าย พร้อมคำแนะนำที่ทำได้จริงในสัปดาห์หน้า
กติกา:
- ใช้เฉพาะตัวเลขที่ให้มา ห้ามเดาหรือแต่งตัวเลขเพิ่ม ถ้าข้อมูลน้อยหรือไม่มี ให้บอกตรง ๆ
- เงินเป็นบาท เปอร์เซ็นต์เป็น % อ้างอิงช่วงก่อนหน้าเมื่อเทียบ
- คำแนะนำ 3 ถึง 5 ข้อ เรียงจากสำคัญที่สุด แต่ละข้อทำได้เองโดยเจ้าของ (เช่น โปรโมชันช่วงวันว่าง ปรับรูป/คำอธิบายบ้านที่ขายได้น้อย ใส่ UTM ในลิงก์โพสต์ โพสต์ในช่องทางที่ได้ผล)
- ห้ามแนะนำให้เก็บหรือใช้ข้อมูลส่วนตัวของแขก และห้ามสัญญาผลลัพธ์
- ตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น ตามรูปแบบ:
{"headline":"ประโยคเดียวสรุปช่วงนี้","summary":"2-4 ประโยค","recommendations":[{"title":"สิ่งที่ควรทำ","detail":"ทำอย่างไร 1-2 ประโยค","basedOn":"ตัวเลขที่เป็นเหตุผล"}]}`;

export function userPrompt(input: Record<string, unknown>): string {
  return `ข้อมูลรายงาน (JSON):\n${JSON.stringify(input)}\n\nตอบเป็น JSON ตามรูปแบบที่กำหนดเท่านั้น`;
}

const LIMITS = { headline: 200, summary: 1200, title: 120, detail: 500, basedOn: 300, recommendations: 5 } as const;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** The AI's answer → a summary, or null when it is not the JSON asked for. */
export function parseSummary(answer: string): AiSummaryDto | null {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const headline = text(o.headline, LIMITS.headline);
  const summary = text(o.summary, LIMITS.summary);
  if (!headline || !summary) return null;
  const recommendations = (Array.isArray(o.recommendations) ? o.recommendations : [])
    .map((r) => {
      const x = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
      const title = text(x.title, LIMITS.title);
      const detail = text(x.detail, LIMITS.detail);
      return title && detail ? { title, detail, basedOn: text(x.basedOn, LIMITS.basedOn) ?? "" } : null;
    })
    .filter((r): r is AiSummaryDto["recommendations"][number] => r !== null)
    .slice(0, LIMITS.recommendations);
  return { headline, summary, recommendations };
}
