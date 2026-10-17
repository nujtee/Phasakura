import { CENTER_ROLES, type CenterActor, type CenterRole } from "../shared/center-protocol.ts";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../worker/security/password.ts";
import { randomToken, sha256Hex } from "../worker/security/tokens.ts";
import { parseSites, type CenterEnv, type CenterSite } from "./env.ts";
import { ACTION_LABELS, bkk, esc, page, ROLE_LABELS, SSO_SCRIPT, ssoHandoffPage, type LayoutUser } from "./html.ts";
import { CenterRepository, type CenterUserRow } from "./repository.ts";
import { SiteClient, signingKey } from "./site-client.ts";

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

export interface CenterAppOptions {
  clock?: () => Date;
  /** Password hashing cost (tests use fewer iterations). */
  hashIterations?: number;
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
      if (request.method === "POST") assertSameOrigin(request, url);
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

    const me = await currentUser(ctx);
    if (!me) {
      if (request.method === "GET") return redirect("/login");
      throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    }
    if (key === "POST /logout") return logout(ctx, me);
    if (key === "GET /") return dashboard(ctx, me);
    if (key === "GET /audit") return auditPage(ctx, me);
    if (key === "GET /account") return accountPage(ctx, me);
    if (key === "POST /account/password") return changePassword(ctx, me);
    const sso = /^\/sites\/([a-z][a-z0-9-]{1,30})\/sso$/.exec(url.pathname);
    if (sso && request.method === "POST") return startSso(ctx, me, sso[1]!);

    if (me.role !== "PLATFORM_OWNER" && url.pathname.startsWith("/users")) throw new HttpError(403, "หน้านี้สำหรับเจ้าของแพลตฟอร์มเท่านั้น");
    if (key === "GET /users") return usersPage(ctx, me);
    if (key === "POST /users") return createUser(ctx, me);
    const user = /^\/users\/(u_[0-9a-f]{8,38})\/(role|disable|enable|setup-link)$/.exec(url.pathname);
    if (user && request.method === "POST") return changeUser(ctx, me, user[1]!, user[2] as "role" | "disable" | "enable" | "setup-link");
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
    return { id: row.id, email: row.email, displayName: row.display_name, role: row.role, sessionId: row.session_id };
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
    return redirect("/", `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CENTER_SESSION_TTL_MS / 1000}`);
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
    if (!user || user.status !== "ACTIVE" || !user.password_hash) {
      await hash("timing-equaliser-not-a-password");
      return loginPage(ctx, wrong, email);
    }
    if (user.locked_until && Date.parse(user.locked_until) > ctx.now.getTime()) return loginPage(ctx, wrong, email);
    if (!(await verifyPassword(password, user.password_hash))) {
      const count = user.failed_login_count + 1;
      const locked = count >= MAX_FAILED_LOGINS ? iso(new Date(ctx.now.getTime() + LOCK_MS)) : null;
      await ctx.repo.recordLoginFailure(user.id, locked ? 0 : count, locked, iso(ctx.now));
      await audit(ctx, user.id, locked ? "LOGIN_LOCKED" : "LOGIN_FAILED").run();
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
    const client = new SiteClient(ctx.env, 5000, clock);
    const actor = actorOf(me);
    const states = await Promise.all(ctx.sites.map((s) => client.call<{ schema: { status: string }; suspended: boolean }>(s, "GET", "/api/center/hello", actor)));
    const keyOk = !!(await signingKey(ctx.env.CENTER_SIGNING_KEY));
    const rows = ctx.sites.map((site, i) => {
      const st = states[i]!;
      const status = st.status === 200 && st.data
        ? `${st.data.suspended ? '<span class="bad">พักการรับจอง</span>' : '<span class="ok">ออนไลน์</span>'} · <span class="${st.data.schema.status === "ok" ? "muted" : "warn"}">ฐานข้อมูล ${esc(st.data.schema.status)}</span>`
        : `<span class="warn">${esc(siteError(st.status, st.error?.code))}</span>`;
      return `<tr><td><strong>${esc(site.name)}</strong><br><a class="small" href="https://${esc(site.domain)}" rel="noopener noreferrer" target="_blank">${esc(site.domain)}</a></td>
<td>${status}</td>
<td><form method="post" action="/sites/${esc(site.slug)}/sso" target="_blank" class="inline">
<input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผล เช่น ช่วยตั้งค่าห้องพัก" aria-label="เหตุผลที่เข้าหลังบ้าน ${esc(site.name)}">
<button type="submit">เข้าหลังบ้าน</button></form></td></tr>`;
    }).join("");
    const keyNote = keyOk ? "" : '<div class="flash error">ยังไม่มี key สำหรับเซ็นคำสั่ง — GitHub → Actions → Center keys → Run workflow</div>';
    return html(page({
      title: "เว็บทั้งหมด", user: me, current: "sites", flash,
      body: `<h1>เว็บทั้งหมด (${ctx.sites.length})</h1>${keyNote}<div class="card scroll"><table><thead><tr><th>เว็บ</th><th>สถานะ</th><th>หลังบ้าน</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted small">การเข้าหลังบ้านทุกครั้งถูกบันทึกทั้งใน Center และใน Audit logs ของเว็บนั้น พร้อมเหตุผล${me.role === "SUPPORT_READONLY" ? " — บทบาทของคุณเข้าได้แบบดูอย่างเดียว" : ""}</p></div>`,
    }));
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

  function accountPage(_ctx: Ctx, me: Me, flash: { kind: "ok" | "error"; text: string } | null = null): Response {
    return html(page({
      title: "บัญชีของฉัน", user: me, current: "account", flash,
      body: `<h1>บัญชีของฉัน</h1><div class="card"><p>${esc(me.displayName)} · ${esc(me.email)} · ${esc(ROLE_LABELS[me.role])}</p>
<h2>เปลี่ยนรหัสผ่าน</h2><form method="post" action="/account/password" class="stack" style="max-width:380px">
<label for="current">รหัสผ่านปัจจุบัน</label><input id="current" name="current" type="password" autocomplete="current-password" required maxlength="200">
<label for="password">รหัสผ่านใหม่ (อย่างน้อย 12 ตัว)</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="200">
<label for="confirm">พิมพ์อีกครั้ง</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="200">
<p><button type="submit">เปลี่ยนรหัสผ่าน</button></p></form><p class="muted small">เปลี่ยนแล้ว ทุก session อื่นของคุณจะออกจากระบบ</p></div>`,
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
${self ? "" : `<form method="post" action="/users/${u.id}/disable" class="inline" style="margin-top:6px"><input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผลที่ปิดบัญชี" aria-label="เหตุผลที่ปิดบัญชี"><button class="danger" type="submit">ปิดบัญชี</button></form>`}`
        : `<form method="post" action="/users/${u.id}/enable" class="inline"><input name="reason" required minlength="3" maxlength="300" placeholder="เหตุผล" aria-label="เหตุผล"><button type="submit">เปิดบัญชีอีกครั้ง</button></form>`;
      return `<tr><td><strong>${esc(u.display_name)}</strong>${self ? ' <span class="muted small">(คุณ)</span>' : ""}<br><span class="small">${esc(u.email)}</span></td>
<td>${esc(ROLE_LABELS[u.role])}<br><span class="small ${u.status === "ACTIVE" ? "ok" : "bad"}">${u.status === "ACTIVE" ? (u.password_hash ? "ใช้งานอยู่" : "รอตั้งรหัสผ่าน") : "ปิดบัญชีแล้ว"}</span></td>
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

function assertSameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (origin !== url.origin || (site !== null && site !== "same-origin")) throw new HttpError(403, "คำขอนี้ไม่ได้มาจากหน้า Center");
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
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("Cache-Control", "no-store");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
