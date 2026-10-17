import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CENTER_HEADERS, base64UrlEncode, canonicalString, decodeActor, encodeActor, parseCenterPublicKeys, signCenterRequest, type CenterActor,
} from "../../src/shared/center-protocol.ts";
import { LATEST_MIGRATION } from "../../src/worker/services/health.service.ts";
import { Harness, ORIGIN } from "../helpers/harness.ts";

/** Center Management phase C2: the CENTER level of access (Ed25519-signed requests to /api/center/*). */

const ACTOR: CenterActor = { id: "u_owner", email: "owner@phasakura.com", role: "PLATFORM_OWNER" };

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicB64: base64UrlEncode(raw) };
}

async function setup() {
  const h = new Harness();
  const key = await keyPair();
  h.env.CENTER_PUBLIC_KEYS = JSON.stringify({ c1: key.publicB64 });
  const send = async (path: string, opts: { url?: string; now?: Date; nonce?: string; keyId?: string; actor?: CenterActor; privateKey?: CryptoKey; tamper?: (headers: Record<string, string>) => void } = {}) => {
    const headers = await signCenterRequest({
      privateKey: opts.privateKey ?? key.privateKey, keyId: opts.keyId ?? "c1", method: "GET", url: opts.url ?? `${ORIGIN}${path}`,
      actor: opts.actor ?? ACTOR, now: opts.now ?? h.now, nonce: opts.nonce,
    });
    opts.tamper?.(headers);
    const res = await h.app.fetch(new Request(`${ORIGIN}${path}`, { headers: { ...headers, "CF-Connecting-IP": "198.51.100.7" } }), h.env);
    const body = (await res.json()) as { data?: Record<string, unknown>; error?: { code: string } };
    return { status: res.status, body, headers: res.headers };
  };
  const refusals = () => (h.db.all("SELECT details_json FROM security_events WHERE event_type = 'CENTER_REQUEST_REFUSED' ORDER BY created_at, rowid") as { details_json: string }[])
    .map((r) => (JSON.parse(r.details_json) as { reason: string }).reason);
  return { h, key, send, refusals };
}

describe("Center protocol", () => {
  it("canonical string: fixed field order, method upper-cased, host lower-cased", () => {
    assert.equal(
      canonicalString({ method: "get", host: "WWW.Phasakura.com", pathAndQuery: "/api/center/status?x=1", time: 1, nonce: "n", actor: "a", bodySha256: "h" }),
      "CENTER-V1\nGET\nwww.phasakura.com\n/api/center/status?x=1\n1\nn\na\nh",
    );
  });

  it("actor header round-trips and refuses unknown roles, bad e-mails and long reasons", () => {
    assert.deepEqual(decodeActor(encodeActor({ ...ACTOR, reason: "ช่วยแขกแก้การจอง" })), { ...ACTOR, reason: "ช่วยแขกแก้การจอง" });
    assert.equal(decodeActor(encodeActor({ ...ACTOR, role: "SUPER_ADMIN" as never })), null);
    assert.equal(decodeActor(encodeActor({ ...ACTOR, email: "not-an-email" })), null);
    assert.equal(decodeActor(encodeActor({ ...ACTOR, reason: "x".repeat(301) })), null);
    assert.equal(decodeActor("!!"), null);
    assert.equal(decodeActor(base64UrlEncode(new TextEncoder().encode("[1]"))), null);
  });

  it("CENTER_PUBLIC_KEYS: only valid ids with 32-byte keys count; anything else = off", () => {
    const good = base64UrlEncode(new Uint8Array(32).fill(7));
    assert.equal(parseCenterPublicKeys("").size, 0);
    assert.equal(parseCenterPublicKeys("not json").size, 0);
    assert.equal(parseCenterPublicKeys(`["${good}"]`).size, 0);
    assert.deepEqual([...parseCenterPublicKeys(JSON.stringify({ c1: good, "bad id": good, c2: "short", c3: 5 })).keys()], ["c1"]);
  });
});

describe("/api/center/* on a site", () => {
  it("does not exist while CENTER_PUBLIC_KEYS is empty (404, even with a valid signature)", async () => {
    const { h, send } = await setup();
    h.env.CENTER_PUBLIC_KEYS = "";
    assert.equal((await send("/api/center/hello")).status, 404);
    assert.equal((await send("/api/center/status")).status, 404);
  });

  it("hello: a signed request learns the site, API and schema; no-store", async () => {
    const { send, refusals } = await setup();
    const res = await send("/api/center/hello");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data as { apiVersion: number; site: { host: string }; schema: { expected: string }; actor: { id: string; role: string } };
    assert.equal(data.apiVersion, 1);
    assert.equal(data.site.host, new URL(ORIGIN).host);
    assert.equal(data.schema.expected, LATEST_MIGRATION);
    assert.deepEqual(data.actor, { id: ACTOR.id, role: ACTOR.role });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(refusals(), []);
  });

  it("status: the back office's System status without a site session", async () => {
    const { send } = await setup();
    const res = await send("/api/center/status");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data as { apiVersion: number; health: unknown; checks: unknown[] };
    assert.equal(data.apiVersion, 1);
    assert.ok(data.health);
    assert.ok(Array.isArray(data.checks) && data.checks.length > 0);
  });

  it("refuses with 401 and logs a security event: no headers, unknown key, other key, bad actor, tampered path", async () => {
    const { h, send, refusals } = await setup();
    const plain = await h.app.fetch(new Request(`${ORIGIN}/api/center/status`), h.env);
    assert.equal(plain.status, 401);
    assert.equal((await send("/api/center/status", { keyId: "c9" })).status, 401);
    const stranger = await keyPair();
    assert.equal((await send("/api/center/status", { privateKey: stranger.privateKey })).status, 401);
    assert.equal((await send("/api/center/status", { tamper: (x) => { x[CENTER_HEADERS.actor] = encodeActor({ ...ACTOR, role: "OPERATOR" }); } })).status, 401, "actor is signed");
    assert.equal((await send("/api/center/status", { url: `${ORIGIN}/api/center/hello` })).status, 401, "path is signed");
    const res = await send("/api/center/status", { tamper: (x) => { x[CENTER_HEADERS.actor] = "e30"; } });
    assert.equal(res.status, 401);
    assert.equal(res.body.error?.code, "CENTER_UNAUTHORIZED");
    assert.deepEqual(refusals(), ["MALFORMED", "UNKNOWN_KEY", "BAD_SIGNATURE", "BAD_SIGNATURE", "BAD_SIGNATURE", "BAD_ACTOR"]);
  });

  it("a request signed for another site is refused (host is in the signature)", async () => {
    const { send, refusals } = await setup();
    assert.equal((await send("/api/center/status", { url: "https://chomkhao.com/api/center/status" })).status, 401);
    assert.deepEqual(refusals(), ["BAD_SIGNATURE"]);
  });

  it("time must be within 60 s of the site's clock", async () => {
    const { h, send, refusals } = await setup();
    assert.equal((await send("/api/center/status", { now: new Date(h.now.getTime() - 59_000) })).status, 200);
    assert.equal((await send("/api/center/status", { now: new Date(h.now.getTime() - 61_000) })).status, 401);
    assert.equal((await send("/api/center/status", { now: new Date(h.now.getTime() + 61_000) })).status, 401);
    assert.deepEqual(refusals(), ["CLOCK_SKEW", "CLOCK_SKEW"]);
  });

  it("a nonce works once; a forged request does not burn it; the cron forgets old nonces", async () => {
    const { h, send, refusals } = await setup();
    const nonce = "nonce-0123456789abcdef";
    const stranger = await keyPair();
    assert.equal((await send("/api/center/hello", { nonce, privateKey: stranger.privateKey })).status, 401);
    assert.equal((await send("/api/center/hello", { nonce })).status, 200, "the forged attempt did not use it up");
    assert.equal((await send("/api/center/hello", { nonce })).status, 401);
    assert.deepEqual(refusals(), ["BAD_SIGNATURE", "REPLAYED_NONCE"]);
    assert.equal((h.db.all("SELECT nonce FROM center_nonces") as unknown[]).length, 1);
    h.advance(10 * 60_000);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:15:00Z"));
    assert.equal((h.db.all("SELECT nonce FROM center_nonces") as unknown[]).length, 0);
  });

  it("the nonce table refuses malformed nonces (defence in depth)", async () => {
    const { h } = await setup();
    assert.throws(() => h.db.run("INSERT INTO center_nonces (nonce, key_id, expires_at) VALUES ('short', 'c1', 'x')"));
    assert.throws(() => h.db.run("INSERT INTO center_nonces (nonce, key_id, expires_at) VALUES ('has space in it 12345', 'c1', 'x')"));
  });
});

// ------------------------------------------------------------------ phase C3: writes and SSO

const OWNER: CenterActor = { id: "u_owner", email: "owner@phasakura.com", role: "PLATFORM_OWNER", reason: "ช่วยเจ้าของตั้งค่าห้องพัก" };
const OPERATOR: CenterActor = { id: "u_ops", email: "ops@phasakura.com", role: "OPERATOR", reason: "ตรวจการจองที่ค้าง" };
const SUPPORT: CenterActor = { id: "u_support", email: "support@phasakura.com", role: "SUPPORT_READONLY", reason: "ดูปัญหาที่แจ้งมา" };

async function c3() {
  const base = await setup();
  const { h, key } = base;
  await h.user({ id: "site-owner", email: "owner@site.test", roles: ["SUPER_ADMIN"] });
  const signed = async <T = Record<string, unknown>>(method: string, path: string, actor: CenterActor, body?: unknown) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signCenterRequest({ privateKey: key.privateKey, keyId: "c1", method, url: `${ORIGIN}${path}`, actor, now: h.now, body: raw });
    const res = await h.app.fetch(new Request(`${ORIGIN}${path}`, {
      method, body: raw, headers: { ...headers, ...(raw ? { "Content-Type": "application/json" } : {}), "CF-Connecting-IP": "198.51.100.7" },
    }), h.env);
    const json = (await res.json()) as { data?: T; error?: { code: string; details?: Record<string, string> } };
    return { status: res.status, data: json.data as T, error: json.error };
  };
  /** The Center user's browser posting the ticket (cross-site form: no Origin match, no CSRF header). */
  const consume = (ticket: string) => h.app.fetch(new Request(`${ORIGIN}/api/center/sso/consume`, {
    method: "POST", body: `ticket=${encodeURIComponent(ticket)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://center.phasakura.com", "Sec-Fetch-Site": "cross-site" },
  }), h.env);
  const sso = async (actor: CenterActor) => {
    const issued = await signed<{ ticket: string; consumeUrl: string }>("POST", "/api/center/sso", actor);
    assert.equal(issued.status, 200, JSON.stringify(issued.error));
    const res = await consume(issued.data.ticket);
    const token = res.headers.get("Set-Cookie")?.match(/__Host-sid=([A-Za-z0-9_-]+)/)?.[1] ?? null;
    return { res, token, ticket: issued.data.ticket, consumeUrl: issued.data.consumeUrl };
  };
  return { ...base, signed, consume, sso };
}

describe("Center SSO (phase C3)", () => {
  it("a one-time ticket opens a short back-office session as “Center · email” with SUPER_ADMIN; audited with the reason", async () => {
    const { h, sso } = await c3();
    const { res, token, consumeUrl } = await sso(OWNER);
    assert.equal(consumeUrl, `${ORIGIN}/api/center/sso/consume`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/admin");
    assert.ok(token);
    const me = await h.api<{ displayName: string; roles: string[]; session: { expiresAt: string } }>("GET", "/api/auth/me", { token });
    assert.equal(me.status, 200);
    assert.equal(me.data.displayName, "Center · owner@phasakura.com");
    assert.deepEqual(me.data.roles, ["SUPER_ADMIN"]);
    assert.equal(Date.parse(me.data.session.expiresAt) - h.now.getTime(), 2 * 3600_000, "2-hour session");
    assert.equal((await h.api("GET", "/api/admin/users", { token })).status, 200, "the back office works");
    const audit = h.audits("CENTER_SSO");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.user_id, "center_u_owner");
    assert.deepEqual(JSON.parse(audit[0]!.new_value!).center, { email: OWNER.email, role: "PLATFORM_OWNER", keyId: "c1", reason: OWNER.reason });
    assert.equal(h.events("CENTER_SSO_LOGIN").length, 1);
  });

  it("the ticket works once and for 60 seconds; a bad ticket shows a page and is a security event", async () => {
    const { h, signed, consume } = await c3();
    const first = await signed<{ ticket: string }>("POST", "/api/center/sso", OWNER);
    assert.equal((await consume(first.data.ticket)).status, 303);
    const again = await consume(first.data.ticket);
    assert.equal(again.status, 400);
    assert.match(again.headers.get("Content-Type") ?? "", /text\/html/);
    assert.equal(again.headers.get("Set-Cookie"), null);
    const late = await signed<{ ticket: string }>("POST", "/api/center/sso", OWNER);
    h.advance(61_000);
    assert.equal((await consume(late.data.ticket)).status, 400);
    assert.equal((await consume("nonsense")).status, 400);
    assert.equal(h.events("CENTER_SSO_REFUSED").length, 3);
  });

  it("every write needs a reason", async () => {
    const { signed } = await c3();
    const res = await signed("POST", "/api/center/sso", { ...OWNER, reason: undefined });
    assert.equal(res.status, 422);
    assert.equal(res.error?.details?.reason, "CENTER_REASON_REQUIRED");
    assert.equal((await signed("POST", "/api/center/sso", { ...OWNER, reason: "  " })).status, 422);
  });

  it("SUPPORT_READONLY gets every *.view permission and nothing else", async () => {
    const { h, sso } = await c3();
    const { token } = await sso(SUPPORT);
    const me = await h.api<{ roles: string[]; permissions: string[] }>("GET", "/api/auth/me", { token });
    assert.deepEqual(me.data.roles, []);
    assert.ok(me.data.permissions.length > 10);
    assert.ok(me.data.permissions.every((p) => p.endsWith(".view")), me.data.permissions.join(","));
    const create = await h.api("POST", "/api/admin/users", { token, body: { email: "x@site.test", displayName: "X", roles: ["MANAGER"] } });
    assert.equal(create.status, 403);
  });

  it("a Center user's access follows its Center role at each sign-in", async () => {
    const { h, sso } = await c3();
    await sso(OWNER);
    const { token } = await sso({ ...OWNER, role: "SUPPORT_READONLY" });
    assert.deepEqual((await h.api<{ roles: string[] }>("GET", "/api/auth/me", { token })).data.roles, []);
    const back = await sso(OWNER);
    assert.deepEqual((await h.api<{ roles: string[] }>("GET", "/api/auth/me", { token: back.token })).data.roles, ["SUPER_ADMIN"]);
  });
});

describe("Center users are invisible to the site's own admins (phase C3)", () => {
  it("not listed, not found, not counted, cannot sign in with a password", async () => {
    const { h, sso } = await c3();
    await sso(OWNER);
    const token = await h.login("owner@site.test");
    const list = await h.api<{ items: { id: string }[]; total: number }>("GET", "/api/admin/users", { token });
    assert.deepEqual(list.data.items.map((u) => u.id), ["site-owner"]);
    assert.equal(list.data.total, 1);
    assert.equal((await h.api("GET", "/api/admin/users/center_u_owner", { token })).status, 404);
    assert.equal((await h.api("POST", "/api/admin/users/center_u_owner/suspend", { token, body: {} })).status, 404);
    const roles = await h.api<{ code: string; userCount: number }[]>("GET", "/api/admin/roles", { token });
    assert.equal(roles.data.find((r) => r.code === "SUPER_ADMIN")?.userCount, 1);
    const login = await h.api("POST", "/api/auth/login", { body: { identifier: "u_owner@center.invalid", password: "!center-sso-only", rememberMe: false } });
    assert.equal(login.status, 401);
    const status = await h.api<{ checks: { key: string; value: string | null }[] }>("GET", "/api/admin/system", { token });
    assert.equal(status.data.checks.find((c) => c.key === "superAdmins")?.value, "1", "Center does not count as a second SUPER_ADMIN");
  });

  it("the site's last SUPER_ADMIN stays protected even while a Center user holds SUPER_ADMIN", async () => {
    const { h, sso } = await c3();
    await sso(OWNER);
    assert.throws(() => h.db.run("UPDATE users SET status = 'SUSPENDED' WHERE id = 'site-owner'"), /LAST_SUPER_ADMIN/);
    assert.throws(() => h.db.run("DELETE FROM user_roles WHERE user_id = 'site-owner'"), /LAST_SUPER_ADMIN/);
    h.db.run("DELETE FROM user_roles WHERE user_id = 'center_u_owner'");
    assert.throws(() => h.db.run("UPDATE users SET id = 'center_x' WHERE id = 'site-owner'"), /USER_ID_LOCKED/);
  });
});

describe("Center writes (phase C3)", () => {
  it("sign out Center users: OPERATOR may, SUPPORT may not; the session stops working", async () => {
    const { h, sso, signed } = await c3();
    const { token } = await sso(OWNER);
    const denied = await signed("POST", "/api/center/sessions/revoke", SUPPORT, { actorId: "u_owner" });
    assert.equal(denied.status, 403);
    assert.equal(denied.error?.code, "CENTER_ROLE_REQUIRED");
    const res = await signed<{ revoked: number }>("POST", "/api/center/sessions/revoke", OPERATOR, { actorId: "u_owner" });
    assert.equal(res.status, 200);
    assert.equal(res.data.revoked, 1);
    assert.equal((await h.api("GET", "/api/auth/me", { token })).status, 401);
    assert.equal(h.audits("CENTER_REVOKE_SESSIONS")[0]?.user_id, "center_u_ops");
    assert.equal((await signed("POST", "/api/center/sessions/revoke", OPERATOR, { actorId: "bad id!" })).status, 422);
  });

  it("suspension: PLATFORM_OWNER only; new public bookings stop (423), the back office keeps working; resume reopens", async () => {
    const { h, signed } = await c3();
    const quote = () => h.api("POST", "/api/public/bookings/quote", { body: {} });
    assert.notEqual((await quote()).status, 423);
    assert.equal((await signed("PUT", "/api/center/suspension", OPERATOR, { suspended: true })).error?.code, "CENTER_ROLE_REQUIRED");
    const on = await signed<{ suspended: boolean; reasonCode: string; note: string }>("PUT", "/api/center/suspension", OWNER, { suspended: true, note: "ค้างค่าบริการ ก.ย." });
    assert.equal(on.status, 200, JSON.stringify(on.error));
    assert.deepEqual([on.data.suspended, on.data.reasonCode, on.data.note], [true, "UNPAID_FEES", "ค้างค่าบริการ ก.ย."]);
    const blocked = await quote();
    assert.equal(blocked.status, 423);
    assert.equal(blocked.error?.code, "SITE_SUSPENDED");
    assert.equal((await h.api("POST", "/api/public/bookings", { body: {} })).status, 423);
    assert.equal((await h.api("GET", "/api/public/site?lang=th")).status, 200, "the website itself stays up");
    const token = await h.login("owner@site.test");
    const status = await h.api<{ checks: { key: string; level: string }[] }>("GET", "/api/admin/system", { token });
    assert.equal(status.data.checks.find((c) => c.key === "centerSuspension")?.level, "error", "the owner sees why");
    assert.equal((await signed<{ suspended: boolean }>("GET", "/api/center/hello", OWNER)).data.suspended, true);
    const off = await signed<{ suspended: boolean }>("PUT", "/api/center/suspension", OWNER, { suspended: false });
    assert.equal(off.data.suspended, false);
    assert.notEqual((await quote()).status, 423);
    assert.deepEqual(h.audits("CENTER_SUSPEND").length + h.audits("CENTER_RESUME").length, 2);
    assert.throws(() => h.db.run("INSERT INTO site_suspension (id, reason_code, suspended_by, suspended_at) VALUES (1, 'OTHER', 'center_u_owner', 'x')"));
  });

  it("users: the site's own accounts for Center (no Center users, no password hashes)", async () => {
    const { sso, signed } = await c3();
    await sso(OWNER);
    const res = await signed<{ items: Record<string, unknown>[] }>("GET", "/api/center/users", SUPPORT);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.items.map((u) => u.id), ["site-owner"]);
    assert.deepEqual(res.data.items[0]!.roles, ["SUPER_ADMIN"]);
    assert.ok(!JSON.stringify(res.data).includes("password"));
  });
});
