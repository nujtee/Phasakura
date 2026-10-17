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
