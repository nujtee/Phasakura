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
 *   npm run site -- <slug> release          # CI (.github/workflows/release.yml): preflight → Time Travel bookmark
 *                                           #   → migrate → deploy → smoke (no D1 export: guest data stays off CI)
 *   tsx scripts/sites.ts plan "<all|slugs>" # CI: which sites go in which release wave (JSON per wave), and Center
 *   npm run site -- center release          # Center console (phase C4): migrate center-db → deploy → /healthz
 *
 * Center (center/wrangler.jsonc) is GENERATED too: its domain and D1 come from the registry's "center" entry, and it
 * gets one service binding per site (SITE_<SLUG>) plus the site list (CENTER_SITES), so adding a site to the
 * registry and regenerating is all Center needs.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
export interface CenterEntry {
  domain: string;
  d1: { name: string; id: string };
}
export interface Registry {
  template: string;
  center?: CenterEntry;
  reservedRateLimitBases?: { base: number; note?: string }[];
  sites: Site[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Release waves in .github/workflows/release.yml (wave1…wave3 jobs). */
export const MAX_WAVES = 3;

/**
 * Release plan: the chosen sites ("all", or slugs separated by spaces / commas) grouped by wave.
 * Unknown slugs are an error, so a typo never silently releases nothing.
 */
export function releasePlan(registry: Registry, selection: string): { waves: string[][]; unknown: string[]; center: boolean } {
  const all = selection.trim() === "" || selection.trim() === "all";
  const wanted = all ? registry.sites.map((s) => s.slug) : [...new Set(selection.split(/[\s,]+/).filter(Boolean))];
  const center = !!registry.center && (all || wanted.includes(CENTER_SLUG));
  const unknown = wanted.filter((slug) => slug !== CENTER_SLUG && !registry.sites.some((s) => s.slug === slug));
  const waves = Array.from({ length: MAX_WAVES }, (_, i) =>
    registry.sites.filter((s) => s.wave === i + 1 && wanted.includes(s.slug)).map((s) => s.slug).sort());
  return { waves, unknown, center };
}

/** "center" in a release selection means the Center console; no site may use that slug. */
export const CENTER_SLUG = "center";
export const CENTER_CONFIG_PATH = "center/wrangler.jsonc";

/** Service-binding name of a site inside Center: SITE_PHASAKURA, SITE_CHOM_KHAO… */
export function siteBinding(slug: string): string {
  return `SITE_${slug.toUpperCase().replace(/-/g, "_")}`;
}

/** Center's Worker config (center/wrangler.jsonc): shared runtime settings from the template, its own D1, one binding per site. */
export function centerConfig(registry: Registry, template: Obj): Obj {
  const center = registry.center!;
  return {
    $schema: "../node_modules/wrangler/config-schema.json",
    name: CENTER_SLUG,
    main: "../src/center/index.ts",
    compatibility_date: template.compatibility_date,
    observability: template.observability,
    // Phase C5: health check of every site + LINE alerts.
    triggers: { crons: ["*/5 * * * *"] },
    routes: [{ pattern: center.domain, custom_domain: true }],
    workers_dev: false,
    preview_urls: false,
    vars: {
      APP_BASE_URL: `https://${center.domain}`,
      CENTER_SITES: JSON.stringify(registry.sites.map((s) => ({ slug: s.slug, name: s.name, domain: s.domain, binding: siteBinding(s.slug) }))),
    },
    d1_databases: [{ binding: "DB", database_name: center.d1.name, database_id: center.d1.id, migrations_dir: "migrations" }],
    services: registry.sites.map((s) => ({ binding: siteBinding(s.slug), service: s.slug })),
  };
}

export function centerText(registry: Registry, templateText: string): string {
  return [
    `// GENERATED by \`npm run sites:generate\` from ${REGISTRY_PATH} ("center" + every site) and ${TEMPLATE_PATH} — do not edit.`,
    "// Center Management console: its own Worker and D1; each site is reached through its service binding (no public internet,",
    "// no bot protection in the way). Secret: CENTER_SIGNING_KEY (Actions → Center keys). Never any site's secrets.",
    JSON.stringify(centerConfig(registry, parseJsonc(templateText) as Obj), null, 2),
    "",
  ].join("\n");
}

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
    if (!Number.isInteger(s.wave) || s.wave < 1 || s.wave > MAX_WAVES) out.push(`${s.slug}: wave must be 1…${MAX_WAVES} (the release workflow has ${MAX_WAVES} wave jobs)`);
  }
  seen((s) => s.slug, "slug");
  seen((s) => s.domain, "domain");
  seen((s) => s.d1?.id, "D1 id");
  const bases = [...registry.sites.map((s) => s.rateLimitBase), ...(registry.reservedRateLimitBases ?? []).map((r) => r.base)];
  for (const b of new Set(bases)) if (bases.filter((x) => x === b).length > 1) out.push(`rateLimitBase ${b} is used twice (namespace ids must be unique in the account)`);
  if (!registry.sites.some((s) => s.slug === registry.template)) out.push(`template "${registry.template}" is not one of the sites`);
  if (registry.sites.some((s) => s.slug === CENTER_SLUG)) out.push(`slug "${CENTER_SLUG}" is reserved for the Center console`);
  if (registry.center) {
    const c = registry.center;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(c.domain ?? "")) out.push(`center: domain "${c.domain}" must be a hostname`);
    if (registry.sites.some((s) => s.domain === c.domain)) out.push("center: domain is a site's domain");
    if (c.d1?.name !== "center-db") out.push('center: D1 name must be "center-db"');
    if (!UUID.test(c.d1?.id ?? "")) out.push("center: D1 id is not a UUID");
    if (registry.sites.some((s) => s.d1.id === c.d1?.id)) out.push("center: D1 id is a site's database");
  }
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
  if (registry.center) {
    const path = join(root, CENTER_CONFIG_PATH);
    if (!existsSync(path) || readFileSync(path, "utf8") !== centerText(registry, template)) problems.push(`${CENTER_CONFIG_PATH} is missing or out of date — run npm run sites:generate`);
  }
  return problems;
}

export function generate(): void {
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
  if (registry.center) {
    mkdirSync(join(ROOT, "center"), { recursive: true });
    writeFileSync(join(ROOT, CENTER_CONFIG_PATH), centerText(registry, template));
    console.log(`wrote ${CENTER_CONFIG_PATH}`);
  }
}

/**
 * Release Center from CI: migrate center-db (additive), deploy, then GET /healthz until it answers.
 * No Time Travel bookmark step is needed for the restore story (Center keeps no guest data), but D1 keeps 30 days anyway.
 */
async function releaseCenter(registry: Registry): Promise<void> {
  const center = registry.center!;
  summary(`### Center — ${center.domain}`);
  sh("npx", ["wrangler", "d1", "migrations", "apply", center.d1.name, "--remote", "--config", CENTER_CONFIG_PATH]);
  summary("- Migrations: applied (or none pending)");
  sh("npx", ["wrangler", "deploy", "--config", CENTER_CONFIG_PATH]);
  summary("- Deploy: done");
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://${center.domain}/healthz`, { headers: { "User-Agent": "center-release-smoke" } });
      const body = (await res.json().catch(() => null)) as { status?: string; signingKey?: boolean } | null;
      if (res.status !== 200 || body?.status !== "ok") throw new Error(`GET /healthz → ${res.status} ${JSON.stringify(body)}`);
      summary(`- Smoke test: passed (signing key ${body.signingKey ? "set" : "**not set yet** — run Actions → Center keys"})`);
      return;
    } catch (e) {
      if (attempt >= 4) {
        summary(`- **Smoke test failed** (${String(e)}) — roll back with \`npx wrangler rollback --config ${CENTER_CONFIG_PATH}\``);
        throw e;
      }
      console.log(`center smoke test failed (attempt ${attempt}): ${String(e)} — retrying in 20 s`);
      execFileSync("sleep", ["20"]);
    }
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

const COMMANDS = ["preflight", "migrations", "backup", "migrate", "deploy", "smoke", "release"] as const;
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
    case "release": return release(site, config);
  }
}

/** The bookmark in `wrangler d1 time-travel info` output ("…current bookmark is '00000085-0000024c-…'"). */
export function parseBookmark(output: string): string | null {
  return output.match(/\b([0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32})\b/i)?.[1] ?? null;
}

/** One line in the GitHub job summary (no-op outside Actions). */
function summary(line: string): void {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function capture(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/**
 * Release one site from CI. Order matters: migrations are additive, so the database goes first and the code
 * that needs it second; the bookmark taken before anything changes is the way back (D1 Time Travel).
 * The build (npm run build) is done once per job before this runs.
 */
function release(site: Site, config: string): void {
  summary(`### ${site.name} — ${site.domain}`);
  sh("npx", ["tsx", "scripts/preflight.ts", "--config", config]);
  const info = capture(["d1", "time-travel", "info", site.d1.name, "--config", config]);
  const bookmark = parseBookmark(info) ?? "(see job log)";
  summary(`- Restore point (D1 Time Travel bookmark, before this release): \`${bookmark}\``);
  sh("npx", ["wrangler", "d1", "migrations", "apply", site.d1.name, "--remote", "--config", config]);
  summary("- Migrations: applied (or none pending)");
  sh("npx", ["wrangler", "deploy", "--config", config]);
  summary("- Deploy: done");
  // A fresh deploy can take a few seconds to reach every edge location: try the smoke test up to 3 times.
  for (let attempt = 1; ; attempt++) {
    try {
      sh("npx", ["tsx", "scripts/smoke-test.ts", `https://${site.domain}`]);
      summary("- Smoke test: passed");
      return;
    } catch (e) {
      if (attempt >= 3) {
        summary(`- **Smoke test failed** — roll back with \`npx wrangler rollback --config ${config}\`; data restore point above`);
        throw e;
      }
      console.log(`smoke test failed (attempt ${attempt}) — retrying in 20 s`);
      execFileSync("sleep", ["20"]);
    }
  }
}

function main(): void {
  const [action, ...rest] = process.argv.slice(2);
  if (action === "plan") {
    const registry = loadRegistry();
    const problems = checkAll();
    if (problems.length) fail(problems);
    const { waves, unknown, center } = releasePlan(registry, rest.join(" "));
    if (unknown.length) fail([`unknown site(s): ${unknown.join(", ")} (known: ${[...registry.sites.map((s) => s.slug), CENTER_SLUG].join(", ")})`]);
    if (!waves.some((w) => w.length) && !center) fail(["no site selected"]);
    const lines = [...waves.map((w, i) => `wave${i + 1}=${JSON.stringify(w)}`), `center=${center}`];
    for (const l of lines) console.log(l);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
    return;
  }
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
    if (slug === CENTER_SLUG) {
      if (command !== "release" || !registry.center) fail(["usage: npm run site -- center release"]);
      const problems = checkAll();
      if (problems.length) fail(problems);
      releaseCenter(registry).catch((e) => { console.error(String(e)); process.exit(1); });
      return;
    }
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
  fail(["usage: tsx scripts/sites.ts generate | check | plan <all|slugs> | run <slug|all> <command>"]);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) main();
