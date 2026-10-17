import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createCenterApp, LOCK_MS, MAX_FAILED_LOGINS } from "../../src/center/app.ts";
import type { CenterEnv } from "../../src/center/env.ts";
import { generateKeys, firstOwnerSql } from "../../scripts/center-setup.ts";
import { Harness, ORIGIN } from "../helpers/harness.ts";
import { SqliteD1 } from "../helpers/sqlite-d1.ts";

/** Center Management phase C4: the Center console, end to end against a real site app (service binding). */

const CENTER = "https://center.test";
const PASSWORD = "a long and unusual passphrase 42";
const CENTER_MIGRATIONS = join(import.meta.dirname, "..", "..", "center", "migrations");

function centerDb(): SqliteD1 {
  const db = new SqliteD1();
  for (const f of readdirSync(CENTER_MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(join(CENTER_MIGRATIONS, f), "utf8"));
  return db;
}

async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function setup(options: { siteKeys?: boolean; signingKey?: boolean } = {}) {
  const site = new Harness();
  await site.user({ id: "site-owner", email: "owner@site.test", roles: ["SUPER_ADMIN"] });
  const keys = await generateKeys(new Date("2026-10-17T00:00:00Z"));
  if (options.siteKeys !== false) site.env.CENTER_PUBLIC_KEYS = JSON.stringify(keys.publicKeys);
  const db = centerDb();
  let now = new Date(site.now);
  const app = createCenterApp({ clock: () => new Date(now), hashIterations: 1000 });
  const env: CenterEnv = {
    DB: db,
    APP_BASE_URL: CENTER,
    CENTER_SITES: JSON.stringify([{ slug: "phasakura", name: "Phasakura", domain: new URL(ORIGIN).host, binding: "SITE_PHASAKURA" }]),
    CENTER_SIGNING_KEY: options.signingKey === false ? undefined : keys.secret,
    // The site's Worker behind its service binding; the site's clock follows Center's.
    SITE_PHASAKURA: { fetch: (req: Request) => { site.now = new Date(now); return site.app.fetch(req, site.env); } },
  };
  const req = async (method: string, path: string, opts: { form?: Record<string, string>; cookie?: string | null; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "CF-Connecting-IP": "203.0.113.5", "User-Agent": "test" };
    if (method === "POST") Object.assign(headers, { Origin: CENTER, "Sec-Fetch-Site": "same-origin" });
    if (opts.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (opts.cookie) headers.Cookie = `__Host-csid=${opts.cookie}`;
    Object.assign(headers, opts.headers);
    for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
    const res = await app.fetch(new Request(`${CENTER}${path}`, { method, headers, body: opts.form ? new URLSearchParams(opts.form).toString() : undefined }), env);
    const text = await res.text();
    const cookie = res.headers.get("Set-Cookie")?.match(/__Host-csid=([A-Za-z0-9_-]*)/)?.[1] ?? null;
    return { status: res.status, text, headers: res.headers, cookie, location: res.headers.get("Location") };
  };
  /** First owner exactly as the Center setup workflow creates it; returns the one-time link token. */
  const firstOwner = async (email = "owner@phasakura.com", name = "Owner") => {
    const token = `tok${"x".repeat(40)}`;
    db.exec(firstOwnerSql({ id: "u_00000000000000aa", email, name, tokenHash: await sha256(token), now, ttlMs: 48 * 3_600_000 }));
    return token;
  };
  const ownerSession = async () => {
    const token = await firstOwner();
    const res = await req("POST", `/setup?token=${token}`, { form: { password: PASSWORD, confirm: PASSWORD } });
    assert.equal(res.status, 303, res.text.slice(0, 300));
    return res.cookie!;
  };
  const audits = (action: string) => db.all<{ user_id: string; site: string | null; reason: string | null; detail_json: string | null }>("SELECT user_id, site, reason, detail_json FROM center_audit WHERE action = ? ORDER BY created_at, rowid", action);
  return { site, db, env, req, firstOwner, ownerSession, audits, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, keys };
}

describe("Center: health and sign-in", () => {
  it("/healthz reports the database and whether the signing key is set (no secrets)", async () => {
    const { req } = await setup();
    const res = await req("GET", "/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { status: "ok", database: "ok", signingKey: true, sites: 1 });
    const none = await (await setup({ signingKey: false })).req("GET", "/healthz");
    assert.equal(JSON.parse(none.text).signingKey, false);
  });

  it("every page needs a session; security headers on every response", async () => {
    const { req } = await setup();
    const res = await req("GET", "/");
    assert.equal(res.status, 303);
    assert.equal(res.location, "/login");
    const login = await req("GET", "/login");
    const csp = login.headers.get("Content-Security-Policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(login.headers.get("Cache-Control"), "no-store");
    assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  });

  it("first owner: one-time setup link → password policy → signed in; the link cannot be used again", async () => {
    const { req, firstOwner, audits } = await setup();
    const token = await firstOwner();
    assert.equal((await req("GET", `/setup?token=${token}`)).status, 200);
    const weak = await req("POST", `/setup?token=${token}`, { form: { password: "short", confirm: "short" } });
    assert.equal(weak.status, 422);
    const mismatch = await req("POST", `/setup?token=${token}`, { form: { password: PASSWORD, confirm: `${PASSWORD}!` } });
    assert.equal(mismatch.status, 422);
    const ok = await req("POST", `/setup?token=${token}`, { form: { password: PASSWORD, confirm: PASSWORD } });
    assert.equal(ok.status, 303);
    assert.ok(ok.cookie);
    assert.match(ok.headers.get("Set-Cookie") ?? "", /HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await req("GET", "/", { cookie: ok.cookie })).status, 200);
    assert.equal((await req("GET", `/setup?token=${token}`)).status, 400, "used");
    assert.equal(audits("PASSWORD_SET").length, 1);
  });

  it("the first-owner SQL does nothing once Center has users", async () => {
    const { db, firstOwner } = await setup();
    await firstOwner();
    db.exec(firstOwnerSql({ id: "u_00000000000000bb", email: "intruder@x.com", name: "X", tokenHash: "f".repeat(64), now: new Date(), ttlMs: 1000 }));
    assert.equal(db.all("SELECT id FROM center_users").length, 1);
    assert.equal(db.all("SELECT token_hash FROM center_setup_tokens").length, 1);
    assert.throws(() => firstOwnerSql({ id: "u_00000000000000cc", email: "a'b@x.com", name: "Y", tokenHash: "f".repeat(64), now: new Date(), ttlMs: 1 }));
  });

  it("login: 5 wrong passwords lock the account for 15 minutes; same message either way", async () => {
    const { req, ownerSession, advance, audits } = await setup();
    await ownerSession();
    const login = (password: string) => req("POST", "/login", { form: { email: "owner@phasakura.com", password } });
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) assert.equal((await login("wrong password!!")).status, 401);
    const locked = await login(PASSWORD);
    assert.equal(locked.status, 401, "locked even with the right password");
    assert.equal(locked.cookie, null);
    const unknown = await req("POST", "/login", { form: { email: "nobody@phasakura.com", password: PASSWORD } });
    assert.ok(unknown.text.includes("อีเมลหรือรหัสผ่านไม่ถูกต้อง") && locked.text.includes("อีเมลหรือรหัสผ่านไม่ถูกต้อง"));
    advance(LOCK_MS + 1000);
    const ok = await login(PASSWORD);
    assert.equal(ok.status, 303);
    assert.equal(audits("LOGIN_LOCKED").length, 1);
    assert.equal(audits("LOGIN").length, 1);
  });

  it("sessions end after 1 hour idle; logout ends the session", async () => {
    const { req, ownerSession, advance } = await setup();
    const cookie = await ownerSession();
    advance(61 * 60_000);
    assert.equal((await req("GET", "/", { cookie })).status, 303);
    const { req: req2, ownerSession: os2 } = await setup();
    const c2 = await os2();
    assert.equal((await req2("POST", "/logout", { cookie: c2, form: {} })).status, 303);
    assert.equal((await req2("GET", "/", { cookie: c2 })).status, 303);
  });

  it("a browser that withholds the origin (Origin: null) but says same-origin may post — Center's own forms", async () => {
    const { req, firstOwner } = await setup();
    const token = await firstOwner();
    const res = await req("POST", `/setup?token=${token}`, { form: { password: PASSWORD, confirm: PASSWORD }, headers: { Origin: "null", "Sec-Fetch-Site": "same-origin" } });
    assert.equal(res.status, 303, res.text.slice(0, 200));
    const login = await req("POST", "/login", { form: { email: "owner@phasakura.com", password: PASSWORD }, headers: { Origin: "", "Sec-Fetch-Site": "same-origin" } });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("Referrer-Policy"), "same-origin");
  });

  it("a POST from anywhere but Center is refused (CSRF)", async () => {
    const { req, ownerSession } = await setup();
    const cookie = await ownerSession();
    assert.equal((await req("POST", "/logout", { cookie, form: {}, headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await req("POST", "/logout", { cookie, form: {}, headers: { Origin: "", "Sec-Fetch-Site": "" } })).status, 403, "no Origin, no fetch metadata");
    assert.equal((await req("POST", "/logout", { cookie, form: {}, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await req("POST", "/logout", { cookie, form: {}, headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await req("POST", "/logout", { cookie, form: {}, headers: { Origin: "null", "Sec-Fetch-Site": "" } })).status, 403, "no proof of same origin");
  });
});

describe("Center: sites and SSO", () => {
  it("the dashboard shows each site's state read through its binding", async () => {
    const { req, ownerSession } = await setup();
    const cookie = await ownerSession();
    const res = await req("GET", "/", { cookie });
    assert.equal(res.status, 200);
    assert.match(res.text, /Phasakura/);
    assert.match(res.text, /ออนไลน์/);
  });

  it("a site without Center's public key says so; no key in Center says so", async () => {
    const off = await setup({ siteKeys: false });
    const res = await off.req("GET", "/", { cookie: await off.ownerSession() });
    assert.match(res.text, /ยังไม่เปิดรับ Center/);
    const nokey = await setup({ signingKey: false });
    const res2 = await nokey.req("GET", "/", { cookie: await nokey.ownerSession() });
    assert.match(res2.text, /ยังไม่มี key/);
  });

  it("SSO: reason → hand-off page that posts the ticket to the site → back office as “Center · email”; audited on both sides", async () => {
    const { req, ownerSession, site, audits } = await setup();
    const cookie = await ownerSession();
    assert.equal((await req("POST", "/sites/phasakura/sso", { cookie, form: { reason: "" } })).status, 422);
    const res = await req("POST", "/sites/phasakura/sso", { cookie, form: { reason: "ช่วยตั้งค่าห้องพัก" } });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.ok(csp.includes(`form-action 'self' ${ORIGIN}`));
    const action = res.text.match(/action="([^"]+)"/)?.[1];
    const ticket = res.text.match(/name="ticket" value="([^"]+)"/)?.[1];
    assert.equal(action, `${ORIGIN}/api/center/sso/consume`);
    assert.ok(ticket);
    const consumed = await site.app.fetch(new Request(action!, {
      method: "POST", body: `ticket=${ticket}`, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: CENTER, "Sec-Fetch-Site": "cross-site" },
    }), site.env);
    assert.equal(consumed.status, 303);
    const token = consumed.headers.get("Set-Cookie")?.match(/__Host-sid=([A-Za-z0-9_-]+)/)?.[1];
    const me = await site.api<{ displayName: string; roles: string[] }>("GET", "/api/auth/me", { token });
    assert.equal(me.data.displayName, "Center · owner@phasakura.com");
    assert.deepEqual(me.data.roles, ["SUPER_ADMIN"]);
    assert.deepEqual(audits("SSO").map((a) => [a.site, a.reason, JSON.parse(a.detail_json!).ok]), [["phasakura", "ช่วยตั้งค่าห้องพัก", true]]);
    assert.equal(JSON.parse(site.audits("CENTER_SSO")[0]!.new_value!).center.reason, "ช่วยตั้งค่าห้องพัก");
  });

  it("SSO to a site that refuses (no key on the site) is an error page and a failed audit row", async () => {
    const { req, ownerSession, audits } = await setup({ siteKeys: false });
    const res = await req("POST", "/sites/phasakura/sso", { cookie: await ownerSession(), form: { reason: "ตรวจสอบ" } });
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(audits("SSO")[0]!.detail_json!).ok, false);
    assert.equal((await req("POST", "/sites/nosuchsite/sso", { cookie: await (async () => "x")(), form: { reason: "abc" } })).status, 401);
  });
});

describe("Center: people", () => {
  async function addOperator(ctx: Awaited<ReturnType<typeof setup>>, ownerCookie: string, name = "Ops") {
    const res = await ctx.req("POST", "/users", { cookie: ownerCookie, form: { name, email: "ops@phasakura.com", role: "OPERATOR" } });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const token = res.text.match(/\/setup\?token=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(token, "the setup link is shown once");
    const set = await ctx.req("POST", `/setup?token=${token}`, { form: { password: PASSWORD, confirm: PASSWORD } });
    assert.equal(set.status, 303);
    return { cookie: set.cookie!, page: res.text };
  }

  it("the owner adds an OPERATOR with a one-time link; an OPERATOR cannot manage people", async () => {
    const ctx = await setup();
    const owner = await ctx.ownerSession();
    const ops = await addOperator(ctx, owner);
    assert.equal((await ctx.req("GET", "/users", { cookie: ops.cookie })).status, 403);
    assert.equal((await ctx.req("POST", "/users", { cookie: ops.cookie, form: { name: "X", email: "x@x.com", role: "PLATFORM_OWNER" } })).status, 403);
    assert.equal((await ctx.req("GET", "/", { cookie: ops.cookie })).status, 200);
    assert.equal(ctx.audits("USER_CREATED").length, 1);
  });

  it("names are escaped everywhere", async () => {
    const ctx = await setup();
    const owner = await ctx.ownerSession();
    const { page } = await addOperator(ctx, owner, "<script>alert(1)</script>");
    assert.ok(!page.includes("<script>alert(1)</script>"));
    assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  });

  it("disabling someone ends their Center session and signs them out of every site's back office", async () => {
    const ctx = await setup();
    const owner = await ctx.ownerSession();
    const ops = await addOperator(ctx, owner);
    const sso = await ctx.req("POST", "/sites/phasakura/sso", { cookie: ops.cookie, form: { reason: "ตรวจการจอง" } });
    const ticket = sso.text.match(/name="ticket" value="([^"]+)"/)![1]!;
    const consumed = await ctx.site.app.fetch(new Request(`${ORIGIN}/api/center/sso/consume`, {
      method: "POST", body: `ticket=${ticket}`, headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }), ctx.site.env);
    const siteToken = consumed.headers.get("Set-Cookie")!.match(/__Host-sid=([A-Za-z0-9_-]+)/)![1]!;
    assert.equal((await ctx.site.api("GET", "/api/auth/me", { token: siteToken })).status, 200);
    const opsId = ctx.db.all<{ id: string }>("SELECT id FROM center_users WHERE email = 'ops@phasakura.com'")[0]!.id;
    const res = await ctx.req("POST", `/users/${opsId}/disable`, { cookie: owner, form: { reason: "ลาออก" } });
    assert.equal(res.status, 200);
    assert.match(res.text, /ออกจากหลังบ้านทุกเว็บแล้ว/);
    assert.equal((await ctx.req("GET", "/", { cookie: ops.cookie })).status, 303, "Center session gone");
    assert.equal((await ctx.site.api("GET", "/api/auth/me", { token: siteToken })).status, 401, "site session gone");
    assert.equal(ctx.site.audits("CENTER_REVOKE_SESSIONS").length, 1);
  });

  it("the last PLATFORM_OWNER cannot be demoted; people are never deleted; the audit log is append-only", async () => {
    const ctx = await setup();
    const owner = await ctx.ownerSession();
    const res = await ctx.req("POST", "/users/u_00000000000000aa/role", { cookie: owner, form: { role: "OPERATOR", reason: "ทดสอบ" } });
    assert.equal(res.status, 422);
    assert.match(res.text, /อย่างน้อย 1 คน/);
    assert.throws(() => ctx.db.exec("DELETE FROM center_users"), /NEVER_DELETED/);
    assert.throws(() => ctx.db.exec("DELETE FROM center_audit"), /APPEND_ONLY/);
    assert.throws(() => ctx.db.exec("UPDATE center_audit SET reason = 'x'"), /APPEND_ONLY/);
  });

  it("a second PLATFORM_OWNER can be added, after which the first may step down", async () => {
    const ctx = await setup();
    const owner = await ctx.ownerSession();
    const res = await ctx.req("POST", "/users", { cookie: owner, form: { name: "Owner 2", email: "owner2@phasakura.com", role: "PLATFORM_OWNER" } });
    assert.equal(res.status, 200);
    const token = res.text.match(/\/setup\?token=([A-Za-z0-9_-]{43})/)![1]!;
    await ctx.req("POST", `/setup?token=${token}`, { form: { password: PASSWORD, confirm: PASSWORD } });
    const demote = await ctx.req("POST", "/users/u_00000000000000aa/role", { cookie: owner, form: { role: "OPERATOR", reason: "ส่งต่องาน" } });
    assert.equal(demote.status, 200);
    assert.equal((await ctx.req("GET", "/users", { cookie: owner })).status, 403, "now an OPERATOR");
  });
});
