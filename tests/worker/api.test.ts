import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiErrorBody, ApiSuccess, HealthDto, PublicSiteDto } from "../../src/shared/api-types.ts";
import { createServices } from "../../src/worker/container.ts";
import { createApp } from "../../src/worker/index.ts";
import { FakeD1, makeEnv, missingTables, seededSite } from "../helpers/fake-env.ts";

const app = createApp({ requestId: () => "req-test" });

function get(path: string, init: RequestInit = {}) {
  return new Request(`https://example.test${path}`, init);
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const configured = seededSite({
  defaultLanguage: "th",
  translations: [
    { language_code: "th", site_name: "ชื่อทดสอบ", tagline: "คำโปรย" },
    { language_code: "en", site_name: "Test Name", tagline: "  " },
  ],
  branding: {
    logo_main_key: "branding/logo-main.webp",
    logo_main_width: 240,
    logo_main_height: 80,
    logo_mobile_key: null,
    logo_mobile_width: null,
    logo_mobile_height: null,
  },
});

describe("API security headers", () => {
  it("adds security headers, request id and no-store by default", async () => {
    const res = await app.fetch(get("/api/health"), makeEnv(configured));
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/);
    assert.match(res.headers.get("Strict-Transport-Security") ?? "", /max-age=/);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("X-Request-Id"), "req-test");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null, "no CORS by default");
  });
});

describe("GET /api/health", () => {
  it("returns ok when D1 responds", async () => {
    const res = await app.fetch(get("/api/health"), makeEnv(configured));
    assert.equal(res.status, 200);
    const { data } = await body<ApiSuccess<HealthDto>>(res);
    assert.equal(data.status, "ok");
    assert.equal(data.database, "ok");
    assert.equal(Object.keys(data).sort().join(","), "database,status,time", "exposes no config");
  });

  it("returns 503 degraded when D1 fails", async () => {
    const broken = new FakeD1(() => {
      throw new Error("D1 unavailable");
    });
    const res = await app.fetch(get("/api/health"), makeEnv(broken));
    assert.equal(res.status, 503);
    const { data } = await body<ApiSuccess<HealthDto>>(res);
    assert.equal(data.database, "unavailable");
  });
});

describe("GET /api/public/site", () => {
  it("returns site name, tagline and logo from D1/R2 in the default language", async () => {
    const res = await app.fetch(get("/api/public/site"), makeEnv(configured));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control") ?? "", /public/);
    const { data } = await body<ApiSuccess<PublicSiteDto>>(res);
    assert.equal(data.configured, true);
    assert.equal(data.language, "th");
    assert.equal(data.siteName, "ชื่อทดสอบ");
    assert.equal(data.tagline, "คำโปรย");
    assert.deepEqual(data.logo.main, {
      url: "/media/branding/logo-main.webp",
      alt: "ชื่อทดสอบ",
      width: 240,
      height: 80,
    });
    assert.equal(data.logo.mobile, null);
    assert.deepEqual(data.languages, ["th", "en", "zh-CN"]);
  });

  it("returns the requested language and treats blank values as missing", async () => {
    const res = await app.fetch(get("/api/public/site?lang=en"), makeEnv(configured));
    const { data } = await body<ApiSuccess<PublicSiteDto>>(res);
    assert.equal(data.language, "en");
    assert.equal(data.siteName, "Test Name");
    assert.equal(data.tagline, null);
  });

  it("falls back to the default language when a translation is missing", async () => {
    const res = await app.fetch(get("/api/public/site?lang=zh-cn"), makeEnv(configured));
    const { data } = await body<ApiSuccess<PublicSiteDto>>(res);
    assert.equal(data.language, "zh-CN");
    assert.equal(data.siteName, "ชื่อทดสอบ");
  });

  it("uses the configured media domain for logo URLs", async () => {
    const env = makeEnv(configured, { PUBLIC_MEDIA_BASE_URL: "https://media.example.com" });
    const res = await app.fetch(get("/api/public/site"), env);
    const { data } = await body<ApiSuccess<PublicSiteDto>>(res);
    assert.equal(data.logo.main?.url, "https://media.example.com/branding/logo-main.webp");
  });

  it("drops unsafe stored logo keys instead of emitting them", async () => {
    const db = seededSite({
      translations: [],
      branding: { logo_main_key: "../../private/slip.jpg", logo_mobile_key: "javascript:alert(1)" },
    });
    const res = await app.fetch(get("/api/public/site"), makeEnv(db));
    const { data } = await body<ApiSuccess<PublicSiteDto>>(res);
    assert.equal(data.logo.main, null);
    assert.equal(data.logo.mobile, null);
  });

  it("reports configured=false (no hard-coded name/logo) before migrations exist", async () => {
    const res = await app.fetch(get("/api/public/site?lang=th"), makeEnv(missingTables()));
    assert.equal(res.status, 200);
    const { data } = await body<ApiSuccess<PublicSiteDto>>(res);
    assert.equal(data.configured, false);
    assert.equal(data.siteName, null);
    assert.equal(data.logo.main, null);
  });

  it("rejects unsupported languages with 400", async () => {
    const res = await app.fetch(get("/api/public/site?lang=fr"), makeEnv(configured));
    assert.equal(res.status, 400);
    const { error } = await body<ApiErrorBody>(res);
    assert.equal(error.code, "UNSUPPORTED_LANGUAGE");
    assert.equal(error.requestId, "req-test");
  });

  it("uses only static SQL (no user input reaches D1)", async () => {
    const db = seededSite({ translations: [] });
    await app.fetch(get("/api/public/site?lang=en%27%3B%20DROP%20TABLE%20users"), makeEnv(db));
    assert.equal(db.executed.length, 0, "invalid lang rejected before any query");
    await app.fetch(get("/api/public/site?lang=en"), makeEnv(db));
    for (const { sql, params } of db.executed) {
      assert.doesNotMatch(sql, /DROP|'en'/i);
      assert.equal(params.length, 0);
    }
  });
});

describe("routing and errors", () => {
  it("returns JSON 404 for unknown API routes", async () => {
    const res = await app.fetch(get("/api/nope"), makeEnv(configured));
    assert.equal(res.status, 404);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
    const { error } = await body<ApiErrorBody>(res);
    assert.equal(error.code, "NOT_FOUND");
  });

  it("returns 405 with Allow header", async () => {
    const res = await app.fetch(
      get("/api/public/site", {
        method: "POST",
        headers: { Origin: "https://example.test", "X-Requested-With": "phasakura" },
      }),
      makeEnv(configured),
    );
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "GET, HEAD");
  });

  it("blocks state-changing API requests without same-origin proof (CSRF)", async () => {
    const res = await app.fetch(get("/api/public/site", { method: "POST" }), makeEnv(configured));
    assert.equal(res.status, 403);
  });

  it("supports HEAD without a body", async () => {
    const res = await app.fetch(get("/api/health", { method: "HEAD" }), makeEnv(configured));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  it("hides internal error details from clients", async () => {
    const exploding = createApp({
      requestId: () => "req-500",
      services: (env, options) => {
        const s = createServices(env, options);
        s.site.getPublicSite = async () => {
          throw new Error("secret stack detail: DB password=hunter2");
        };
        return s;
      },
    });
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (msg: string) => logged.push(msg);
    try {
      const res = await exploding.fetch(get("/api/public/site"), makeEnv(configured));
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.doesNotMatch(text, /hunter2|stack/);
      assert.equal((JSON.parse(text) as ApiErrorBody).error.code, "INTERNAL_ERROR");
      assert.match(logged[0] ?? "", /req-500/);
    } finally {
      console.error = originalError;
    }
  });

  it("serves the app shell for pages, even when page metadata cannot be loaded", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const res = await app.fetch(get("/th/gallery"), makeEnv(configured));
      assert.equal(res.status, 200);
      assert.match(await res.text(), /asset/);
    } finally {
      console.error = original;
    }
  });

  it("does not treat /apiary as an API route (it is an unknown page)", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const res = await app.fetch(get("/apiary"), makeEnv(configured));
      assert.equal(res.status, 404);
      assert.match(res.headers.get("Content-Type") ?? "", /text\/html/);
      // The app shell (from ASSETS) rendered as a not-found page, not an API error.
      const body = await res.text();
      assert.match(body, /<!doctype html>/i);
      assert.doesNotMatch(body, /"error"/);
    } finally {
      console.error = original;
    }
  });
});
