import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSafeObjectKey, publicMediaUrl } from "../../src/worker/services/media-url.ts";

describe("publicMediaUrl", () => {
  it("uses same-origin /media/ when no media domain is configured", () => {
    assert.equal(publicMediaUrl("branding/logo.webp"), "/media/branding/logo.webp");
  });

  it("uses the configured https media domain", () => {
    assert.equal(
      publicMediaUrl("branding/logo.webp", "https://media.example.com/"),
      "https://media.example.com/branding/logo.webp",
    );
  });

  it("ignores insecure or invalid base URLs", () => {
    assert.equal(publicMediaUrl("a.webp", "http://media.example.com"), "/media/a.webp");
    assert.equal(publicMediaUrl("a.webp", "javascript:alert(1)"), "/media/a.webp");
    assert.equal(publicMediaUrl("a.webp", "not a url"), "/media/a.webp");
    assert.equal(publicMediaUrl("a.webp", "http://localhost:8787"), "http://localhost:8787/a.webp");
  });

  it("rejects unsafe object keys (path traversal, schemes, empty)", () => {
    for (const key of ["../secret", "a/../b", "/abs", "a//b", "https://evil.com/x", "a b", "", "slips/x?y"]) {
      assert.equal(isSafeObjectKey(key), false, key);
      assert.equal(publicMediaUrl(key), null, key);
    }
    assert.equal(publicMediaUrl(null), null);
  });
});
