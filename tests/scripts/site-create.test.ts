import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkZone, d1IdFromList, nextRateLimitBase, normalizeInput, planSite, registryWithSite } from "../../scripts/site-create.ts";
import { loadRegistry, REGISTRY_PATH, validateRegistry, type Registry } from "../../scripts/sites.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const registry = (): Registry => loadRegistry(ROOT);
const ID = "11111111-2222-4333-8444-555555555555";

describe("site:create (Center phase C7)", () => {
  it("normalises the input: trimmed, lower-case apex domain without scheme, www or path", () => {
    assert.deepEqual(normalizeInput({ slug: " SuanPho ", name: "  Suan   Pho ", domain: "https://www.SuanPho.com/th" }), { slug: "suanpho", name: "Suan Pho", domain: "suanpho.com" });
  });

  it("the next rate-limit base skips every site and every reservation", () => {
    const r = registry();
    const base = nextRateLimitBase(r);
    assert.ok(!r.sites.some((s) => s.rateLimitBase === base));
    assert.ok(!(r.reservedRateLimitBases ?? []).some((x) => x.base === base));
    assert.equal(nextRateLimitBase({ ...r, sites: [], reservedRateLimitBases: [] }), 1000);
    assert.equal(nextRateLimitBase({ ...r, sites: [{ ...r.sites[0]!, rateLimitBase: 1000 }], reservedRateLimitBases: [{ base: 2000 }] }), 3000);
  });

  it("plans a valid wave-1 entry that keeps the registry valid", () => {
    const r = registry();
    const { site, problems } = planSite(r, { slug: "baanrim", name: "Baan Rim", domain: "baanrim.com" }, ID);
    assert.deepEqual(problems, []);
    assert.deepEqual(site, { slug: "baanrim", name: "Baan Rim", domain: "baanrim.com", d1: { name: "baanrim-db", id: ID }, rateLimitBase: nextRateLimitBase(r), wave: 1 });
    assert.deepEqual(validateRegistry({ ...r, sites: [...r.sites, site!] }), []);
  });

  it("refuses taken slugs and domains, Center's slug and domain, and bad input", () => {
    const r = registry();
    const existing = r.sites[0]!;
    const problems = (slug: string, domain: string, name = "X") => planSite(r, { slug, name, domain }).problems.join(" | ");
    assert.match(problems(existing.slug, "fresh.com"), /already a site/);
    assert.match(problems("fresh", existing.domain), /already a site/);
    assert.match(problems("center", "fresh.com"), /reserved/);
    assert.match(problems("fresh", r.center!.domain), /Center's domain/);
    assert.match(problems("Bad Slug!", "fresh.com"), /slug must be/);
    assert.match(problems("fresh", "not a domain"), /must be the apex/);
    assert.match(problems("fresh", "fresh.com", ""), /name is empty/);
  });

  it("appends to sites.json keeping its layout; the result parses and validates", () => {
    const text = readFileSync(join(ROOT, REGISTRY_PATH), "utf8");
    const { site } = planSite(registry(), { slug: "baanrim", name: "Baan \"Rim\"", domain: "baanrim.com" }, ID);
    const next = registryWithSite(text, site!);
    assert.ok(next.startsWith(text.replace(/\n\s*\}\n\s*\]\s*\}\s*$/, "")), "everything before the new entry is unchanged");
    assert.match(next, /"d1": \{ "name": "baanrim-db", "id": "11111111-2222-4333-8444-555555555555" \}/);
    const parsed = JSON.parse(next) as Registry;
    assert.equal(parsed.sites.at(-1)!.name, "Baan \"Rim\"");
    assert.deepEqual(validateRegistry(parsed), []);
  });

  it("reads the D1 id from wrangler's JSON list", () => {
    const json = JSON.stringify([{ uuid: "a", name: "x-db" }, { uuid: ID, name: "baanrim-db" }]);
    assert.equal(d1IdFromList(json, "baanrim-db"), ID);
    assert.equal(d1IdFromList(json, "nope-db"), null);
  });

  it("zone check: active passes; missing / pending fail with what to do; a token without zone access only warns", async () => {
    const env = { token: "t", accountId: "acc" };
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    let seen = "";
    const spy = (async (url: string, init?: RequestInit) => {
      seen = `${url} ${(init?.headers as Record<string, string>).Authorization}`;
      return new Response(JSON.stringify({ success: true, result: [{ name: "baanrim.com", status: "active" }] }));
    }) as unknown as typeof fetch;
    assert.deepEqual(await checkZone("baanrim.com", env, spy), { ok: true, message: "zone baanrim.com is active in the platform's account" });
    assert.match(seen, /zones\?name=baanrim\.com&account\.id=acc Bearer t$/);
    assert.match((await checkZone("baanrim.com", env, answer(200, { success: true, result: [] }))).message, /not in the platform's Cloudflare account/);
    const pending = await checkZone("baanrim.com", env, answer(200, { success: true, result: [{ name: "baanrim.com", status: "pending" }] }));
    assert.equal(pending.ok, false);
    assert.match(pending.message, /nameserver/);
    const noScope = await checkZone("baanrim.com", env, answer(403, { success: false }));
    assert.deepEqual([noScope.ok, noScope.warning], [true, true]);
    assert.equal((await checkZone("baanrim.com", {}, spy)).ok, false);
  });
});
