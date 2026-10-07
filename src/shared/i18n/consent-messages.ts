/**
 * Cookie banner, cookie settings and privacy page texts (Phase 14, spec §46).
 * The three main buttons use the spec's wording ("ยอมรับทั้งหมด", "ตั้งค่าคุกกี้", "ปฏิเสธที่ไม่จำเป็น").
 * The banner sentence can be replaced per language in Settings → Privacy.
 * `th` is the reference shape; EN and ZH-CN must have the same keys (tested).
 */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

const th = {
  region: "การใช้คุกกี้",
  title: "เราใช้คุกกี้",
  text: "เว็บไซต์นี้ใช้คุกกี้ที่จำเป็นเพื่อให้การจองทำงานได้ และหากคุณอนุญาต จะใช้คุกกี้วิเคราะห์การใช้งานและการตลาดเพื่อปรับปรุงเว็บไซต์และวัดผลโฆษณา คุณเปลี่ยนการตั้งค่าได้ทุกเมื่อที่ท้ายหน้า",
  acceptAll: "ยอมรับทั้งหมด",
  settings: "ตั้งค่าคุกกี้",
  rejectOptional: "ปฏิเสธที่ไม่จำเป็น",
  policy: "อ่านนโยบายความเป็นส่วนตัว",
  dialogTitle: "ตั้งค่าคุกกี้",
  dialogIntro: "เลือกประเภทคุกกี้ที่อนุญาต การเลือกของคุณใช้กับเว็บไซต์นี้ในเบราว์เซอร์นี้เท่านั้น",
  save: "บันทึกการตั้งค่า",
  close: "ปิด",
  alwaysOn: "เปิดตลอด",
  saved: "บันทึกการตั้งค่าคุกกี้แล้ว",
  categories: {
    necessary: { name: "คุกกี้ที่จำเป็น", text: "ทำให้เว็บไซต์ การเข้าสู่ระบบ และการจองทำงานได้ และจำการตั้งค่าคุกกี้ของคุณ ปิดไม่ได้" },
    analytics: { name: "คุกกี้วิเคราะห์การใช้งาน", text: "Google Analytics นับจำนวนผู้เข้าชมและหน้าที่ถูกเปิด เพื่อให้เราปรับปรุงเว็บไซต์ ไม่ส่งชื่อ เบอร์โทร หรือข้อมูลการชำระเงิน" },
    marketing: { name: "คุกกี้การตลาด", text: "Meta Pixel และ Conversions API วัดผลโฆษณาบน Facebook และ Instagram เมื่อมีการจอง ไม่ส่งชื่อ เบอร์โทร หรือข้อมูลการชำระเงิน" },
  },
  privacy: {
    empty: "ยังไม่มีนโยบายความเป็นส่วนตัวในภาษานี้",
    updated: "ปรับปรุงล่าสุด {date}",
    manage: "ตั้งค่าคุกกี้",
  },
};

export type ConsentMessages = Widen<typeof th>;

const en: ConsentMessages = {
  region: "Cookie consent",
  title: "We use cookies",
  text: "This website uses necessary cookies so booking works and, if you allow it, analytics and marketing cookies to improve the site and measure our ads. You can change your choice at any time at the bottom of the page.",
  acceptAll: "Accept all",
  settings: "Cookie settings",
  rejectOptional: "Reject non-essential",
  policy: "Read the privacy policy",
  dialogTitle: "Cookie settings",
  dialogIntro: "Choose which cookies you allow. Your choice applies to this website in this browser only.",
  save: "Save settings",
  close: "Close",
  alwaysOn: "Always on",
  saved: "Cookie settings saved",
  categories: {
    necessary: { name: "Necessary cookies", text: "Make the website, sign-in and booking work and remember your cookie choice. They can't be switched off." },
    analytics: { name: "Analytics cookies", text: "Google Analytics counts visitors and page views so we can improve the website. No name, phone number or payment details are sent." },
    marketing: { name: "Marketing cookies", text: "Meta Pixel and the Conversions API measure our Facebook and Instagram ads when a booking is made. No name, phone number or payment details are sent." },
  },
  privacy: {
    empty: "There is no privacy policy in this language yet.",
    updated: "Last updated {date}",
    manage: "Cookie settings",
  },
};

const zhCN: ConsentMessages = {
  region: "Cookie 同意",
  title: "我们使用 Cookie",
  text: "本网站使用必要的 Cookie 以保证预订正常运行；经您同意后，还会使用分析和营销 Cookie 来改进网站并衡量广告效果。您可以随时在页面底部更改选择。",
  acceptAll: "全部接受",
  settings: "Cookie 设置",
  rejectOptional: "拒绝非必要 Cookie",
  policy: "阅读隐私政策",
  dialogTitle: "Cookie 设置",
  dialogIntro: "选择您允许的 Cookie 类型。您的选择仅适用于此浏览器中的本网站。",
  save: "保存设置",
  close: "关闭",
  alwaysOn: "始终开启",
  saved: "Cookie 设置已保存",
  categories: {
    necessary: { name: "必要 Cookie", text: "用于网站、登录和预订的正常运行，并记住您的 Cookie 选择。无法关闭。" },
    analytics: { name: "分析 Cookie", text: "Google Analytics 统计访客和页面浏览量，帮助我们改进网站。不会发送姓名、电话或付款信息。" },
    marketing: { name: "营销 Cookie", text: "Meta Pixel 和 Conversions API 在产生预订时衡量 Facebook 和 Instagram 广告效果。不会发送姓名、电话或付款信息。" },
  },
  privacy: {
    empty: "此语言暂无隐私政策。",
    updated: "最后更新 {date}",
    manage: "Cookie 设置",
  },
};

const DICTIONARIES = { th, en, "zh-CN": zhCN } as const;

export function getConsentMessages(code: keyof typeof DICTIONARIES): ConsentMessages {
  return DICTIONARIES[code] ?? th;
}

export { th as consentTh, en as consentEn, zhCN as consentZhCN };
