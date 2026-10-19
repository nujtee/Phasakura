/**
 * A new booking site on the platform (Center phase C7). Run from GitHub → Actions → Create site, or locally:
 *
 *   npm run site:create -- --slug suanpho --name "Suan Pho" --domain suanpho.com [--dry-run]
 *
 * Steps (each is safe to run again — anything that already exists is reused):
 *   1. checks the input against sites/sites.json (slug, domain and Center's domain must be free)
 *   2. checks that the domain's zone is in the platform's Cloudflare account and Active
 *   3. creates D1 <slug>-db (apac) and R2 <slug>-media-public / <slug>-media-private
 *   4. adds the site to sites/sites.json (next free rate-limit base, wave 1) and regenerates the configs
 * Nothing is deployed and no account is created: after the registry change is merged, Release "<slug> center"
 * puts the site (and Center's new binding) live, then the owner's account is created in Center (site page).
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the same as Release). Never touches guest data.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CENTER_SLUG, checkAll, generate, loadRegistry, REGISTRY_PATH, validateRegistry, type Registry, type Site } from "./sites.ts";

const ROOT = join(import.meta.dirname, "..");
export const PLACEHOLDER_D1_ID = "00000000-0000-4000-8000-000000000000";

export interface NewSiteInput {
  slug: string;
  name: string;
  domain: string;
}

/** The input as the registry stores it (trimmed, lower-case domain without scheme / www / path). */
export function normalizeInput(input: NewSiteInput): NewSiteInput {
  const domain = input.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return { slug: input.slug.trim().toLowerCase(), name: input.name.trim().replace(/\s+/g, " "), domain };
}

/** Lowest multiple of 1000 that no site and no reservation uses. */
export function nextRateLimitBase(registry: Registry): number {
  const used = new Set([...registry.sites.map((s) => s.rateLimitBase), ...(registry.reservedRateLimitBases ?? []).map((r) => r.base)]);
  let base = 1000;
  while (used.has(base)) base += 1000;
  return base;
}

/**
 * The registry entry for the new site, or the problems with the input. `d1Id` is the real database id once it
 * exists (a placeholder while checking the input before anything is created).
 */
export function planSite(registry: Registry, raw: NewSiteInput, d1Id = PLACEHOLDER_D1_ID): { site?: Site; problems: string[] } {
  const input = normalizeInput(raw);
  const problems: string[] = [];
  if (input.slug === CENTER_SLUG) problems.push(`slug "${CENTER_SLUG}" is reserved for the Center console`);
  if (input.slug === "new") problems.push('slug "new" is reserved (Center → เพิ่มเว็บใหม่)');
  if (registry.sites.some((s) => s.slug === input.slug)) problems.push(`slug "${input.slug}" is already a site`);
  if (registry.sites.some((s) => s.domain === input.domain)) problems.push(`domain "${input.domain}" is already a site`);
  if (registry.center && input.domain === registry.center.domain) problems.push("that is Center's domain");
  if (input.name.length > 60) problems.push("name is longer than 60 characters");
  const site: Site = {
    slug: input.slug, name: input.name, domain: input.domain,
    d1: { name: `${input.slug}-db`, id: d1Id }, rateLimitBase: nextRateLimitBase(registry), wave: 1,
  };
  problems.push(...validateRegistry({ ...registry, sites: [...registry.sites, site] }));
  return problems.length ? { problems: [...new Set(problems)] } : { site, problems };
}

/** sites/sites.json with the site appended, keeping the file's hand-written layout. */
export function registryWithSite(text: string, site: Site): string {
  const entry = [
    "    {",
    `      "slug": ${JSON.stringify(site.slug)},`,
    `      "name": ${JSON.stringify(site.name)},`,
    `      "domain": ${JSON.stringify(site.domain)},`,
    `      "d1": { "name": ${JSON.stringify(site.d1.name)}, "id": ${JSON.stringify(site.d1.id)} },`,
    `      "rateLimitBase": ${site.rateLimitBase},`,
    `      "wave": ${site.wave}`,
    "    }",
  ].join("\n");
  const end = text.match(/\n(\s*)\}\n\s*\]\s*\}\s*$/);
  const next = end
    ? `${text.slice(0, end.index! + 1)}${end[1]}},\n${entry}\n  ]\n}\n`
    : `${JSON.stringify({ ...(JSON.parse(text) as Registry), sites: [...(JSON.parse(text) as Registry).sites, site] }, null, 2)}\n`;
  const parsed = JSON.parse(next) as Registry;
  if (parsed.sites.at(-1)?.slug !== site.slug) throw new Error("could not add the site to the registry");
  return next;
}

/** The D1 id from `wrangler d1 list --json`, or null. */
export function d1IdFromList(json: string, name: string): string | null {
  const list = JSON.parse(json) as { name?: string; uuid?: string; database_id?: string }[];
  const db = Array.isArray(list) ? list.find((d) => d.name === name) : undefined;
  return db?.uuid ?? db?.database_id ?? null;
}

export interface ZoneCheck { ok: boolean; warning?: boolean; message: string }

/** Is the domain's zone in the platform's account and Active? (A token without Zone › Read only warns.) */
export async function checkZone(domain: string, env: { token?: string; accountId?: string }, fetchFn: typeof fetch = fetch): Promise<ZoneCheck> {
  if (!env.token || !env.accountId) return { ok: false, message: "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set" };
  const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}&account.id=${encodeURIComponent(env.accountId)}`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Authorization: `Bearer ${env.token}` } });
  } catch (error) {
    return { ok: false, message: `could not reach the Cloudflare API: ${String(error).slice(0, 200)}` };
  }
  if (res.status === 403 || res.status === 401) {
    return { ok: true, warning: true, message: "the API token cannot read zones — skipped the zone check (deploy fails if the zone is missing)" };
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { name: string; status: string }[] };
  if (!res.ok || !body.success) return { ok: false, message: `Cloudflare API answered HTTP ${res.status}` };
  const zone = body.result?.find((z) => z.name === domain);
  if (!zone) return { ok: false, message: `zone ${domain} is not in the platform's Cloudflare account — the owner must add the domain there first (Cloudflare → Add a domain, then change the nameservers at the registrar)` };
  if (zone.status !== "active") return { ok: false, message: `zone ${domain} is "${zone.status}", not active yet — wait until the nameserver change has gone through, then run again` };
  return { ok: true, message: `zone ${domain} is active in the platform's account` };
}

// ---------------------------------------------------------------- CLI

function summary(line: string): void {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function wrangler(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function errorText(error: unknown): string {
  const e = error as { stdout?: string; stderr?: string; message?: string };
  return `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
}

function ensureD1(name: string): { id: string; created: boolean } {
  const existing = d1IdFromList(wrangler(["d1", "list", "--json"]), name);
  if (existing) return { id: existing, created: false };
  wrangler(["d1", "create", name, "--location=apac"]);
  const id = d1IdFromList(wrangler(["d1", "list", "--json"]), name);
  if (!id) throw new Error(`D1 ${name} was created but is not listed`);
  return { id, created: true };
}

function ensureBucket(name: string): boolean {
  try {
    wrangler(["r2", "bucket", "create", name]);
    return true;
  } catch (error) {
    if (/already exists|10004/i.test(errorText(error))) return false;
    throw error;
  }
}

function fail(problems: string[]): never {
  for (const p of problems) summary(`- ✗ ${p}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { slug: { type: "string" }, name: { type: "string" }, domain: { type: "string" }, "dry-run": { type: "boolean" } } });
  const input = { slug: values.slug ?? "", name: values.name ?? "", domain: values.domain ?? "" };
  summary(`## Create site: ${normalizeInput(input).name || "?"} (${normalizeInput(input).domain || "?"})`);
  const registry = loadRegistry();
  const before = checkAll();
  if (before.length) fail(before);
  const check = planSite(registry, input);
  if (!check.site) fail(check.problems);
  const planned = check.site;
  summary(`- slug \`${planned.slug}\`, Worker \`${planned.slug}\`, D1 \`${planned.d1.name}\`, R2 \`${planned.slug}-media-public\` / \`${planned.slug}-media-private\`, rate-limit ids ${planned.rateLimitBase + 1}–${planned.rateLimitBase + 4}, wave 1`);

  const zone = await checkZone(planned.domain, { token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
  summary(`- ${zone.ok ? (zone.warning ? "⚠️" : "✓") : "✗"} ${zone.message}`);
  if (!zone.ok) process.exit(1);
  if (values["dry-run"]) {
    summary("- dry run: nothing created");
    return;
  }

  const d1 = ensureD1(planned.d1.name);
  summary(`- ✓ D1 ${planned.d1.name} ${d1.created ? "created" : "already existed — reused"} (${d1.id})`);
  for (const bucket of [`${planned.slug}-media-public`, `${planned.slug}-media-private`]) {
    summary(`- ✓ R2 ${bucket} ${ensureBucket(bucket) ? "created" : "already existed — reused"}`);
  }

  const final = planSite(registry, input, d1.id);
  if (!final.site) fail(final.problems);
  const path = join(ROOT, REGISTRY_PATH);
  writeFileSync(path, registryWithSite(readFileSync(path, "utf8"), final.site));
  generate();
  const after = checkAll();
  if (after.length) fail(after);
  summary(`- ✓ added to ${REGISTRY_PATH}; configs regenerated (sites/${final.site.slug}/wrangler.jsonc, center/wrangler.jsonc)`);
  summary("");
  summary("### Next");
  summary("1. Merge the pull request with the registry change");
  summary(`2. Actions → Release → sites \`${final.site.slug} center\``);
  summary(`3. Center → ${final.site.name} → create the owner's account and send them the link`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `slug=${final.site.slug}\nname=${final.site.name.replace(/\n/g, " ")}\ndomain=${final.site.domain}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((error) => { console.error(String(error)); process.exit(1); });
}
