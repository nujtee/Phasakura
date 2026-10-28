import { SqliteD1 } from "../helpers/sqlite-d1.ts";
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

async function c3(opts: { noOwner?: boolean } = {}) {
  const base = await setup();
  const { h, key } = base;
  if (!opts.noOwner) await h.user({ id: "site-owner", email: "owner@site.test", roles: ["SUPER_ADMIN"] });
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

describe("A new site's first owner (phase C7)", () => {
  it("PLATFORM_OWNER only, reason required; creates a SUPER_ADMIN with a one-time invite link; audited", async () => {
    const { h, signed } = await c3({ noOwner: true });
    const body = { email: " New.Owner@Example.com ", name: "เจ้าของใหม่" };
    assert.equal((await signed("POST", "/api/center/owner", OPERATOR, body)).status, 403);
    assert.equal((await signed("POST", "/api/center/owner", { ...OWNER, reason: "" }, body)).status, 422);
    assert.equal((await signed("POST", "/api/center/owner", OWNER, { email: "nope", name: "x" })).error?.details?.email, "INVALID");
    assert.equal((await signed("POST", "/api/center/owner", OWNER, { ...body, extra: 1 })).status, 422);
    const res = await signed<{ userId: string; created: boolean; url: string; expiresAt: string }>("POST", "/api/center/owner", OWNER, body);
    assert.equal(res.status, 200, JSON.stringify(res.error));
    assert.equal(res.data.created, true);
    assert.match(res.data.url, /\/admin\/reset-password#token=[A-Za-z0-9_-]{43}&invite=1$/);
    const users = await signed<{ items: { email: string; roles: string[] }[] }>("GET", "/api/center/users", SUPPORT);
    assert.deepEqual(users.data.items.map((u) => [u.email, u.roles]), [["new.owner@example.com", ["SUPER_ADMIN"]]]);
    // No password logs in before the link is used.
    assert.equal((await h.api("POST", "/api/auth/login", { body: { identifier: "new.owner@example.com", password: "!owner-invite-pending" } })).status, 401);
    const token = res.data.url.match(/token=([A-Za-z0-9_-]{43})/)![1]!;
    const newPassword = "a long owner passphrase 2026";
    assert.equal((await h.api("POST", "/api/auth/reset-password", { body: { token, newPassword } })).status, 200);
    await h.login("new.owner@example.com", newPassword);
    const audit = h.audits("CENTER_OWNER_INVITED");
    assert.equal(audit.length, 1);
    assert.ok(!audit[0]!.new_value!.includes(token), "the link is never in the audit log");
  });

  it("asking again before the owner signs in replaces the link; once they have, or anyone else exists, it is refused", async () => {
    const { h, signed } = await c3({ noOwner: true });
    const body = { email: "owner@new.test", name: "Owner" };
    const first = await signed<{ url: string; userId: string }>("POST", "/api/center/owner", OWNER, body);
    const second = await signed<{ url: string; userId: string; created: boolean }>("POST", "/api/center/owner", OWNER, body);
    assert.equal(second.status, 200);
    assert.equal(second.data.created, false);
    assert.equal(second.data.userId, first.data.userId);
    const oldToken = first.data.url.match(/token=([A-Za-z0-9_-]{43})/)![1]!;
    assert.notEqual((await h.api("POST", "/api/auth/reset-password", { body: { token: oldToken, newPassword: "quiet mountain river lantern 2026" } })).status, 200, "the old link stopped working");
    assert.equal((await signed("POST", "/api/center/owner", OWNER, { email: "someone@else.test", name: "X" })).error?.code, "SITE_HAS_OWNER");
    const token = second.data.url.match(/token=([A-Za-z0-9_-]{43})/)![1]!;
    const pw = "quiet mountain river lantern 2026";
    const set = await h.api("POST", "/api/auth/reset-password", { body: { token, newPassword: pw } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    await h.login("owner@new.test", pw);
    assert.equal((await signed("POST", "/api/center/owner", OWNER, body)).status, 409, "signed in: the site's admins manage people now");
  });

  it("a site that already has its own admin refuses", async () => {
    const { signed } = await c3();
    const res = await signed("POST", "/api/center/owner", OWNER, { email: "another@site.test", name: "Owner" });
    assert.equal(res.status, 409);
    assert.equal(res.error?.code, "SITE_HAS_OWNER");
  });
});

describe("Backups (phase C8)", () => {
  const gunzip = async (bytes: Uint8Array) => new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  const bucket = (h: Awaited<ReturnType<typeof c3>>["h"]) => h.env.MEDIA_PRIVATE as unknown as { objects: Map<string, { bytes: Uint8Array }> };

  it("a backup into the private bucket: OPERATOR / OWNER with a reason; SUPPORT can only list; audited", async () => {
    const { h, signed } = await c3();
    assert.equal((await signed("POST", "/api/center/backups", SUPPORT)).status, 403);
    assert.equal((await signed("POST", "/api/center/backups", { ...OPERATOR, reason: "" })).status, 422);
    const made = await signed<{ name: string; size: number; tables: number; rows: number; sha256: string; trigger: string }>("POST", "/api/center/backups", OPERATOR);
    assert.equal(made.status, 200, JSON.stringify(made.error));
    assert.match(made.data.name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[A-Za-z0-9_-]{6}\.sql\.gz$/);
    assert.equal(made.data.trigger, "CENTER");
    assert.ok(made.data.tables > 30 && made.data.rows > 0);
    assert.ok(bucket(h).objects.has(`backups/${made.data.name}`));
    const list = await signed<{ items: { name: string; rows: number; sha256: string }[] }>("GET", "/api/center/backups", SUPPORT);
    assert.deepEqual(list.data.items.map((b) => [b.name, b.rows, b.sha256]), [[made.data.name, made.data.rows, made.data.sha256]]);
    const audit = h.audits("CENTER_BACKUP");
    assert.equal(audit.length, 1);
    assert.match(audit[0]!.new_value!, /ops@phasakura\.com/);
  });

  it("download: PLATFORM_OWNER only; the file is SQL that rebuilds the database in an empty one, without sessions", async () => {
    const { h, signed, key } = await c3();
    await h.login("owner@site.test"); // a live session must not travel in a backup
    const made = await signed<{ name: string; sha256: string }>("POST", "/api/center/backups", OWNER);
    const path = `/api/center/backups/download?name=${encodeURIComponent(made.data.name)}`;
    const raw = async (p: string, actor: CenterActor) => h.app.fetch(new Request(`${ORIGIN}${p}`, {
      headers: { ...(await signCenterRequest({ privateKey: key.privateKey, keyId: "c1", method: "GET", url: `${ORIGIN}${p}`, actor, now: h.now })), "CF-Connecting-IP": "198.51.100.7" },
    }), h.env);
    assert.equal((await raw(path, OPERATOR)).status, 403);
    assert.equal((await raw("/api/center/backups/download?name=..%2Fslips%2Fx", OWNER)).status, 422);
    assert.equal((await raw("/api/center/backups/download?name=2026-01-01T00-00-00Z-abcdef.sql.gz", OWNER)).status, 404);
    const res = await raw(path, OWNER);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/gzip");
    assert.match(res.headers.get("Content-Disposition") ?? "", /attachment; filename="\d{4}-.*\.sql\.gz"/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.equal(digest, made.data.sha256);
    assert.equal(h.audits("CENTER_BACKUP_DOWNLOAD").length, 1);
    const sql = await gunzip(bytes);
    assert.match(sql, new RegExp(`^-- [a-z0-9-]+ D1 backup .* schema ${LATEST_MIGRATION.replace(".", "\\.")}`));
    assert.match(sql, /CREATE TABLE users/);
    assert.match(sql, /INSERT INTO "users" \(/);
    assert.ok(!/INSERT INTO "sessions"/.test(sql), "no sessions");
    assert.ok(sql.indexOf("CREATE TRIGGER") > sql.lastIndexOf('\nINSERT INTO "'), "triggers after the rows");
    // Restore into a fresh database and compare.
    const fresh = new SqliteD1();
    fresh.raw.exec(sql);
    const count = async (db: SqliteD1, t: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
    for (const t of ["roles", "permissions", "role_permissions", "site_settings", "languages"]) {
      assert.equal(await count(fresh, t), await count(h.db as SqliteD1, t), t);
    }
    // The backup was taken before Center's own account was added for the request: only the site's owner.
    assert.equal((await fresh.prepare("SELECT group_concat(email) AS e FROM users").first<{ e: string }>())!.e, "owner@site.test");
    assert.equal(await count(fresh, "sessions"), 0);
    assert.ok(await count(h.db as SqliteD1, "sessions") > 0);
  });

  it("daily backup from the cron at 03:17 Bangkok, once a day; only the newest 30 are kept", async () => {
    const { h, signed } = await c3();
    const at = (iso: string) => { h.now = new Date(iso); return h.app.scheduled(h.env, h.now.getTime()); };
    await at("2026-10-20T20:16:00Z");
    assert.equal(bucket(h).objects.size, 0, "not at another minute");
    await at("2026-10-20T20:17:00Z");
    assert.equal(bucket(h).objects.size, 1);
    await at("2026-10-20T20:17:30Z");
    assert.equal(bucket(h).objects.size, 1, "not twice the same day");
    await at("2026-10-21T20:17:00Z");
    assert.equal(bucket(h).objects.size, 2);
    const list = await signed<{ items: { trigger: string; createdAt: string }[] }>("GET", "/api/center/backups", SUPPORT);
    assert.deepEqual(list.data.items.map((b) => [b.trigger, b.createdAt]), [["CRON", "2026-10-21T20:17:00.000Z"], ["CRON", "2026-10-20T20:17:00.000Z"]]);
    for (let i = 0; i < 31; i++) {
      h.now = new Date(Date.parse("2026-11-01T00:00:00Z") + i * 1000);
      await signed("POST", "/api/center/backups", OWNER);
    }
    const kept = await signed<{ items: { createdAt: string }[] }>("GET", "/api/center/backups", SUPPORT);
    assert.equal(kept.data.items.length, 30);
    assert.equal(kept.data.items.at(-1)!.createdAt, "2026-11-01T00:00:01.000Z", "the oldest went first");
  });
});

// ------------------------------------------------------------------ phase O1: OTA channels switch

describe("Center: OTA channels (phase O1)", () => {
  it("reads the state; PLATFORM_OWNER / OPERATOR switch iCal with a reason (audited as the Center user); SUPPORT cannot", async () => {
    const { h, signed } = await c3();
    const read = await signed<{ ical: { enabled: boolean; feedsWithImport: number }; channex: { available: boolean } }>("GET", "/api/center/channels", SUPPORT);
    assert.equal(read.status, 200);
    assert.equal(read.data.ical.enabled, false);
    assert.equal(read.data.channex.available, false);
    assert.equal((await signed("PUT", "/api/center/channels", SUPPORT, { ical: true })).error?.code, "CENTER_ROLE_REQUIRED");
    assert.equal((await signed("PUT", "/api/center/channels", { ...OPERATOR, reason: "" }, { ical: true })).error?.details?.reason, "CENTER_REASON_REQUIRED");
    assert.equal((await signed("PUT", "/api/center/channels", OPERATOR, { ical: "on" })).status, 422);
    const on = await signed<{ ical: { enabled: boolean } }>("PUT", "/api/center/channels", OPERATOR, { ical: true });
    assert.equal(on.status, 200, JSON.stringify(on.error));
    assert.equal(on.data.ical.enabled, true);
    const audit = h.audits("CHANNEL_ICAL_ON");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.user_id, "center_u_ops");
    assert.match(String(audit[0]!.new_value), /ตรวจการจองที่ค้าง/);
    assert.equal(h.db.get<{ ical_enabled: number }>("SELECT ical_enabled FROM channel_settings")!.ical_enabled, 1);
    assert.equal((await signed<{ ical: { enabled: boolean } }>("PUT", "/api/center/channels", OWNER, { ical: false })).data.ical.enabled, false);
  });

  it("Channex: refused until CHANNEX_API_KEY is set on the site; then switched like iCal", async () => {
    const { h, signed } = await c3();
    assert.equal((await signed("PUT", "/api/center/channels", OWNER, { channex: true })).error?.code, "CHANNEX_NOT_CONFIGURED");
    assert.equal((await signed("PUT", "/api/center/channels", OWNER, {})).error?.details?.ical, "REQUIRED");
    h.env.CHANNEX_API_KEY = "k";
    const on = await signed<{ channex: { enabled: boolean; available: boolean; environment: string } }>("PUT", "/api/center/channels", OWNER, { channex: true });
    assert.equal(on.status, 200, JSON.stringify(on.error));
    assert.deepEqual([on.data.channex.enabled, on.data.channex.available, on.data.channex.environment], [true, true, "staging"]);
    assert.equal(h.audits("CHANNEL_CHANNEX_ON")[0]!.user_id, "center_u_owner");
  });
});

// ------------------------------------------------------------------ site plan / credit system switches

describe("Center: features only a SUPER_ADMIN switches (landscape, credits)", () => {
  it("reads both; PLATFORM_OWNER / OPERATOR switch them with a reason, audited as the Center user; SUPPORT cannot", async () => {
    const { h, signed } = await c3();
    type F = { landscape: { enabled: boolean; layouts: number } | null; credits: { enabled: boolean; payeeSet: boolean } | null };
    const read = await signed<F>("GET", "/api/center/features", SUPPORT);
    assert.equal(read.status, 200, JSON.stringify(read.error));
    assert.deepEqual([read.data.landscape?.enabled, read.data.landscape?.layouts, read.data.credits?.enabled], [false, 0, false]);
    assert.equal((await signed("PUT", "/api/center/features", SUPPORT, { landscape: true })).error?.code, "CENTER_ROLE_REQUIRED");
    assert.equal((await signed("PUT", "/api/center/features", { ...OPERATOR, reason: "" }, { landscape: true })).error?.details?.reason, "CENTER_REASON_REQUIRED");
    assert.equal((await signed("PUT", "/api/center/features", OPERATOR, { landscape: "on" })).status, 422);
    assert.equal((await signed("PUT", "/api/center/features", OPERATOR, { spaceship: true })).status, 422);
    assert.equal((await signed("PUT", "/api/center/features", OPERATOR, {})).status, 422);

    const on = await signed<F>("PUT", "/api/center/features", OPERATOR, { landscape: true });
    assert.equal(on.status, 200, JSON.stringify(on.error));
    assert.equal(on.data.landscape?.enabled, true);
    assert.equal(h.db.get<{ e: number }>("SELECT enabled AS e FROM landscape_settings")!.e, 1);
    const audit = h.audits("LANDSCAPE_ON");
    assert.equal(audit[0]!.user_id, "center_u_ops");
    assert.match(String(audit[0]!.new_value), /ตรวจการจองที่ค้าง/);

    // Credits: only once it is set where top-ups are paid (the same rule as the settings page).
    assert.equal((await signed("PUT", "/api/center/features", OWNER, { credits: true })).error?.code, "CREDIT_PAYEE_NOT_SET");
    h.db.run("UPDATE credit_settings SET account_number = '111-2-33333-4', bank_name = 'Kasikorn' WHERE id = 1");
    const credits = await signed<F>("PUT", "/api/center/features", OWNER, { credits: true });
    assert.equal(credits.status, 200, JSON.stringify(credits.error));
    assert.deepEqual([credits.data.credits?.enabled, credits.data.credits?.payeeSet], [true, true]);
    assert.equal(h.audits("CREDITS_ON")[0]!.user_id, "center_u_owner");
    assert.equal((await signed<F>("PUT", "/api/center/features", OWNER, { credits: false, landscape: false })).data.landscape?.enabled, false);
  });
});
