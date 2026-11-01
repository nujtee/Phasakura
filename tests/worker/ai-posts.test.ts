import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PostDraftDto, QuietDatesDto } from "../../src/shared/ai-post-types.ts";
import { parsePostDraft, trackedLink } from "../../src/worker/ai-marketing/post-writer.ts";
import { AI_POST_DRAFT } from "../helpers/fake-http.ts";
import { Harness } from "../helpers/harness.ts";

// AI post helper (Module C): quiet dates + three drafts with a tracked booking link; nothing posted or sent.
// Harness clock: 2027-01-10 (Sunday) in Bangkok.

const KEY = "sk-ant-test-posts-0123456789abcdefghijklmnop";
const LINK = "https://phasakura.test/th/booking?checkIn=2027-01-12&checkOut=2027-01-13&utm_source=facebook&utm_medium=social&utm_campaign=ai_post_20270112";

describe("post drafts (pure)", () => {
  it("builds the tracked booking link", () => {
    assert.equal(trackedLink("https://phasakura.test", "th", "FACEBOOK", { from: "2027-01-12", today: "2027-01-10" }), LINK);
    assert.equal(trackedLink("https://phasakura.test", "en", "LINE", { from: "2027-01-12", unitSlug: "house-sakura", today: "2027-01-10" }),
      "https://phasakura.test/en/booking?checkIn=2027-01-12&checkOut=2027-01-13&unit=house-sakura&utm_source=line&utm_medium=social&utm_campaign=ai_post_20270112");
    assert.equal(trackedLink("https://phasakura.test", "zh-CN", "INSTAGRAM", { today: "2027-01-10" }),
      "https://phasakura.test/zh-cn/booking?utm_source=instagram&utm_medium=social&utm_campaign=ai_post_20270110");
  });

  it("puts the link in once, removes any other URL, keeps the link when cutting", () => {
    const v = parsePostDraft(JSON.stringify({ variants: [
      { text: "A {LINK} and again {LINK}" }, { text: "No placeholder, see https://evil.example/x and www.spam.test" }, { text: `${"x".repeat(3000)} {LINK}` }, { text: "" },
    ] }), LINK)!;
    assert.equal(v.length, 3);
    assert.equal(v[0]!.text, `A ${LINK} and again`);
    assert.ok(v[1]!.text.endsWith(LINK) && !/evil|spam/.test(v[1]!.text));
    assert.ok(v[2]!.text.length <= 2200 && v[2]!.text.includes(LINK));
    assert.equal(parsePostDraft("nope", LINK), null);
    assert.equal(parsePostDraft(JSON.stringify({ variants: [] }), LINK), null);
  });
});

async function setup(on = true) {
  const h = new Harness({ seed: true });
  const root = await h.login(await h.user({ id: "root_posts", roles: ["SUPER_ADMIN"] }));
  if (on) {
    h.env.AI_API_KEY = KEY;
    await h.api("PUT", "/api/admin/ai-marketing/settings", { token: root, body: { aiEnabled: true } });
  }
  const post = (body: Record<string, unknown>, token = root) => h.api<PostDraftDto>("POST", "/api/admin/ai-marketing/post-drafts", { token, body });
  return { h, root, post };
}

describe("AI post helper", () => {
  it("quiet dates of the next 60 days, with the units to feature", async () => {
    const { h, root } = await setup(false);
    const q = await h.api<QuietDatesDto>("GET", "/api/admin/ai-marketing/quiet-dates?lang=en", { token: root });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.data.from, "2027-01-10");
    assert.equal(q.data.days, 60);
    assert.ok(q.data.quietRuns.length >= 1);
    assert.ok(q.data.units.some((u) => u.id === "dev_house_01" && u.slug));
    const viewer = await h.user({ id: "dash_posts" });
    h.grant("dash_posts", "dashboard.view");
    assert.equal((await h.api("GET", "/api/admin/ai-marketing/quiet-dates", { token: await h.login(viewer) })).status, 403);
  });

  it("three drafts with the tracked link; the owner's offer and unit facts go to the AI, no guest data; audited", async () => {
    const { h, post } = await setup();
    const r = await post({ channel: "FACEBOOK", lang: "th", from: "2027-01-12", to: "2027-01-14", unitId: "dev_house_01", offer: "ลด 10% เมื่อพัก 2 คืน", note: "หมอกสวย" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const link = r.data.link;
    assert.match(link, /\/th\/booking\?checkIn=2027-01-12&checkOut=2027-01-13&unit=[a-z0-9-]+&utm_source=facebook&utm_medium=social&utm_campaign=ai_post_20270112$/);
    assert.equal(r.data.variants.length, 3);
    for (const [i, v] of r.data.variants.entries()) {
      assert.ok(v.text.includes(link), "link put in");
      assert.ok(!v.text.includes("{LINK}"));
      assert.equal(v.text, AI_POST_DRAFT.variants[i]!.text.replace("{LINK}", link));
    }
    const call = h.ai.requests[0]!;
    assert.match(String(call.json!.system), /A Facebook page post/);
    assert.match(String(call.json!.system), /Thai/);
    assert.match(call.body, /ลด 10% เมื่อพัก 2 คืน/);
    const facts = JSON.parse(String((call.json!.messages as { content: string }[])[0]!.content).split("\n")[1]!) as { dates: { nights: number }; units: unknown[] };
    assert.equal(facts.dates.nights, 3);
    assert.equal(facts.units.length, 1, "the featured unit only");
    assert.doesNotMatch(call.body, /utm_|https?:\/\//, "the AI never sees or writes the link");
    assert.doesNotMatch(call.body, /BK-|customer|@example\.test/);
    assert.equal(h.audits("AI_DRAFT_POST").length, 1);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_usage WHERE report_id IS NULL AND status = 'OK'")!.n, 1);
  });

  it("refused: AI off, no marketing.edit, bad input", async () => {
    const off = await setup(false);
    const r0 = await off.post({ channel: "LINE", lang: "en" });
    assert.equal(r0.status, 409);
    assert.equal(r0.body.error?.code, "AI_OFF");

    const { h, post } = await setup();
    const viewer = await h.user({ id: "mkt_viewer" });
    h.grant("mkt_viewer", "marketing.view");
    assert.equal((await post({ channel: "LINE", lang: "en" }, await h.login(viewer))).status, 403);
    for (const body of [
      { channel: "TIKTOK", lang: "th" }, { channel: "LINE", lang: "fr" }, { channel: "LINE", lang: "th", from: "2027-01-12" },
      { channel: "LINE", lang: "th", from: "2027-01-12", to: "2027-01-11" }, { channel: "LINE", lang: "th", from: "2027-01-01", to: "2027-06-01" },
      { channel: "LINE", lang: "th", offer: "x".repeat(201) }, { channel: "LINE", lang: "th", unitId: "nope" }, { channel: "LINE", lang: "th", extra: 1 },
    ]) assert.equal((await post(body)).status, 422, JSON.stringify(body));
    assert.equal(h.ai.requests.length, 0);
    const ok = await post({ channel: "INSTAGRAM", lang: "zh-CN" });
    assert.equal(ok.status, 200);
    assert.match(String(h.ai.requests[0]!.json!.system), /Instagram caption[\s\S]*Simplified Chinese|Simplified Chinese[\s\S]*Instagram caption/);
  });
});
