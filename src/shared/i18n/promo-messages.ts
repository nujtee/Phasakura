/**
 * Promotion texts for guests (migration 0055): booking page, house page, food step and bill.
 * `th` is the reference shape; EN and ZH-CN must have the same keys (tested).
 */
const th = {
  badge: "โปรโมชั่น",
  title: "โปรโมชั่น",
  percentOff: "ลด {v}%",
  amountOff: "ลด {v} / คืน",
  freeExtraBed: "ฟรีที่นอนเสริม",
  freePets: "ฟรีค่าสัตว์เลี้ยง",
  freeFood: "ฟรีอาหารที่ร่วมรายการ",
  dates: "{from} – {to}",
  oneDate: "{from}",
  free: "ฟรี",
  freeFoodHint: "ฟรีในวันที่มีโปรโมชั่น (ไม่เกินจำนวนผู้เข้าพัก)",
  foodFreeQty: "ฟรี {n}",
  savings: "ประหยัดจากโปรโมชั่น",
  roomDiscount: "ส่วนลดค่าห้อง",
  extraBedFree: "ที่นอนเสริมฟรี",
  petsFree: "สัตว์เลี้ยงฟรี",
  foodFree: "อาหารฟรี",
  freeNights: "ฟรี {n} คืน",
  wasPrice: "ราคาปกติ",
  upcoming: "โปรโมชั่นของที่พักนี้",
};

export type PromoMessages = typeof th;

const en: PromoMessages = {
  badge: "Promotion",
  title: "Promotion",
  percentOff: "{v}% off",
  amountOff: "{v} off / night",
  freeExtraBed: "Free extra bed",
  freePets: "Free pet fee",
  freeFood: "Free selected dishes",
  dates: "{from} – {to}",
  oneDate: "{from}",
  free: "Free",
  freeFoodHint: "Free on promotion dates (up to the number of guests)",
  foodFreeQty: "{n} free",
  savings: "Promotion savings",
  roomDiscount: "Room discount",
  extraBedFree: "Extra bed free",
  petsFree: "Pets free",
  foodFree: "Free food",
  freeNights: "{n} nights free",
  wasPrice: "Regular price",
  upcoming: "Promotions for this stay",
};

const zhCN: PromoMessages = {
  badge: "优惠",
  title: "优惠",
  percentOff: "减 {v}%",
  amountOff: "每晚减 {v}",
  freeExtraBed: "免费加床",
  freePets: "免宠物费",
  freeFood: "指定餐点免费",
  dates: "{from} – {to}",
  oneDate: "{from}",
  free: "免费",
  freeFoodHint: "优惠日期免费（不超过入住人数）",
  foodFreeQty: "免费 {n}",
  savings: "优惠节省",
  roomDiscount: "房价折扣",
  extraBedFree: "加床免费",
  petsFree: "宠物免费",
  foodFree: "餐点免费",
  freeNights: "{n} 晚免费",
  wasPrice: "原价",
  upcoming: "此住宿的优惠",
};

const DICTIONARIES = { th, en, "zh-CN": zhCN } as const;

export function getPromoMessages(code: keyof typeof DICTIONARIES): PromoMessages {
  return DICTIONARIES[code] ?? th;
}

export { th as promoTh, en as promoEn, zhCN as promoZhCN };
