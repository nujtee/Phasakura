import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MethodNotAllowedError, NotFoundError } from "../../src/worker/http/errors.ts";
import { Router } from "../../src/worker/router.ts";

const ok = () => new Response("ok");

describe("Router", () => {
  const router = new Router().get("/api/items", ok).post("/api/items", ok).get("/api/items/:id", ok);

  it("matches static routes by method", () => {
    assert.ok(router.match("GET", "/api/items"));
    assert.ok(router.match("POST", "/api/items"));
  });

  it("serves HEAD with the GET handler", () => {
    assert.ok(router.match("HEAD", "/api/items"));
  });

  it("extracts and decodes params", () => {
    assert.deepEqual(router.match("GET", "/api/items/BK-20260110-0001").params, { id: "BK-20260110-0001" });
    assert.deepEqual(router.match("GET", "/api/items/a%20b").params, { id: "a b" });
  });

  it("throws NotFound for unknown paths and malformed encodings", () => {
    assert.throws(() => router.match("GET", "/api/unknown"), NotFoundError);
    assert.throws(() => router.match("GET", "/api/items/%E0%A4%A"), NotFoundError);
    assert.throws(() => router.match("GET", "/api/items/1/extra"), NotFoundError);
  });

  it("throws MethodNotAllowed with the allowed methods", () => {
    assert.throws(
      () => router.match("DELETE", "/api/items"),
      (error: unknown) => error instanceof MethodNotAllowedError && error.allow.join(",") === "GET,POST",
    );
  });
});
