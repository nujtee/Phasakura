/**
 * Every booking site runs this one codebase (Center phase C0). sites/sites.json lists them; Phasakura's
 * wrangler.jsonc (repository root) is the template, and every other site gets a GENERATED config at
 * sites/<slug>/wrangler.jsonc that differs only in what is that site's own: name, domain, D1, R2 buckets,
 * rate-limit namespace ids. Shared settings (crons, assets, observability, compatibility date…) are edited
 * once, in wrangler.jsonc, then `npm run sites:generate`.
 *
 *   npm run sites:generate                  # rewrite sites/<slug>/wrangler.jsonc from the template
 *   npm run sites:check                     # registry valid + generated configs up to date (CI)
 *   npm run site -- <slug> preflight        # npm run preflight for that site's config
 *   npm run site -- <slug> migrations       # list remote migrations (applied / pending)
 *   npm run site -- <slug> backup           # Time Travel bookmark + export of that site's D1
 *   npm run site -- <slug> migrate          # backup, then apply pending migrations to that site's D1
 *   npm run site -- <slug> deploy           # preflight + build + wrangler deploy for that site
 *   npm run site -- <slug> smoke            # smoke test https://<domain>
 *   npm run site -- all <command>           # every site, in release-wave order; stops at the first failure
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "./preflight.ts";

const ROOT = join(import.meta.dirname, "..");
export const REGISTRY_PATH = "sites/sites.json";
export const TEMPLATE_PATH = "wrangler.jsonc";

export interface Site {
  slug: string;
  name: string;
  domain: string;
  d1: { name: string; id: string };
  rateLimitBase: number;
  wave: number;
}
export interface Registry {
  template: string;
  reservedRateLimitBases?: { base: number; note?: string }[];
  sites: Site[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a site's Worker config lives: the template site uses the root wrangler.jsonc. */
export function configPath(registry: Registry, slug: string): string {
  return slug === registry.template ? TEMPLATE_PATH : `sites/${slug}/wrangler.jsonc`;
}

/** Problems with the registry itself (empty = valid). */
export function validateRegistry(registry: Registry): string[] {
  const out: string[] = [];
  const seen = (key: (s: Site) => string, what: string) => {
    const values = registry.sites.map(key);
    for (const v of new Set(values)) if (values.filter((x) => x === v).length > 1) out.push(`${what} "${v}" is used by more than one site`);
  };
  if (!registry.sites.length) out.push("no sites");
  for (const s of registry.sites) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(s.slug)) out.push(`${s.slug}: slug must be lowercase letters, digits and - (2–31 chars)`);
    if (!s.name?.trim()) out.push(`${s.slug}: name is empty`);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s.domain) || s.domain.startsWith("www.")) out.push(`${s.slug}: domain "${s.domain}" must be the apex (no https://, no www.)`);
    if (s.d1?.name !== `${s.slug}-db`) out.push(`${s.slug}: D1 name must be "${s.slug}-db"`);
    if (!UUID.test(s.d1?.id ?? "")) out.push(`${s.slug}: D1 id is not a UUID — create it with \`wrangler d1 create ${s.slug}-db --location=apac\``);
    if (!Number.isInteger(s.rateLimitBase) || s.rateLimitBase < 1000 || s.rateLimitBase % 1000 !== 0) out.push(`${s.slug}: rateLimitBase must be a multiple of 1000 (ids are base + 1…4)`);
    if (!Number.isInteger(s.wave) || s.wave < 1) out.push(`${s.slug}: wave must be 1 or more`);
  }
  seen((s) => s.slug, "slug");
  seen((s) => s.domain, "domain");
  seen((s) => s.d1?.id, "D1 id");
  const bases = [...registry.sites.map((s) => s.rateLimitBase), ...(registry.reservedRateLimitBases ?? []).map((r) => r.base)];
  for (const b of new Set(bases)) if (bases.filter((x) => x === b).length > 1) out.push(`rateLimitBase ${b} is used twice (namespace ids must be unique in the account)`);
  if (!registry.sites.some((s) => s.slug === registry.template)) out.push(`template "${registry.template}" is not one of the sites`);
  return out;
}

/** The template config must describe the template site exactly (domain, D1, buckets, rate limits). */
export function checkTemplate(registry: Registry, templateText: string): string[] {
  const site = registry.sites.find((s) => s.slug === registry.template);
  if (!site) return [];
  const want = siteConfig(parseJsonc(templateText) as Obj, site, "");
  const have = parseJsonc(templateText) as Obj;
  return JSON.stringify(normalizeForCompare(have)) === JSON.stringify(normalizeForCompare(want))
    ? []
    : [`${TEMPLATE_PATH} does not match the "${site.slug}" entry in ${REGISTRY_PATH} (name, domain, D1, buckets or rate-limit ids)`];
}

function normalizeForCompare(cfg: Obj): Obj {
  const copy = structuredClone(cfg);
  delete copy.$comment;
  return copy;
}

/**
 * The template with one site's own values. `prefix` turns the template's repository-relative paths into
 * paths relative to the generated file ("../../" for sites/<slug>/wrangler.jsonc).
 */
export function siteConfig(template: Obj, site: Site, prefix: string): Obj {
  const cfg = structuredClone(template);
  cfg.name = site.slug;
  if (typeof cfg.$schema === "string") cfg.$schema = prefix + cfg.$schema;
  if (typeof cfg.main === "string") cfg.main = prefix + cfg.main;
  if (prefix && isObj(cfg.assets) && typeof cfg.assets.directory === "string") cfg.assets.directory = prefix + cfg.assets.directory.replace(/^\.\//, "");
  cfg.routes = [
    { pattern: site.domain, custom_domain: true },
    { pattern: `www.${site.domain}`, custom_domain: true },
  ];
  if (isObj(cfg.vars)) cfg.vars.APP_BASE_URL = `https://${site.domain}`;
  if (Array.isArray(cfg.d1_databases)) {
    cfg.d1_databases = (cfg.d1_databases as Obj[]).map((d) =>
      d.binding === "DB" ? { ...d, database_name: site.d1.name, database_id: site.d1.id, migrations_dir: prefix + String(d.migrations_dir) } : d,
    );
  }
  if (Array.isArray(cfg.r2_buckets)) {
    cfg.r2_buckets = (cfg.r2_buckets as Obj[]).map((b) =>
      b.binding === "MEDIA_PUBLIC" ? { ...b, bucket_name: `${site.slug}-media-public` }
        : b.binding === "MEDIA_PRIVATE" ? { ...b, bucket_name: `${site.slug}-media-private` } : b,
    );
  }
  if (Array.isArray(cfg.ratelimits)) {
    cfg.ratelimits = (cfg.ratelimits as Obj[]).map((r, i) => ({ ...r, namespace_id: String(site.rateLimitBase + i + 1) }));
  }
  return cfg;
}

/** Text of sites/<slug>/wrangler.jsonc. */
export function generatedText(templateText: string, site: Site): string {
  const cfg = siteConfig(parseJsonc(templateText) as Obj, site, "../../");
  return [
    `// GENERATED by \`npm run sites:generate\` from ${TEMPLATE_PATH} + ${REGISTRY_PATH} — do not edit.`,
    `// ${site.name} (${site.domain}): same code as every site; its own Worker, D1, R2 and secrets.`,
    `// Shared settings: edit ${TEMPLATE_PATH}. This site's values: edit ${REGISTRY_PATH}. Then regenerate.`,
    JSON.stringify(cfg, null, 2),
    "",
  ].join("\n");
}

export function loadRegistry(root = ROOT): Registry {
  return JSON.parse(readFileSync(join(root, REGISTRY_PATH), "utf8")) as Registry;
}

/** Everything `sites:check` reports (empty = fine). */
export function checkAll(root = ROOT): string[] {
  const registry = loadRegistry(root);
  const problems = validateRegistry(registry);
  if (problems.length) return problems;
  const template = readFileSync(join(root, TEMPLATE_PATH), "utf8");
  problems.push(...checkTemplate(registry, template));
  for (const site of registry.sites) {
    if (site.slug === registry.template) continue;
    const path = join(root, configPath(registry, site.slug));
    if (!existsSync(path)) problems.push(`${configPath(registry, site.slug)} is missing — run npm run sites:generate`);
    else if (readFileSync(path, "utf8") !== generatedText(template, site)) problems.push(`${configPath(registry, site.slug)} is out of date — run npm run sites:generate`);
  }
  return problems;
}

function generate(): void {
  const registry = loadRegistry();
  const problems = validateRegistry(registry);
  if (problems.length) fail(problems);
  const template = readFileSync(join(ROOT, TEMPLATE_PATH), "utf8");
  const templateProblems = checkTemplate(registry, template);
  if (templateProblems.length) fail(templateProblems);
  for (const site of registry.sites) {
    if (site.slug === registry.template) continue;
    const rel = configPath(registry, site.slug);
    mkdirSync(join(ROOT, `sites/${site.slug}`), { recursive: true });
    writeFileSync(join(ROOT, rel), generatedText(template, site));
    console.log(`wrote ${rel}`);
  }
}

function fail(problems: string[]): never {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}

function sh(cmd: string, args: string[]): void {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
}

const COMMANDS = ["preflight", "migrations", "backup", "migrate", "deploy", "smoke"] as const;
type Command = (typeof COMMANDS)[number];

function runFor(registry: Registry, site: Site, command: Command, extra: string[]): void {
  const config = configPath(registry, site.slug);
  const wrangler = (...args: string[]) => sh("npx", ["wrangler", ...args, "--config", config]);
  console.log(`\n=== ${site.name} (${site.domain}) — ${command}`);
  switch (command) {
    case "preflight": return sh("npx", ["tsx", "scripts/preflight.ts", "--config", config, ...extra]);
    case "migrations": return wrangler("d1", "migrations", "list", site.d1.name, "--remote");
    case "backup": return sh("npx", ["tsx", "scripts/backup-d1.ts", "--database", site.d1.name, "--config", config]);
    case "migrate":
      sh("npx", ["tsx", "scripts/backup-d1.ts", "--database", site.d1.name, "--config", config]);
      return wrangler("d1", "migrations", "apply", site.d1.name, "--remote");
    case "deploy":
      sh("npx", ["tsx", "scripts/preflight.ts", "--config", config]);
      sh("npm", ["run", "build"]);
      return wrangler("deploy");
    case "smoke": return sh("npx", ["tsx", "scripts/smoke-test.ts", `https://${site.domain}`, ...extra]);
  }
}

function main(): void {
  const [action, ...rest] = process.argv.slice(2);
  if (action === "generate") return generate();
  if (action === "check") {
    const problems = checkAll();
    if (problems.length) fail(problems);
    console.log(`sites: ${loadRegistry().sites.map((s) => s.slug).join(", ")} — registry valid, generated configs up to date`);
    return;
  }
  if (action === "run") {
    const [slug, command, ...extra] = rest;
    const registry = loadRegistry();
    if (!command || !(COMMANDS as readonly string[]).includes(command)) {
      fail([`usage: npm run site -- <${registry.sites.map((s) => s.slug).join("|")}|all> <${COMMANDS.join("|")}>`]);
    }
    const problems = checkAll();
    if (problems.length) fail(problems);
    const targets = slug === "all"
      ? [...registry.sites].sort((a, b) => a.wave - b.wave || a.slug.localeCompare(b.slug))
      : registry.sites.filter((s) => s.slug === slug);
    if (!targets.length) fail([`unknown site "${slug}" (known: ${registry.sites.map((s) => s.slug).join(", ")})`]);
    for (const site of targets) runFor(registry, site, command as Command, extra);
    return;
  }
  fail(["usage: tsx scripts/sites.ts generate | check | run <slug|all> <command>"]);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) main();
