import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCookie, sessionCookie } from "../../src/worker/security/cookies.ts";
import {
  PBKDF2_ITERATIONS,
  hashPassword,
  needsRehash,
  validatePasswordPolicy,
  verifyPassword,
} from "../../src/worker/security/password.ts";
import { base64UrlDecode, base64UrlEncode, randomToken, sha256Hex, timingSafeEqual } from "../../src/worker/security/tokens.ts";
import { redact } from "../../src/worker/repositories/log.repository.ts";

describe("password hashing", () => {
  it("hashes with PBKDF2-SHA256 at the Workers maximum iterations and a random salt", async () => {
    const a = await hashPassword("a long enough passphrase");
    const b = await hashPassword("a long enough passphrase");
    assert.match(a, new RegExp(`^pbkdf2_sha256\\$${PBKDF2_ITERATIONS}\\$[A-Za-z0-9_-]+\\$[A-Za-z0-9_-]{43}$`));
    assert.notEqual(a, b, "salted");
    assert.ok(!a.includes("passphrase"));
  });

  it("verifies correct and rejects wrong passwords", async () => {
    const h = await hashPassword("a long enough passphrase", 1000);
    assert.equal(await verifyPassword("a long enough passphrase", h), true);
    assert.equal(await verifyPassword("a long enough passphrasE", h), false);
    assert.equal(await verifyPassword("", h), false);
  });

  it("normalises Unicode (NFKC) so the same Thai password always matches", async () => {
    const h = await hashPassword("รหัสผ่านภาษาไทยยาวพอ", 1000);
    assert.equal(await verifyPassword("รหัสผ่านภาษาไทยยาวพอ".normalize("NFD"), h), true);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    for (const bad of ["", "plain", "md5$1$a$b", "pbkdf2_sha256$999999999$AAAA$BBBB", "pbkdf2_sha256$1000$!!$??"]) {
      assert.equal(await verifyPassword("x", bad), false, bad);
    }
  });

  it("flags weaker hashes for rehash", async () => {
    assert.equal(needsRehash(await hashPassword("a long enough passphrase", 1000)), true);
    assert.equal(needsRehash(await hashPassword("a long enough passphrase")), false);
  });
});

describe("password policy (length-first)", () => {
  it("accepts long passphrases, rejects short/common/simple/identifier-based ones", () => {
    assert.equal(validatePasswordPolicy("correct horse battery staple"), null);
    assert.equal(validatePasswordPolicy("short"), "TOO_SHORT");
    assert.equal(validatePasswordPolicy("x".repeat(129)), "TOO_LONG");
    assert.equal(validatePasswordPolicy("password1234"), "TOO_COMMON");
    assert.equal(validatePasswordPolicy("aaaaaaaaaaaaaaaa"), "TOO_SIMPLE");
    assert.equal(validatePasswordPolicy("somchai-is-great-2027", ["somchai@example.com"]), "CONTAINS_IDENTIFIER");
  });
});

describe("tokens", () => {
  it("generates 256-bit url-safe tokens", () => {
    const t = randomToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(t, randomToken());
  });

  it("round-trips base64url and rejects invalid input", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    assert.deepEqual(base64UrlDecode(base64UrlEncode(bytes)), bytes);
    assert.throws(() => base64UrlDecode("a+b/"));
  });

  it("sha256Hex and constant-time compare", async () => {
    assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
    assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
    assert.equal(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
  });
});

describe("session cookie", () => {
  it("uses __Host- prefix with HttpOnly, Secure, SameSite=Strict, Path=/ and no Domain", () => {
    const c = sessionCookie("t".repeat(43));
    assert.match(c, /^__Host-sid=t{43}; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    assert.doesNotMatch(c, /Domain/i);
    assert.match(sessionCookie("t".repeat(43), 3600), /Max-Age=3600$/);
  });

  it("only accepts well-formed cookie values", () => {
    const req = (cookie: string) => new Request("https://x.test", { headers: { Cookie: cookie } });
    assert.equal(readCookie(req(`a=1; __Host-sid=${"x".repeat(43)}`), "__Host-sid"), "x".repeat(43));
    assert.equal(readCookie(req("__Host-sid=short"), "__Host-sid"), null);
    assert.equal(readCookie(req("__Host-sid=abc';DROP TABLE users;--xxxxxxxxxxxxxx"), "__Host-sid"), null);
  });
});

describe("log redaction", () => {
  it("never writes passwords, tokens or secrets to audit/security logs", () => {
    assert.deepEqual(
      redact({ email: "a@b.c", password: "p", newPassword: "p", nested: { token_hash: "h", apiKey: "k", ok: 1 }, list: [{ secret: "s" }] }),
      { email: "a@b.c", password: "[REDACTED]", newPassword: "[REDACTED]", nested: { token_hash: "[REDACTED]", apiKey: "[REDACTED]", ok: 1 }, list: [{ secret: "[REDACTED]" }] },
    );
  });
});
