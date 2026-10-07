/**
 * Default page descriptions for search engines and link previews (Phase 13), used when the
 * administrator has not written one in Website → SEO. `{site}` = website name from D1.
 * `th` is the reference shape; EN and ZH-CN must have the same keys (tested).
 */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

const th = {
  description: {
    home: "จองบ้านพัก เต็นท์ VIP และลานกางเต็นท์ของ {site} ออนไลน์ ดูวันว่าง ราคา และเมนูอาหาร",
    gallery: "ภาพบรรยากาศ ที่พัก และธรรมชาติรอบ ๆ {site}",
    booking: "เลือกวันเข้าพัก ดูที่พักว่างและราคาของบ้านพัก เต็นท์ VIP และลานกางเต็นท์ที่ {site} แล้วจองออนไลน์",
    history: "เรื่องราวและความเป็นมาของ {site}",
    bookingLookup: "ตรวจสอบการจองด้วยรหัสการจองและเบอร์โทรศัพท์",
    notFound: "ไม่พบหน้าที่คุณต้องการ",
    accommodation: "{name} ที่ {site} พักได้สูงสุด {guests} ท่าน ราคาเริ่มต้น {price} ต่อคืน",
  },
};

export type SeoMessages = Widen<typeof th>;

const en: SeoMessages = {
  description: {
    home: "Book houses, VIP tents and camping at {site} online. See free dates, prices and the food menu.",
    gallery: "Photos of the stay, the rooms and the nature around {site}.",
    booking: "Choose your dates, see which houses, VIP tents and camping spots are free at {site}, and book online.",
    history: "The story of {site}.",
    bookingLookup: "Check your booking with your Booking ID and phone number.",
    notFound: "This page could not be found.",
    accommodation: "{name} at {site}: up to {guests} guests, from {price} per night.",
  },
};

const zhCN: SeoMessages = {
  description: {
    home: "在线预订 {site} 的小屋、VIP 帐篷和露营位，查看空房日期、价格和餐饮菜单。",
    gallery: "{site} 的环境、住宿和周边自然风光照片。",
    booking: "选择入住日期，查看 {site} 的小屋、VIP 帐篷和露营位的空房与价格，并在线预订。",
    history: "{site} 的故事与历史。",
    bookingLookup: "使用预订编号和电话号码查询您的预订。",
    notFound: "找不到您要访问的页面。",
    accommodation: "{site} 的 {name}：最多可住 {guests} 人，每晚 {price} 起。",
  },
};

const DICTIONARIES = { th, en, "zh-CN": zhCN } as const;

export function getSeoMessages(code: keyof typeof DICTIONARIES): SeoMessages {
  return DICTIONARIES[code] ?? th;
}

export { th as seoTh, en as seoEn, zhCN as seoZhCN };
