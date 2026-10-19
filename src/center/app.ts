import { listReleaseRuns, releaseSelection, startRelease, type ReleaseRun } from "./releases.ts";
import { CENTER_ROLES, type CenterActor, type CenterRole } from "../shared/center-protocol.ts";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../worker/security/password.ts";
import { randomToken, sha256Hex } from "../worker/security/tokens.ts";
import { parseSites, type CenterEnv, type CenterSite } from "./env.ts";
import { ACTION_LABELS, bkk, esc, page, ROLE_LABELS, SSO_SCRIPT, ssoHandoffPage, type LayoutUser } from "./html.ts";
import { CenterRepository, type CenterUserRow } from "./repository.ts";
import { SiteClient, signingKey } from "./site-client.ts";
import { verifyLineSignature, createLineApi, type FetchLike } from "../worker/line/line-api.ts";
import { ALERT_LABELS, lineWebhook, loadSettings, runChecks, securityAlert, sendTest, SETTING_TYPES, type SettingType } from "./monitor.ts";
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri, qrSvg, verifyTotp } from "./totp.ts";

const COOKIE = "__Host-csid";
const HOUR = 3_600_000;
export const CENTER_SESSION_TTL_MS = 8 * HOUR;
export const CENTER_IDLE_MS = 1 * HOUR;
const TOUCH_MS = 5 * 60_000;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 15 * 60_000;
export const INVITE_TTL_MS = 48 * HOUR;
export const RESET_TTL_MS = 24 * HOUR;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** Sensitive actions want the two-step code to have been entered within this long (step-up, phase C9). */
export const STEP_UP_MS = 15 * 60_000;
/** Failed sign-ins (password or code) from one IP within IP_WINDOW_MS before that IP is turned away. */
export const IP_MAX_FAILURES = 20;
export const IP_WINDOW_MS = 15 * 60_000;
const ISSUER = "Center Phasakura";

export interface CenterAppOptions {
  clock?: () => Date;
  /** Password hashing cost (tests use fewer iterations). */
  hashIterations?: number;
  /** LINE Messaging API calls (tests pass a fake). */
  lineFetch?: FetchLike;
  /** GitHub API calls for Release from Center (tests pass a fake). */
  githubFetch?: FetchLike;
}

interface Ctx {
  request: Request;
  env: CenterEnv;
  url: URL;
  repo: CenterRepository;
  sites: CenterSite[];
  now: Date;
  ip: string | null;
}

interface Me extends LayoutUser {
  id: string;
  email: string;
  sessionId: string;
  /** When this session passed the two-step check; null = password only so far. */
  mfaAt: string | null;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * The Center Management console (phase C4) — server-rendered, no client JavaScript except the one-line SSO hand-off.
 * Every page needs a Center session (email + password; lock after 5 failures; 8 h absolute, 1 h idle).
 * Every POST must come from this origin (Origin header). Every change is in the Center audit log.
 */
export function createCenterApp(options: CenterAppOptions = {}) {
  const clock = options.clock ?? (() => new Date());
  const hash = (password: string) => (options.hashIterations ? hashPassword(password, options.hashIterations) : hashPassword(password));

  async function fetch(request: Request, env: CenterEnv): Promise<Response> {
    const url = new URL(request.url);
    const ctx: Ctx = {
      request, env, url, repo: new CenterRepository(env.DB), sites: parseSites(env.CENTER_SITES), now: clock(),
      ip: request.headers.get("CF-Connecting-IP"),
    };
    let response: Response;
    try {
      // The LINE webhook is server-to-server, authenticated by its HMAC signature instead.
      if (request.method === "POST" && url.pathname !== "/line/webhook") assertSameOrigin(request, url);
      response = await route(ctx);
    } catch (error) {
      if (error instanceof HttpError) response = html(page({ title: "ผิดพลาด", body: `<div class="card"><p>${esc(error.message)}</p><p><a href="/">กลับหน้าแรก</a></p></div>` }), error.status);
      else {
        console.error(JSON.stringify({ level: "error", message: "center_unhandled", error: String(error).slice(0, 300), path: url.pathname }));
        response = html(page({ title: "ผิดพลาด", body: '<div class="card"><p>เกิดข้อผิดพลาด ลองใหม่อีกครั้ง</p></div>' }), 500);
      }
    }
    return secure(response, ctx.sites);
  }

  async function route(ctx: Ctx): Promise<Response> {
    const { request, url } = ctx;
    const key = `${request.method} ${url.pathname}`;
    if (key === "GET /healthz") return healthz(ctx);
    if (key === "GET /login") return loginPage(ctx);
    if (key === "POST /login") return login(ctx);
    if (key === "GET /setup") return setupPage(ctx);
    if (key === "POST /setup") return setup(ctx);
    if (key === "POST /line/webhook") return webhook(ctx);

    const me = await currentUser(ctx);
    if (!me) {
      if (request.method === "GET") return redirect("/login");
      throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    }
    if (key === "POST /logout") return logout(ctx, me);
    // Two-step sign-in (phase C9): nothing else until this session has passed it (or set it up).
    if (key === "GET /mfa") return mfaPage(ctx, me);
    if (key === "POST /mfa") return mfaVerify(ctx, me);
    if (key === "POST /mfa/setup") return mfaSetup(ctx, me);
    if (!me.mfaAt) {
      if (request.method === "GET") return redirect("/mfa");
      throw new HttpError(401, "กรุณายืนยันรหัส 2 ขั้นก่อน");
    }
    // Step-up: sensitive actions want the code entered within STEP_UP_MS; otherwise ask for it, then come back.
    const back = sensitiveReturnPath(request.method, url.pathname);
    if (back && ctx.now.getTime() - Date.parse(me.mfaAt) > STEP_UP_MS) return stepUpPage(ctx, me, back);
    if (key === "GET /") return dashboard(ctx, me);
    if (key === "GET /audit") return auditPage(ctx, me);
    if (key === "GET /account") return accountPage(ctx, me);
    if (key === "POST /account/password") return changePassword(ctx, me);
    if (key === "POST /account/recovery-codes") return regenerateRecoveryCodes(ctx, me);
    const sso = /^\/sites\/([a-z][a-z0-9-]{1,30})\/sso$/.exec(url.pathname);
    if (sso && request.method === "POST") return startSso(ctx, me, sso[1]!);
    const detail = /^\/sites\/([a-z][a-z0-9-]{1,30})$/.exec(url.pathname);
    if (detail && request.method === "GET") return sitePage(ctx, me, detail[1]!);
    const siteAction = /^\/sites\/([a-z][a-z0-9-]{1,30})\/(suspension|revoke|owner|backup|backup-download)$/.exec(url.pathname);
    if (siteAction && request.method === "POST") {
      const slug = siteAction[1]!;
      switch (siteAction[2]) {
        case "suspension": return changeSuspension(ctx, me, slug);
        case "revoke": return revokeSiteSessions(ctx, me, slug);
        case "owner": return inviteSiteOwner(ctx, me, slug);
        case "backup": return backupSite(ctx, me, slug);
        default: return downloadBackup(ctx, me, slug);
      }
    }
    if (key === "GET /releases") return releasesPage(ctx, me);
    if (key === "POST /releases") return requestRelease(ctx, me);
    if (key === "POST /checks/run") {
      if (me.role === "SUPPORT_READONLY") throw new HttpError(403, "บทบาทของคุณสั่งตรวจไม่ได้");
      const result = await runChecks(ctx.env, { clock, lineFetch: options.lineFetch });
      await audit(ctx, me.id, "CHECKS_RUN", null, null, { events: result.events.length, delivery: result.delivery }).run();
      return dashboard(ctx, me, { kind: "ok", text: `ตรวจ ${result.checked} เว็บแล้ว — ${result.events.length ? `${result.events.length} เหตุการณ์ใหม่ (LINE: ${result.delivery})` : "ไม่มีเหตุการณ์ใหม่"}` });
    }

    if (me.role !== "PLATFORM_OWNER" && url.pathname.startsWith("/settings")) throw new HttpError(403, "หน้านี้สำหรับเจ้าของแพลตฟอร์มเท่านั้น");
    if (key === "GET /settings") return settingsPage(ctx, me);
    if (key === "POST /settings") return saveSettings(ctx, me);
    if (key === "POST /settings/test") {
      const res = await sendTest(ctx.env, me.displayName, ctx.now, options.lineFetch);
      await audit(ctx, me.id, "ALERT_TEST", null, null, { ok: res.ok }).run();
      return settingsPage(ctx, me, { kind: res.ok ? "ok" : "error", text: `ข้อความทดสอบ: ${res.reason}` });
    }

    if (me.role !== "PLATFORM_OWNER" && url.pathname.startsWith("/users")) throw new HttpError(403, "หน้านี้สำหรับเจ้าของแพลตฟอร์มเท่านั้น");
    if (key === "GET /users") return usersPage(ctx, me);
    if (key === "POST /users") return createUser(ctx, me);
    const user = /^\/users\/(u_[0-9a-f]{8,38})\/(role|disable|enable|setup-link|mfa-reset)$/.exec(url.pathname);
    if (user && request.method === "POST") {
      if (user[2] === "mfa-reset") return resetUserMfa(ctx, me, user[1]!);
      return changeUser(ctx, me, user[1]!, user[2] as "role" | "disable" | "enable" | "setup-link");
    }
    throw new HttpError(404, "ไม่พบหน้านี้");
  }

  // ---------------------------------------------------------------- sessions

  async function currentUser(ctx: Ctx): Promise<Me | null> {
    const token = readCookie(ctx.request, COOKIE);
    if (!token) return null;
    const row = await ctx.repo.sessionByTokenHash(await sha256Hex(token), iso(ctx.now));
    if (!row) return null;
    const idle = ctx.now.getTime() - Date.parse(row.last_seen_at);
    if (idle > CENTER_IDLE_MS) {
      await ctx.repo.revokeSessionStatement(row.session_id, iso(ctx.now)).run();
      return null;
    }
    if (idle > TOUCH_MS) await ctx.repo.touchSession(row.session_id, iso(ctx.now));
    return { id: row.id, email: row.email, displayName: row.display_name, role: row.role, sessionId: row.session_id, mfaAt: row.mfa_at };
  }

  async function newSession(ctx: Ctx, user: CenterUserRow, action: "LOGIN" | "PASSWORD_SET", extra: D1Statements = []): Promise<Response> {
    const token = randomToken(32);
    const now = iso(ctx.now);
    await ctx.repo.db.batch([
      ...extra,
      ctx.repo.insertSessionStatement({
        id: crypto.randomUUID(), userId: user.id, tokenHash: await sha256Hex(token), now,
        expiresAt: iso(new Date(ctx.now.getTime() + CENTER_SESSION_TTL_MS)), ip: ctx.ip, userAgent: ctx.request.headers.get("User-Agent")?.slice(0, 200) ?? null,
      }),
      ctx.repo.recordLoginStatement(user.id, now),
      audit(ctx, user.id, action),
    ]);
    // Password only so far: the two-step check (or its set-up) comes next (phase C9).
    return redirect("/mfa", `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CENTER_SESSION_TTL_MS / 1000}`);
  }

  // ---------------------------------------------------------------- two-step sign-in (phase C9)

  async function ipThrottled(ctx: Ctx): Promise<boolean> {
    if (!ctx.ip) return false;
    return (await ctx.repo.failuresFromIp(ctx.ip, iso(new Date(ctx.now.getTime() - IP_WINDOW_MS)))) >= IP_MAX_FAILURES;
  }

  /** Announce once, when an IP reaches the limit. */
  async function noteIpFailure(ctx: Ctx): Promise<void> {
    if (!ctx.ip) return;
    const n = await ctx.repo.failuresFromIp(ctx.ip, iso(new Date(ctx.now.getTime() - IP_WINDOW_MS)));
    if (n === IP_MAX_FAILURES) {
      await audit(ctx, null, "LOGIN_THROTTLED", null, null, { failures: n }).run();
      await securityAlert(ctx.env, `IP ${ctx.ip} เข้าสู่ระบบผิด ${n} ครั้งใน 15 นาที — หยุดรับจาก IP นี้ชั่วคราว`, ctx.now, options.lineFetch);
    }
  }

  function codeForm(action: string, label: string, button: string, recovery: boolean): string {
    return `<form method="post" action="${esc(action)}" class="stack" style="max-width:320px">
<label for="code">${esc(label)}</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="12" pattern="[0-9 ]{6,7}|[A-Za-z2-7 -]{8,10}" autofocus>
<p><button type="submit">${esc(button)}</button></p></form>${recovery ? '<p class="small muted">ไม่มีมือถือ: ใส่รหัสสำรอง (เช่น abcd-2345) ในช่องเดียวกัน — ใช้ได้รหัสละครั้ง</p>' : ""}`;
  }

  async function mfaPage(ctx: Ctx, me: Me, flash: string | null = null): Promise<Response> {
    const user = (await ctx.repo.userById(me.id))!;
    const next = safeNext(ctx.url.searchParams.get("next"));
    if (user.totp_secret) {
      return html(page({
        title: "ยืนยันรหัส 2 ขั้น", flash: flash ? { kind: "error", text: flash } : null,
        body: `<div class="narrow card"><h1>ยืนยันรหัส 2 ขั้น</h1><p class="muted">${esc(me.email)}</p>
${codeForm(`/mfa${next ? `?next=${encodeURIComponent(next)}` : ""}`, "รหัส 6 หลักจากแอปยืนยันตัวตน", "ยืนยัน", true)}
<form method="post" action="/logout" class="inline"><button class="plain" type="submit">ออกจากระบบ</button></form></div>`,
      }), flash ? 422 : 200);
    }
    // First sign-in since phase C9 (or after a reset): set it up now.
    let secret = user.totp_pending_secret;
    if (!secret) {
      secret = newTotpSecret();
      await ctx.repo.setPendingSecretStatement(me.id, secret, iso(ctx.now)).run();
    }
    const uri = otpauthUri(secret, user.email, ISSUER);
    return html(page({
      title: "ตั้งค่ายืนยันตัวตน 2 ขั้น", flash: flash ? { kind: "error", text: flash } : null,
      body: `<div class="narrow card" style="max-width:520px"><h1>ตั้งค่ายืนยันตัวตน 2 ขั้น</h1>
<p>Center บังคับทุกบัญชีใช้รหัสจากแอปบนมือถือทุกครั้งที่เข้าสู่ระบบ</p>
<ol class="small"><li>เปิดแอป Google Authenticator, Microsoft Authenticator หรือ 1Password บนมือถือ</li>
<li>เพิ่มบัญชีใหม่ → สแกน QR ด้านล่าง</li><li>ใส่รหัส 6 หลักที่แอปแสดง</li></ol>
<div style="max-width:240px;margin:12px 0">${qrSvg(uri)}</div>
<p class="small muted">สแกนไม่ได้: เลือก "ใส่คีย์เอง" ในแอป แล้วพิมพ์</p><p class="mono">${esc(secret.replace(/(.{4})/g, "$1 ").trim())}</p>
${codeForm("/mfa/setup", "รหัส 6 หลักจากแอป", "ยืนยันและเปิดใช้", false)}
<form method="post" action="/logout" class="inline"><button class="plain" type="submit">ออกจากระบบ</button></form></div>`,
    }), flash ? 422 : 200);
  }

  /** A wrong code counts like a wrong password (5 → locked 15 minutes, session ended). */
  async function mfaFailure(ctx: Ctx, user: CenterUserRow): Promise<Response | null> {
    const count = user.failed_login_count + 1;
    const locked = count >= MAX_FAILED_LOGINS ? iso(new Date(ctx.now.getTime() + LOCK_MS)) : null;
    await ctx.repo.recordLoginFailure(user.id, locked ? 0 : count, locked, iso(ctx.now));
    await audit(ctx, user.id, locked ? "LOGIN_LOCKED" : "MFA_FAILED").run();
    await noteIpFailure(ctx);
    if (!locked) return null;
    await ctx.repo.revokeUserSessionsStatement(user.id, iso(ctx.now)).run();
    await securityAlert(ctx.env, `บัญชี ${user.email} ถูกล็อก 15 นาที — ใส่รหัส 2 ขั้นผิด ${MAX_FAILED_LOGINS} ครั้ง (IP ${ctx.ip ?? "?"})`, ctx.now, options.lineFetch);
    return redirect("/login", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  }

  async function mfaVerify(ctx: Ctx, me: Me): Promise<Response> {
    const user = (await ctx.repo.userById(me.id))!;
    if (!user.totp_secret) return redirect("/mfa");
    if (user.locked_until && Date.parse(user.locked_until) > ctx.now.getTime()) return mfaPage(ctx, me, "บัญชีถูกล็อกชั่วคราว ลองใหม่ภายหลัง");
    const code = ((await readForm(ctx.request)).get("code") ?? "").trim();
    const next = safeNext(ctx.url.searchParams.get("next")) ?? "/";
    const now = iso(ctx.now);
    const step = await verifyTotp(user.totp_secret, code, ctx.now, user.totp_last_step);
    if (step !== null) {
      await ctx.repo.db.batch([ctx.repo.totpUsedStatement(user.id, step, now), ctx.repo.sessionMfaStatement(me.sessionId, now), audit(ctx, me.id, "MFA_OK")]);
      return redirect(next);
    }
    const recovery = normalizeRecoveryCode(code);
    if (recovery && (await ctx.repo.useRecoveryCode(user.id, await sha256Hex(recovery), now))) {
      const left = await ctx.repo.recoveryCodesLeft(user.id);
      await ctx.repo.db.batch([ctx.repo.recordLoginStatement(user.id, now), ctx.repo.sessionMfaStatement(me.sessionId, now), audit(ctx, me.id, "MFA_RECOVERY_USED", null, null, { left })]);
      await securityAlert(ctx.env, `${user.email} เข้าสู่ระบบด้วยรหัสสำรอง (เหลือ ${left} รหัส)`, ctx.now, options.lineFetch);
      return redirect(left <= 3 ? "/account" : next);
    }
    return (await mfaFailure(ctx, user)) ?? mfaPage(ctx, me, "รหัสไม่ถูกต้อง (หรือใช้ไปแล้ว) ลองรหัสใหม่จากแอป");
  }

  async function mfaSetup(ctx: Ctx, me: Me): Promise<Response> {
    const user = (await ctx.repo.userById(me.id))!;
    if (user.totp_secret || !user.totp_pending_secret) return redirect("/mfa");
    const code = ((await readForm(ctx.request)).get("code") ?? "").trim();
    const step = await verifyTotp(user.totp_pending_secret, code, ctx.now, null);
    if (step === null) return (await mfaFailure(ctx, user)) ?? mfaPage(ctx, me, "รหัสไม่ถูกต้อง ตรวจว่าเวลาในมือถือตรง แล้วใส่รหัสล่าสุดจากแอป");
    const now = iso(ctx.now);
    const codes = newRecoveryCodes();
    await ctx.repo.db.batch([
      ctx.repo.enableTotpStatement(user.id, step, now),
      ...ctx.repo.replaceRecoveryCodesStatements(user.id, await Promise.all(codes.map((c) => sha256Hex(c))), now),
      ctx.repo.sessionMfaStatement(me.sessionId, now),
      audit(ctx, me.id, "MFA_ENABLED"),
    ]);
    return recoveryCodesPage(me, codes, "เปิดใช้ยืนยันตัวตน 2 ขั้นแล้ว");
  }

  function recoveryCodesPage(me: Me, codes: string[], title: string): Response {
    return html(page({
      title, user: me,
      body: `<div class="narrow card" style="max-width:520px"><h1>${esc(title)}</h1>
<p><strong>รหัสสำรอง 10 รหัส</strong> — ใช้แทนรหัสจากแอปเมื่อมือถือหาย รหัสละครั้ง เก็บไว้ในที่ปลอดภัย (เช่น password manager หรือพิมพ์เก็บ) <strong>หน้านี้แสดงครั้งเดียว</strong></p>
<pre class="mono" style="font-size:1.05rem;line-height:1.9">${codes.map(esc).join("\n")}</pre>
<p><a href="/">ไปหน้าแรก</a></p></div>`,
    }));
  }

  async function regenerateRecoveryCodes(ctx: Ctx, me: Me): Promise<Response> {
    const codes = newRecoveryCodes();
    const now = iso(ctx.now);
    await ctx.repo.db.batch([
      ...ctx.repo.replaceRecoveryCodesStatements(me.id, await Promise.all(codes.map((c) => sha256Hex(c))), now),
      audit(ctx, me.id, "MFA_RECOVERY_RENEWED"),
    ]);
    return recoveryCodesPage(me, codes, "รหัสสำรองชุดใหม่ (ชุดเก่าใช้ไม่ได้แล้ว)");
  }

  function stepUpPage(_ctx: Ctx, me: Me, back: string): Response {
    return html(page({
      title: "ยืนยันรหัสอีกครั้ง", user: me,
      body: `<div class="narrow card"><h1>ยืนยันรหัส 2 ขั้นอีกครั้ง</h1>
<p class="muted">งานนี้ต้องยืนยันรหัสภายใน 15 นาทีล่าสุด ใส่รหัสแล้วระบบจะพากลับไปหน้าเดิม ให้กดคำสั่งอีกครั้ง</p>
${codeForm(`/mfa?next=${encodeURIComponent(back)}`, "รหัส 6 หลักจากแอป", "ยืนยัน", true)}</div>`,
    }), 403);
  }

  async function resetUserMfa(ctx: Ctx, me: Me, id: string): Promise<Response> {
    const target = await ctx.repo.userById(id);
    if (!target) throw new HttpError(404, "ไม่พบผู้ใช้นี้");
    if (id === me.id) return usersPage(ctx, me, { kind: "error", text: "รีเซ็ต 2 ขั้นของตัวเองไม่ได้ — ให้เจ้าของแพลตฟอร์มอีกคนทำ หรือใช้รหัสสำรอง" });
    const reason = ((await readForm(ctx.request)).get("reason") ?? "").trim();
    if (reason.length < 3 || reason.length > 300) return usersPage(ctx, me, { kind: "error", text: "กรุณาระบุเหตุผล 3–300 ตัวอักษร" });
    await ctx.repo.db.batch([...ctx.repo.resetMfaStatements(id, iso(ctx.now)), audit(ctx, me.id, "MFA_RESET", null, reason, { target: id, email: target.email })]);
    await securityAlert(ctx.env, `${me.email} รีเซ็ตยืนยันตัวตน 2 ขั้นของ ${target.email} — เหตุผล: ${reason}`, ctx.now, options.lineFetch);
    return usersPage(ctx, me, { kind: "ok", text: `รีเซ็ต 2 ขั้นของ ${target.display_name} แล้ว — เข้าสู่ระบบครั้งถัดไปต้องสแกน QR ใหม่` });
  }

  // ---------------------------------------------------------------- public pages

  async function healthz(ctx: Ctx): Promise<Response> {
    let db = "ok";
    try {
      await ctx.repo.db.prepare("SELECT count(*) AS n FROM center_users").first();
    } catch {
      db = "unavailable";
    }
    const body = { status: db === "ok" ? "ok" : "degraded", database: db, signingKey: !!(await signingKey(ctx.env.CENTER_SIGNING_KEY)), sites: ctx.sites.length };
    return new Response(JSON.stringify(body), { status: db === "ok" ? 200 : 503, headers: { "Content-Type": "application/json" } });
  }

  function loginPage(_ctx: Ctx, flash: string | null = null, email = ""): Response {
    return html(page({
      title: "เข้าสู่ระบบ",
      flash: flash ? { kind: "error", text: flash } : null,
      body: `<div class="narrow card"><h1>เข้าสู่ระบบ Center</h1><form method="post" action="/login" class="stack">
<label for="email">อีเมล</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254" value="${esc(email)}">
<label for="password">รหัสผ่าน</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200">
<p><button type="submit">เข้าสู่ระบบ</button></p></form>
<p class="muted small">ลืมรหัสผ่าน: ขอลิงก์ตั้งรหัสผ่านใหม่จากเจ้าของแพลตฟอร์ม</p></div>`,
    }), flash ? 401 : 200);
  }

  async function login(ctx: Ctx): Promise<Response> {
    const form = await readForm(ctx.request);
    const email = (form.get("email") ?? "").trim().slice(0, 254);
    const password = form.get("password") ?? "";
    const user = EMAIL.test(email) ? await ctx.repo.userByEmail(email) : null;
    const wrong = "อีเมลหรือรหัสผ่านไม่ถูกต้อง หรือบัญชีถูกล็อกชั่วคราว";
    if (await ipThrottled(ctx)) return loginPage(ctx, "ลองเข้าสู่ระบบจากเครือข่ายนี้หลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่", email);
    if (!user || user.status !== "ACTIVE" || !user.password_hash) {
      await hash("timing-equaliser-not-a-password");
      await audit(ctx, null, "LOGIN_FAILED", null, null, { unknownAccount: true }).run();
      await noteIpFailure(ctx);
      return loginPage(ctx, wrong, email);
    }
    if (user.locked_until && Date.parse(user.locked_until) > ctx.now.getTime()) return loginPage(ctx, wrong, email);
    if (!(await verifyPassword(password, user.password_hash))) {
      const count = user.failed_login_count + 1;
      const locked = count >= MAX_FAILED_LOGINS ? iso(new Date(ctx.now.getTime() + LOCK_MS)) : null;
      await ctx.repo.recordLoginFailure(user.id, locked ? 0 : count, locked, iso(ctx.now));
      await audit(ctx, user.id, locked ? "LOGIN_LOCKED" : "LOGIN_FAILED").run();
      if (locked) await securityAlert(ctx.env, `บัญชี ${user.email} ถูกล็อก 15 นาที — ใส่รหัสผ่านผิด ${MAX_FAILED_LOGINS} ครั้ง (IP ${ctx.ip ?? "?"})`, ctx.now, options.lineFetch);
      await noteIpFailure(ctx);
      return loginPage(ctx, wrong, email);
    }
    return newSession(ctx, user, "LOGIN");
  }

  async function setupPage(ctx: Ctx, flash: string | null = null): Promise<Response> {
    const token = ctx.url.searchParams.get("token") ?? "";
    const user = /^[A-Za-z0-9_-]{43}$/.test(token) ? await ctx.repo.tokenUser(await sha256Hex(token), iso(ctx.now)) : null;
    if (!user) return html(page({ title: "ลิงก์ใช้ไม่ได้", body: '<div class="narrow card"><h1>ลิงก์ใช้ไม่ได้</h1><p>ลิงก์หมดอายุหรือถูกใช้ไปแล้ว ขอลิงก์ใหม่จากเจ้าของแพลตฟอร์ม</p></div>' }), 400);
    return html(page({
      title: "ตั้งรหัสผ่าน",
      flash: flash ? { kind: "error", text: flash } : null,
      body: `<div class="narrow card"><h1>ตั้งรหัสผ่าน Center</h1><p class="muted">${esc(user.display_name)} · ${esc(user.email)} · ${esc(ROLE_LABELS[user.role])}</p>
<form method="post" action="/setup?token=${esc(token)}" class="stack">
<label for="password">รหัสผ่านใหม่ (อย่างน้อย 12 ตัว)</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="200">
<label for="confirm">พิมพ์อีกครั้ง</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="200">
<p><button type="submit">ตั้งรหัสผ่านและเข้าสู่ระบบ</button></p></form></div>`,
    }), flash ? 422 : 200);
  }

  async function setup(ctx: Ctx): Promise<Response> {
    const token = ctx.url.searchParams.get("token") ?? "";
    const tokenHash = /^[A-Za-z0-9_-]{43}$/.test(token) ? await sha256Hex(token) : null;
    const user = tokenHash ? await ctx.repo.tokenUser(tokenHash, iso(ctx.now)) : null;
    if (!user) return setupPage(ctx);
    const form = await readForm(ctx.request);
    const password = form.get("password") ?? "";
    if (password !== (form.get("confirm") ?? "")) return setupPage(ctx, "รหัสผ่านสองช่องไม่ตรงกัน");
    const problem = validatePasswordPolicy(password, [user.email, user.display_name]);
    if (problem) return setupPage(ctx, passwordMessage(problem));
    const now = iso(ctx.now);
    return newSession(ctx, user, "PASSWORD_SET", [
      ctx.repo.setPasswordStatement(user.id, await hash(password), now),
      ctx.repo.closeTokensStatement(user.id, now),
      ctx.repo.revokeUserSessionsStatement(user.id, now),
    ]);
  }

  // ---------------------------------------------------------------- signed-in pages

  async function logout(ctx: Ctx, me: Me): Promise<Response> {
    await ctx.repo.db.batch([ctx.repo.revokeSessionStatement(me.sessionId, iso(ctx.now)), audit(ctx, me.id, "LOGOUT")]);
    return redirect("/login", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  }

  async function dashboard(ctx: Ctx, me: Me, flash: { kind: "ok" | "error"; text: string } | null = null): Promise<Response> {
    const [latest, open, keyOk] = await Promise.all([
      ctx.repo.db.prepare(
        `SELECT c.site, c.checked_at, c.http_status, c.schema_state, c.cron_state, c.errors_24h, c.slips_waiting, c.suspended, c.detail
           FROM center_site_checks c JOIN (SELECT site, max(checked_at) AS at FROM center_site_checks GROUP BY site) m ON m.site = c.site AND m.at = c.checked_at`,
      ).all<CheckRow>(),
      ctx.repo.db.prepare("SELECT site, type, open_since, detail FROM center_alert_states WHERE open_since IS NOT NULL").all<{ site: string; type: string; open_since: string; detail: string | null }>(),
      signingKey(ctx.env.CENTER_SIGNING_KEY).then(Boolean),
    ]);
    const bySite = new Map(latest.results.map((r) => [r.site, r]));
    const rows = ctx.sites.map((site) => {
      const c = bySite.get(site.slug);
      const alerts = open.results.filter((a) => a.site === site.slug);
      const status = !c ? '<span class="muted">ยังไม่เคยตรวจ</span>'
        : c.http_status !== 200 ? `<span class="bad">ติดต่อไม่ได้</span> <span class="small muted">${esc(c.detail ?? "")}</span>`
          : `${c.suspended ? '<span class="bad">พักการรับจอง</span>' : '<span class="ok">ออนไลน์</span>'}
<span class="small ${c.schema_state === "ok" ? "muted" : "warn"}">· ฐานข้อมูล ${esc(c.schema_state)}</span>
<span class="small ${c.cron_state === "ok" ? "muted" : "warn"}">· cron ${esc(c.cron_state)}</span>
<span class="small ${(c.errors_24h ?? 0) > 0 ? "warn" : "muted"}">· error 24 ชม. ${esc(c.errors_24h)}</span>
<span class="small muted">· สลิปรอตรวจ ${esc(c.slips_waiting)}</span>`;
      const alertHtml = alerts.length
        ? alerts.map((a) => `<div class="small bad">🔴 ${esc(ALERT_LABELS[a.type as SettingType] ?? a.type)} — ตั้งแต่ ${esc(bkk(a.open_since))}</div>`).join("") : "";
      return `<tr><td><a href="/sites/${esc(site.slug)}"><strong>${esc(site.name)}</strong></a><br><a class="small" href="https://${esc(site.domain)}" rel="noopener noreferrer" target="_blank">${esc(site.domain)}</a></td>
<td>${status}${alertHtml}<div class="small muted">ตรวจล่าสุด ${esc(bkk(c?.checked_at ?? null))}</div></td>
<td><form method="post" action="/sites/${esc(site.slug)}/sso" target="_blank" class="inline">
<input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผล เช่น ช่วยตั้งค่าห้องพัก" aria-label="เหตุผลที่เข้าหลังบ้าน ${esc(site.name)}">
<button type="submit">เข้าหลังบ้าน</button></form></td></tr>`;
    }).join("");
    const keyNote = keyOk ? "" : '<div class="flash error">ยังไม่มี key สำหรับเซ็นคำสั่ง — GitHub → Actions → Center setup → keys</div>';
    const runButton = me.role === "SUPPORT_READONLY" ? "" : '<form method="post" action="/checks/run" class="inline"><button class="plain" type="submit">ตรวจตอนนี้</button></form>';
    return html(page({
      title: "เว็บทั้งหมด", user: me, current: "sites", flash,
      body: `<div class="inline" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><h1 style="margin:0">เว็บทั้งหมด (${ctx.sites.length})</h1>${runButton}</div>
<p class="muted small">ตรวจอัตโนมัติทุก 5 นาที · ปัญหาที่เห็น 2 รอบติดกันจะแจ้งเตือนเข้ากลุ่ม LINE</p>${keyNote}
<div class="card scroll"><table><thead><tr><th>เว็บ</th><th>สถานะ</th><th>หลังบ้าน</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted small">การเข้าหลังบ้านทุกครั้งถูกบันทึกทั้งใน Center และใน Audit logs ของเว็บนั้น พร้อมเหตุผล${me.role === "SUPPORT_READONLY" ? " — บทบาทของคุณเข้าได้แบบดูอย่างเดียว" : ""}</p></div>`,
    }));
  }

  async function sitePage(ctx: Ctx, me: Me, slug: string, flash: { kind: "ok" | "error"; text: string } | null = null,
    invite: { email: string; url: string; expiresAt: string } | null = null): Promise<Response> {
    const site = ctx.sites.find((s) => s.slug === slug);
    if (!site) throw new HttpError(404, "ไม่พบเว็บนี้");
    const client = new SiteClient(ctx.env, 5000, clock);
    const actor = actorOf(me);
    const [checks, alerts, log, suspension, users, backups] = await Promise.all([
      ctx.repo.db.prepare("SELECT site, checked_at, http_status, schema_state, cron_state, errors_24h, slips_waiting, suspended, detail FROM center_site_checks WHERE site = ?1 ORDER BY checked_at DESC LIMIT 96").bind(slug).all<CheckRow>(),
      ctx.repo.db.prepare("SELECT type, open_since, detail FROM center_alert_states WHERE site = ?1 AND open_since IS NOT NULL").bind(slug).all<{ type: string; open_since: string; detail: string | null }>(),
      ctx.repo.db.prepare("SELECT type, event, message, delivery, created_at FROM center_alert_log WHERE site = ?1 ORDER BY created_at DESC LIMIT 30").bind(slug).all<{ type: string; event: string; message: string; delivery: string; created_at: string }>(),
      client.call<SuspensionDto>(site, "GET", "/api/center/suspension", actor),
      client.call<{ items: SiteUserDto[] }>(site, "GET", "/api/center/users", actor),
      client.call<{ items: BackupDto[] }>(site, "GET", "/api/center/backups", actor),
    ]);
    const openHtml = alerts.results.length
      ? alerts.results.map((a) => `<li class="bad">${esc(ALERT_LABELS[a.type as SettingType] ?? a.type)} — ${esc(a.detail ?? "")} <span class="muted small">(ตั้งแต่ ${esc(bkk(a.open_since))})</span></li>`).join("")
      : '<li class="ok">ไม่มีปัญหาที่เปิดอยู่</li>';
    const checkRows = checks.results.map((c) => `<tr><td class="small">${esc(bkk(c.checked_at))}</td>
<td>${c.http_status === 200 ? (c.suspended ? '<span class="bad">พัก</span>' : '<span class="ok">ออนไลน์</span>') : `<span class="bad">${c.http_status === 0 ? "ติดต่อไม่ได้" : `HTTP ${c.http_status}`}</span>`}</td>
<td>${esc(c.schema_state ?? "—")}</td><td>${esc(c.cron_state ?? "—")}</td><td>${esc(c.errors_24h ?? "—")}</td><td>${esc(c.slips_waiting ?? "—")}</td><td class="small">${esc(c.detail ?? "")}</td></tr>`).join("");
    const logRows = log.results.map((l) => `<tr><td class="small">${esc(bkk(l.created_at))}</td><td>${l.event === "OPENED" ? "🔴 เกิดปัญหา" : "✅ กลับมาปกติ"}</td><td>${esc(l.message)}</td><td class="small">${esc(l.delivery)}</td></tr>`).join("");

    // ---- service (suspension)
    const s = suspension.status === 200 ? suspension.data : undefined;
    const reasonInput = (label: string) => `<input name="reason" required minlength="3" maxlength="300" placeholder="${esc(label)}" aria-label="${esc(label)}" style="min-width:16rem">`;
    let serviceHtml: string;
    if (!s) serviceHtml = `<p class="warn">อ่านสถานะไม่ได้: ${esc(siteError(suspension.status, suspension.error?.code))}</p>`;
    else if (s.suspended) {
      serviceHtml = `<p class="bad"><strong>พักการรับจองออนไลน์อยู่</strong> — ค้างค่าบริการ ตั้งแต่ ${esc(bkk(s.since))}${s.note ? ` · ${esc(s.note)}` : ""}</p>
<p class="muted small">แขกจองใหม่ไม่ได้ · หน้าเว็บ การจองเดิม สลิป และหลังบ้านใช้ได้ตามปกติ</p>
${me.role === "PLATFORM_OWNER" ? `<form method="post" action="/sites/${esc(slug)}/suspension" class="inline"><input type="hidden" name="op" value="resume">${reasonInput("เหตุผล เช่น ชำระค่าบริการแล้ว")}<button type="submit">เปิดรับจองอีกครั้ง</button></form>` : ""}`;
    } else {
      serviceHtml = `<p class="ok"><strong>เปิดรับจองตามปกติ</strong></p>
${me.role === "PLATFORM_OWNER" ? `<details><summary class="small">พักการรับจอง (เฉพาะกรณีค้างค่าบริการ)</summary>
<form method="post" action="/sites/${esc(slug)}/suspension" class="stack" style="max-width:420px">
<input type="hidden" name="op" value="suspend">
<label for="note">หมายเหตุที่เจ้าของเว็บจะเห็นใน Audit logs (ไม่บังคับ)</label><input id="note" name="note" maxlength="300" placeholder="เช่น ค้างค่าบริการ ก.ย.–ต.ค.">
<label for="reason">เหตุผล (บันทึกใน Center และในเว็บ)</label><input id="reason" name="reason" required minlength="3" maxlength="300">
<label class="check"><input type="checkbox" name="confirm" value="UNPAID_FEES" required> ยืนยันว่าเว็บนี้ค้างค่าบริการ — แขกจะจองใหม่ไม่ได้จนกว่าจะเปิดอีกครั้ง</label>
<p><button class="danger" type="submit">พักการรับจอง</button></p></form></details>` : '<p class="muted small">พัก / เปิดเว็บได้เฉพาะเจ้าของแพลตฟอร์ม</p>'}`;
    }

    // ---- the site's own admins
    const roleNames: Record<string, string> = { SUPER_ADMIN: "SUPER_ADMIN", MANAGER: "ผู้จัดการ", STAFF: "พนักงาน" };
    const userRows = users.status === 200 && users.data
      ? users.data.items.map((u) => `<tr><td>${esc(u.displayName)}<br><span class="small muted">${esc(u.email)}</span></td><td class="small">${esc(u.roles.map((r) => roleNames[r] ?? r).join(", ") || "—")}</td>
<td class="small ${u.status === "ACTIVE" ? "ok" : "bad"}">${esc(u.status)}</td><td class="small">${esc(bkk(u.lastLoginAt))}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">ไม่มีผู้ใช้</td></tr>'
      : `<tr><td colspan="4" class="warn">อ่านรายชื่อไม่ได้: ${esc(siteError(users.status, users.error?.code))}</td></tr>`;

    // ---- a new site's first owner (phase C7): only while the site has no account of its own, or its only
    // SUPER_ADMIN has never signed in (then a new link replaces the old one).
    const siteUsers = users.status === 200 && users.data ? users.data.items : null;
    const pendingOwner = siteUsers?.length === 1 && siteUsers[0]!.lastLoginAt === null && siteUsers[0]!.roles.includes("SUPER_ADMIN") ? siteUsers[0]! : null;
    let ownerHtml = "";
    if (invite) {
      ownerHtml = `<div class="card" style="border-color:var(--ok)"><h2 style="margin-top:0">ลิงก์สำหรับเจ้าของเว็บ</h2>
<p>ส่งลิงก์นี้ให้ <strong>${esc(invite.email)}</strong> ทางช่องทางส่วนตัว — ใช้ตั้งรหัสผ่านได้ครั้งเดียว ภายใน ${esc(bkk(invite.expiresAt))}
<br><span class="small muted">แสดงครั้งเดียวและไม่ถูกบันทึกที่ใด ถ้าทำหายให้สร้างใหม่ (ลิงก์เก่าจะใช้ไม่ได้)</span></p>
<p class="mono">${esc(invite.url)}</p></div>`;
    } else if (me.role === "PLATFORM_OWNER" && siteUsers && (siteUsers.length === 0 || pendingOwner)) {
      ownerHtml = `<div class="card"><h2 style="margin-top:0">เจ้าของเว็บ</h2>
<p class="small muted">${pendingOwner
  ? `${esc(pendingOwner.email)} ยังไม่ได้เข้าใช้ — สร้างลิงก์ใหม่ได้ (ลิงก์เดิมจะใช้ไม่ได้)`
  : "เว็บนี้ยังไม่มีผู้ดูแล — สร้างบัญชี SUPER_ADMIN ให้เจ้าของ แล้วส่งลิงก์ตั้งรหัสผ่าน (72 ชั่วโมง) ให้เขา"}</p>
<form method="post" action="/sites/${esc(slug)}/owner" class="stack" style="max-width:420px">
<label for="owner-email">อีเมลเจ้าของ</label><input id="owner-email" name="email" type="email" required maxlength="254" value="${esc(pendingOwner?.email ?? "")}"${pendingOwner ? " readonly" : ""}>
<label for="owner-name">ชื่อ</label><input id="owner-name" name="name" required maxlength="120" value="${esc(pendingOwner?.displayName ?? "")}"${pendingOwner ? " readonly" : ""}>
<label for="owner-reason">เหตุผล</label><input id="owner-reason" name="reason" required minlength="3" maxlength="300" value="${pendingOwner ? "" : "เปิดเว็บใหม่"}">
<p><button type="submit">${pendingOwner ? "สร้างลิงก์ใหม่" : "สร้างบัญชีเจ้าของเว็บ"}</button></p></form></div>`;
    }

    // ---- backups (phase C8): in the site's own private bucket; the file only for PLATFORM_OWNER (guest data).
    const backupRows = backups.status === 200 && backups.data
      ? backups.data.items.slice(0, 10).map((b) => `<tr><td class="small">${esc(bkk(b.createdAt))}</td><td class="small">${b.trigger === "CRON" ? "อัตโนมัติ" : "จาก Center"}</td>
<td class="small">${esc(sizeText(b.size))}</td><td class="small">${esc(b.rows ?? "—")} แถว</td>
<td>${me.role === "PLATFORM_OWNER" ? `<form method="post" action="/sites/${esc(slug)}/backup-download" class="inline"><input type="hidden" name="name" value="${esc(b.name)}"><input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผล" aria-label="เหตุผลที่ดาวน์โหลด" style="width:9rem"><button class="plain" type="submit">ดาวน์โหลด</button></form>` : ""}</td></tr>`).join("")
        || '<tr><td colspan="5" class="muted">ยังไม่มีไฟล์สำรอง (สำรองอัตโนมัติทุกวัน 03:17 น.)</td></tr>'
      : `<tr><td colspan="5" class="warn">อ่านรายการไม่ได้: ${esc(siteError(backups.status, backups.error?.code))}</td></tr>`;
    const latestBackup = backups.data?.items[0];
    const backupStale = !latestBackup || ctx.now.getTime() - new Date(latestBackup.createdAt).getTime() > 48 * 3_600_000;
    const backupHtml = `<div class="card scroll"><h2 style="margin-top:0">สำรองข้อมูล</h2>
<p class="small ${backups.status === 200 && backupStale ? "warn" : "muted"}">ฐานข้อมูลของเว็บนี้สำรองเป็นไฟล์ .sql.gz ไว้ในที่เก็บไฟล์ส่วนตัวของเว็บเอง (ในบัญชี Cloudflare ของแพลตฟอร์ม) อัตโนมัติวันละครั้ง เก็บ 30 ไฟล์ล่าสุด${backups.status === 200 && backupStale ? " — ไม่มีไฟล์สำรองในช่วง 48 ชั่วโมงที่ผ่านมา" : ""}</p>
<table><thead><tr><th>เวลา</th><th>ที่มา</th><th>ขนาด</th><th>ข้อมูล</th><th></th></tr></thead><tbody>${backupRows}</tbody></table>
${me.role === "SUPPORT_READONLY" ? "" : `<form method="post" action="/sites/${esc(slug)}/backup" class="inline" style="margin-top:12px">${reasonInput("เหตุผล เช่น ก่อนแก้ข้อมูลจำนวนมาก")}<button type="submit">สำรองตอนนี้</button></form>`}
${me.role === "PLATFORM_OWNER" ? '<p class="small muted">ไฟล์มีข้อมูลแขก: ดาวน์โหลดเฉพาะเมื่อจำเป็น (เช่น เจ้าของเว็บขอข้อมูลตอนเลิกใช้บริการ) ทุกครั้งถูกบันทึกทั้งใน Center และในเว็บ</p>' : ""}</div>`;

    const revokeHtml = me.role === "SUPPORT_READONLY" ? "" : `<div class="card"><h2 style="margin-top:0">session ของ Center ในเว็บนี้</h2>
<p class="small muted">ออกจากหลังบ้านของเว็บนี้ทุกคนที่เข้ามาจาก Center (บัญชี "Center · …") และยกเลิกตั๋ว SSO ที่ยังไม่ได้ใช้ — admin ของเว็บเองไม่ถูกกระทบ</p>
<form method="post" action="/sites/${esc(slug)}/revoke" class="inline">${reasonInput("เหตุผล")}<button class="danger" type="submit">ตัด session ของ Center ทั้งหมด</button></form></div>`;

    return html(page({
      title: site.name, user: me, current: "sites", flash,
      body: `<p class="small"><a href="/">← เว็บทั้งหมด</a></p><h1>${esc(site.name)} <a class="muted small" href="https://${esc(site.domain)}" rel="noopener noreferrer" target="_blank">${esc(site.domain)}</a></h1>
<div class="card"><h2 style="margin-top:0">หลังบ้าน</h2><form method="post" action="/sites/${esc(slug)}/sso" target="_blank" class="inline">${reasonInput("เหตุผลที่เข้าหลังบ้าน")}<button type="submit">เข้าหลังบ้าน</button></form></div>
${ownerHtml}
<div class="card"><h2 style="margin-top:0">การให้บริการ</h2>${serviceHtml}</div>
<div class="card"><h2 style="margin-top:0">ปัญหาที่เปิดอยู่</h2><ul>${openHtml}</ul></div>
<div class="card scroll"><h2 style="margin-top:0">ผู้ดูแลของเว็บ</h2><table><thead><tr><th>ชื่อ</th><th>บทบาท</th><th>สถานะ</th><th>เข้าล่าสุด</th></tr></thead><tbody>${userRows}</tbody></table>
<p class="small muted">อ่านจากเว็บโดยตรง (ไม่รวมบัญชี Center) — เพิ่ม / แก้ผู้ใช้ทำในหลังบ้านของเว็บ</p></div>
${backupHtml}
${revokeHtml}
<div class="card scroll"><h2 style="margin-top:0">ผลตรวจล่าสุด (8 ชั่วโมง)</h2><table><thead><tr><th>เวลา</th><th>สถานะ</th><th>ฐานข้อมูล</th><th>cron</th><th>error 24 ชม.</th><th>สลิปรอตรวจ</th><th>รายละเอียด</th></tr></thead>
<tbody>${checkRows || '<tr><td colspan="7" class="muted">ยังไม่เคยตรวจ</td></tr>'}</tbody></table></div>
<div class="card scroll"><h2 style="margin-top:0">ประวัติการแจ้งเตือน</h2><table><thead><tr><th>เวลา</th><th>เหตุการณ์</th><th>รายละเอียด</th><th>LINE</th></tr></thead>
<tbody>${logRows || '<tr><td colspan="4" class="muted">ยังไม่มี</td></tr>'}</tbody></table></div>`,
    }), flash?.kind === "error" ? 422 : 200);
  }

  async function changeSuspension(ctx: Ctx, me: Me, slug: string): Promise<Response> {
    const site = ctx.sites.find((s) => s.slug === slug);
    if (!site) throw new HttpError(404, "ไม่พบเว็บนี้");
    if (me.role !== "PLATFORM_OWNER") throw new HttpError(403, "พัก / เปิดเว็บได้เฉพาะเจ้าของแพลตฟอร์ม");
    const form = await readForm(ctx.request);
    const op = form.get("op");
    const reason = (form.get("reason") ?? "").trim();
    const note = (form.get("note") ?? "").trim().slice(0, 300) || null;
    if (op !== "suspend" && op !== "resume") throw new HttpError(422, "คำสั่งไม่ถูกต้อง");
    if (reason.length < 3 || reason.length > 300) return sitePage(ctx, me, slug, { kind: "error", text: "กรุณาระบุเหตุผล 3–300 ตัวอักษร" });
    if (op === "suspend" && form.get("confirm") !== "UNPAID_FEES") return sitePage(ctx, me, slug, { kind: "error", text: "ต้องติ๊กยืนยันว่าเว็บนี้ค้างค่าบริการ" });
    const suspended = op === "suspend";
    const res = await new SiteClient(ctx.env, 8000, clock).call<SuspensionDto>(site, "PUT", "/api/center/suspension", { ...actorOf(me), reason }, { suspended, note: suspended ? note : null });
    const ok = res.status === 200;
    await audit(ctx, me.id, suspended ? "SITE_SUSPENDED" : "SITE_RESUMED", site.slug, reason, { ok, status: res.status, note: suspended ? note : null, error: res.error?.code ?? null }).run();
    if (!ok) return sitePage(ctx, me, slug, { kind: "error", text: `${site.name} ไม่รับคำสั่ง: ${siteError(res.status, res.error?.code)}` });
    return sitePage(ctx, me, slug, { kind: "ok", text: suspended ? `พักการรับจองของ ${site.name} แล้ว` : `เปิดรับจองของ ${site.name} อีกครั้งแล้ว` });
  }

  async function inviteSiteOwner(ctx: Ctx, me: Me, slug: string): Promise<Response> {
    const site = ctx.sites.find((s) => s.slug === slug);
    if (!site) throw new HttpError(404, "ไม่พบเว็บนี้");
    if (me.role !== "PLATFORM_OWNER") throw new HttpError(403, "สร้างบัญชีเจ้าของเว็บได้เฉพาะเจ้าของแพลตฟอร์ม");
    const form = await readForm(ctx.request);
    const email = (form.get("email") ?? "").trim().toLowerCase();
    const name = (form.get("name") ?? "").trim();
    const reason = (form.get("reason") ?? "").trim();
    if (reason.length < 3 || reason.length > 300) return sitePage(ctx, me, slug, { kind: "error", text: "กรุณาระบุเหตุผล 3–300 ตัวอักษร" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !name || name.length > 120) {
      return sitePage(ctx, me, slug, { kind: "error", text: "กรุณาใส่อีเมลและชื่อให้ถูกต้อง" });
    }
    const res = await new SiteClient(ctx.env, 8000, clock).call<{ created: boolean; url: string; expiresAt: string }>(site, "POST", "/api/center/owner", { ...actorOf(me), reason }, { email, name });
    // The link itself is never stored in Center.
    await audit(ctx, me.id, "OWNER_INVITED", site.slug, reason, { ok: res.status === 200, email, created: res.data?.created ?? null, error: res.error?.code ?? null }).run();
    if (res.status !== 200 || !res.data) {
      const text = res.error?.code === "SITE_HAS_OWNER" ? `${site.name} มีผู้ดูแลของตัวเองแล้ว — ให้ admin ของเว็บเพิ่มผู้ใช้ในหลังบ้าน` : `${site.name} ไม่รับคำสั่ง: ${siteError(res.status, res.error?.code)}`;
      return sitePage(ctx, me, slug, { kind: "error", text });
    }
    return sitePage(ctx, me, slug, { kind: "ok", text: res.data.created ? `สร้างบัญชีเจ้าของ ${site.name} แล้ว` : "สร้างลิงก์ใหม่แล้ว (ลิงก์เดิมใช้ไม่ได้)" },
      { email, url: res.data.url, expiresAt: res.data.expiresAt });
  }

  async function backupSite(ctx: Ctx, me: Me, slug: string): Promise<Response> {
    const site = ctx.sites.find((s) => s.slug === slug);
    if (!site) throw new HttpError(404, "ไม่พบเว็บนี้");
    if (me.role === "SUPPORT_READONLY") throw new HttpError(403, "บทบาทของคุณทำไม่ได้");
    const reason = ((await readForm(ctx.request)).get("reason") ?? "").trim();
    if (reason.length < 3 || reason.length > 300) return sitePage(ctx, me, slug, { kind: "error", text: "กรุณาระบุเหตุผล 3–300 ตัวอักษร" });
    const res = await new SiteClient(ctx.env, 30000, clock).call<BackupDto>(site, "POST", "/api/center/backups", { ...actorOf(me), reason });
    await audit(ctx, me.id, "SITE_BACKUP", site.slug, reason, { ok: res.status === 200, name: res.data?.name ?? null, size: res.data?.size ?? null, error: res.error?.code ?? null }).run();
    if (res.status !== 200 || !res.data) return sitePage(ctx, me, slug, { kind: "error", text: `${site.name} ไม่รับคำสั่ง: ${siteError(res.status, res.error?.code)}` });
    return sitePage(ctx, me, slug, { kind: "ok", text: `สำรองข้อมูล ${site.name} แล้ว (${sizeText(res.data.size)}, ${res.data.rows ?? 0} แถว)` });
  }

  async function downloadBackup(ctx: Ctx, me: Me, slug: string): Promise<Response> {
    const site = ctx.sites.find((s) => s.slug === slug);
    if (!site) throw new HttpError(404, "ไม่พบเว็บนี้");
    if (me.role !== "PLATFORM_OWNER") throw new HttpError(403, "ดาวน์โหลดไฟล์สำรองได้เฉพาะเจ้าของแพลตฟอร์ม");
    const form = await readForm(ctx.request);
    const name = form.get("name") ?? "";
    const reason = (form.get("reason") ?? "").trim();
    if (!BACKUP_NAME.test(name)) throw new HttpError(422, "ชื่อไฟล์ไม่ถูกต้อง");
    if (reason.length < 3 || reason.length > 300) return sitePage(ctx, me, slug, { kind: "error", text: "กรุณาระบุเหตุผลที่ดาวน์โหลด 3–300 ตัวอักษร" });
    const res = await new SiteClient(ctx.env, 8000, clock).raw(site, `/api/center/backups/download?name=${encodeURIComponent(name)}`, { ...actorOf(me), reason });
    const ok = res?.status === 200 && res.headers.get("Content-Type") === "application/gzip";
    await audit(ctx, me.id, "BACKUP_DOWNLOAD", site.slug, reason, { ok, name, status: res?.status ?? 0 }).run();
    if (!ok || !res?.body) {
      await res?.body?.cancel();
      return sitePage(ctx, me, slug, { kind: "error", text: `ดาวน์โหลดไม่ได้ (${res ? `HTTP ${res.status}` : "ติดต่อเว็บไม่ได้"})` });
    }
    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${site.slug}-${name}"`,
        ...(res.headers.get("Content-Length") ? { "Content-Length": res.headers.get("Content-Length")! } : {}),
      },
    });
  }

  // ---------------------------------------------------------------- release (phase C8)

  async function releasesPage(ctx: Ctx, me: Me, flash: { kind: "ok" | "error"; text: string } | null = null): Promise<Response> {
    const runs = await listReleaseRuns(ctx.env, options.githubFetch);
    const statusText = (r: ReleaseRun) => r.status !== "completed" ? `<span class="warn">${r.status === "queued" ? "รอคิว" : r.status === "waiting" ? "รออนุมัติ" : "กำลังทำ"}</span>`
      : r.conclusion === "success" ? '<span class="ok">สำเร็จ</span>' : `<span class="bad">${esc(r.conclusion ?? "ไม่สำเร็จ")}</span>`;
    const rows = runs.ok
      ? runs.value.map((r) => `<tr><td>#${r.number}</td><td>${esc(r.title)}</td><td>${statusText(r)}</td><td class="small">${esc(bkk(r.createdAt))}</td>
<td class="small mono">${esc(r.sha)}</td><td class="small">${esc(r.actor ?? "")}</td><td>${r.url ? `<a href="${esc(r.url)}" rel="noopener noreferrer" target="_blank">ดูใน GitHub</a>` : ""}</td></tr>`).join("")
        || '<tr><td colspan="7" class="muted">ยังไม่มี</td></tr>'
      : `<tr><td colspan="7" class="warn">${esc(runs.reason)}</td></tr>`;
    const choices = [...ctx.sites.map((s) => [s.slug, `${s.name} (${s.domain})`]), ["center", "Center (center.phasakura.com)"]]
      .map(([v, l]) => `<label class="check"><input type="checkbox" name="site" value="${esc(v)}"> ${esc(l)}</label>`).join("");
    const form = me.role !== "PLATFORM_OWNER" ? '<p class="small muted">สั่ง Release ได้เฉพาะเจ้าของแพลตฟอร์ม</p>'
      : `<form method="post" action="/releases" class="stack" style="max-width:520px">
<p class="small muted">GitHub Actions จะปล่อยโค้ดล่าสุดของ main ทีละเว็บตามรอบ (wave): preflight → จุดย้อนกลับ D1 → migrate → deploy → smoke test</p>
<label class="check"><input type="checkbox" name="site" value="all"> <strong>ทุกเว็บ + Center</strong></label>${choices}
<label for="rel-reason">เหตุผล (แสดงในชื่อ run บน GitHub และบันทึกใน Center)</label><input id="rel-reason" name="reason" required minlength="3" maxlength="100">
<p><button type="submit">เริ่ม Release</button></p></form>`;
    return html(page({
      title: "Release", user: me, current: "releases", flash,
      body: `<h1>Release</h1><div class="card">${form}</div>
<div class="card scroll"><h2 style="margin-top:0">Release ล่าสุด</h2><table><thead><tr><th>Run</th><th>รายการ</th><th>สถานะ</th><th>เริ่ม</th><th>commit</th><th>โดย</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<p class="small muted"><a href="/releases">รีเฟรช</a> · รายละเอียดแต่ละขั้นและจุดย้อนกลับ (bookmark) อยู่ในหน้า Summary ของ run บน GitHub</p></div>`,
    }), flash?.kind === "error" ? 422 : 200);
  }

  async function requestRelease(ctx: Ctx, me: Me): Promise<Response> {
    if (me.role !== "PLATFORM_OWNER") throw new HttpError(403, "สั่ง Release ได้เฉพาะเจ้าของแพลตฟอร์ม");
    const form = await readForm(ctx.request);
    const reason = (form.get("reason") ?? "").trim();
    const sites = releaseSelection(form.getAll("site"), ctx.sites);
    if (!sites) return releasesPage(ctx, me, { kind: "error", text: "เลือกอย่างน้อยหนึ่งเว็บ" });
    if (reason.length < 3 || reason.length > 100) return releasesPage(ctx, me, { kind: "error", text: "กรุณาระบุเหตุผล 3–100 ตัวอักษร" });
    const note = `${me.email}: ${reason}`.replace(/[\r\n]+/g, " ");
    const res = await startRelease(ctx.env, sites, note, options.githubFetch);
    await audit(ctx, me.id, "RELEASE_STARTED", null, reason, { sites, ok: res.ok, error: res.ok ? null : res.reason }).run();
    return releasesPage(ctx, me, res.ok
      ? { kind: "ok", text: `ส่งคำสั่ง Release "${sites}" ให้ GitHub แล้ว — run ใหม่จะขึ้นในรายการภายในไม่กี่วินาที` }
      : { kind: "error", text: `GitHub ไม่รับคำสั่ง: ${res.reason}` });
  }

  async function revokeSiteSessions(ctx: Ctx, me: Me, slug: string): Promise<Response> {
    const site = ctx.sites.find((s) => s.slug === slug);
    if (!site) throw new HttpError(404, "ไม่พบเว็บนี้");
    if (me.role === "SUPPORT_READONLY") throw new HttpError(403, "บทบาทของคุณทำไม่ได้");
    const reason = ((await readForm(ctx.request)).get("reason") ?? "").trim();
    if (reason.length < 3 || reason.length > 300) return sitePage(ctx, me, slug, { kind: "error", text: "กรุณาระบุเหตุผล 3–300 ตัวอักษร" });
    const res = await new SiteClient(ctx.env, 8000, clock).call<{ revoked: number }>(site, "POST", "/api/center/sessions/revoke", { ...actorOf(me), reason }, {});
    await audit(ctx, me.id, "SITE_SESSIONS_REVOKED", site.slug, reason, { ok: res.status === 200, revoked: res.data?.revoked ?? null }).run();
    if (res.status !== 200) return sitePage(ctx, me, slug, { kind: "error", text: `${site.name} ไม่รับคำสั่ง: ${siteError(res.status, res.error?.code)}` });
    return sitePage(ctx, me, slug, { kind: "ok", text: `ตัด session ของ Center ใน ${site.name} แล้ว (${res.data?.revoked ?? 0} session)` });
  }

  async function settingsPage(ctx: Ctx, me: Me, flash: { kind: "ok" | "error"; text: string } | null = null): Promise<Response> {
    const settings = await loadSettings(ctx.repo.db);
    const token = ctx.env.CENTER_LINE_TOKEN?.trim();
    const bot = token ? await createLineApi(token, options.lineFetch).botInfo() : null;
    const groups = (await ctx.repo.db.prepare("SELECT group_id, name, joined_at FROM center_line_groups WHERE left_at IS NULL ORDER BY joined_at DESC").all<{ group_id: string; name: string | null; joined_at: string }>()).results;
    const log = (await ctx.repo.db.prepare("SELECT site, event, message, delivery, error, created_at FROM center_alert_log ORDER BY created_at DESC LIMIT 20").all<{ site: string | null; event: string; message: string; delivery: string; error: string | null; created_at: string }>()).results;
    const base = (ctx.env.APP_BASE_URL?.trim() || ctx.url.origin).replace(/\/+$/, "");
    const botLine = !token ? '<span class="bad">ยังไม่ได้ตั้ง secret CENTER_LINE_TOKEN และ CENTER_LINE_SECRET</span>'
      : bot && bot.ok ? `<span class="ok">เชื่อมต่อแล้ว</span> · ${esc(bot.info.displayName ?? "")} ${bot.info.basicId ? `(${esc(bot.info.basicId)})` : ""}` : `<span class="bad">token ใช้ไม่ได้ (${esc(bot && !bot.ok ? bot.error : "")})</span>`;
    const groupOptions = groups.length
      ? groups.map((g) => `<label style="font-weight:400"><input type="radio" name="line_group_id" value="${esc(g.group_id)}"${g.group_id === settings.lineGroupId ? " checked" : ""}> ${esc(g.name ?? "(ไม่ทราบชื่อกลุ่ม)")} <span class="muted small mono">${esc(g.group_id)}</span></label>`).join("")
        + `<label style="font-weight:400"><input type="radio" name="line_group_id" value=""${settings.lineGroupId ? "" : " checked"}> ไม่ส่ง</label>`
      : '<p class="muted">ยังไม่มีกลุ่ม — เชิญบอทของ Center เข้ากลุ่ม LINE แล้วพิมพ์ข้อความอะไรก็ได้ในกลุ่ม 1 ครั้ง จากนั้นรีเฟรชหน้านี้</p><input type="hidden" name="line_group_id" value="">';
    const typeBoxes = SETTING_TYPES.map((t) => `<label class="check"><input type="checkbox" name="type" value="${t}"${settings.alertTypes.has(t) ? " checked" : ""}> ${esc(ALERT_LABELS[t])}</label>`).join("");
    const logRows = log.map((l) => `<tr><td class="small">${esc(bkk(l.created_at))}</td><td>${esc(l.site ?? "—")}</td><td>${esc(l.event)}</td><td class="small">${esc(l.message)}</td><td class="small ${l.delivery === "SENT" ? "ok" : l.delivery === "FAILED" ? "bad" : "muted"}">${esc(l.delivery)}${l.error ? ` — ${esc(l.error)}` : ""}</td></tr>`).join("");
    return html(page({
      title: "ตั้งค่า", user: me, current: "settings", flash,
      body: `<h1>ตั้งค่า Center</h1>
<div class="card"><h2 style="margin-top:0">LINE สำหรับแจ้งเตือนระบบ</h2><p>${botLine}</p>
<p class="small">Webhook URL (ใส่ใน LINE Developers → Messaging API): <span class="mono">${esc(base)}/line/webhook</span></p>
<form method="post" action="/settings" class="stack"><h2>ส่งแจ้งเตือนเข้ากลุ่ม</h2>${groupOptions}
<h2>ประเภทที่แจ้งเตือน</h2>${typeBoxes}
<p class="muted small">ปัญหาต้องพบ 2 รอบติดกัน (ประมาณ 10 นาที) จึงแจ้ง · แจ้งครั้งเดียวต่อปัญหา · error สูง = ตั้งแต่ 5 ครั้งใน 24 ชม.</p>
<p><button type="submit">บันทึก</button></p></form>
<form method="post" action="/settings/test" class="inline"><button class="plain" type="submit">ส่งข้อความทดสอบ</button></form></div>
<div class="card scroll"><h2 style="margin-top:0">การแจ้งเตือนล่าสุด</h2><table><thead><tr><th>เวลา</th><th>เว็บ</th><th>เหตุการณ์</th><th>ข้อความ</th><th>LINE</th></tr></thead><tbody>${logRows || '<tr><td colspan="5" class="muted">ยังไม่มี</td></tr>'}</tbody></table></div>`,
    }), flash?.kind === "error" ? 422 : 200);
  }

  async function saveSettings(ctx: Ctx, me: Me): Promise<Response> {
    const form = await readForm(ctx.request);
    const group = (form.get("line_group_id") ?? "").trim();
    if (group && !/^C[0-9a-f]{32}$/.test(group)) return settingsPage(ctx, me, { kind: "error", text: "กลุ่ม LINE ไม่ถูกต้อง" });
    if (group && !(await ctx.repo.db.prepare("SELECT 1 AS ok FROM center_line_groups WHERE group_id = ?1 AND left_at IS NULL").bind(group).first())) {
      return settingsPage(ctx, me, { kind: "error", text: "บอทไม่ได้อยู่ในกลุ่มนี้แล้ว" });
    }
    const types = form.getAll("type").filter((t): t is SettingType => (SETTING_TYPES as readonly string[]).includes(t));
    const before = await loadSettings(ctx.repo.db);
    await ctx.repo.db.batch([
      ctx.repo.db.prepare("UPDATE center_settings SET line_group_id = ?1, alert_types = ?2, updated_by = ?3, updated_at = ?4 WHERE id = 1")
        .bind(group || null, JSON.stringify([...new Set(types)]), me.id, iso(ctx.now)),
      audit(ctx, me.id, "SETTINGS_CHANGED", null, null, {
        lineGroup: { from: before.lineGroupId, to: group || null }, alertTypes: { from: [...before.alertTypes], to: [...new Set(types)] },
      }),
    ]);
    return settingsPage(ctx, me, { kind: "ok", text: "บันทึกแล้ว" });
  }

  async function webhook(ctx: Ctx): Promise<Response> {
    const secret = ctx.env.CENTER_LINE_SECRET?.trim() ?? "";
    const raw = new Uint8Array(await ctx.request.arrayBuffer());
    if (raw.length > 256 * 1024) throw new HttpError(413, "too large");
    if (!(await verifyLineSignature(secret, raw, ctx.request.headers.get("x-line-signature")))) {
      return new Response(JSON.stringify({ error: "bad signature" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    let events: unknown[] = [];
    try {
      const body = JSON.parse(new TextDecoder().decode(raw)) as { events?: unknown };
      if (Array.isArray(body.events)) events = body.events.slice(0, 100);
    } catch {
      return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const handled = await lineWebhook(ctx.env, events, ctx.now, options.lineFetch);
    return new Response(JSON.stringify({ handled }), { headers: { "Content-Type": "application/json" } });
  }

  async function startSso(ctx: Ctx, me: Me, slug: string): Promise<Response> {
    const site = ctx.sites.find((s) => s.slug === slug);
    if (!site) throw new HttpError(404, "ไม่พบเว็บนี้");
    const reason = ((await readForm(ctx.request)).get("reason") ?? "").trim();
    if (reason.length < 3 || reason.length > 300) throw new HttpError(422, "กรุณาระบุเหตุผล 3–300 ตัวอักษร");
    const res = await new SiteClient(ctx.env, 8000, clock).call<{ ticket: string; consumeUrl: string }>(site, "POST", "/api/center/sso", { ...actorOf(me), reason });
    const consume = res.data?.consumeUrl ?? "";
    if (res.status !== 200 || !res.data?.ticket || consume !== `https://${site.domain}/api/center/sso/consume`) {
      await audit(ctx, me.id, "SSO", site.slug, reason, { ok: false, status: res.status, error: res.error?.code ?? null }).run();
      throw new HttpError(502, `เข้าหลังบ้าน ${site.name} ไม่ได้: ${siteError(res.status, res.error?.code)}`);
    }
    await audit(ctx, me.id, "SSO", site.slug, reason, { ok: true }).run();
    return new Response(ssoHandoffPage(site.name, consume, res.data.ticket), { headers: { "Content-Type": "text/html; charset=utf-8", "X-Center-Page": "sso" } });
  }

  async function auditPage(ctx: Ctx, me: Me): Promise<Response> {
    const rows = (await ctx.repo.recentAudit(300)).map((a) => `<tr><td class="small">${esc(bkk(a.created_at))}</td><td>${esc(a.user_name ?? "—")}</td>
<td>${esc(ACTION_LABELS[a.action] ?? a.action)}${a.detail_json?.includes('"ok":false') ? ' <span class="bad small">ไม่สำเร็จ</span>' : ""}</td><td>${esc(a.site ?? "")}</td><td>${esc(a.reason ?? "")}</td></tr>`).join("");
    return html(page({
      title: "บันทึกการใช้งาน", user: me, current: "audit",
      body: `<h1>บันทึกการใช้งาน Center</h1><div class="card scroll"><table><thead><tr><th>เวลา (ไทย)</th><th>ใคร</th><th>ทำอะไร</th><th>เว็บ</th><th>เหตุผล</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">ยังไม่มีรายการ</td></tr>'}</tbody></table>
<p class="muted small">300 รายการล่าสุด สิ่งที่ทำในหลังบ้านของเว็บดูได้ใน Audit logs ของเว็บนั้น</p></div>`,
    }));
  }

  async function accountPage(ctx: Ctx, me: Me, flash: { kind: "ok" | "error"; text: string } | null = null): Promise<Response> {
    const left = await ctx.repo.recoveryCodesLeft(me.id);
    const mfaCard = `<div class="card"><h2 style="margin-top:0">ยืนยันตัวตน 2 ขั้น</h2><p class="ok">เปิดใช้อยู่</p>
<p class="small ${left <= 3 ? "warn" : "muted"}">รหัสสำรองที่ยังไม่ได้ใช้: ${left} รหัส${left <= 3 ? " — ควรสร้างชุดใหม่" : ""}</p>
<form method="post" action="/account/recovery-codes" class="inline"><button type="submit">สร้างรหัสสำรองชุดใหม่</button></form>
<p class="small muted">มือถือหาย: ใช้รหัสสำรองเข้าสู่ระบบ แล้วขอเจ้าของแพลตฟอร์มอีกคน "รีเซ็ต 2 ขั้น" ให้ เพื่อสแกน QR ใหม่</p></div>`;
    return html(page({
      title: "บัญชีของฉัน", user: me, current: "account", flash,
      body: `<h1>บัญชีของฉัน</h1><div class="card"><p>${esc(me.displayName)} · ${esc(me.email)} · ${esc(ROLE_LABELS[me.role])}</p>
<h2>เปลี่ยนรหัสผ่าน</h2><form method="post" action="/account/password" class="stack" style="max-width:380px">
<label for="current">รหัสผ่านปัจจุบัน</label><input id="current" name="current" type="password" autocomplete="current-password" required maxlength="200">
<label for="password">รหัสผ่านใหม่ (อย่างน้อย 12 ตัว)</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="200">
<label for="confirm">พิมพ์อีกครั้ง</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="200">
<p><button type="submit">เปลี่ยนรหัสผ่าน</button></p></form><p class="muted small">เปลี่ยนแล้ว ทุก session อื่นของคุณจะออกจากระบบ</p></div>${mfaCard}`,
    }), flash?.kind === "error" ? 422 : 200);
  }

  async function changePassword(ctx: Ctx, me: Me): Promise<Response> {
    const form = await readForm(ctx.request);
    const user = await ctx.repo.userById(me.id);
    if (!user?.password_hash || !(await verifyPassword(form.get("current") ?? "", user.password_hash))) return accountPage(ctx, me, { kind: "error", text: "รหัสผ่านปัจจุบันไม่ถูกต้อง" });
    const password = form.get("password") ?? "";
    if (password !== (form.get("confirm") ?? "")) return accountPage(ctx, me, { kind: "error", text: "รหัสผ่านใหม่สองช่องไม่ตรงกัน" });
    const problem = validatePasswordPolicy(password, [user.email, user.display_name]);
    if (problem) return accountPage(ctx, me, { kind: "error", text: passwordMessage(problem) });
    const now = iso(ctx.now);
    await ctx.repo.db.batch([
      ctx.repo.setPasswordStatement(me.id, await hash(password), now),
      ctx.repo.db.prepare("UPDATE center_sessions SET revoked_at = ?2 WHERE user_id = ?1 AND id <> ?3 AND revoked_at IS NULL").bind(me.id, now, me.sessionId),
      audit(ctx, me.id, "PASSWORD_CHANGED"),
    ]);
    return accountPage(ctx, me, { kind: "ok", text: "เปลี่ยนรหัสผ่านแล้ว" });
  }

  // ---------------------------------------------------------------- people (PLATFORM_OWNER)

  async function usersPage(ctx: Ctx, me: Me, flash: { kind: "ok" | "error"; text: string } | null = null, extra = ""): Promise<Response> {
    const roleOptions = (selected: string) => CENTER_ROLES.map((r) => `<option value="${r}"${r === selected ? " selected" : ""}>${esc(ROLE_LABELS[r])}</option>`).join("");
    const rows = (await ctx.repo.users()).map((u) => {
      const self = u.id === me.id;
      const actions = u.status === "ACTIVE"
        ? `<form method="post" action="/users/${u.id}/role" class="inline"><select name="role" aria-label="บทบาทของ ${esc(u.display_name)}">${roleOptions(u.role)}</select>
<input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผล" aria-label="เหตุผล"><button type="submit">เปลี่ยนบทบาท</button></form>
<form method="post" action="/users/${u.id}/setup-link" class="inline" style="margin-top:6px"><button class="plain" type="submit">สร้างลิงก์ตั้งรหัสผ่านใหม่</button></form>
${self || !u.totp_secret ? "" : `<form method="post" action="/users/${u.id}/mfa-reset" class="inline" style="margin-top:6px"><input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผล เช่น มือถือหาย" aria-label="เหตุผลที่รีเซ็ต 2 ขั้น"><button class="plain" type="submit">รีเซ็ต 2 ขั้น</button></form>`}
${self ? "" : `<form method="post" action="/users/${u.id}/disable" class="inline" style="margin-top:6px"><input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผลที่ปิดบัญชี" aria-label="เหตุผลที่ปิดบัญชี"><button class="danger" type="submit">ปิดบัญชี</button></form>`}`
        : `<form method="post" action="/users/${u.id}/enable" class="inline"><input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผล" aria-label="เหตุผล"><button type="submit">เปิดบัญชีอีกครั้ง</button></form>`;
      return `<tr><td><strong>${esc(u.display_name)}</strong>${self ? ' <span class="muted small">(คุณ)</span>' : ""}<br><span class="small">${esc(u.email)}</span></td>
<td>${esc(ROLE_LABELS[u.role])}<br><span class="small ${u.status === "ACTIVE" ? "ok" : "bad"}">${u.status === "ACTIVE" ? (u.password_hash ? "ใช้งานอยู่" : "รอตั้งรหัสผ่าน") : "ปิดบัญชีแล้ว"}</span>
<br><span class="small ${u.totp_secret ? "ok" : "warn"}">${u.totp_secret ? "2 ขั้น: เปิดแล้ว" : "2 ขั้น: ยังไม่ได้ตั้ง"}</span></td>
<td class="small">${esc(bkk(u.last_login_at))}</td><td>${actions}</td></tr>`;
    }).join("");
    return html(page({
      title: "ผู้ใช้ Center", user: me, current: "users", flash,
      body: `<h1>ผู้ใช้ Center</h1>${extra}<div class="card scroll"><table><thead><tr><th>ชื่อ</th><th>บทบาท</th><th>เข้าล่าสุด</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="card"><h2 style="margin-top:0">เพิ่มผู้ใช้</h2><form method="post" action="/users" class="stack" style="max-width:420px">
<label for="nu-name">ชื่อ</label><input id="nu-name" name="name" required maxlength="100">
<label for="nu-email">อีเมล</label><input id="nu-email" name="email" type="email" required maxlength="254">
<label for="nu-role">บทบาท</label><select id="nu-role" name="role">${roleOptions("OPERATOR")}</select>
<p><button type="submit">เพิ่มและสร้างลิงก์ตั้งรหัสผ่าน</button></p></form>
<p class="muted small">เจ้าของแพลตฟอร์ม: ทุกอย่างรวมถึงพักเว็บ · ผู้ดูแลระบบ: เข้าหลังบ้านแบบ SUPER_ADMIN · ซัพพอร์ต: เข้าหลังบ้านแบบดูอย่างเดียว</p></div>`,
    }), flash?.kind === "error" ? 422 : 200);
  }

  async function setupLinkBox(ctx: Ctx, me: Me, user: { id: string; display_name: string }, purpose: "INVITE" | "RESET"): Promise<{ statement: D1Statement; box: string }> {
    const token = randomToken(32);
    const ttl = purpose === "INVITE" ? INVITE_TTL_MS : RESET_TTL_MS;
    const expiresAt = iso(new Date(ctx.now.getTime() + ttl));
    const link = `${(ctx.env.APP_BASE_URL?.trim() || ctx.url.origin).replace(/\/+$/, "")}/setup?token=${token}`;
    return {
      statement: ctx.repo.insertTokenStatement({ tokenHash: await sha256Hex(token), userId: user.id, purpose, expiresAt, createdBy: me.id, now: iso(ctx.now) }),
      box: `<div class="card"><h2 style="margin-top:0">ลิงก์ตั้งรหัสผ่านของ ${esc(user.display_name)}</h2><p class="mono">${esc(link)}</p>
<p class="muted small">ส่งให้เจ้าตัวทางช่องทางส่วนตัว ใช้ได้ครั้งเดียว หมดอายุ ${esc(bkk(expiresAt))} — ลิงก์นี้แสดงครั้งเดียว</p></div>`,
    };
  }

  async function createUser(ctx: Ctx, me: Me): Promise<Response> {
    const form = await readForm(ctx.request);
    const name = (form.get("name") ?? "").trim();
    const email = (form.get("email") ?? "").trim().toLowerCase();
    const role = form.get("role") as CenterRole;
    if (!name || name.length > 100 || !EMAIL.test(email) || !(CENTER_ROLES as readonly string[]).includes(role)) return usersPage(ctx, me, { kind: "error", text: "กรอกชื่อ อีเมล และบทบาทให้ถูกต้อง" });
    if (await ctx.repo.userByEmail(email)) return usersPage(ctx, me, { kind: "error", text: "อีเมลนี้มีผู้ใช้อยู่แล้ว" });
    const id = newUserId();
    const now = iso(ctx.now);
    const { statement, box } = await setupLinkBox(ctx, me, { id, display_name: name }, "INVITE");
    await ctx.repo.db.batch([
      ctx.repo.insertUserStatement({ id, email, displayName: name, role, createdBy: me.id, now }),
      statement,
      audit(ctx, me.id, "USER_CREATED", null, null, { target: id, email, role }),
    ]);
    if (role === "PLATFORM_OWNER") await securityAlert(ctx.env, `${me.email} เพิ่มเจ้าของแพลตฟอร์มคนใหม่: ${email}`, ctx.now, options.lineFetch);
    return usersPage(ctx, me, { kind: "ok", text: `เพิ่ม ${name} แล้ว` }, box);
  }

  async function changeUser(ctx: Ctx, me: Me, id: string, op: "role" | "disable" | "enable" | "setup-link"): Promise<Response> {
    const target = await ctx.repo.userById(id);
    if (!target) throw new HttpError(404, "ไม่พบผู้ใช้นี้");
    const form = await readForm(ctx.request);
    const reason = (form.get("reason") ?? "").trim();
    const now = iso(ctx.now);
    if (op === "setup-link") {
      const { statement, box } = await setupLinkBox(ctx, me, target, "RESET");
      await ctx.repo.db.batch([statement, audit(ctx, me.id, "SETUP_LINK", null, null, { target: id })]);
      return usersPage(ctx, me, { kind: "ok", text: `สร้างลิงก์ให้ ${target.display_name} แล้ว` }, box);
    }
    if (reason.length < 3 || reason.length > 300) return usersPage(ctx, me, { kind: "error", text: "กรุณาระบุเหตุผล 3–300 ตัวอักษร" });
    if (op === "disable" && id === me.id) return usersPage(ctx, me, { kind: "error", text: "ปิดบัญชีของตัวเองไม่ได้" });
    let statements: D1Statements;
    let action: string;
    let detail: Record<string, unknown> = { target: id };
    if (op === "role") {
      const role = form.get("role") as CenterRole;
      if (!(CENTER_ROLES as readonly string[]).includes(role)) return usersPage(ctx, me, { kind: "error", text: "บทบาทไม่ถูกต้อง" });
      if (role === target.role) return usersPage(ctx, me, { kind: "ok", text: "บทบาทเหมือนเดิม" });
      statements = [ctx.repo.setRoleStatement(id, role, now)];
      action = "USER_ROLE";
      detail = { ...detail, from: target.role, to: role };
    } else if (op === "disable") {
      statements = [ctx.repo.setStatusStatement(id, "DISABLED", now), ctx.repo.revokeUserSessionsStatement(id, now), ctx.repo.closeTokensStatement(id, now)];
      action = "USER_DISABLED";
    } else {
      statements = [ctx.repo.setStatusStatement(id, "ACTIVE", now)];
      action = "USER_ENABLED";
    }
    try {
      await ctx.repo.db.batch([...statements, audit(ctx, me.id, action, null, reason, detail)]);
    } catch (error) {
      if (String(error).includes("LAST_PLATFORM_OWNER")) return usersPage(ctx, me, { kind: "error", text: "ต้องมีเจ้าของแพลตฟอร์มที่ใช้งานได้อย่างน้อย 1 คน" });
      throw error;
    }
    if (op === "role" && detail.to === "PLATFORM_OWNER") await securityAlert(ctx.env, `${me.email} เปลี่ยน ${target.email} เป็นเจ้าของแพลตฟอร์ม — เหตุผล: ${reason}`, ctx.now, options.lineFetch);
    // A role change or a disabled account: sign that person out of every site's back office too.
    let note = "";
    if (op === "role" || op === "disable") {
      const client = new SiteClient(ctx.env, 8000, clock);
      const results = await Promise.all(ctx.sites.map((s) => client.call<{ revoked: number }>(s, "POST", "/api/center/sessions/revoke", { ...actorOf(me), reason }, { actorId: id })));
      const failed = ctx.sites.filter((_, i) => results[i]!.status !== 200).map((s) => s.name);
      note = failed.length ? ` — ออกจากหลังบ้านไม่สำเร็จที่: ${failed.join(", ")} (session ที่ค้างจะหมดอายุเองภายใน 2 ชั่วโมง)` : " — ออกจากหลังบ้านทุกเว็บแล้ว";
    }
    return usersPage(ctx, me, { kind: "ok", text: `${ACTION_LABELS[action]}: ${target.display_name}${note}` });
  }

  // ---------------------------------------------------------------- helpers

  function audit(ctx: Ctx, userId: string | null, action: string, site: string | null = null, reason: string | null = null, detail: unknown = null): D1Statement {
    return ctx.repo.auditStatement({ id: crypto.randomUUID(), userId, action, site, reason, detail, ip: ctx.ip, now: iso(ctx.now) });
  }

  return { fetch };
}

type D1Statement = ReturnType<CenterRepository["auditStatement"]>;
/** A local path to return to after the two-step check (never another origin). */
function safeNext(next: string | null): string | null {
  return next && /^\/(?!\/)[A-Za-z0-9/_-]{0,200}$/.test(next) ? next : null;
}

/** Sensitive POSTs (step-up) and the page to come back to. */
function sensitiveReturnPath(method: string, path: string): string | null {
  if (method !== "POST") return null;
  const site = /^\/sites\/([a-z][a-z0-9-]{1,30})\/(suspension|revoke|owner|backup-download)$/.exec(path);
  if (site) return `/sites/${site[1]}`;
  if (path === "/releases") return "/releases";
  if (path === "/users" || path.startsWith("/users/")) return "/users";
  if (path === "/settings") return "/settings";
  if (path === "/account/recovery-codes" || path === "/account/password") return "/account";
  return null;
}

const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[A-Za-z0-9_-]{6}\.sql\.gz$/;

interface BackupDto {
  name: string; size: number; createdAt: string; tables: number | null; rows: number | null; trigger: string | null;
}

function sizeText(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface SuspensionDto {
  suspended: boolean; reasonCode: string | null; note: string | null; since: string | null;
}
interface SiteUserDto {
  id: string; email: string; displayName: string; status: string; roles: string[]; lastLoginAt: string | null;
}
interface CheckRow {
  site: string; checked_at: string; http_status: number; schema_state: string | null; cron_state: string | null;
  errors_24h: number | null; slips_waiting: number | null; suspended: number | null; detail: string | null;
}
type D1Statements = D1Statement[];

function actorOf(me: Me): CenterActor {
  return { id: me.id, email: me.email, role: me.role };
}

function iso(d: Date): string {
  return d.toISOString();
}

export function newUserId(): string {
  return `u_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function siteError(status: number, code: string | undefined): string {
  if (code === "NO_SIGNING_KEY") return "Center ยังไม่มี key";
  if (code === "NO_BINDING") return "ยังไม่ได้ผูกกับ Center (deploy Center ใหม่)";
  if (status === 0) return "ติดต่อเว็บไม่ได้";
  if (status === 404) return "เว็บยังไม่เปิดรับ Center (ยังไม่มี public key — Release เว็บนี้)";
  if (status === 401) return "ลายเซ็นไม่ผ่าน (key ไม่ตรงกับที่เว็บมี)";
  if (status === 403) return "บทบาทของคุณทำไม่ได้";
  if (status === 422) return "ข้อมูลไม่ครบ";
  return `เว็บตอบ ${status}${code ? ` (${code})` : ""}`;
}

function passwordMessage(code: string): string {
  return ({
    TOO_SHORT: "รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษร", TOO_LONG: "รหัสผ่านยาวเกินไป",
    CONTAINS_IDENTIFIER: "รหัสผ่านต้องไม่มีอีเมลหรือชื่อของคุณ", TOO_COMMON: "รหัสผ่านนี้เดาง่ายเกินไป",
  } as Record<string, string>)[code] ?? "รหัสผ่านไม่ผ่านเกณฑ์ ลองรหัสที่ยาวและเดายากกว่านี้";
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) throw new HttpError(415, "รูปแบบข้อมูลไม่ถูกต้อง");
  const text = await request.text();
  if (text.length > 8192) throw new HttpError(413, "ข้อมูลยาวเกินไป");
  return new URLSearchParams(text);
}

/**
 * A POST must come from a Center page: Origin = this origin, or — where the browser withholds the origin
 * ("Origin: null", e.g. under a strict referrer policy) — the browser's own Sec-Fetch-Site says same-origin.
 * A page on another site can set neither.
 */
export function assertSameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") throw new HttpError(403, "คำขอนี้ไม่ได้มาจากหน้า Center");
  if (origin === url.origin) return;
  if ((origin === null || origin === "null") && site === "same-origin") return;
  throw new HttpError(403, "คำขอนี้ไม่ได้มาจากหน้า Center");
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

let ssoScriptHash: Promise<string> | null = null;
async function scriptHash(): Promise<string> {
  ssoScriptHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(SSO_SCRIPT)).then((d) => btoa(String.fromCharCode(...new Uint8Array(d))));
  return ssoScriptHash;
}

/** Security headers on every response. The SSO hand-off page may run exactly one inline script and post to a site. */
async function secure(response: Response, sites: CenterSite[]): Promise<Response> {
  const headers = new Headers(response.headers);
  const sso = headers.get("X-Center-Page") === "sso";
  headers.delete("X-Center-Page");
  const formTargets = ["'self'", ...sites.map((s) => `https://${s.domain}`)].join(" ");
  headers.set("Content-Security-Policy", [
    "default-src 'none'", "style-src 'unsafe-inline'", "img-src 'self' data:", `form-action ${formTargets}`,
    "frame-ancestors 'none'", "base-uri 'none'", sso ? `script-src 'sha256-${await scriptHash()}'` : "script-src 'none'",
  ].join("; "));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  // "same-origin": Center's own form posts keep their Origin header (with "no-referrer" browsers send Origin: null);
  // other sites — including the booking sites the SSO hand-off posts to — still get no referrer.
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("Cache-Control", "no-store");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
