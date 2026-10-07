import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { CurrentUserDto } from "../../src/shared/auth-types.ts";
import { sha256Hex } from "../../src/worker/security/tokens.ts";
import { buildBootstrapSql } from "../../scripts/create-super-admin.ts";
import { Harness, STRONG_PASSWORD, tokenFromLink } from "../helpers/harness.ts";

const HOUR = 3600_000;
let h: Harness;

beforeEach(async () => {
  h = new Harness();
  await h.user({ id: "root", email: "root@example.test", roles: ["SUPER_ADMIN"], username: "rootadmin" });
  await h.user({ id: "viewer", roles: ["VIEWER"] });
});

describe("POST /api/auth/login", () => {
  it("logs in by email or username and sets a hardened session cookie", async () => {
    const res = await h.api<CurrentUserDto>("POST", "/api/auth/login", {
      body: { identifier: "ROOT@example.test", password: STRONG_PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.match(res.setCookie ?? "", /^__Host-sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal(res.data.email, "root@example.test");
    assert.ok(res.data.roles.includes("SUPER_ADMIN"));
    assert.ok(res.data.permissions.includes("users.delete"));
    assert.equal(res.headers.get("Cache-Control"), "no-store");

    const byUsername = await h.api("POST", "/api/auth/login", { body: { identifier: "rootadmin", password: STRONG_PASSWORD } });
    assert.equal(byUsername.status, 200);
  });

  it("stores only the SHA-256 of the session token", async () => {
    const token = await h.login("root@example.test");
    const hashes = h.db.all<{ token_hash: string }>("SELECT token_hash FROM sessions").map((r) => r.token_hash);
    assert.ok(!hashes.includes(token), "raw token never stored");
    assert.ok(hashes.includes(await sha256Hex(token)));
  });

  it("'Remember me' sets a persistent cookie (30 days); otherwise a browser-session cookie", async () => {
    const remember = await h.api("POST", "/api/auth/login", {
      body: { identifier: "root@example.test", password: STRONG_PASSWORD, rememberMe: true },
    });
    assert.match(remember.setCookie ?? "", /Max-Age=2592000/);
    const plain = await h.api("POST", "/api/auth/login", { body: { identifier: "root@example.test", password: STRONG_PASSWORD } });
    assert.doesNotMatch(plain.setCookie ?? "", /Max-Age/);
  });

  it("gives the same answer for unknown users and wrong passwords (no enumeration)", async () => {
    const unknown = await h.api("POST", "/api/auth/login", { body: { identifier: "nobody@example.test", password: STRONG_PASSWORD } });
    const wrong = await h.api("POST", "/api/auth/login", { body: { identifier: "root@example.test", password: "wrong password here" } });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(unknown.error?.code, wrong.error?.code);
    assert.equal(unknown.error?.message, wrong.error?.message);
    assert.equal(h.events("LOGIN_FAILED").length, 2);
  });

  it("locks the account after 5 failures for 15 minutes, then allows login again", async () => {
    for (let i = 0; i < 5; i++) {
      await h.api("POST", "/api/auth/login", { body: { identifier: "root@example.test", password: "wrong password here" } });
    }
    assert.equal(h.events("ACCOUNT_LOCKED").length, 1);
    const locked = await h.api("POST", "/api/auth/login", { body: { identifier: "root@example.test", password: STRONG_PASSWORD } });
    assert.equal(locked.status, 401, "correct password rejected while locked");
    h.advance(16 * 60_000);
    assert.ok(await h.login("root@example.test"));
    assert.equal(h.db.get<{ n: number }>("SELECT failed_login_count AS n FROM users WHERE id = 'root'")!.n, 0);
  });

  it("throttles an IP after 20 failures with 429 + Retry-After", async () => {
    for (let i = 0; i < 20; i++) {
      await h.api("POST", "/api/auth/login", { body: { identifier: `x${i}@example.test`, password: "wrong password here" } });
    }
    const res = await h.api("POST", "/api/auth/login", { body: { identifier: "root@example.test", password: STRONG_PASSWORD } });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "900");
    h.ip = "198.51.100.7";
    assert.ok(await h.login("root@example.test"), "other IPs unaffected");
  });

  it("suspended users are told only after a correct password; deleted users look unknown", async () => {
    await h.user({ id: "sus", roles: ["VIEWER"], status: "SUSPENDED" });
    const wrong = await h.api("POST", "/api/auth/login", { body: { identifier: "sus@example.test", password: "wrong password here" } });
    assert.equal(wrong.error?.code, "INVALID_CREDENTIALS");
    const right = await h.api("POST", "/api/auth/login", { body: { identifier: "sus@example.test", password: STRONG_PASSWORD } });
    assert.equal(right.status, 403);
    assert.equal(right.error?.code, "ACCOUNT_SUSPENDED");

    h.db.run("UPDATE users SET status = 'DELETED', deleted_at = 'x' WHERE id = 'viewer'");
    const deleted = await h.api("POST", "/api/auth/login", { body: { identifier: "viewer@example.test", password: STRONG_PASSWORD } });
    assert.equal(deleted.error?.code, "INVALID_CREDENTIALS");
  });

  it("upgrades weak password hashes on login", async () => {
    await h.login("root@example.test");
    const hash = h.db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = 'root'")!.password_hash;
    assert.match(hash, /^pbkdf2_sha256\$100000\$/);
  });

  it("validates input strictly (mass assignment, types, size, content type)", async () => {
    const extra = await h.api("POST", "/api/auth/login", {
      body: { identifier: "root@example.test", password: STRONG_PASSWORD, role: "SUPER_ADMIN" },
    });
    assert.equal(extra.status, 422);
    assert.equal(extra.error?.details?.role, "UNKNOWN_FIELD");
    const badType = await h.api("POST", "/api/auth/login", { body: { identifier: 1, password: STRONG_PASSWORD } });
    assert.equal(badType.error?.details?.identifier, "EXPECTED_STRING");
    const text = await h.api("POST", "/api/auth/login", { rawBody: "x", headers: { "Content-Type": "text/plain" } });
    assert.equal(text.status, 415);
    const big = await h.api("POST", "/api/auth/login", { rawBody: JSON.stringify({ identifier: "a".repeat(20_000) }) });
    assert.equal(big.status, 413);
    const notJson = await h.api("POST", "/api/auth/login", { rawBody: "{nope" });
    assert.equal(notJson.error?.details?.body, "INVALID_JSON");
  });
});

describe("CSRF protection", () => {
  const body = { identifier: "root@example.test", password: STRONG_PASSWORD };

  it("rejects a foreign Origin", async () => {
    const res = await h.api("POST", "/api/auth/login", { body, headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(res.error?.code, "CSRF_ORIGIN_MISMATCH");
  });

  it("rejects a missing Origin with no Sec-Fetch-Site", async () => {
    const res = await h.api("POST", "/api/auth/login", { body, headers: { Origin: "" } });
    assert.equal(res.error?.code, "CSRF_ORIGIN_MISSING");
  });

  it("rejects cross-site Sec-Fetch-Site", async () => {
    const res = await h.api("POST", "/api/auth/login", { body, headers: { Origin: "", "Sec-Fetch-Site": "cross-site" } });
    assert.equal(res.status, 403);
  });

  it("requires the custom header", async () => {
    const res = await h.api("POST", "/api/auth/login", { body, headers: { "X-Requested-With": "" } });
    assert.equal(res.error?.code, "CSRF_HEADER_MISSING");
  });
});

describe("sessions: me, logout, refresh, expiry", () => {
  it("GET /api/auth/me requires a valid session", async () => {
    assert.equal((await h.api("GET", "/api/auth/me")).status, 401);
    const token = await h.login("root@example.test");
    const me = await h.api<CurrentUserDto>("GET", "/api/auth/me", { token });
    assert.equal(me.status, 200);
    assert.equal(me.data.id, "root");
  });

  it("an unknown token is rejected and the cookie cleared", async () => {
    const res = await h.api("GET", "/api/auth/me", { token: "A".repeat(43) });
    assert.equal(res.status, 401);
    assert.match(res.setCookie ?? "", /Max-Age=0/);
  });

  it("logout revokes the session server-side", async () => {
    const token = await h.login("root@example.test");
    const out = await h.api("POST", "/api/auth/logout", { token });
    assert.equal(out.status, 200);
    assert.match(out.setCookie ?? "", /Max-Age=0/);
    assert.equal((await h.api("GET", "/api/auth/me", { token })).status, 401, "stolen cookie useless after logout");
  });

  it("refresh rotates the token: the old one stops working", async () => {
    const token = await h.login("root@example.test");
    const res = await h.api("POST", "/api/auth/refresh", { token });
    assert.equal(res.status, 200);
    assert.ok(res.token && res.token !== token);
    assert.equal((await h.api("GET", "/api/auth/me", { token })).status, 401);
    assert.equal((await h.api("GET", "/api/auth/me", { token: res.token })).status, 200);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE revoke_reason = 'ROTATED'")!.n, 1);
  });

  it("browser sessions expire after 2h idle and 12h absolute; remember-me lasts 30 days", async () => {
    const idle = await h.login("root@example.test");
    h.advance(2 * HOUR + 60_000);
    assert.equal((await h.api("GET", "/api/auth/me", { token: idle })).status, 401, "idle timeout");

    const active = await h.login("root@example.test");
    for (let i = 0; i < 12; i++) {
      h.advance(HOUR);
      const res = await h.api("GET", "/api/auth/me", { token: active });
      if (i < 11) assert.equal(res.status, 200, `hour ${i + 1}`);
      else assert.equal(res.status, 401, "absolute 12h");
    }

    const remembered = await h.login("root@example.test", STRONG_PASSWORD, true);
    h.advance(20 * 24 * HOUR);
    assert.equal((await h.api("GET", "/api/auth/me", { token: remembered })).status, 200);
    h.advance(11 * 24 * HOUR);
    assert.equal((await h.api("GET", "/api/auth/me", { token: remembered })).status, 401);
  });

  it("a new login creates a new session (fixation protection)", async () => {
    const a = await h.login("root@example.test");
    const b = await h.login("root@example.test");
    assert.notEqual(a, b);
  });
});

describe("password flows", () => {
  it("forgot-password answers identically for known and unknown emails", async () => {
    const unknown = await h.api("POST", "/api/auth/forgot-password", { body: { email: "nobody@example.test" } });
    const known = await h.api("POST", "/api/auth/forgot-password", { body: { email: "root@example.test" } });
    assert.equal(unknown.status, 202);
    assert.deepEqual(unknown.body, known.body);
    assert.equal(h.delivered.length, 1);
    assert.match(h.delivered[0]!.url, /^https:\/\/phasakura\.test\/th\/admin\/reset-password#token=[A-Za-z0-9_-]{43}$/);
  });

  it("reset link: sets a new password, is single-use, and signs out other sessions", async () => {
    const oldSession = await h.login("root@example.test");
    await h.api("POST", "/api/auth/forgot-password", { body: { email: "root@example.test" } });
    const token = tokenFromLink(h.delivered[0]!.url);
    const newPassword = "a brand new passphrase 2027";

    assert.equal((await h.api("POST", "/api/auth/reset-password", { body: { token, newPassword: "short" } })).status, 422);
    const ok = await h.api("POST", "/api/auth/reset-password", { body: { token, newPassword } });
    assert.equal(ok.status, 200);
    assert.equal((await h.api("GET", "/api/auth/me", { token: oldSession })).status, 401, "old sessions revoked");
    assert.ok(await h.login("root@example.test", newPassword));
    const reuse = await h.api("POST", "/api/auth/reset-password", { body: { token, newPassword: "another passphrase 2027!" } });
    assert.equal(reuse.error?.details?.token, "INVALID_OR_EXPIRED");
  });

  it("reset links expire after 30 minutes and only the newest one works", async () => {
    await h.api("POST", "/api/auth/forgot-password", { body: { email: "root@example.test" } });
    await h.api("POST", "/api/auth/forgot-password", { body: { email: "root@example.test" } });
    const [first, second] = h.delivered.map((d) => tokenFromLink(d.url));
    const r1 = await h.api("POST", "/api/auth/reset-password", { body: { token: first, newPassword: "a brand new passphrase 2027" } });
    assert.equal(r1.status, 422, "superseded");
    h.advance(31 * 60_000);
    const r2 = await h.api("POST", "/api/auth/reset-password", { body: { token: second, newPassword: "a brand new passphrase 2027" } });
    assert.equal(r2.status, 422, "expired");
  });

  it("limits reset requests per account", async () => {
    for (let i = 0; i < 5; i++) await h.api("POST", "/api/auth/forgot-password", { body: { email: "root@example.test" } });
    assert.equal(h.delivered.length, 3);
  });

  it("change-password verifies the current password, rotates this session and revokes others", async () => {
    const other = await h.login("root@example.test");
    const mine = await h.login("root@example.test");
    const wrong = await h.api("POST", "/api/auth/change-password", {
      token: mine, body: { currentPassword: "not my password", newPassword: "a brand new passphrase 2027" },
    });
    assert.equal(wrong.error?.details?.currentPassword, "INCORRECT");
    const same = await h.api("POST", "/api/auth/change-password", {
      token: mine, body: { currentPassword: STRONG_PASSWORD, newPassword: STRONG_PASSWORD },
    });
    assert.equal(same.error?.details?.newPassword, "SAME_AS_CURRENT");

    const ok = await h.api("POST", "/api/auth/change-password", {
      token: mine, body: { currentPassword: STRONG_PASSWORD, newPassword: "a brand new passphrase 2027" },
    });
    assert.equal(ok.status, 200);
    assert.ok(ok.token);
    assert.equal((await h.api("GET", "/api/auth/me", { token: other })).status, 401);
    assert.equal((await h.api("GET", "/api/auth/me", { token: mine })).status, 401, "old token of this device rotated");
    assert.equal((await h.api("GET", "/api/auth/me", { token: ok.token })).status, 200);
  });

  it("must-change-password blocks everything except me / change-password / logout", async () => {
    await h.user({ id: "temp", roles: ["SUPER_ADMIN"], mustChange: true });
    const token = await h.login("temp@example.test");
    const me = await h.api<CurrentUserDto>("GET", "/api/auth/me", { token });
    assert.equal(me.data.mustChangePassword, true);
    const blocked = await h.api("GET", "/api/admin/users", { token });
    assert.equal(blocked.error?.code, "PASSWORD_CHANGE_REQUIRED");
    const changed = await h.api("POST", "/api/auth/change-password", {
      token, body: { currentPassword: STRONG_PASSWORD, newPassword: "a brand new passphrase 2027" },
    });
    assert.equal((await h.api("GET", "/api/admin/users", { token: changed.token })).status, 200);
  });
});

describe("SUPER_ADMIN bootstrap CLI", () => {
  it("creates the first SUPER_ADMIN (must change password) and is a no-op afterwards", async () => {
    const fresh = new Harness();
    const password = "bootstrap passphrase 2027";
    fresh.db.exec(await buildBootstrapSql({ id: "boot1", email: "owner@example.test", displayName: "Owner", username: null, password }));
    const token = await fresh.login("owner@example.test", password);
    const me = await fresh.api<CurrentUserDto>("GET", "/api/auth/me", { token });
    assert.deepEqual(me.data.roles, ["SUPER_ADMIN"]);
    assert.equal(me.data.mustChangePassword, true);

    fresh.db.exec(await buildBootstrapSql({ id: "boot2", email: "second@example.test", displayName: "X", username: null, password }));
    assert.equal(fresh.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n, 1, "second run inserted nothing");
    assert.equal(fresh.audits("BOOTSTRAP_SUPER_ADMIN").length, 1);
  });

  it("the generated SQL contains a hash, never the password", async () => {
    const sql = await buildBootstrapSql({ id: "b", email: "o@example.test", displayName: "O'Brien", username: null, password: "bootstrap passphrase 2027" });
    assert.doesNotMatch(sql, /bootstrap passphrase/);
    assert.match(sql, /'O''Brien'/, "quotes escaped");
  });
});

describe("no secrets in logs", () => {
  it("security events and audit logs never contain passwords or session tokens", async () => {
    const token = await h.login("root@example.test");
    await h.api("POST", "/api/auth/login", { body: { identifier: "root@example.test", password: "a wrong secret pass" } });
    await h.api("POST", "/api/auth/change-password", {
      token, body: { currentPassword: STRONG_PASSWORD, newPassword: "a brand new passphrase 2027" },
    });
    const dump = JSON.stringify([
      h.db.all("SELECT * FROM security_events"),
      h.db.all("SELECT * FROM audit_logs"),
    ]);
    for (const secret of [STRONG_PASSWORD, "a wrong secret pass", "a brand new passphrase 2027", token]) {
      assert.ok(!dump.includes(secret), `leaked: ${secret.slice(0, 6)}…`);
    }
  });
});
