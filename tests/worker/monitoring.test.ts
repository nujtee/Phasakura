import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { HealthDto, SystemStatusDto } from "../../src/shared/system-types.ts";
import { CRON_STALE_MS, LATEST_MIGRATION } from "../../src/worker/services/health.service.ts";
import { resetErrorThrottle, scrubMessage } from "../../src/worker/services/monitoring.service.ts";
import { Harness } from "../helpers/harness.ts";
import { migrationFiles } from "../helpers/sqlite-d1.ts";

/** Phase 16 — production monitoring: health, cron heartbeat, server error log, System status page. */

type Beat = { name: string; last_run_at: string; last_ok_at: string | null; last_status: string; last_error: string | null; runs: number };
type ErrorRow = { source: string; request_id: string | null; method: string | null; path: string | null; error_name: string | null; message: string };

const beats = (h: Harness) => h.db.all("SELECT * FROM system_heartbeats ORDER BY name") as Beat[];
const errors = (h: Harness) => h.db.all("SELECT * FROM error_events ORDER BY occurred_at, rowid") as ErrorRow[];

beforeEach(() => resetErrorThrottle());

describe("scrubMessage: nothing personal or secret reaches the error log", () => {
  it("removes e-mails, phone numbers, tokens and query strings; collapses whitespace; caps the length", () => {
    assert.equal(scrubMessage("guest somchai.k@example.co.th failed"), "guest [email] failed");
    assert.equal(scrubMessage("call +66 81-234-5678 now"), "call [number] now");
    assert.equal(scrubMessage("phone 0812345678"), "phone [number]");
    assert.equal(scrubMessage("Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxx rejected"), "Bearer [token] rejected");
    assert.equal(scrubMessage("token EAAGm0PX4ZCpsBAxxxxxxxx invalid"), "token [token] invalid");
    assert.equal(scrubMessage("jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig"), "jwt [token]");
    assert.equal(scrubMessage(`key ${"a1B2".repeat(10)} leaked`), "key [token] leaked");
    assert.equal(scrubMessage("GET /api/public/bookings?code=PSK-1&phone=0812345678 failed"), "GET /api/public/bookings?… failed");
    assert.equal(scrubMessage("a\n\n  b\tc"), "a b c");
    assert.equal(scrubMessage("word ".repeat(100)).length, 299, "300 characters, trailing space trimmed");
    assert.equal(scrubMessage("D1_ERROR: no such table: bookings: SQLITE_ERROR"), "D1_ERROR: no such table: bookings: SQLITE_ERROR", "ordinary errors stay readable");
  });
});

describe("schema version", () => {
  it("LATEST_MIGRATION is the newest file in migrations/ (bump it with every migration)", () => {
    assert.equal(LATEST_MIGRATION, migrationFiles().at(-1));
  });

  it("D1's migration list decides when it can be read: older → outdated (503), current → ok", async () => {
    const h = new Harness();
    h.db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, applied_at TEXT)");
    h.db.run("INSERT INTO d1_migrations (name) VALUES (?)", "0019_privacy_marketing.sql");
    let res = await h.api<HealthDto>("GET", "/api/health");
    assert.equal(res.status, 503);
    assert.equal(res.data.schema, "outdated");
    h.db.run("INSERT INTO d1_migrations (name) VALUES (?)", LATEST_MIGRATION);
    res = await h.api<HealthDto>("GET", "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.data.schema, "ok");
    h.db.exec("DELETE FROM d1_migrations");
    assert.equal((await h.api<HealthDto>("GET", "/api/health")).data.schema, "outdated", "an empty list means nothing was applied");
  });
});

describe("cron heartbeat", () => {
  it("every run records a heartbeat; /api/health reports a stopped cron as stale (503) and recovers", async () => {
    const h = new Harness();
    assert.equal((await h.api<HealthDto>("GET", "/api/health")).data.cron, "unknown", "never ran: not reported as broken");

    await h.app.scheduled(h.env, h.now.getTime());
    let [beat] = beats(h);
    assert.equal(beat?.name, "cron");
    assert.equal(beat?.last_status, "OK");
    assert.equal(beat?.last_run_at, h.now.toISOString());
    assert.equal(beat?.last_ok_at, h.now.toISOString());
    assert.equal(beat?.runs, 1);
    let res = await h.api<HealthDto>("GET", "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.data.cron, "ok");
    assert.equal(res.data.status, "ok");

    h.advance(CRON_STALE_MS);
    assert.equal((await h.api<HealthDto>("GET", "/api/health")).data.cron, "ok", "exactly at the limit is still fresh");
    h.advance(1000);
    res = await h.api<HealthDto>("GET", "/api/health");
    assert.equal(res.status, 503);
    assert.equal(res.data.cron, "stale");
    assert.equal(res.data.status, "degraded");
    assert.equal(res.headers.get("Cache-Control"), "no-store");

    await h.app.scheduled(h.env, h.now.getTime());
    [beat] = beats(h);
    assert.equal(beat?.runs, 2);
    assert.equal((await h.api<HealthDto>("GET", "/api/health")).status, 200);
  });

  it("a failing task does not stop the others; the heartbeat says which failed and the error log has it", async () => {
    const h = new Harness({ seed: true });
    h.db.exec("ALTER TABLE marketing_events RENAME TO marketing_events_off");
    // A task that runs after the failing one: error log retention (minute 11).
    h.db.run("INSERT INTO error_events (id, occurred_at, source, message) VALUES ('old', '2026-01-01T00:00:00.000Z', 'API', 'old')");
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => logged.push(String(line));
    try {
      await h.app.scheduled(h.env, Date.parse("2027-01-10T03:11:00Z"));
    } finally {
      console.error = original;
    }
    let [beat] = beats(h);
    assert.equal(beat?.last_status, "ERROR");
    assert.equal(beat?.last_ok_at, null, "never succeeded yet");
    assert.equal(beat?.last_error, "failed: capi");
    const [row, ...rest] = errors(h);
    assert.equal(rest.length, 0, "retention still ran after capi failed");
    assert.equal(row?.source, "CRON");
    assert.equal(row?.path, "capi");
    assert.match(row?.message ?? "", /^capi: .*marketing_events/);
    assert.ok(logged.some((l) => JSON.parse(l).message === "capi_failed"), "still on the console for Workers Observability");
    // The cron still ran (it is alive), so health stays up; the failure shows on the System status page instead.
    assert.equal((await h.api<HealthDto>("GET", "/api/health")).data.cron, "ok");

    // Fixed → the next run is OK again and keeps the time of the last success.
    h.db.exec("ALTER TABLE marketing_events_off RENAME TO marketing_events");
    h.advance(60_000);
    await h.app.scheduled(h.env, h.now.getTime());
    [beat] = beats(h);
    assert.deepEqual([beat?.last_status, beat?.last_error, beat?.runs, beat?.last_ok_at], ["OK", null, 2, h.now.toISOString()]);
    assert.equal(errors(h).length, 1, "nothing new");
  });

  it("error log retention: rows older than 30 days are removed at minute 11", async () => {
    const h = new Harness();
    const old = new Date(h.now.getTime() - 31 * 86_400_000).toISOString();
    const recent = new Date(h.now.getTime() - 29 * 86_400_000).toISOString();
    h.db.run("INSERT INTO error_events (id, occurred_at, source, message) VALUES ('e1', ?, 'API', 'old')", old);
    h.db.run("INSERT INTO error_events (id, occurred_at, source, message) VALUES ('e2', ?, 'API', 'recent')", recent);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:10:00Z"));
    assert.equal(errors(h).length, 2, "only once an hour");
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:11:00Z"));
    assert.deepEqual(errors(h).map((e) => e.message), ["recent"]);
  });
});

describe("server error log", () => {
  const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.error = original;
    }
  };

  it("an unexpected API error is logged with method, path and request id — never the query string or the cause details", async () => {
    const h = new Harness();
    h.db.exec("DROP TABLE gallery_image_translations");
    h.db.exec("DROP TABLE gallery_images");
    const res = await quiet(() => h.api("GET", "/api/public/gallery?lang=th&email=somchai%40example.com&phone=0812345678"));
    assert.equal(res.status, 500);
    assert.equal(res.error?.code, "INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(res.body), /gallery_images|SQLITE/, "the client never sees the cause");
    const [row] = errors(h);
    assert.equal(row?.source, "API");
    assert.equal(row?.method, "GET");
    assert.equal(row?.path, "/api/public/gallery");
    assert.equal(row?.request_id, res.headers.get("X-Request-Id"));
    assert.match(row?.message ?? "", /gallery_image/);
    assert.doesNotMatch(JSON.stringify(row), /somchai|0812345678|email=/);
  });

  it("expected errors (4xx) are not logged", async () => {
    const h = new Harness();
    await h.api("GET", "/api/admin/system");
    await h.api("GET", "/api/public/accommodations/no-such-place");
    await h.api("POST", "/api/public/bookings", { body: { nope: 1 } });
    assert.equal(errors(h).length, 0);
  });

  it("an error storm is capped at 20 rows a minute per isolate", async () => {
    const h = new Harness();
    h.db.exec("DROP TABLE gallery_image_translations");
    h.db.exec("DROP TABLE gallery_images");
    await quiet(async () => {
      for (let i = 0; i < 25; i++) await h.api("GET", "/api/public/gallery");
    });
    assert.equal(errors(h).length, 20);
    h.advance(61_000);
    await quiet(() => h.api("GET", "/api/public/gallery"));
    assert.equal(errors(h).length, 21);
  });

  it("a page that renders without its data (degraded) records a PAGE error and still answers", async () => {
    const h = new Harness({ seed: true });
    h.db.exec("DROP TABLE seo_redirects");
    const res = await quiet(() => h.get("/th"));
    assert.ok(res.status < 500, `page still served (${res.status})`);
    const row = errors(h).find((e) => e.source === "PAGE");
    assert.equal(row?.path, "/th");
    assert.match(row?.message ?? "", /^seo_redirect_failed: .*seo_redirects/);
  });

  it("before migration 0020 (no tables) monitoring never breaks a request or the cron", async () => {
    const h = new Harness();
    h.db.exec("DROP TABLE error_events");
    h.db.exec("DROP TABLE system_heartbeats");
    h.db.exec("DROP TABLE gallery_image_translations");
    h.db.exec("DROP TABLE gallery_images");
    assert.equal((await quiet(() => h.api("GET", "/api/public/gallery"))).status, 500, "the original error, not a monitoring one");
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:11:00Z"));
    const health = await h.api<HealthDto>("GET", "/api/health");
    assert.equal(health.data.schema, "outdated");
    assert.equal(health.data.cron, "unknown");
  });
});

describe("Admin → System status (system.view)", () => {
  async function staff(h: Harness, id: string, roles: string[]) {
    return h.login(await h.user({ id, roles }));
  }

  it("needs a session and the system.view permission (SUPER_ADMIN and MANAGER by default)", async () => {
    const h = new Harness({ seed: true });
    assert.equal((await h.api("GET", "/api/admin/system")).status, 401);
    for (const role of ["VIEWER", "BOOKING_ADMIN", "FINANCE_ADMIN", "CONTENT_ADMIN"]) {
      const token = await staff(h, `u-${role}`, [role]);
      assert.equal((await h.api("GET", "/api/admin/system", { token })).status, 403, role);
    }
    for (const role of ["SUPER_ADMIN", "MANAGER"]) {
      const token = await staff(h, `u-${role}`, [role]);
      const res = await h.api<SystemStatusDto>("GET", "/api/admin/system", { token });
      assert.equal(res.status, 200, role);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
    }
    // Per-user overrides work like every other permission.
    const viewer = await staff(h, "u-granted", ["VIEWER"]);
    h.grant("u-granted", "system.view");
    assert.equal((await h.api("GET", "/api/admin/system", { token: viewer })).status, 200);
    const manager = await staff(h, "u-denied", ["MANAGER"]);
    h.grant("u-denied", "system.view", "DENY");
    assert.equal((await h.api("GET", "/api/admin/system", { token: manager })).status, 403);
  });

  it("lists what is not ready: an unconfigured site in production shows errors, never secret values", async () => {
    const h = new Harness();
    Object.assign(h.env, {
      APP_ENV: "production",
      APP_BASE_URL: "",
      META_TEST_EVENT_CODE: "TEST-SECRET-CODE-1",
      META_CAPI_ACCESS_TOKEN: "EAA-SECRET-TOKEN-VALUE",
      GA4_SERVICE_ACCOUNT_KEY: "{\"private_key\":\"-----BEGIN PRIVATE KEY-----SECRET\"}",
      SLIP_VERIFICATION_API_KEY: "SLIP-SECRET-KEY",
    });
    h.db.exec("UPDATE line_settings SET enabled = 1 WHERE id = 1"); // on, but LINE secrets were never set
    const token = await staff(h, "root", ["SUPER_ADMIN"]);
    const res = await h.api<SystemStatusDto>("GET", "/api/admin/system", { token });
    assert.equal(res.status, 200);
    const level = Object.fromEntries(res.data.checks.map((c) => [c.key, c.level]));
    assert.equal(level.environment, "ok");
    assert.equal(level.baseUrl, "error", "production without APP_BASE_URL");
    assert.equal(level.siteName, "error");
    assert.equal(level.primaryAccount, "error");
    assert.equal(level.line, "error", "LINE on without its secrets");
    assert.equal(level.metaTestCode, "warning", "test event code left on in production");
    assert.equal(level.slipVerification, "warning", "no provider → manual checking");
    assert.equal(level.superAdmins, "warning", "a single super admin");
    assert.equal(level.rateLimits, "warning");
    assert.equal(level.cron, "warning", "never ran");
    assert.equal(res.data.checks.length, 19);
    const json = JSON.stringify(res.data);
    for (const secret of ["SECRET", "EAA-", "PRIVATE KEY"]) assert.ok(!json.includes(secret), `no ${secret} in the response`);
  });

  it("a configured production site is all green except what the owner still has to do", async () => {
    const h = new Harness({ seed: true });
    Object.assign(h.env, {
      APP_ENV: "production",
      APP_BASE_URL: "https://phasakura.com",
      RL_PUBLIC: { limit: async () => ({ success: true }) },
      RL_WRITE: { limit: async () => ({ success: true }) },
      RL_AUTH: { limit: async () => ({ success: true }) },
      RL_ADMIN: { limit: async () => ({ success: true }) },
    });
    await staff(h, "root2", ["SUPER_ADMIN"]);
    const token = await staff(h, "root", ["SUPER_ADMIN"]);
    h.db.exec("UPDATE marketing_settings SET gsc_verification = 'abc123' WHERE id = 1");
    await h.app.scheduled(h.env, h.now.getTime());
    const res = await h.api<SystemStatusDto>("GET", "/api/admin/system", { token });
    const notOk = res.data.checks.filter((c) => c.level !== "ok").map((c) => c.key);
    assert.deepEqual(notOk.filter((k) => k !== "superAdmins" && k !== "bootstrapPassword"), ["slipVerification"], JSON.stringify(res.data.checks));
    assert.equal(res.data.health.status, "ok");
    assert.equal(res.data.baseUrl, "https://phasakura.com");
    assert.deepEqual(res.data.heartbeats.map((b) => [b.name, b.lastStatus, b.runs]), [["cron", "OK", 1]]);
    assert.deepEqual(Object.keys(res.data.backlog).sort(), ["capiFailed24h", "capiPending", "linePending", "lineFailed24h", "slipsWaiting"].sort());
  });

  it("recent errors and delivery failures show as warnings with their count", async () => {
    const h = new Harness({ seed: true });
    h.db.run("INSERT INTO error_events (id, occurred_at, source, method, path, message) VALUES ('e1', ?, 'API', 'GET', '/api/x', 'boom')", h.now.toISOString());
    const token = await staff(h, "root", ["SUPER_ADMIN"]);
    const res = await h.api<SystemStatusDto>("GET", "/api/admin/system", { token });
    const check = res.data.checks.find((c) => c.key === "recentErrors");
    assert.deepEqual([check?.level, check?.value], ["warning", "1"]);
    assert.equal(res.data.errorCount24h, 1);
    assert.deepEqual(res.data.errors.map((e) => [e.source, e.method, e.path, e.message]), [["API", "GET", "/api/x", "boom"]]);
    h.advance(25 * 3_600_000);
    const later = await h.api<SystemStatusDto>("GET", "/api/admin/system", { token: await staff(h, "root3", ["SUPER_ADMIN"]) });
    assert.equal(later.data.checks.find((c) => c.key === "recentErrors")?.level, "ok", "older than 24 h: listed, not counted");
    assert.equal(later.data.errors.length, 1);
  });
});
