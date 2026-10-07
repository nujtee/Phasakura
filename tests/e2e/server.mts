// End-to-end test server (Phase 15): the real Worker app over HTTPS with SQLite (all migrations + dev seed),
// in-memory R2, the built SPA, and in-process fakes for LINE, the Meta Graph API and Google APIs.
// Started by tests/e2e/run.mjs — never deploy this. Env: PORT, DIST, TLS_CERT, TLS_KEY, E2E_NO_CAPI.
import { createServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { createApp } from "../../src/worker/index.ts";
import { SqliteD1 } from "../helpers/sqlite-d1.ts";
import { MemoryBucket } from "../helpers/fake-env.ts";
import { hashPassword } from "../../src/worker/security/password.ts";
import { FakeLine } from "../helpers/fake-line.ts";
import { signLineBody } from "../../src/worker/line/line-api.ts";
import { fakeGoogle, fakeMeta } from "../helpers/fake-http.ts";

const PORT = Number(process.env.PORT ?? 4190);
const DIST = process.env.DIST!;
const db = SqliteD1.migrated({ seed: true });
const roles: Record<string, string> = { admin: "SUPER_ADMIN", content: "CONTENT_ADMIN", viewer: "VIEWER", kitchen: "BOOKING_ADMIN" };
for (const [id, role] of Object.entries(roles)) {
  db.run("INSERT INTO users (id, email, display_name, password_hash, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    id, `${id}@example.test`, `${id[0]!.toUpperCase()}${id.slice(1)} Tester`, await hashPassword("correct horse battery staple", 1000));
  db.run("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?", id, role);
}

// Static headers from public/_headers (CSP etc.) so the browser test sees production-like policies.
const headersFile = readFileSync(join(import.meta.dirname, "..", "..", "public", "_headers"), "utf8");
const globalHeaders: Record<string, string> = {};
let inGlobal = false;
for (const line of headersFile.split("\n")) {
  if (/^\/\*\s*$/.test(line)) { inGlobal = true; continue; }
  if (/^\S/.test(line)) inGlobal = false;
  const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
  if (inGlobal && m) globalHeaders[m[1]!] = m[2]!;
}
delete globalHeaders["Strict-Transport-Security"];
// upgrade-insecure-requests would break plain-http localhost testing only.


const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml" };
const env = {
  DB: db, MEDIA_PUBLIC: new MemoryBucket(), MEDIA_PRIVATE: new MemoryBucket(), APP_ENV: "development",
  APP_BASE_URL: `https://localhost:${PORT}`,
  // Fake LINE channel (the LINE API itself is the in-process FakeLine below).
  LINE_CHANNEL_ACCESS_TOKEN: "e2e-channel-token", LINE_CHANNEL_SECRET: "e2e-channel-secret",
  // Meta Conversions API and GA4 Data API (the APIs themselves are the in-process fakes below).
  // E2E_NO_CAPI=1: no token, like a deployment before the secret is set (Phase 9 e2e checks that case).
  META_CAPI_ACCESS_TOKEN: process.env.E2E_NO_CAPI === "1" ? undefined : "e2e-capi-secret-token", GA4_SERVICE_ACCOUNT_KEY: await serviceAccountKey(),
  ASSETS: {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      let file = join(DIST, url.pathname);
      if (!url.pathname.startsWith("/assets/") || !existsSync(file)) file = join(DIST, "index.html");
      return new Response(readFileSync(file), { headers: { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", ...globalHeaders } });
    },
  },
} as never;
const line = new FakeLine();
const meta = fakeMeta();
const google = fakeGoogle();
const app = createApp({ serviceOptions: { lineFetch: line.fetch, metaFetch: meta.fetch, googleFetch: google.fetch } });

async function serviceAccountKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  return JSON.stringify({ client_email: "e2e@example.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n` });
}

/** Test-only hooks (never part of the app): inspect fake LINE, fire the cron, send a signed webhook. */
async function debugRoute(path: string, method: string, body: Buffer | undefined): Promise<Response | null> {
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } });
  if (path === "/__e2e/line" && method === "GET") return json({ pushes: line.pushes, replies: line.replies });
  if (path === "/__e2e/line/next" && method === "POST") { line.nextPush.push(JSON.parse(String(body)).status); return json({ ok: true }); }
  if (path === "/__e2e/meta" && method === "GET") {
    return json(meta.requests.map((r) => ({ url: r.url, testEventCode: r.json?.test_event_code ?? null, hasToken: r.json?.access_token === "e2e-capi-secret-token", data: r.json?.data })));
  }
  if (path === "/__e2e/google" && method === "GET") return json(google.requests.map((r) => r.url));
  if (path === "/__e2e/cron" && method === "POST") { await app.scheduled(env); return json({ ok: true }); }
  if (path === "/__e2e/webhook" && method === "POST") {
    const raw = String(body);
    const res = await app.fetch(new Request(`https://localhost:${PORT}/api/line/webhook`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": await signLineBody("e2e-channel-secret", raw) }, body: raw,
    }), env);
    return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
  }
  return null;
}

createServer({ key: readFileSync(process.env.TLS_KEY!), cert: readFileSync(process.env.TLS_CERT!) }, async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("CF-Connecting-IP", "127.0.0.1");
  const debug = req.url?.startsWith("/__e2e/") ? await debugRoute(req.url, req.method ?? "GET", body) : null;
  if (debug) { res.writeHead(debug.status, { "Content-Type": "application/json" }); res.end(Buffer.from(await debug.arrayBuffer())); return; }
  const request = new Request(`https://localhost:${PORT}${req.url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  const response = await app.fetch(request, env);
  const out: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => { out[k] = k === "set-cookie" ? response.headers.getSetCookie() : v; });
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`e2e server on https://localhost:${PORT}`));
