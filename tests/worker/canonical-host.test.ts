import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Harness, ORIGIN } from "../helpers/harness.ts";

/** Phase 16 — one public address: other hosts that reach the Worker are redirected to APP_BASE_URL. */
describe("canonical host (production)", () => {
  const site = (env: Record<string, unknown>) => {
    const h = new Harness({ seed: true });
    Object.assign(h.env, { APP_ENV: "production", APP_BASE_URL: "https://www.phasakura.com", ...env });
    const get = (url: string, method = "GET") => h.app.fetch(new Request(url, { method }), h.env);
    return { h, get };
  };

  it("pages, files and media on another host → 301 to the same path and query on APP_BASE_URL", async () => {
    const { get } = site({});
    const cases: [string, string][] = [
      ["https://phasakura.com/th/?utm_source=line", "https://www.phasakura.com/th/?utm_source=line"],
      ["https://phasakura.example.workers.dev/en/gallery", "https://www.phasakura.com/en/gallery"],
      ["https://phasakura.com/robots.txt", "https://www.phasakura.com/robots.txt"],
      ["https://phasakura.com/media/a.webp", "https://www.phasakura.com/media/a.webp"],
      ["https://phasakura.com/", "https://www.phasakura.com/"],
      ["https://phasakura.com//evil.example/x", "https://www.phasakura.com//evil.example/x"],
    ];
    for (const [from, to] of cases) {
      const res = await get(from);
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.get("Location"), to);
    }
    assert.equal((await get("https://phasakura.com/th/", "HEAD")).status, 301);
  });

  it("the canonical host itself, API calls, other methods and non-production are served normally", async () => {
    const { get } = site({});
    assert.equal((await get("https://www.phasakura.com/th/")).status, 200);
    assert.equal((await get("https://phasakura.com/api/health")).status, 200, "API never redirected");
    assert.equal((await get("https://phasakura.com/th/", "POST")).status, 405, "a POST is not redirected");
    assert.equal((await site({ APP_ENV: "development" }).get("https://phasakura.com/th/")).status, 200);
    assert.equal((await site({ APP_BASE_URL: "" }).get(`${ORIGIN}/th/`)).status, 200, "no APP_BASE_URL: nothing to redirect to");
    assert.equal((await site({ APP_BASE_URL: "not a url" }).get(`${ORIGIN}/th/`)).status, 200);
    assert.equal((await site({ APP_BASE_URL: "http://www.phasakura.com" }).get(`${ORIGIN}/th/`)).status, 200, "never to http");
  });
});
