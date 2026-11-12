import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overviewHtml, type CheckRow, type OverviewInput } from "../../src/center/overview.ts";
import type { CenterSite } from "../../src/center/env.ts";
import type { DomainRow } from "../../src/center/domains.ts";

/** The "เว็บทั้งหมด" dashboard: totals, the "ต้องดูแล" list (most urgent first), search. */

const NOW = new Date("2026-11-12T03:00:00Z"); // 10:00 Bangkok
const site = (slug: string, name: string): CenterSite => ({ slug, name, domain: `${slug}.com`, binding: slug.toUpperCase() });
const ok = (s: string, extra: Partial<CheckRow> = {}): CheckRow => ({
  site: s, checked_at: "2026-11-12T02:51:00Z", http_status: 200, schema_state: "ok", cron_state: "ok",
  errors_24h: 0, slips_waiting: 0, suspended: 0, detail: null, ...extra,
});
const dom = (d: string, expires: string | null): DomainRow => ({ domain: d, expires_at: expires, registrar: "Cloudflare, Inc.", error: expires ? null : "HTTP 404", checked_at: "2026-11-12T00:00:00Z" });

function input(over: Partial<OverviewInput> = {}): OverviewInput {
  const sites = [site("alpha", "Alpha"), site("bravo", "Bravo"), site("charlie", "Charlie"), site("delta", "Delta")];
  return {
    sites,
    checks: new Map([
      ["alpha", ok("alpha")],
      ["bravo", ok("bravo", { slips_waiting: 2 })],
      ["charlie", ok("charlie", { errors_24h: 1 })],
      ["delta", ok("delta", { http_status: 0, detail: "HTTP 404" })],
    ]),
    alerts: [],
    domains: new Map([
      ["alpha.com", dom("alpha.com", "2027-09-30")],
      ["bravo.com", dom("bravo.com", "2026-11-20")],
      ["charlie.com", dom("charlie.com", "2027-03-20")],
    ]),
    alertLabel: (t) => t,
    now: NOW,
    query: "",
    readOnly: false,
    canAdd: true,
    canRun: true,
    ...over,
  };
}

const attention = (html: string) => {
  const part = html.split('id="h-attn"')[1]?.split('id="h-all"')[0] ?? "";
  return [...part.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]);
};

describe("Center dashboard (เว็บทั้งหมด)", () => {
  it("totals: online, to look at, slips, domains expiring soon", () => {
    const html = overviewHtml(input());
    assert.match(html, /ออนไลน์<\/div><div class="tile-v bad">3 <span class="small muted">\/ 4<\/span>/);
    assert.match(html, /ต้องดูแล<\/div><div class="tile-v bad">3</);
    assert.match(html, /สลิปรอตรวจ<\/div><div class="tile-v warn">2</);
    assert.match(html, /โดเมนใกล้หมดอายุ \(≤ 15 วัน\)<\/div><div class="tile-v warn">1</);
  });

  it("“ต้องดูแล” lists the most urgent first, with what is wrong", () => {
    const html = overviewHtml(input());
    // Delta unreachable (broken) → Bravo (domain in 8 days + slips) → Charlie (one error); Alpha is fine.
    assert.deepEqual(attention(html), ["Delta", "Bravo", "Charlie"]);
    assert.match(html, /ติดต่อไม่ได้ — HTTP 404/);
    assert.match(html, /โดเมน bravo\.com หมดอายุใน 8 วัน/);
    assert.match(html, /สลิปรอตรวจ 2 รายการ/);
    assert.match(html, /มี error 1 ครั้งใน 24 ชม\./);
  });

  it("nothing open: no “ต้องดูแล” section", () => {
    const html = overviewHtml(input({ sites: [site("alpha", "Alpha")] }));
    assert.doesNotMatch(html, /id="h-attn"/);
    assert.match(html, /<span class="pill good">ออนไลน์<\/span>/);
    assert.match(html, /30 ก\.ย\. 2570 <span class="small muted">· อีก 322 วัน/);
  });

  it("an open alert outranks everything and shows since when", () => {
    const html = overviewHtml(input({ alerts: [{ site: "charlie", type: "config", open_since: "2026-10-29T15:20:00Z", detail: null }] }));
    assert.deepEqual(attention(html).slice(0, 2), ["Charlie", "Delta"]);
    assert.match(html, /config — ตั้งแต่ /);
  });

  it("“เข้าหลังบ้าน” asks for a reason; the search filters the table", () => {
    const html = overviewHtml(input({ query: "brav" }));
    assert.match(html, /<form method="post" action="\/sites\/bravo\/sso"[\s\S]*?name="reason" required minlength="3"/);
    const table = html.split('id="h-all"')[1]!;
    assert.match(table, /Bravo/);
    assert.doesNotMatch(table, /Alpha/);
    assert.match(overviewHtml(input({ query: "zzz" })), /ไม่พบเว็บที่ตรงกับ “zzz”/);
  });

  it("read-only support: no add or run buttons", () => {
    const html = overviewHtml(input({ readOnly: true, canAdd: false, canRun: false }));
    assert.doesNotMatch(html, /เพิ่มเว็บใหม่/);
    assert.doesNotMatch(html, /\/checks\/run/);
    assert.match(html, /เข้าได้แบบดูอย่างเดียว/);
  });
});
