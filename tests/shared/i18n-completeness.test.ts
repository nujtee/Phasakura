import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LINE_TEXT_DICTIONARIES } from "../../src/worker/line/line-templates.ts";

/**
 * Phase 15 — every dictionary in the project, found automatically (a new one is checked the day it
 * is added): TH / EN / ZH-CN have the same keys, nothing is empty, `{placeholders}` match, and no
 * Thai text leaks into the English or Chinese versions.
 */

type Dict = Record<string, unknown>;
const DIR = join(import.meta.dirname, "..", "..", "src", "shared", "i18n");
const THAI = /[฀-๿]/;

function flatten(d: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof d === "string") out.set(prefix, d);
  else if (typeof d === "function") out.set(prefix, "[fn]");
  else if (Array.isArray(d)) d.forEach((v, i) => flatten(v, `${prefix}[${i}]`).forEach((x, k) => out.set(k, x)));
  else if (d && typeof d === "object") for (const [k, v] of Object.entries(d)) flatten(v, prefix ? `${prefix}.${k}` : k).forEach((x, kk) => out.set(kk, x));
  return out;
}
/** Keys whose text is deliberately multi-script (a font preview must show Thai glyphs in every language). */
const MULTI_SCRIPT = /(^|\.)sample$/;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

async function dictionaries(): Promise<{ name: string; th: Dict; en: Dict; zh: Dict }[]> {
  const found: { name: string; th: Dict; en: Dict; zh: Dict }[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".ts"))) {
    const mod = (await import(join(DIR, file))) as Record<string, unknown>;
    if (mod.th && mod.en && mod.zhCN) found.push({ name: file, th: mod.th as Dict, en: mod.en as Dict, zh: mod.zhCN as Dict });
    for (const key of Object.keys(mod)) {
      const m = /^(\w+)Th$/.exec(key);
      if (m && mod[`${m[1]}En`] && mod[`${m[1]}ZhCN`]) {
        found.push({ name: `${file}:${m[1]}`, th: mod[key] as Dict, en: mod[`${m[1]}En`] as Dict, zh: mod[`${m[1]}ZhCN`] as Dict });
      }
    }
  }
  const line = LINE_TEXT_DICTIONARIES as unknown as Record<string, Dict>;
  found.push({ name: "line-templates", th: line.th!, en: line.en!, zh: line["zh-CN"]! });
  return found;
}

/** Proper names and codes that are the same in every language. */
const SAME_ANYWHERE = /^(LINE|GA4|Meta Pixel|Google Analytics 4|Meta Conversions API|Google Search Console|Home|Gallery|PromptPay|QR|Booking ID|OG Title|OG Description|Robots|Redirects|SEO|SEO Title|Canonical URL|Webhook URL|Channel secret|Channel access token|Basic ID|Access Token|Test Event Code|Pixel ID.*|Measurement ID.*|ภาษาไทย|ไทย|TH|EN|中文|English|简体中文)$/;

describe("translations are complete in every dictionary", async () => {
  const all = await dictionaries();

  it("finds every dictionary (site, booking, admin, reports, LINE, SEO, search, consent …)", () => {
    assert.ok(all.length >= 12, all.map((d) => d.name).join(", "));
  });

  for (const d of all) {
    it(`${d.name}: same keys, nothing empty, same placeholders, no Thai in EN / ZH`, () => {
      const th = flatten(d.th), en = flatten(d.en), zh = flatten(d.zh);
      assert.deepEqual([...en.keys()].sort(), [...th.keys()].sort(), "EN keys");
      assert.deepEqual([...zh.keys()].sort(), [...th.keys()].sort(), "ZH-CN keys");
      const problems: string[] = [];
      for (const [k, t] of th) {
        const e = en.get(k)!, z = zh.get(k)!;
        for (const [lang, v] of [["th", t], ["en", e], ["zh", z]] as const) if (!v.trim()) problems.push(`${lang} ${k} is empty`);
        if (placeholders(e) !== placeholders(t)) problems.push(`en ${k}: {${placeholders(e)}} ≠ th {${placeholders(t)}}`);
        if (placeholders(z) !== placeholders(t)) problems.push(`zh ${k}: {${placeholders(z)}} ≠ th {${placeholders(t)}}`);
        if (THAI.test(e) && !SAME_ANYWHERE.test(e) && !/language|lang|locale/i.test(k) && !MULTI_SCRIPT.test(k)) problems.push(`en ${k} contains Thai: ${e.slice(0, 50)}`);
        if (THAI.test(z) && !SAME_ANYWHERE.test(z) && !/language|lang|locale/i.test(k) && !MULTI_SCRIPT.test(k)) problems.push(`zh ${k} contains Thai: ${z.slice(0, 50)}`);
      }
      assert.deepEqual(problems, []);
    });
  }
});
