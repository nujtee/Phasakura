import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, FoodCatalogueDto, MassageSettingsDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { mapInventoryError } from "../../src/worker/services/booking.service.ts";
import type { D1DatabaseLike } from "../../src/worker/env.ts";
import { LineFormatter } from "../../src/worker/line/line-templates.ts";
import { LineRepository } from "../../src/worker/repositories/line.repository.ts";
import { Harness } from "../helpers/harness.ts";

// Health massage (migration 0050). Harness clock: 2027-01-10 Bangkok. House 01 ฿3,500 / night.
let seq = 0;
const key = () => `massage-key-${String(++seq).padStart(8, "0")}`;
const PHONE = "0812345678";
const stay = { kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0 };
const body = (massages?: unknown) => ({ checkIn: "2027-02-01", checkOut: "2027-02-03", stays: [stay], food: [], ...(massages === undefined ? {} : { massages }), lang: "th" });

async function setup() {
  const h = new Harness({ seed: true });
  const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const get = () => h.api<MassageSettingsDto>("GET", "/api/admin/massage", { token: admin });
  const save = async (b: Record<string, unknown>, token = admin) => h.api<MassageSettingsDto>("PUT", "/api/admin/massage", { token, body: b });
  const on = async () => {
    const s = (await get()).data;
    const res = await save({ enabled: true, items: s.items });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.data;
  };
  const quote = (massages?: unknown) => h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: body(massages) });
  const menu = () => h.api<FoodCatalogueDto>("GET", "/api/public/food-options?checkIn=2027-02-01&checkOut=2027-02-03&lang=en");
  return { h, admin, get, save, on, quote, menu };
}

describe("health massage — settings and menu", () => {
  it("off by default with the sample menu; the booking page sees it only when on; the owner edits names, lengths and prices", async () => {
    const { h, get, save, on, menu, admin } = await setup();
    const first = (await get()).data;
    assert.equal(first.enabled, false);
    assert.equal(first.items.length, 9);
    assert.deepEqual(first.items[0], { id: "massage_thai", nameTh: "นวดแผนไทย", nameEn: "Traditional Thai Massage", nameZh: null, active: true,
      options: [{ id: "massage_thai_60", minutes: 60, priceSatang: 35000 }, { id: "massage_thai_120", minutes: 120, priceSatang: 70000 }] });
    assert.equal((await menu()).data.massage, null);

    await on();
    const m = (await menu()).data.massage!;
    assert.equal(m.items.length, 9);
    assert.deepEqual([m.items[0]!.name, m.items[0]!.subName], ["Traditional Thai Massage", "นวดแผนไทย"]);
    assert.equal(h.audits("UPDATE_MASSAGE").length, 1);

    // Edit: a 90-minute length, a hidden treatment, a new one (ids made by the server).
    const items = (await get()).data.items;
    items[0]!.options.push({ id: "", minutes: 90, priceSatang: 52000 });
    items[1]!.active = false;
    const saved = await save({ enabled: true, items: [...items.map((i) => ({ ...i, options: i.options.map((o) => (o.id ? o : { minutes: o.minutes, priceSatang: o.priceSatang })) })),
      { nameTh: "นวดสปอร์ต", options: [{ minutes: 45, priceSatang: 30000 }] }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.data.items[0]!.options.map((o) => o.minutes), [60, 90, 120]);
    assert.equal(saved.data.items.at(-1)!.nameTh, "นวดสปอร์ต");
    assert.match(saved.data.items.at(-1)!.id, /^[0-9a-f-]{36}$/);
    const listed = (await menu()).data.massage!.items.map((i) => i.id);
    assert.ok(!listed.includes("massage_balm"), "hidden treatment not offered");

    // Validation and permissions.
    const bad = async (b: Record<string, unknown>) => (await save({ enabled: true, ...b })).error?.details ?? {};
    assert.equal((await bad({ items: [{ nameTh: "", options: [{ minutes: 60, priceSatang: 1 }] }] }))["items.0.nameTh"], "REQUIRED");
    assert.equal((await bad({ items: [{ nameTh: "x", options: [] }] }))["items.0.options"], "INVALID_VALUE");
    assert.equal((await bad({ items: [{ nameTh: "x", options: [{ minutes: 5, priceSatang: 1 }] }] }))["items.0.options.0.minutes"], "OUT_OF_RANGE");
    assert.equal((await bad({ items: [{ nameTh: "x", options: [{ minutes: 60, priceSatang: 1 }, { minutes: 60, priceSatang: 2 }] }] }))["items.0.options.1.minutes"], "DUPLICATE");
    assert.equal((await bad({ items: [] })).items, "EMPTY_MENU");
    const editorId = `editor_${++seq}`;
    const editor = await h.login(await h.user({ id: editorId }));
    h.grant(editorId, "accommodation.edit");
    h.grant(editorId, "accommodation.view");
    const current = (await get()).data.items;
    assert.equal((await save({ enabled: false, items: current }, editor)).status, 200, "on / off without pricing.edit");
    current[0]!.options[0]!.priceSatang = 1;
    assert.equal((await save({ enabled: true, items: current }, editor)).status, 403, "a price change needs pricing.edit");
    assert.equal((await h.api("PUT", "/api/admin/massage", { token: admin, body: { enabled: true, items: current, extra: 1 } })).status, 422);
  });
});

describe("health massage — booking", () => {
  it("priced from D1, paid in full now, kept as a snapshot, shown to guest and staff, in the staff notice", async () => {
    const { h, admin, on, quote, save, get } = await setup();
    await on();
    const q = await quote([{ optionId: "massage_thai_60", quantity: 2 }, { optionId: "massage_oil_120", quantity: 1 }]);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.data.massages!.map((l) => [l.name, l.minutes, l.quantity, l.subtotalSatang]),
      [["นวดแผนไทย", 60, 2, 70000], ["นวดน้ำมัน", 120, 1, 90000]]);
    assert.equal(q.data.massageSubtotalSatang, 160000);
    assert.equal(q.data.foodSubtotalSatang, 0, "food stays food");
    assert.equal(q.data.totalSatang, 700000 + 160000 + (q.data.appFee?.totalSatang ?? 0));

    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body([{ optionId: "massage_thai_60", quantity: 2 }, { optionId: "massage_oil_120", quantity: 1 }]),
        customer: { name: "Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.data.massageSubtotalSatang, 160000);
    assert.equal(res.data.foodSubtotalSatang, 0);
    assert.equal(res.data.paymentInstructions?.amountDueSatang, res.data.totalSatang);

    // A later price change does not touch the booking; the snapshot is frozen.
    const items = (await get()).data.items;
    items[0]!.options[0]!.priceSatang = 99900;
    await save({ enabled: true, items });
    const detail = await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${res.data.bookingCode}`, { token: admin });
    assert.equal(detail.data.massages![0]!.subtotalSatang, 70000);
    assert.throws(() => h.db.run("UPDATE booking_massages SET quantity = 9"), /SNAPSHOT_IMMUTABLE/);
    assert.throws(() => h.db.run("DELETE FROM booking_massages"), /SNAPSHOT_IMMUTABLE/);
    // Staff messages (LINE / e-mail) list the massages.
    const bookingId = h.db.get<{ id: string }>("SELECT id FROM bookings WHERE booking_code = ?", res.data.bookingCode)!.id;
    const [msg] = await new LineRepository(h.env.DB as D1DatabaseLike).messageBookings([bookingId], "th");
    assert.deepEqual(msg!.massages, [{ name: "นวดแผนไทย", minutes: 60, quantity: 2 }, { name: "นวดน้ำมัน", minutes: 120, quantity: 1 }]);
    assert.match(new LineFormatter("th").bookingBlock(msg!), /นวดเพื่อสุขภาพ:\n• นวดแผนไทย 60 นาที ×2\n• นวดน้ำมัน 120 นาที ×1/);
  });

  it("refused when off, for an unknown or hidden length, a bad quantity or a duplicate", async () => {
    const { save, get, on, quote } = await setup();
    const off = await quote([{ optionId: "massage_thai_60", quantity: 1 }]);
    assert.equal(off.status, 409);
    assert.equal(off.error?.code, "MASSAGE_UNAVAILABLE");
    await on();
    assert.equal((await quote([{ optionId: "nope", quantity: 1 }])).error?.details?.["massages.0.optionId"], "UNKNOWN_OPTION");
    assert.equal((await quote([{ optionId: "massage_thai_60", quantity: 0 }])).status, 422);
    assert.equal((await quote([{ optionId: "massage_thai_60", quantity: 21 }])).status, 422);
    assert.equal((await quote([{ optionId: "massage_thai_60", quantity: 1, price: 1 }])).status, 422);
    assert.equal((await quote([{ optionId: "massage_thai_60", quantity: 1 }, { optionId: "massage_thai_60", quantity: 1 }])).error?.details?.["massages.1.optionId"], "DUPLICATE");
    const items = (await get()).data.items;
    items[0]!.active = false;
    await save({ enabled: true, items });
    assert.equal((await quote([{ optionId: "massage_thai_60", quantity: 1 }])).error?.details?.["massages.0.optionId"], "UNKNOWN_OPTION");
    assert.equal((mapInventoryError(new Error("D1_ERROR: MASSAGE_UNAVAILABLE")) as { code: string }).code, "MASSAGE_UNAVAILABLE");
  });
});
