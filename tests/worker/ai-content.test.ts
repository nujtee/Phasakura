import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminUnitDto } from "../../src/shared/accommodation-types.ts";
import type { UnitTextDraftDto } from "../../src/shared/ai-content-types.ts";
import { parseUnitDraft } from "../../src/worker/ai-marketing/content-writer.ts";
import { jsonResponse } from "../helpers/fake-http.ts";
import { Harness } from "../helpers/harness.ts";

// AI content helper (Module B): drafts of a house's texts in one language; nothing saved; same switch / key / budget
// as the marketing report.

const KEY = "sk-ant-test-content-0123456789abcdefghijklmnop";
const DRAFT = {
  name: "Sakura House", shortDescription: "A quiet wooden house for four.",
  description: "Wake up to the hills.\n\nThe house sleeps four, with a terrace and a kitchen.", seoTitle: "Sakura House | Phasakura",
  seoDescription: "Wooden house for up to four guests with terrace and kitchen at Phasakura — book direct for the best price.",
};
const answer = (o: unknown) => () => jsonResponse({ content: [{ type: "text", text: JSON.stringify(o) }], model: "claude-sonnet-5-5", usage: { input_tokens: 900, output_tokens: 400 } });

describe("unit draft answer (pure)", () => {
  it("keeps the fields within the form's limits; refuses answers without a name or description", () => {
    const d = parseUnitDraft(JSON.stringify({ ...DRAFT, name: "N".repeat(200), description: `${"Long sentence here. ".repeat(400)}` }), "en")!;
    assert.equal(d.name.length, 120);
    assert.ok(d.description.length <= 5000);
    assert.equal(parseUnitDraft(JSON.stringify({ name: "x" }), "en"), null);
    assert.equal(parseUnitDraft("Sorry", "en"), null);
    assert.deepEqual(parseUnitDraft(`\`\`\`json\n${JSON.stringify(DRAFT)}\n\`\`\``, "en"), DRAFT);
  });
});

async function setup(on = true) {
  const h = new Harness({ seed: true });
  const root = await h.login(await h.user({ id: "root_content", roles: ["SUPER_ADMIN"] }));
  if (on) {
    h.env.AI_API_KEY = KEY;
    await h.api("PUT", "/api/admin/ai-marketing/settings", { token: root, body: { aiEnabled: true } });
  }
  h.ai.respond = answer(DRAFT);
  const draft = (body: Record<string, unknown>, token = root, unit = "dev_house_01") =>
    h.api<UnitTextDraftDto>("POST", `/api/admin/accommodations/${unit}/ai-draft`, { token, body });
  return { h, root, draft };
}

describe("AI draft of a house's texts", () => {
  it("translates into English from the form's Thai text; nothing saved; facts only; recorded", async () => {
    const { h, draft } = await setup();
    const before = JSON.stringify(h.db.all("SELECT * FROM accommodation_translations WHERE unit_id = 'dev_house_01' ORDER BY language_code"));
    const res = await draft({ lang: "en", mode: "TRANSLATE", texts: { th: { name: "บ้านซากุระ (แก้ใหม่)", description: "บ้านไม้เงียบสงบ มีระเบียง" } } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.data, { ...DRAFT, model: "claude-sonnet-5-5" });
    assert.equal(JSON.stringify(h.db.all("SELECT * FROM accommodation_translations WHERE unit_id = 'dev_house_01' ORDER BY language_code")), before, "not saved");

    const call = h.ai.requests[0]!;
    assert.equal(call.headers.get("x-api-key"), KEY);
    assert.match(String(call.json!.system), /Translate the Thai texts of this accommodation into English/);
    assert.match(call.body, /บ้านซากุระ \(แก้ใหม่\)/, "the form's unsaved Thai text is used");
    assert.match(call.body, /pricePerNightBaht/);
    assert.doesNotMatch(call.body, /booking_code|BK-|customer|@example\.test|08\d{8}/);
    assert.equal(h.audits("AI_DRAFT_UNIT_TEXT").length, 1);
    assert.deepEqual(h.db.all<{ report_id: string | null; status: string }>("SELECT report_id, status FROM ai_usage").map((u) => ({ ...u })), [{ report_id: null, status: "OK" }]);
  });

  it("Thai: write from the facts; a unit without Thai text cannot be translated", async () => {
    const { h, root, draft } = await setup();
    const w = await draft({ lang: "th", mode: "WRITE" });
    assert.equal(w.status, 200);
    assert.match(String(h.ai.requests[0]!.json!.system), /Write the texts of this accommodation in Thai/);
    const made = await h.api<AdminUnitDto>("POST", "/api/admin/accommodations", {
      token: root, body: { unitCode: "HOUSE-88", unitType: "HOUSE", slug: "house-88", basePriceSatang: 150_000, paymentMode: "FULL", standardGuests: 2, maxGuests: 2 },
    });
    const t = await draft({ lang: "en", mode: "TRANSLATE" }, root, made.data.id);
    assert.equal(t.status, 422);
    assert.equal(t.body.error?.details?.mode, "THAI_TEXT_REQUIRED");
  });

  it("refused: AI off, no permission, bad input, budget used up, unreadable answer, 30 a day", async () => {
    const off = await setup(false);
    const r0 = await off.draft({ lang: "en", mode: "WRITE" });
    assert.equal(r0.status, 409);
    assert.equal(r0.body.error?.code, "AI_OFF");
    assert.equal(off.h.ai.requests.length, 0);

    const { h, root, draft } = await setup();
    const viewer = await h.user({ id: "acc_viewer" });
    h.grant("acc_viewer", "accommodation.view");
    assert.equal((await draft({ lang: "en", mode: "WRITE" }, await h.login(viewer))).status, 403);
    assert.equal((await draft({ lang: "fr", mode: "WRITE" })).status, 422);
    assert.equal((await draft({ lang: "en", mode: "POEM" })).status, 422);
    assert.equal((await draft({ lang: "en", mode: "WRITE", texts: { th: { name: "x".repeat(200) } } })).status, 422);
    assert.equal((await draft({ lang: "en", mode: "WRITE", extra: 1 })).status, 422);

    h.ai.respond = answer({ nope: true });
    const bad = await draft({ lang: "en", mode: "WRITE" });
    assert.equal(bad.status, 502);
    assert.equal(bad.body.error?.code, "AI_FAILED");

    await h.api("PUT", "/api/admin/ai-marketing/settings", { token: root, body: { monthlyBudgetSatang: 0 } });
    const broke = await draft({ lang: "en", mode: "WRITE" });
    assert.equal(broke.status, 409);
    assert.equal(broke.body.error?.code, "AI_BUDGET_REACHED");
    await h.api("PUT", "/api/admin/ai-marketing/settings", { token: root, body: { monthlyBudgetSatang: 10_000_000 } });
    h.ai.respond = answer(DRAFT);
    for (let i = 0; i < 28; i++) assert.equal((await draft({ lang: "en", mode: "WRITE" })).status, 200, `draft ${i}`);
    assert.equal((await draft({ lang: "en", mode: "WRITE" })).status, 429, "31st today");
  });
});
