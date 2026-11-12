import { parseLocale, type LocaleCode } from "../../shared/i18n/locales.ts";

/**
 * Texts of the credit notices (migration 0027), TH / EN / ZH, used for e-mail (subject / title / body) and LINE
 * (title + body). Plain text: every value is a number or a name read from D1.
 */

export type CreditNotice =
  | { kind: "LOW"; available: number; units: number; threshold: number }
  | { kind: "EMPTY"; available: number; feePerUnit: number }
  | { kind: "TOPUP_REQUEST"; requester: string; plan: string; amount: number; reasons: string[] }
  | { kind: "TOPUP_APPROVED"; amount: number; plan: string; balance: number }
  | { kind: "TOPUP_REJECTED"; amount: number; reason: string }
  /** From Center: the site's domain name expires soon (renew it at the registrar). */
  | { kind: "DOMAIN_EXPIRY"; domain: string; expiresAt: string; daysLeft: number };

const TEXTS = {
  th: {
    lowSubject: "เครดิตใกล้หมด: เหลือใช้ได้ {available} เครดิต",
    lowTitle: "⚠️ เครดิตค่าธรรมเนียมใกล้หมด",
    lowBody: "ยอดเครดิตที่ใช้ได้ {available} เครดิต (ต่ำกว่า {threshold})\nจองได้อีกประมาณ {units} หลัง\nกรุณาเติมเครดิตก่อนเครดิตหมด เพื่อให้ลูกค้าจองออนไลน์ได้ต่อเนื่อง",
    emptySubject: "เครดิตหมด: ระบบปิดรับจองออนไลน์",
    emptyTitle: "⛔ เครดิตหมด — ระบบปิดรับจองออนไลน์",
    emptyBody: "ยอดเครดิตที่ใช้ได้ {available} เครดิต ไม่พอสำหรับการจอง 1 หลัง ({fee} เครดิต)\nลูกค้าจะจองออนไลน์ไม่ได้จนกว่าจะเติมเครดิต",
    requestSubject: "คำขอเติมเครดิต {amount} บาท รอตรวจ",
    requestTitle: "💳 มีคำขอเติมเครดิตรอตรวจ",
    requestBody: "จาก: {name}\nแพ็กเกจ: {plan}\nยอด: {amount} บาท{reasons}",
    reasons: "\nผลตรวจอัตโนมัติ: {list}",
    approvedSubject: "เติมเครดิตสำเร็จ {amount} เครดิต",
    approvedTitle: "✅ เติมเครดิตสำเร็จ",
    approvedBody: "ได้รับ {amount} เครดิต (แพ็กเกจ {plan})\nยอดคงเหลือ {balance} เครดิต",
    rejectedSubject: "คำขอเติมเครดิตไม่ผ่าน",
    rejectedTitle: "❌ คำขอเติมเครดิตไม่ผ่าน",
    rejectedBody: "ยอด {amount} บาท\nเหตุผล: {reason}",
    openLabel: "เปิดหน้าเติมเครดิต",
    openAdminLabel: "เปิดหน้าจัดการเติมเครดิต",
    domainSubject: "โดเมน {domain} จะหมดอายุในอีก {days} วัน",
    domainTitle: "🌐 โดเมนใกล้หมดอายุ",
    domainBody: "โดเมน {domain} หมดอายุวันที่ {date} (อีก {days} วัน)\nกรุณาต่ออายุที่ผู้ให้บริการจดโดเมน ก่อนเว็บและอีเมลหยุดทำงาน",
    domainLabel: "เปิดหลังบ้าน",
  },
  en: {
    lowSubject: "Credits running low: {available} left",
    lowTitle: "⚠️ App-fee credits running low",
    lowBody: "Usable credits: {available} (below {threshold})\nEnough for about {units} more units\nPlease top up before they run out so guests can keep booking online.",
    emptySubject: "Credits used up: online booking closed",
    emptyTitle: "⛔ Credits used up — online booking closed",
    emptyBody: "Usable credits: {available}, not enough for one unit ({fee} credits)\nGuests cannot book online until you top up.",
    requestSubject: "Top-up of {amount} THB waiting for approval",
    requestTitle: "💳 A top-up waits for approval",
    requestBody: "From: {name}\nPlan: {plan}\nAmount: {amount} THB{reasons}",
    reasons: "\nAutomatic check: {list}",
    approvedSubject: "Top-up approved: {amount} credits",
    approvedTitle: "✅ Top-up approved",
    approvedBody: "{amount} credits added ({plan} plan)\nBalance: {balance} credits",
    rejectedSubject: "Top-up not accepted",
    rejectedTitle: "❌ Top-up not accepted",
    rejectedBody: "Amount: {amount} THB\nReason: {reason}",
    openLabel: "Open Top up credits",
    openAdminLabel: "Open Credit management",
    domainSubject: "Domain {domain} expires in {days} days",
    domainTitle: "🌐 Domain expiring soon",
    domainBody: "The domain {domain} expires on {date} ({days} days left)\nPlease renew it with your domain registrar before the website and e-mail stop working.",
    domainLabel: "Open admin",
  },
  "zh-CN": {
    lowSubject: "积分即将用完：剩余 {available}",
    lowTitle: "⚠️ 应用费积分即将用完",
    lowBody: "可用积分 {available}（低于 {threshold}）\n约可再预订 {units} 个单位\n请及时充值，以免客人无法在线预订。",
    emptySubject: "积分已用完：在线预订已关闭",
    emptyTitle: "⛔ 积分已用完 — 在线预订已关闭",
    emptyBody: "可用积分 {available}，不足一个单位（{fee} 积分）\n充值前客人无法在线预订。",
    requestSubject: "充值 {amount} 泰铢待审核",
    requestTitle: "💳 有充值申请待审核",
    requestBody: "申请人：{name}\n套餐：{plan}\n金额：{amount} 泰铢{reasons}",
    reasons: "\n自动核验：{list}",
    approvedSubject: "充值成功：{amount} 积分",
    approvedTitle: "✅ 充值成功",
    approvedBody: "已到账 {amount} 积分（{plan} 套餐）\n余额 {balance} 积分",
    rejectedSubject: "充值申请未通过",
    rejectedTitle: "❌ 充值申请未通过",
    rejectedBody: "金额 {amount} 泰铢\n原因：{reason}",
    openLabel: "打开充值页面",
    openAdminLabel: "打开积分管理",
    domainSubject: "域名 {domain} 将在 {days} 天后到期",
    domainTitle: "🌐 域名即将到期",
    domainBody: "域名 {domain} 将于 {date} 到期（剩余 {days} 天）\n请在域名注册商处续费，以免网站和邮箱停止工作。",
    domainLabel: "打开后台",
  },
} as const;

function lang(code: string | null | undefined): LocaleCode {
  return (parseLocale(code ?? "th")?.code ?? "th") as LocaleCode;
}

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => (k in values ? String(values[k]) : `{${k}}`));
}

function num(n: number, code: LocaleCode): string {
  return n.toLocaleString(code === "th" ? "th-TH" : code === "zh-CN" ? "zh-CN" : "en-US");
}

export interface CreditMessage {
  subject: string;
  title: string;
  body: string;
  /** Button label; the link is the top-up page (users) or the credit admin page (Super Admin). */
  linkLabel: string;
  forAdmin: boolean;
  /** Admin page to link (under /{lang}/admin/), when not the credit pages. */
  path?: string;
}

export function creditMessage(notice: CreditNotice, languageCode: string | null | undefined): CreditMessage {
  const code = lang(languageCode);
  const t = TEXTS[code];
  const n = (v: number) => num(v, code);
  switch (notice.kind) {
    case "LOW":
      return {
        subject: fill(t.lowSubject, { available: n(notice.available) }), title: t.lowTitle,
        body: fill(t.lowBody, { available: n(notice.available), threshold: n(notice.threshold), units: n(notice.units) }),
        linkLabel: t.openLabel, forAdmin: false,
      };
    case "EMPTY":
      return {
        subject: t.emptySubject, title: t.emptyTitle,
        body: fill(t.emptyBody, { available: n(notice.available), fee: n(notice.feePerUnit) }), linkLabel: t.openLabel, forAdmin: false,
      };
    case "TOPUP_REQUEST":
      return {
        subject: fill(t.requestSubject, { amount: n(notice.amount) }), title: t.requestTitle,
        body: fill(t.requestBody, {
          name: notice.requester, plan: notice.plan, amount: n(notice.amount),
          reasons: notice.reasons.length ? fill(t.reasons, { list: notice.reasons.join(", ") }) : "",
        }),
        linkLabel: t.openAdminLabel, forAdmin: true,
      };
    case "TOPUP_APPROVED":
      return {
        subject: fill(t.approvedSubject, { amount: n(notice.amount) }), title: t.approvedTitle,
        body: fill(t.approvedBody, { amount: n(notice.amount), plan: notice.plan, balance: n(notice.balance) }), linkLabel: t.openLabel, forAdmin: false,
      };
    case "DOMAIN_EXPIRY": {
      const date = new Date(`${notice.expiresAt}T00:00:00Z`).toLocaleDateString(code === "th" ? "th-TH" : code === "zh-CN" ? "zh-CN" : "en-GB",
        { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
      return {
        subject: fill(t.domainSubject, { domain: notice.domain, days: n(notice.daysLeft) }), title: t.domainTitle,
        body: fill(t.domainBody, { domain: notice.domain, date, days: n(notice.daysLeft) }), linkLabel: t.domainLabel, forAdmin: true, path: "",
      };
    }
    case "TOPUP_REJECTED":
      return {
        subject: t.rejectedSubject, title: t.rejectedTitle,
        body: fill(t.rejectedBody, { amount: n(notice.amount), reason: notice.reason }), linkLabel: t.openLabel, forAdmin: false,
      };
  }
}

/** LINE text: title, body and (when there is one) the link on its own line. */
export function creditLineText(m: CreditMessage, link: string | null): string {
  return [m.title, m.body, ...(link ? [link] : [])].join("\n").slice(0, 4900);
}
