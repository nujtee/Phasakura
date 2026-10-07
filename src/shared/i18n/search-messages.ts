/**
 * Global search texts (Phase 13): the search box and results, plus words added to each result type
 * in the index so "tent", "เต็นท์" or "帐篷" find VIP tents even when a name does not say so.
 * `th` is the reference shape; EN and ZH-CN must have the same keys (tested).
 */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

const th = {
  open: "ค้นหา",
  label: "ค้นหาในเว็บไซต์",
  placeholder: "ค้นหาที่พัก อาหาร หรือกิจกรรม...",
  close: "ปิดการค้นหา",
  dates: "ระบุวันเข้าพัก (ไม่บังคับ)",
  checkIn: "เช็คอิน",
  checkOut: "เช็คเอาท์",
  clearDates: "ล้างวันที่",
  hint: "พิมพ์อย่างน้อย 2 ตัวอักษร หรือเลือกวันเข้าพักเพื่อดูที่พักว่าง",
  searching: "กำลังค้นหา…",
  empty: "ไม่พบผลลัพธ์สำหรับ “{q}”",
  emptyTip: "ลองใช้คำที่สั้นลง หรือลองค้นหาด้วยภาษาอื่น",
  emptyDates: "ไม่พบที่พักในวันที่เลือก",
  count: "{n} ผลลัพธ์",
  error: "ค้นหาไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
  invalidDates: "วันเช็คเอาท์ต้องอยู่หลังวันเช็คอิน",
  available: "ว่าง",
  unavailable: "ไม่ว่างในวันที่เลือก",
  tentsLeft: "เหลือ {n} เต็นท์",
  from: "เริ่มต้น {price}",
  bookDates: "ดูที่พักว่างและจองในวันที่นี้",
  per: { NIGHT: "/ คืน", ADULT_NIGHT: "/ ผู้ใหญ่ / คืน", PERSON: "/ ท่าน", SET: "/ ชุด", ITEM: "/ รายการ" },
  types: {
    HOUSE: "บ้านพัก", VIP_TENT: "เต็นท์ VIP", CAMPING: "ลานกางเต็นท์", FOOD: "อาหาร", ACTIVITY: "กิจกรรม",
    PROMOTION: "โปรโมชัน", FAQ: "คำถามที่พบบ่อย", HISTORY: "ประวัติความเป็นมา", GALLERY: "แกลเลอรี", ARTICLE: "บทความ",
  },
  keywords: {
    HOUSE: "บ้านพัก บ้าน ที่พัก ห้องพัก", VIP_TENT: "เต็นท์ VIP เต็นท์ แกลมปิ้ง ที่พัก", CAMPING: "ลานกางเต็นท์ แคมป์ปิ้ง กางเต็นท์ ที่พัก",
    FOOD: "อาหาร เมนู", HISTORY: "ประวัติ ความเป็นมา", GALLERY: "รูปภาพ ภาพ แกลเลอรี",
  },
};

export type SearchMessages = Widen<typeof th>;

const en: SearchMessages = {
  open: "Search",
  label: "Search the website",
  placeholder: "Search for a stay, food or activities...",
  close: "Close search",
  dates: "Add your dates (optional)",
  checkIn: "Check-in",
  checkOut: "Check-out",
  clearDates: "Clear dates",
  hint: "Type at least 2 characters, or pick dates to see what is free.",
  searching: "Searching…",
  empty: "Nothing found for “{q}”",
  emptyTip: "Try a shorter word, or search in another language.",
  emptyDates: "Nothing is free on those dates.",
  count: "{n} results",
  error: "Search failed. Please try again.",
  invalidDates: "Check-out must be after check-in.",
  available: "Free",
  unavailable: "Not free on these dates",
  tentsLeft: "{n} tents left",
  from: "From {price}",
  bookDates: "See what is free and book these dates",
  per: { NIGHT: "/ night", ADULT_NIGHT: "/ adult / night", PERSON: "/ person", SET: "/ set", ITEM: "/ item" },
  types: {
    HOUSE: "House", VIP_TENT: "VIP tent", CAMPING: "Camping", FOOD: "Food", ACTIVITY: "Activity",
    PROMOTION: "Promotion", FAQ: "FAQ", HISTORY: "Our story", GALLERY: "Gallery", ARTICLE: "Article",
  },
  keywords: {
    HOUSE: "house home cabin room stay accommodation", VIP_TENT: "vip tent glamping stay accommodation",
    CAMPING: "camping campsite tent pitch", FOOD: "food menu meal", HISTORY: "history story", GALLERY: "photo picture gallery",
  },
};

const zhCN: SearchMessages = {
  open: "搜索",
  label: "搜索网站",
  placeholder: "搜索住宿、餐饮或活动...",
  close: "关闭搜索",
  dates: "填写入住日期（可选）",
  checkIn: "入住",
  checkOut: "退房",
  clearDates: "清除日期",
  hint: "请输入至少 2 个字符，或选择日期查看空房。",
  searching: "正在搜索…",
  empty: "没有找到与“{q}”相关的结果",
  emptyTip: "试试更短的词，或用其他语言搜索。",
  emptyDates: "所选日期没有可预订的住宿。",
  count: "{n} 个结果",
  error: "搜索失败，请重试。",
  invalidDates: "退房日期必须晚于入住日期。",
  available: "有空房",
  unavailable: "所选日期已满",
  tentsLeft: "剩余 {n} 顶帐篷",
  from: "{price} 起",
  bookDates: "查看这些日期的空房并预订",
  per: { NIGHT: "/ 晚", ADULT_NIGHT: "/ 成人 / 晚", PERSON: "/ 人", SET: "/ 套", ITEM: "/ 份" },
  types: {
    HOUSE: "小屋", VIP_TENT: "VIP 帐篷", CAMPING: "露营", FOOD: "餐饮", ACTIVITY: "活动",
    PROMOTION: "优惠", FAQ: "常见问题", HISTORY: "我们的故事", GALLERY: "图库", ARTICLE: "文章",
  },
  keywords: {
    HOUSE: "小屋 房子 住宿 客房", VIP_TENT: "VIP 帐篷 豪华露营 住宿", CAMPING: "露营 营地 帐篷",
    FOOD: "餐饮 菜单 美食", HISTORY: "历史 故事", GALLERY: "照片 图片 图库",
  },
};

const DICTIONARIES = { th, en, "zh-CN": zhCN } as const;

export function getSearchMessages(code: keyof typeof DICTIONARIES): SearchMessages {
  return DICTIONARIES[code] ?? th;
}

export { th as searchTh, en as searchEn, zhCN as searchZhCN };
