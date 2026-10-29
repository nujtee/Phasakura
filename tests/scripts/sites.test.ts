import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseJsonc, preflight, type Finding } from "../../scripts/preflight.ts";
import {
  centerConfig, checkAll, checkTemplate, configPath, generatedText, loadRegistry, MAX_WAVES, parseBookmark, releasePlan, siteBinding, siteConfig, validateRegistry, type Registry,
} from "../../scripts/sites.ts";
import { splitPhones } from "../../src/shared/phones.ts";
import { siteLabel, siteMailDomain, siteSlug } from "../../src/shared/site-name.ts";
import { LATEST_MIGRATION } from "../../src/worker/services/health.service.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const TEMPLATE = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
const MIGRATIONS = Object.fromEntries(readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).map((f) => [f, readFileSync(join(ROOT, "migrations", f), "utf8")]));
const registry = loadRegistry(ROOT);
const errors = (f: Finding[]) => f.filter((x) => x.level === "error").map((x) => `${x.area}: ${x.message}`);

describe("sites registry (Center phase C0: one codebase, every site)", () => {
  it("is valid, matches wrangler.jsonc for the template site, and every generated config is up to date", () => {
    assert.deepEqual(checkAll(ROOT), []);
    assert.ok(registry.sites.length >= 3);
    assert.ok(registry.sites.some((s) => s.slug === registry.template));
  });

  it("every site passes preflight with its own config, and paths resolve from sites/<slug>/", () => {
    for (const site of registry.sites) {
      const rel = configPath(registry, site.slug);
      const configDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const findings = preflight({
        wrangler: readFileSync(join(ROOT, rel), "utf8"), configDir,
        migrations: MIGRATIONS, latestMigration: LATEST_MIGRATION,
        headers: readFileSync(join(ROOT, "public", "_headers"), "utf8"), tracked: ["src/worker/index.ts"],
        secrets: null, exists: (p) => existsSync(join(ROOT, p)), today: new Date("2026-10-17T00:00:00Z"),
      });
      assert.deepEqual(errors(findings), [], site.slug);
    }
  });

  it("a generated config keeps every shared setting and changes only the site's own values", () => {
    const template = parseJsonc(TEMPLATE) as Record<string, unknown>;
    const site = registry.sites.find((s) => s.slug !== registry.template)!;
    type Cfg = {
      name: string; routes: { pattern: string }[]; vars: Record<string, unknown>; d1_databases: { database_id: string; migrations_dir: string }[];
      r2_buckets: { bucket_name: string }[]; ratelimits: { namespace_id: string }[];
    } & Record<string, unknown>;
    const cfg = parseJsonc(generatedText(TEMPLATE, site)) as Cfg;
    assert.equal(cfg.name, site.slug);
    assert.deepEqual(cfg.routes.map((r) => r.pattern), [site.domain, `www.${site.domain}`]);
    assert.equal(cfg.vars.APP_BASE_URL, `https://${site.domain}`);
    assert.equal(cfg.d1_databases[0]!.database_id, site.d1.id);
    assert.equal(cfg.d1_databases[0]!.migrations_dir, "../../migrations");
    assert.deepEqual(cfg.r2_buckets.map((b) => b.bucket_name), [`${site.slug}-media-public`, `${site.slug}-media-private`]);
    assert.deepEqual(cfg.ratelimits.map((r) => r.namespace_id), [1, 2, 3, 4].map((n) => String(site.rateLimitBase + n)));
    for (const key of ["compatibility_date", "observability", "triggers", "workers_dev", "preview_urls"]) assert.deepEqual(cfg[key], template[key], key);
    assert.deepEqual({ ...cfg.vars, APP_BASE_URL: null }, { ...(template.vars as object), APP_BASE_URL: null });
  });

  it("refuses duplicate slugs, domains, D1 ids and rate-limit ranges (incl. reserved ones)", () => {
    const base = registry.sites[0]!;
    const twin = { ...base, slug: "twin", d1: { name: "twin-db", id: base.d1.id } };
    const bad: Registry = { ...registry, sites: [...registry.sites, twin], reservedRateLimitBases: [{ base: 1000 }] };
    const problems = validateRegistry(bad).join("\n");
    assert.match(problems, /domain .* more than one site/);
    assert.match(problems, /D1 id .* more than one site/);
    assert.match(problems, /rateLimitBase 1000 is used twice/);
    assert.match(validateRegistry({ ...registry, sites: [{ ...base, domain: "www.x.com", d1: { name: "x", id: "no" } }] }).join("\n"), /apex[\s\S]*D1 name[\s\S]*not a UUID/);
  });

  it("notices when wrangler.jsonc no longer matches the template site's entry", () => {
    assert.deepEqual(checkTemplate(registry, TEMPLATE), []);
    assert.match(checkTemplate(registry, TEMPLATE.replace(/"database_id": "[^"]+"/, '"database_id": "00000000-0000-0000-0000-000000000000"'))[0] ?? "", /does not match/);
  });

  it("the template site's own config is unchanged by siteConfig (paths stay repository-relative)", () => {
    const template = parseJsonc(TEMPLATE) as Record<string, unknown>;
    const site = registry.sites.find((s) => s.slug === registry.template)!;
    assert.deepEqual(siteConfig(template, site, ""), template);
  });
});

describe("release plan (Center phase C1: .github/workflows/release.yml)", () => {
  it("groups the chosen sites by wave; quiet sites first", () => {
    const { waves, unknown } = releasePlan(registry, "all");
    assert.equal(waves.length, MAX_WAVES);
    assert.deepEqual(unknown, []);
    assert.deepEqual(waves.flat().sort(), registry.sites.map((s) => s.slug).sort());
    for (const [i, wave] of waves.entries()) for (const slug of wave) assert.equal(registry.sites.find((s) => s.slug === slug)!.wave, i + 1);
  });

  it("accepts slugs separated by spaces or commas, and names unknown ones instead of releasing nothing", () => {
    assert.deepEqual(releasePlan(registry, "chomkhao, phasakura").waves.flat().sort(), ["chomkhao", "phasakura"]);
    assert.deepEqual(releasePlan(registry, "chomkao").unknown, ["chomkao"]);
    assert.deepEqual(releasePlan(registry, "  ").waves.flat().length, registry.sites.length);
  });

  it("a wave outside 1…MAX_WAVES is refused (the workflow has a fixed number of wave jobs)", () => {
    const site = { ...registry.sites[0]!, wave: MAX_WAVES + 1 };
    assert.match(validateRegistry({ ...registry, sites: [site, ...registry.sites.slice(1)] }).join("\n"), /wave must be 1…/);
  });

  it("reads the restore point from `wrangler d1 time-travel info`", () => {
    const out = "🚧 Time Traveling...\n⚠️ Timestamp '2026-10-17T02:30:00Z' corresponds with bookmark '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683'\n";
    assert.equal(parseBookmark(out), "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683");
    assert.equal(parseBookmark("no bookmark here"), null);
  });

  it("the workflow's wave jobs match MAX_WAVES and only run `sites.ts run <site> release`", () => {
    const wf = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    for (let w = 1; w <= MAX_WAVES; w++) assert.match(wf, new RegExp(`\\n  wave${w}:\\n`));
    assert.doesNotMatch(wf, new RegExp(`\\n  wave${MAX_WAVES + 1}:`));
    assert.equal(wf.match(/sites\.ts run \$\{\{ matrix\.site \}\} release/g)?.length, MAX_WAVES);
    const runLines = wf.split("\n").filter((l) => /^\s+(- )?run:|^\s{12}\S/.test(l));
    assert.ok(runLines.every((l) => !l.includes("${{ inputs.")), "workflow inputs reach shell steps through env only");
  });
});

describe("Center config (phase C4: center/wrangler.jsonc)", () => {
  it("one service binding per site, the site list, its own D1 and domain — generated, never by hand", () => {
    const cfg = centerConfig(registry, parseJsonc(TEMPLATE) as Record<string, unknown>) as {
      name: string; main: string; routes: { pattern: string }[]; vars: Record<string, string>; services: { binding: string; service: string }[];
      d1_databases: { database_id: string; migrations_dir: string }[]; triggers?: unknown; workers_dev: boolean;
    };
    assert.equal(cfg.name, "center");
    assert.equal(cfg.main, "../src/center/index.ts");
    assert.deepEqual(cfg.routes.map((r) => r.pattern), [registry.center!.domain]);
    assert.equal(cfg.workers_dev, false);
    assert.deepEqual(cfg.services, registry.sites.map((s) => ({ binding: siteBinding(s.slug), service: s.slug })));
    assert.deepEqual(JSON.parse(cfg.vars.CENTER_SITES!).map((s: { slug: string }) => s.slug), registry.sites.map((s) => s.slug));
    assert.equal(cfg.d1_databases[0]!.database_id, registry.center!.d1.id);
    assert.equal(cfg.d1_databases[0]!.migrations_dir, "migrations");
    assert.ok(!registry.sites.some((s) => s.d1.id === registry.center!.d1.id), "never a site's database");
    assert.equal(siteBinding("chom-khao"), "SITE_CHOM_KHAO");
  });

  it("release: \"all\" includes Center, \"center\" alone releases only Center; the slug is reserved", () => {
    assert.equal(releasePlan(registry, "all").center, true);
    assert.equal(releasePlan(registry, "chomkhao").center, false);
    const only = releasePlan(registry, "center");
    assert.deepEqual([only.center, only.waves.flat(), only.unknown], [true, [], []]);
    const site = { ...registry.sites[0]!, slug: "center" };
    assert.match(validateRegistry({ ...registry, sites: [site, ...registry.sites.slice(1)] }).join("\n"), /reserved for the Center console/);
    assert.match(validateRegistry({ ...registry, center: { ...registry.center!, d1: registry.sites[0]!.d1 } }).join("\n"), /center: D1/);
    const wf = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    assert.match(wf, /\n {2}center:\n[\s\S]*?sites\.ts run center release/);
    // Center binds to every site's Worker: a new site (Create site → wave 1) must exist before Center deploys.
    assert.match(wf, /\n {2}center:\n {4}needs: \[plan, verify, wave1\]\n/);
    assert.match(wf, /\n {2}center:[\s\S]*?!cancelled\(\)[\s\S]*?needs\.verify\.result == 'success'/);
  });
});

describe("site name from the domain (no hardcoded Phasakura)", () => {
  it("slug, label and mail domain", () => {
    assert.equal(siteSlug("https://phasakura.com"), "phasakura");
    assert.equal(siteSlug("www.chomkhao.com"), "chomkhao");
    assert.equal(siteSlug("cherngdoi.com"), "cherngdoi");
    assert.equal(siteSlug("localhost"), "site");
    assert.equal(siteSlug("http://127.0.0.1:8787"), "site");
    assert.equal(siteLabel("https://www.chomkhao.com"), "Chomkhao");
    assert.equal(siteMailDomain("www.cherngdoi.com"), "cherngdoi.com");
    assert.equal(siteMailDomain("localhost"), "your-domain.com");
  });

  it("contact phones also split on the Thai / Chinese full-width comma", () => {
    assert.deepEqual(splitPhones("063 795 1218，095 579 0679、02-123-4567"), ["063 795 1218", "095 579 0679", "02-123-4567"]);
  });
});
