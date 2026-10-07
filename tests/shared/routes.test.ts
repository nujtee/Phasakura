import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getLocale } from "../../src/shared/i18n/index.ts";
import { alternatePaths, pagePath, resolveRoute } from "../../src/shared/routes.ts";

describe("pagePath", () => {
  it("builds the spec routes for every language", () => {
    const expected = [
      "/th/", "/th/gallery", "/th/booking", "/th/history",
      "/en/", "/en/gallery", "/en/booking", "/en/history",
      "/zh-cn/", "/zh-cn/gallery", "/zh-cn/booking", "/zh-cn/history",
    ];
    const actual = (["th", "en", "zh-CN"] as const).flatMap((code) =>
      (["home", "gallery", "booking", "history"] as const).map((page) => pagePath(getLocale(code), page)),
    );
    assert.deepEqual(actual, expected);
  });

  it("lists alternates for hreflang / language switcher", () => {
    assert.deepEqual(
      alternatePaths("gallery").map((a) => a.path),
      ["/th/gallery", "/en/gallery", "/zh-cn/gallery"],
    );
  });
});

describe("resolveRoute", () => {
  it("redirects / to the default language home", () => {
    assert.deepEqual(resolveRoute("/"), { kind: "redirect", to: "/th/" });
  });

  it("canonicalises locale home to a trailing slash", () => {
    assert.deepEqual(resolveRoute("/en"), { kind: "redirect", to: "/en/" });
  });

  it("canonicalises uppercase locale segments", () => {
    assert.deepEqual(resolveRoute("/ZH-CN/gallery"), { kind: "redirect", to: "/zh-cn/gallery" });
  });

  it("removes a trailing slash from pages", () => {
    assert.deepEqual(resolveRoute("/th/booking/"), { kind: "redirect", to: "/th/booking" });
  });

  it("resolves pages", () => {
    const r = resolveRoute("/zh-cn/history");
    assert.equal(r.kind, "page");
    if (r.kind === "page") {
      assert.equal(r.page, "history");
      assert.equal(r.locale.code, "zh-CN");
    }
    const home = resolveRoute("/th/");
    assert.equal(home.kind === "page" && home.page, "home");
  });

  it("returns notFound in the requested locale for unknown pages", () => {
    const r = resolveRoute("/en/does-not-exist");
    assert.equal(r.kind, "notFound");
    assert.equal(r.kind === "notFound" && r.locale.code, "en");
  });

  it("returns notFound in the default locale for unknown languages", () => {
    const r = resolveRoute("/fr/gallery");
    assert.equal(r.kind, "notFound");
    assert.equal(r.kind === "notFound" && r.locale.code, "th");
  });

  it("does not treat nested or traversal paths as pages", () => {
    assert.equal(resolveRoute("/th/gallery/extra").kind, "notFound");
    assert.equal(resolveRoute("/th/../admin").kind, "notFound");
  });
});

describe("admin routes", () => {
  it("redirects /admin/* to the default language", () => {
    assert.deepEqual(resolveRoute("/admin"), { kind: "redirect", to: "/th/admin" });
    assert.deepEqual(resolveRoute("/admin/users"), { kind: "redirect", to: "/th/admin/users" });
  });

  it("resolves /{lang}/admin/* with safe segments only", () => {
    const r = resolveRoute("/zh-cn/admin/users/abc-123");
    assert.equal(r.kind, "admin");
    if (r.kind === "admin") {
      assert.equal(r.locale.code, "zh-CN");
      assert.deepEqual(r.segments, ["users", "abc-123"]);
    }
    assert.deepEqual(resolveRoute("/th/admin").kind, "admin");
    assert.equal(resolveRoute("/th/admin/users/<script>").kind, "notFound");
    assert.equal(resolveRoute("/th/admin/a/b/c/d/e").kind, "notFound");
  });
});

describe("accommodation detail routes", () => {
  it("resolves /{lang}/accommodation/{slug} and rejects bad slugs", () => {
    const r = resolveRoute("/en/accommodation/house-sakura");
    assert.equal(r.kind === "page" && r.page, "accommodation");
    assert.equal(r.kind === "page" && r.slug, "house-sakura");
    assert.deepEqual(resolveRoute("/th/accommodation/house-sakura/"), { kind: "redirect", to: "/th/accommodation/house-sakura" });
    assert.equal(resolveRoute("/th/accommodation/Bad_Slug").kind, "notFound");
    assert.equal(resolveRoute("/th/accommodation").kind, "notFound");
  });
});
