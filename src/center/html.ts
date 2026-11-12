import type { CenterRole } from "../shared/center-protocol.ts";

/** Escapes text for HTML element content and quoted attribute values. Every dynamic value goes through it. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const ROLE_LABELS: Record<CenterRole, string> = {
  PLATFORM_OWNER: "เจ้าของแพลตฟอร์ม",
  OPERATOR: "ผู้ดูแลระบบ",
  SUPPORT_READONLY: "ซัพพอร์ต (ดูอย่างเดียว)",
};

export const ACTION_LABELS: Record<string, string> = {
  LOGIN: "เข้าสู่ระบบ",
  LOGIN_FAILED: "เข้าสู่ระบบไม่สำเร็จ",
  LOGIN_LOCKED: "บัญชีถูกล็อกชั่วคราว",
  LOGOUT: "ออกจากระบบ",
  PASSWORD_SET: "ตั้งรหัสผ่าน",
  PASSWORD_CHANGED: "เปลี่ยนรหัสผ่าน",
  SSO: "เข้าหลังบ้านของเว็บ",
  USER_CREATED: "เพิ่มผู้ใช้",
  USER_ROLE: "เปลี่ยนบทบาท",
  USER_DISABLED: "ปิดบัญชี",
  USER_ENABLED: "เปิดบัญชี",
  SETUP_LINK: "สร้างลิงก์ตั้งรหัสผ่าน",
  SETTINGS_CHANGED: "เปลี่ยนการตั้งค่า",
  CHECKS_RUN: "สั่งตรวจเว็บ",
  ALERT_TEST: "ส่งข้อความทดสอบ LINE",
  SITE_SUSPENDED: "พักการรับจองของเว็บ",
  CHANNEL_ICAL_ON: "เปิด iCal (OTA) ของเว็บ",
  FEATURE_LANDSCAPE_ON: "เปิดแผนผังที่พักของเว็บ",
  FEATURE_LANDSCAPE_OFF: "ปิดแผนผังที่พักของเว็บ",
  FEATURE_CREDITS_ON: "เปิดระบบเครดิตของเว็บ",
  FEATURE_CREDITS_OFF: "ปิดระบบเครดิตของเว็บ",
  CHANNEL_ICAL_OFF: "ปิด iCal (OTA) ของเว็บ",
  CHANNEL_CHANNEX_ON: "เปิด Channex ของเว็บ",
  CHANNEL_CHANNEX_OFF: "ปิด Channex ของเว็บ",
  SITE_RESUMED: "เปิดรับจองของเว็บอีกครั้ง",
  SITE_SESSIONS_REVOKED: "ตัด session ของ Center ในเว็บ",
  OWNER_INVITED: "สร้างบัญชี / ลิงก์ของเจ้าของเว็บ",
  SITE_BACKUP: "สำรองข้อมูลของเว็บ",
  BACKUP_DOWNLOAD: "ดาวน์โหลดไฟล์สำรอง",
  RELEASE_STARTED: "สั่ง Release",
  PR_MERGED: "Merge pull request",
  NEW_SITE_ZONE: "เพิ่มโดเมนของเว็บใหม่เข้า Cloudflare",
  NEW_SITE_CREATE: "สั่งสร้างเว็บใหม่ (Create site)",
  NEW_SITE_REMOVED: "เอาเว็บใหม่ออกจากรายการ",
  MFA_OK: "ยืนยันรหัส 2 ขั้น",
  MFA_FAILED: "รหัส 2 ขั้นไม่ถูกต้อง",
  MFA_ENABLED: "เปิดใช้ยืนยันตัวตน 2 ขั้น",
  MFA_RESET: "รีเซ็ตยืนยันตัวตน 2 ขั้น",
  MFA_RECOVERY_USED: "ใช้รหัสสำรอง",
  MFA_RECOVERY_RENEWED: "สร้างรหัสสำรองชุดใหม่",
  LOGIN_THROTTLED: "หยุดรับการเข้าสู่ระบบจาก IP",
  CREDIT_SETTINGS_SAVED: "บันทึกค่าเครดิตกลาง",
  CREDIT_IMPORTED: "นำค่าเครดิตของเว็บมาเป็นค่ากลาง",
  TOPUP_APPROVED: "อนุมัติคำขอเติมเครดิต",
  TOPUP_REJECTED: "ไม่อนุมัติคำขอเติมเครดิต",
  TOPUP_SLIP_VIEWED: "ดูสลิปเติมเครดิต",
  CREDIT_SYNC: "ส่งค่าเครดิตกลางให้เว็บ",
  MULTI_STAY_SETTINGS: "ตั้งค่าเครดิตครั้งเดียวต่อการจอง (หลายที่พัก)",
  MULTI_STAY_SITE_ON: "เลือกเว็บใช้เครดิตครั้งเดียวต่อการจอง",
  MULTI_STAY_SITE_OFF: "เลิกเลือกเว็บใช้เครดิตครั้งเดียวต่อการจอง",
  MULTI_STAY_SENT: "ส่งค่าเครดิตครั้งเดียวต่อการจองให้เว็บ",
  THEME_UNLOCK_ON: "เปิด Theme ให้เว็บ (ไม่ขึ้นกับแพ็กเกจ)",
  THEME_UNLOCK_OFF: "เลิกเปิด Theme ของเว็บ (กลับไปตามแพ็กเกจ)",
};

/** Bangkok time for people reading the console. */
export function bkk(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(d);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#5f6673;--line:#dfe3e8;--accent:#1f5fbf;--ok:#1a7f37;--warn:#9a6700;--bad:#c62828;--info:#1f5fbf}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f25;--text:#e6e9ee;--muted:#9aa3ad;--line:#2c333b;--accent:#6ea8ff;--ok:#4cc26b;--warn:#e3b341;--bad:#ff6b6b;--info:#8ab8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI","Noto Sans Thai",sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:1080px;margin:0 auto;padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;margin-right:auto}nav{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
nav a{color:var(--text);text-decoration:none}nav a[aria-current]{color:var(--accent);font-weight:600}
main{max-width:1080px;margin:0 auto;padding:20px 16px 48px}h1{font-size:1.35rem;margin:0 0 16px}h2{font-size:1.1rem;margin:28px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.85rem;color:var(--muted);font-weight:600}.muted{color:var(--muted)}.small{font-size:.85rem}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
input,select,button{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--text)}
input{min-width:0}button{cursor:pointer;background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.plain{background:transparent;color:var(--accent)}button.danger{background:var(--bad);border-color:var(--bad)}
form.inline{display:flex;gap:8px;flex-wrap:wrap;align-items:center}label{display:block;margin:10px 0 4px;font-weight:600}
.stack input,.stack select{width:100%}.stack input[type=checkbox],.stack input[type=radio]{width:auto}
label.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:6px 0;cursor:pointer}label.check input{margin:3px 0 0;flex:none}.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;border:1px solid var(--line);background:var(--card)}
.flash.error{border-color:var(--bad)}.flash.ok{border-color:var(--ok)}code,.mono{font-family:ui-monospace,Menlo,monospace;font-size:.9em;word-break:break-all}
.narrow{max-width:420px;margin:48px auto}.scroll{overflow-x:auto}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.tabs{display:flex;gap:24px;border-bottom:1px solid var(--line);margin:0 0 16px;flex-wrap:wrap}
.tabs a{padding:10px 2px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a[aria-current]{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.82rem;font-weight:500;white-space:nowrap}
.pill.good{background:rgba(26,127,55,.12);color:var(--ok)}.pill.low{background:rgba(154,103,0,.14);color:var(--warn)}
.pill.empty{background:rgba(198,40,40,.12);color:var(--bad)}.pill.off{background:rgba(95,102,115,.14);color:var(--muted)}
th.num,td.num{text-align:right}.card.flush{padding:0}
table.features th{vertical-align:bottom}table.features td{vertical-align:middle;padding:10px 12px}table.features th{padding:12px}
.sub{font-weight:400}.bulk{margin-top:4px;font-weight:400;color:var(--muted)}.bulk button{padding:2px 0;font-weight:500;border:0;font-size:.82rem;text-decoration:underline;text-underline-offset:2px}
.cell{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-radius:10px;padding:6px 8px;margin:-6px -8px}
.cell small{font-size:.8rem}button.small{padding:2px 6px;font-size:.82rem}.cell button.small{border:0;text-decoration:underline}
.cell:has(input[data-was="0"]:checked),.cell:has(input[data-was="1"]:not(:checked)){background:rgba(245,181,74,.16);box-shadow:inset 0 0 0 2px #f5b54a}
.sw{position:relative;display:inline-flex;margin:0;cursor:pointer;flex:none}
.sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.sw-track{width:44px;height:26px;border-radius:999px;background:#c5ccd5;position:relative;transition:background .15s}
.sw-track::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .15s}
.sw input:checked+.sw-track{background:var(--accent)}.sw input:checked+.sw-track::after{left:21px}
.sw input:focus-visible+.sw-track{outline:2px solid var(--accent);outline-offset:2px}
.sw input:disabled+.sw-track{opacity:.45;cursor:not-allowed}
.savebar{position:sticky;bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:var(--card);border:1px solid #f5b54a;border-radius:12px;padding:12px 16px;box-shadow:0 8px 24px rgba(16,24,40,.12)}
.savebar label{margin:0 0 0 auto}.savebar input{width:min(320px,100%)}
.page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:16px}.page-head h1{margin:0}.page-head p{margin:2px 0 0}
.head-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;min-height:36px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font-weight:500;text-decoration:none;cursor:pointer;white-space:nowrap;list-style:none}
.btn::-webkit-details-marker{display:none}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.btn:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px}.tile-v{font-size:1.6rem;font-weight:700;line-height:1.3}
.sec-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px}.sec-head h2{margin:0}
.search{display:flex;gap:6px;margin-left:auto}.search input{width:min(240px,60vw)}
.attn{display:flex;align-items:center;gap:14px;padding:12px 16px;border-top:1px solid var(--line);flex-wrap:wrap}
.attn-body{flex:1;min-width:220px}.sev{width:4px;align-self:stretch;border-radius:2px;flex:none;background:var(--info)}
.sev.bad{background:var(--bad)}.sev.warn{background:var(--warn)}.info{color:var(--info)}
.acts{display:flex;gap:8px;align-items:center}
table.sites{min-width:820px}table.sites td{vertical-align:middle;padding:10px 16px}table.sites th{padding:10px 16px}
.chks{display:flex;gap:12px;flex-wrap:wrap}.chk{font-size:.85rem;color:var(--muted);white-space:nowrap}.chk b{color:var(--text);font-weight:600}.chk.w b{color:var(--warn)}
.exp{height:4px;width:120px;border-radius:2px;background:var(--line);overflow:hidden;margin:5px 0 2px}.exp span{display:block;height:100%;background:var(--ok)}
.exp.warn span{background:var(--warn)}.exp.bad span{background:var(--bad)}
table.sites a,.attn a{color:inherit;text-decoration:none}table.sites a:hover,.attn a:hover{text-decoration:underline}
details.sso{position:relative;display:inline-block;text-align:left}
.sso-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:5;width:300px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:8px}
table.sites .sso-pop{position:static;width:260px;margin-top:6px;box-shadow:none}
.sso-pop label{margin:0;font-size:.85rem}.sso-pop p{margin:0}
table.features{min-width:760px}@media (max-width:640px){.savebar{position:static}.savebar label{margin:0}}
`;

export interface LayoutUser {
  displayName: string;
  role: CenterRole;
}

export function page(opts: { title: string; body: string; user?: LayoutUser | null; current?: string; flash?: { kind: "ok" | "error"; text: string } | null }): string {
  const u = opts.user;
  const link = (href: string, label: string, key: string) => `<a href="${href}"${opts.current === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const nav = u
    ? `<nav>${link("/", "เว็บทั้งหมด", "sites")}${link("/releases", "Release", "releases")}${link("/credits", "เครดิต", "credits")}${link("/topups", "คำขอเติมเครดิต", "topups")}${u.role === "PLATFORM_OWNER" ? link("/users", "ผู้ใช้ Center", "users") + link("/settings", "ตั้งค่า", "settings") : ""}${link("/audit", "บันทึกการใช้งาน", "audit")}${link("/account", "บัญชีของฉัน", "account")}
<form method="post" action="/logout" class="inline"><button class="plain" type="submit">ออกจากระบบ</button></form></nav>
<span class="muted small">${esc(u.displayName)} · ${esc(ROLE_LABELS[u.role])}</span>`
    : "";
  const flash = opts.flash ? `<div class="flash ${opts.flash.kind}" role="status">${esc(opts.flash.text)}</div>` : "";
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(opts.title)} · Center</title><style>${STYLE}</style></head>
<body><header><div class="bar"><span class="brand">Center</span>${nav}</div></header><main>${flash}${opts.body}</main></body></html>`;
}

/** The inline script on the SSO hand-off page; its SHA-256 is the only script the CSP allows there. */
export const SSO_SCRIPT = `document.getElementById("sso").submit();`;

export function ssoHandoffPage(siteName: string, consumeUrl: string, ticket: string): string {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>กำลังเข้าหลังบ้าน · Center</title><style>${STYLE}</style></head>
<body><main class="narrow"><div class="card"><h1>กำลังเข้าหลังบ้าน ${esc(siteName)}</h1>
<form id="sso" method="post" action="${esc(consumeUrl)}"><input type="hidden" name="ticket" value="${esc(ticket)}">
<p class="muted">ถ้าหน้านี้ไม่ไปต่อเอง ให้กดปุ่มด้านล่างภายใน 60 วินาที</p><button type="submit">ไปที่หลังบ้าน</button></form></div></main>
<script>${SSO_SCRIPT}</script></body></html>`;
}
