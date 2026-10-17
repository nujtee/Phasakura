/**
 * Center Management one-time setup, run from GitHub → Actions → Center setup (.github/workflows/center-setup.yml).
 *
 *   tsx scripts/center-setup.ts keys
 *       New Ed25519 key pair. The PRIVATE key goes straight into the Center Worker's secret CENTER_SIGNING_KEY
 *       (`wrangler secret put`, stdin) and is never printed or written to disk. The PUBLIC key is printed (job summary)
 *       as the JSON to put in wrangler.jsonc → vars.CENTER_PUBLIC_KEYS, then `npm run sites:generate` and Release.
 *
 *   tsx scripts/center-setup.ts first-owner --email you@example.com --name "Your Name"
 *       The first PLATFORM_OWNER, only while Center has no users at all. Prints a one-time link (48 h) to set the
 *       password. Everyone after that is added in Center → ผู้ใช้ Center.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { base64UrlEncode } from "../src/shared/center-protocol.ts";
import { loadRegistry, CENTER_CONFIG_PATH } from "./sites.ts";

const ROOT = join(import.meta.dirname, "..");
const EMAIL = /^[^\s@'"\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;
const NAME = /^[^'"\\<>\u0000-\u001f]{1,100}$/;

export interface GeneratedKeys {
  keyId: string;
  /** CENTER_SIGNING_KEY value: "<keyId>:<pkcs8 base64url>". */
  secret: string;
  /** Goes into every site's CENTER_PUBLIC_KEYS. */
  publicKeys: Record<string, string>;
}

export async function generateKeys(now = new Date()): Promise<GeneratedKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const keyId = `c${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
  return { keyId, secret: `${keyId}:${base64UrlEncode(pkcs8)}`, publicKeys: { [keyId]: base64UrlEncode(raw) } };
}

const sqlText = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** SQL for the first owner + their setup link. Inserts nothing when Center already has a user. */
export function firstOwnerSql(input: { id: string; email: string; name: string; tokenHash: string; now: Date; ttlMs: number }): string {
  if (!EMAIL.test(input.email)) throw new Error("invalid email");
  if (!NAME.test(input.name.trim())) throw new Error("invalid name");
  if (!/^u_[0-9a-f]{16}$/.test(input.id) || !/^[0-9a-f]{64}$/.test(input.tokenHash)) throw new Error("invalid id or token");
  const now = sqlText(input.now.toISOString());
  const expires = sqlText(new Date(input.now.getTime() + input.ttlMs).toISOString());
  return [
    `INSERT INTO center_users (id, email, display_name, role, created_at, updated_at)
       SELECT ${sqlText(input.id)}, ${sqlText(input.email.toLowerCase())}, ${sqlText(input.name.trim())}, 'PLATFORM_OWNER', ${now}, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM center_users);`,
    `INSERT INTO center_setup_tokens (token_hash, user_id, purpose, expires_at, created_by, created_at)
       SELECT ${sqlText(input.tokenHash)}, ${sqlText(input.id)}, 'INVITE', ${expires}, NULL, ${now}
        WHERE EXISTS (SELECT 1 FROM center_users WHERE id = ${sqlText(input.id)});`,
  ].join("\n");
}

function summary(line: string): void {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function wrangler(args: string[], input?: string): string {
  return execFileSync("npx", ["wrangler", ...args, "--config", CENTER_CONFIG_PATH], {
    cwd: ROOT, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
  });
}

async function keys(): Promise<void> {
  const k = await generateKeys();
  wrangler(["secret", "put", "CENTER_SIGNING_KEY"], k.secret);
  summary("## Center signing key");
  summary(`- New key **${k.keyId}** — the private key is now the Center Worker's secret CENTER_SIGNING_KEY (never shown anywhere).`);
  summary("- Public key for every site (wrangler.jsonc → vars.CENTER_PUBLIC_KEYS), then `npm run sites:generate` and Release:");
  summary("```json");
  summary(JSON.stringify(k.publicKeys));
  summary("```");
}

async function firstOwner(email: string, name: string): Promise<void> {
  const registry = loadRegistry(ROOT);
  if (!registry.center) throw new Error("sites/sites.json has no \"center\" entry");
  const db = registry.center.d1.name;
  const count = wrangler(["d1", "execute", db, "--remote", "--json", "--command", "SELECT count(*) AS n FROM center_users"]);
  const n = (JSON.parse(count) as { results: { n: number }[] }[])[0]?.results[0]?.n ?? -1;
  if (n !== 0) throw new Error(n > 0 ? "Center already has users — add people in Center → ผู้ใช้ Center" : "could not read center_users (run Release with sites=center first)");
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const id = `u_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  wrangler(["d1", "execute", db, "--remote", "--command", firstOwnerSql({ id, email, name, tokenHash, now: new Date(), ttlMs: 48 * 3_600_000 })]);
  summary("## First PLATFORM_OWNER");
  summary(`- ${name} <${email}>`);
  summary(`- Set the password (one-time link, valid 48 hours): https://${registry.center.domain}/setup?token=${token}`);
}

async function main(): Promise<void> {
  const [action, ...rest] = process.argv.slice(2);
  if (action === "keys") return keys();
  if (action === "first-owner") {
    const { values } = parseArgs({ args: rest, options: { email: { type: "string" }, name: { type: "string" } } });
    if (!values.email || !EMAIL.test(values.email) || !values.name || !NAME.test(values.name.trim())) throw new Error("usage: first-owner --email <email> --name <name>");
    return firstOwner(values.email, values.name);
  }
  throw new Error("usage: tsx scripts/center-setup.ts keys | first-owner --email <email> --name <name>");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
