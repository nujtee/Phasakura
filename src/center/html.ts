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
};

/** Bangkok time for people reading the console. */
export function bkk(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(d);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#5f6673;--line:#dfe3e8;--accent:#1f5fbf;--ok:#1a7f37;--warn:#9a6700;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f25;--text:#e6e9ee;--muted:#9aa3ad;--line:#2c333b;--accent:#6ea8ff;--ok:#4cc26b;--warn:#e3b341;--bad:#ff6b6b}}
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
.stack input,.stack select{width:100%}.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;border:1px solid var(--line);background:var(--card)}
.flash.error{border-color:var(--bad)}.flash.ok{border-color:var(--ok)}code,.mono{font-family:ui-monospace,Menlo,monospace;font-size:.9em;word-break:break-all}
.narrow{max-width:420px;margin:48px auto}.scroll{overflow-x:auto}
`;

export interface LayoutUser {
  displayName: string;
  role: CenterRole;
}

export function page(opts: { title: string; body: string; user?: LayoutUser | null; current?: string; flash?: { kind: "ok" | "error"; text: string } | null }): string {
  const u = opts.user;
  const link = (href: string, label: string, key: string) => `<a href="${href}"${opts.current === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const nav = u
    ? `<nav>${link("/", "เว็บทั้งหมด", "sites")}${u.role === "PLATFORM_OWNER" ? link("/users", "ผู้ใช้ Center", "users") + link("/settings", "ตั้งค่า", "settings") : ""}${link("/audit", "บันทึกการใช้งาน", "audit")}${link("/account", "บัญชีของฉัน", "account")}
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
