import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseJsonc, preflight, type Finding } from "../../scripts/preflight.ts";
import {
  checkAll, checkTemplate, configPath, generatedText, loadRegistry, siteConfig, validateRegistry, type Registry,
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
