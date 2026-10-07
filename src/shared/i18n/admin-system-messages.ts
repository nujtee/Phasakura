/**
 * Admin texts for System status (Phase 16). Every check has a label and what to do when it is not OK.
 * `th` is the reference shape; EN and ZH-CN must have the same keys (tested).
 */
import type { SystemCheckKey } from "../system-types.ts";

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
type CheckTexts = Record<SystemCheckKey, { label: string; fix: string }>;

const thChecks: CheckTexts = {
  environment: { label: "สภาพแวดล้อม (APP_ENV)", fix: "ตั้ง APP_ENV เป็น production ใน wrangler.jsonc — ค่าอื่นทำให้ Google ไม่เก็บเว็บไซต์ (noindex)" },
  baseUrl: { label: "โดเมนหลัก (APP_BASE_URL)", fix: "ตั้ง APP_BASE_URL เป็น https://โดเมนจริง ใน wrangler.jsonc ใช้กับ canonical, sitemap, ลิงก์รีเซ็ตรหัสผ่าน และข้อความ LINE" },
  schema: { label: "ฐานข้อมูลเป็นเวอร์ชันล่าสุด", fix: "สำรองข้อมูลก่อน แล้วรัน npm run db:migrate:remote" },
  cron: { label: "งานเบื้องหลังทุกนาที (cron)", fix: "ตรวจ Triggers ของ Worker ใน Cloudflare ต้องมี “* * * * *” ใช้ปล่อยการจองที่ไม่ชำระเงิน ส่ง LINE และ Conversions API" },
  superAdmins: { label: "บัญชี SUPER_ADMIN ที่ใช้งานได้", fix: "ควรมีอย่างน้อย 2 บัญชี เผื่อกรณีลืมรหัสผ่าน (ระบบไม่มีการรีเซ็ตทางอีเมล)" },
  bootstrapPassword: { label: "SUPER_ADMIN ที่ยังใช้รหัสผ่านชั่วคราว", fix: "เข้าสู่ระบบด้วยบัญชีนั้นแล้วเปลี่ยนรหัสผ่านทันที" },
  siteName: { label: "ชื่อเว็บไซต์", fix: "ตั้งค่า → เว็บไซต์: ใส่ชื่อเว็บไซต์ภาษาไทย" },
  primaryAccount: { label: "บัญชีรับเงินหลัก", fix: "ไม่มีบัญชีหลัก ลูกค้าจะจองไม่ได้: การเงิน → บัญชีรับเงิน → ตั้งเป็นบัญชีหลัก" },
  slipVerification: { label: "ตรวจสลิปอัตโนมัติ", fix: "ตอนนี้พนักงานตรวจสลิปทุกใบ หากต้องการตรวจอัตโนมัติ ตั้ง SLIP_VERIFY_PROVIDER และ secret SLIP_VERIFICATION_API_KEY" },
  line: { label: "LINE", fix: "เปิด LINE แล้วแต่ยังไม่มี secrets: wrangler secret put LINE_CHANNEL_ACCESS_TOKEN และ LINE_CHANNEL_SECRET" },
  ga4: { label: "Google Analytics 4", fix: "—" },
  ga4Data: { label: "ตัวเลข GA4 บน Dashboard", fix: "ใส่ Property ID แล้วแต่ยังไม่มี secret GA4_SERVICE_ACCOUNT_KEY (หรือไฟล์ key ไม่ถูกต้อง)" },
  metaCapi: { label: "Meta Conversions API", fix: "เปิด CAPI แล้วแต่ยังไม่มี secret META_CAPI_ACCESS_TOKEN: ตั้ง secret หรือปิด CAPI" },
  metaTestCode: { label: "Meta test event code", fix: "ลบ secret META_TEST_EVENT_CODE เมื่อใช้งานจริง มิฉะนั้นทุก Event ไปอยู่ที่ Test events" },
  privacyPolicy: { label: "นโยบายความเป็นส่วนตัว", fix: "เปิด GA4 / Meta Pixel แล้วแต่ยังไม่มีนโยบายภาษาไทย: ตั้งค่า → ความเป็นส่วนตัว" },
  searchConsole: { label: "Google Search Console", fix: "ยืนยันเว็บไซต์ด้วย DNS (แนะนำ ถ้าทำแล้วข้ามข้อนี้ได้) หรือใส่รหัส HTML tag ที่ การตลาด แล้วส่ง /sitemap.xml" },
  rateLimits: { label: "จำกัดจำนวนคำขอ (rate limit)", fix: "ตรวจ ratelimits ใน wrangler.jsonc ต้องมีครบ 4 ชุด และ namespace_id ไม่ซ้ำกับ Worker อื่นในบัญชี" },
  recentErrors: { label: "ข้อผิดพลาดของเซิร์ฟเวอร์ (24 ชม.)", fix: "ดูรายการด้านล่าง และ Workers Logs ใน Cloudflare dashboard (ค้นด้วย request id)" },
  deliveries: { label: "ส่ง LINE / CAPI ไม่สำเร็จ (24 ชม.)", fix: "ดู ตั้งค่า → LINE → ประวัติการส่ง และ การตลาด → CAPI" },
};

const th = {
  title: "สถานะระบบ",
  intro: "ตรวจความพร้อมก่อนเปิดใช้งานจริงและติดตามระบบหลังเปิด ข้อมูลลับแสดงเพียงว่าตั้งค่าแล้วหรือยัง",
  refresh: "โหลดใหม่",
  environment: "สภาพแวดล้อม",
  baseUrl: "โดเมน",
  levels: { ok: "ผ่าน", warning: "ควรตรวจ", error: "ต้องแก้" },
  summary: "{errors} ต้องแก้ · {warnings} ควรตรวจ · {ok} ผ่าน",
  checks: "รายการตรวจ",
  value: "ค่า",
  health: "สุขภาพระบบ (/api/health)",
  healthParts: { database: "ฐานข้อมูล", schema: "โครงสร้างฐานข้อมูล", cron: "งานเบื้องหลัง" },
  heartbeats: "งานเบื้องหลังล่าสุด",
  hb: { name: "งาน", lastRun: "ทำงานล่าสุด", lastOk: "สำเร็จล่าสุด", status: "สถานะ", duration: "ใช้เวลา", runs: "จำนวนครั้ง" },
  noHeartbeat: "ยังไม่เคยทำงาน",
  backlog: "งานค้าง",
  bl: { linePending: "LINE รอส่ง", lineFailed24h: "LINE ไม่สำเร็จ (24 ชม.)", capiPending: "CAPI รอส่ง", capiFailed24h: "CAPI ไม่สำเร็จ (24 ชม.)", slipsWaiting: "สลิปรอตรวจ" },
  errors: "ข้อผิดพลาดล่าสุด",
  er: { time: "เวลา", source: "ที่มา", request: "Request ID", path: "ตำแหน่ง", message: "ข้อความ" },
  noErrors: "ไม่มีข้อผิดพลาดของเซิร์ฟเวอร์",
  errorsNote: "เก็บ 30 วัน ไม่มีข้อมูลส่วนบุคคล (ตัดอีเมล เบอร์โทร และ query string ออก)",
  checkTexts: thChecks,
};

export type AdminSystemMessages = Widen<typeof th>;

const en: AdminSystemMessages = {
  title: "System status",
  intro: "Check readiness before going live and watch the system afterwards. Secrets only show whether they are set.",
  refresh: "Refresh",
  environment: "Environment",
  baseUrl: "Domain",
  levels: { ok: "OK", warning: "Check", error: "Fix" },
  summary: "{errors} to fix · {warnings} to check · {ok} OK",
  checks: "Checks",
  value: "Value",
  health: "Health (/api/health)",
  healthParts: { database: "Database", schema: "Database schema", cron: "Background jobs" },
  heartbeats: "Background jobs",
  hb: { name: "Job", lastRun: "Last run", lastOk: "Last success", status: "Status", duration: "Duration", runs: "Runs" },
  noHeartbeat: "Has not run yet",
  backlog: "Backlog",
  bl: { linePending: "LINE waiting", lineFailed24h: "LINE failed (24 h)", capiPending: "CAPI waiting", capiFailed24h: "CAPI failed (24 h)", slipsWaiting: "Slips to review" },
  errors: "Recent errors",
  er: { time: "Time", source: "Source", request: "Request ID", path: "Where", message: "Message" },
  noErrors: "No server errors",
  errorsNote: "Kept 30 days. No personal data (e-mails, phone numbers and query strings are removed).",
  checkTexts: {
    environment: { label: "Environment (APP_ENV)", fix: "Set APP_ENV to production in wrangler.jsonc — anything else keeps the site out of Google (noindex)." },
    baseUrl: { label: "Main domain (APP_BASE_URL)", fix: "Set APP_BASE_URL to https://your-domain in wrangler.jsonc; used for canonical URLs, the sitemap, password links and LINE messages." },
    schema: { label: "Database up to date", fix: "Back up first, then run npm run db:migrate:remote." },
    cron: { label: "Every-minute background job (cron)", fix: "Check the Worker's Triggers in Cloudflare: “* * * * *” must be there. It releases unpaid holds and sends LINE and Conversions API events." },
    superAdmins: { label: "Active SUPER_ADMIN accounts", fix: "Keep at least two, in case one forgets the password (there is no e-mail reset)." },
    bootstrapPassword: { label: "SUPER_ADMIN still on a temporary password", fix: "Sign in with that account and change the password now." },
    siteName: { label: "Website name", fix: "Settings → Website: enter the Thai website name." },
    primaryAccount: { label: "Primary receiving account", fix: "Without one, guests cannot book: Finance → Receiving accounts → make one primary." },
    slipVerification: { label: "Automatic slip verification", fix: "Staff check every slip now. For automatic checks set SLIP_VERIFY_PROVIDER and the secret SLIP_VERIFICATION_API_KEY." },
    line: { label: "LINE", fix: "LINE is on but the secrets are missing: wrangler secret put LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET." },
    ga4: { label: "Google Analytics 4", fix: "—" },
    ga4Data: { label: "GA4 numbers on the dashboard", fix: "A property ID is set but the secret GA4_SERVICE_ACCOUNT_KEY is missing or unreadable." },
    metaCapi: { label: "Meta Conversions API", fix: "CAPI is on but the secret META_CAPI_ACCESS_TOKEN is missing: set it or switch CAPI off." },
    metaTestCode: { label: "Meta test event code", fix: "Delete the secret META_TEST_EVENT_CODE in production, or every event goes to Test events." },
    privacyPolicy: { label: "Privacy policy", fix: "GA4 / Meta Pixel are on but there is no Thai privacy policy: Settings → Privacy." },
    searchConsole: { label: "Google Search Console", fix: "Verify the site by DNS (recommended — then ignore this) or paste the HTML-tag code in Marketing, and submit /sitemap.xml." },
    rateLimits: { label: "Request rate limits", fix: "Check ratelimits in wrangler.jsonc: all four, with namespace_id values unique in your account." },
    recentErrors: { label: "Server errors (24 h)", fix: "See the list below and Workers Logs in the Cloudflare dashboard (search by request id)." },
    deliveries: { label: "Failed LINE / CAPI deliveries (24 h)", fix: "See Settings → LINE → Delivery log and Marketing → CAPI." },
  },
};

const zhCN: AdminSystemMessages = {
  title: "系统状态",
  intro: "上线前检查准备情况，上线后持续监控。机密信息只显示是否已设置。",
  refresh: "刷新",
  environment: "环境",
  baseUrl: "域名",
  levels: { ok: "正常", warning: "需检查", error: "需修复" },
  summary: "{errors} 项需修复 · {warnings} 项需检查 · {ok} 项正常",
  checks: "检查项",
  value: "值",
  health: "健康状况（/api/health）",
  healthParts: { database: "数据库", schema: "数据库结构", cron: "后台任务" },
  heartbeats: "后台任务",
  hb: { name: "任务", lastRun: "最近运行", lastOk: "最近成功", status: "状态", duration: "耗时", runs: "次数" },
  noHeartbeat: "尚未运行",
  backlog: "待处理",
  bl: { linePending: "LINE 待发送", lineFailed24h: "LINE 失败（24 小时）", capiPending: "CAPI 待发送", capiFailed24h: "CAPI 失败（24 小时）", slipsWaiting: "待审核转账单" },
  errors: "最近错误",
  er: { time: "时间", source: "来源", request: "请求 ID", path: "位置", message: "信息" },
  noErrors: "没有服务器错误",
  errorsNote: "保留 30 天，不含个人信息（已移除邮箱、电话和查询字符串）。",
  checkTexts: {
    environment: { label: "环境（APP_ENV）", fix: "在 wrangler.jsonc 中将 APP_ENV 设为 production，否则网站不会被 Google 收录（noindex）。" },
    baseUrl: { label: "主域名（APP_BASE_URL）", fix: "在 wrangler.jsonc 中将 APP_BASE_URL 设为 https://您的域名，用于规范链接、站点地图、密码链接和 LINE 消息。" },
    schema: { label: "数据库为最新版本", fix: "先备份，再运行 npm run db:migrate:remote。" },
    cron: { label: "每分钟后台任务（cron）", fix: "检查 Cloudflare 中 Worker 的触发器，必须有“* * * * *”。它负责释放未付款的预订并发送 LINE 和 Conversions API 事件。" },
    superAdmins: { label: "可用的 SUPER_ADMIN 账号", fix: "至少保留两个，以防忘记密码（系统没有邮件重置）。" },
    bootstrapPassword: { label: "仍在使用临时密码的 SUPER_ADMIN", fix: "请用该账号登录并立即修改密码。" },
    siteName: { label: "网站名称", fix: "设置 → 网站：填写泰语网站名称。" },
    primaryAccount: { label: "主收款账户", fix: "没有主账户客人无法预订：财务 → 收款账户 → 设为主账户。" },
    slipVerification: { label: "转账单自动核验", fix: "目前由员工逐张核验。如需自动核验，请设置 SLIP_VERIFY_PROVIDER 和机密 SLIP_VERIFICATION_API_KEY。" },
    line: { label: "LINE", fix: "已开启 LINE 但缺少机密：wrangler secret put LINE_CHANNEL_ACCESS_TOKEN 和 LINE_CHANNEL_SECRET。" },
    ga4: { label: "Google Analytics 4", fix: "—" },
    ga4Data: { label: "仪表板上的 GA4 数据", fix: "已填写媒体资源 ID，但缺少机密 GA4_SERVICE_ACCOUNT_KEY 或其无法读取。" },
    metaCapi: { label: "Meta Conversions API", fix: "已开启 CAPI 但缺少机密 META_CAPI_ACCESS_TOKEN：请设置或关闭 CAPI。" },
    metaTestCode: { label: "Meta 测试事件代码", fix: "正式环境请删除机密 META_TEST_EVENT_CODE，否则所有事件都进入 Test events。" },
    privacyPolicy: { label: "隐私政策", fix: "已开启 GA4 / Meta Pixel 但没有泰语隐私政策：设置 → 隐私。" },
    searchConsole: { label: "Google Search Console", fix: "通过 DNS 验证网站（推荐，完成后可忽略此项）或在营销中填写 HTML 标记代码，并提交 /sitemap.xml。" },
    rateLimits: { label: "请求频率限制", fix: "检查 wrangler.jsonc 中的 ratelimits：四项齐全，namespace_id 在账户内唯一。" },
    recentErrors: { label: "服务器错误（24 小时）", fix: "查看下方列表及 Cloudflare 控制台中的 Workers Logs（按请求 ID 搜索）。" },
    deliveries: { label: "LINE / CAPI 发送失败（24 小时）", fix: "查看 设置 → LINE → 发送记录 以及 营销 → CAPI。" },
  },
};

const DICTIONARIES = { th, en, "zh-CN": zhCN } as const;

export function getAdminSystemMessages(code: keyof typeof DICTIONARIES): AdminSystemMessages {
  return DICTIONARIES[code] ?? th;
}

export { th as adminSystemTh, en as adminSystemEn, zhCN as adminSystemZhCN };
