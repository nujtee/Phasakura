import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { FoodCapacityDto, FoodOrderDto } from "../../src/shared/food-admin-types.ts";
import { Harness } from "../helpers/harness.ts";

let seq = 0;
const key = () => `food-key-${String(++seq).padStart(10, "0")}`;

async function staff(h: Harness, perms: string[]) {
  const id = `food_staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

/** Stay 2027-01-12 → 01-14 in House 02 with dinner for 2 on the 12th (dinner deadline: 1 day before). */
async function bookWithDinner(h: Harness, adults = 2) {
  const body = {
    checkIn: "2027-01-12", checkOut: "2027-01-14", adults, children: 0, lang: "th", stay: { kind: "UNIT", unitId: "dev_house_02" },
    food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-12", adults }],
  };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer: { name: "Kitchen Guest", phone: "0812345678" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

const orders = (h: Harness, token: string, query = "from=2027-01-12&to=2027-01-13") =>
  h.api<{ orders: FoodOrderDto[] }>("GET", `/api/admin/food-orders?${query}`, { token });

describe("kitchen orders (spec §24)", () => {
  it("lists orders per service day and moves them forward only once the booking is confirmed", async () => {
    const h = new Harness({ seed: true });
    const kitchen = await staff(h, ["food_orders.view", "food_orders.manage"]);
    const b = await bookWithDinner(h);

    const list = await orders(h, kitchen);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const order = list.data.orders.find((o) => o.bookingCode === b.bookingCode)!;
    assert.equal(order.categoryCode, "DINNER");
    assert.equal(order.status, "PENDING");
    assert.equal(order.customerName, null, "no customer names without bookings.view");
    assert.deepEqual(order.lines.map((l) => [l.name, l.quantity]), [["อาหารเย็น A", 2]]);

    const early = await h.api("PATCH", `/api/admin/food-orders/${order.id}`, { token: kitchen, body: { status: "PREPARING", expectedStatus: "PENDING" } });
    assert.equal(early.error?.code, "BOOKING_NOT_CONFIRMED");
    const noteOnly = await h.api<{ kitchenNote: string }>("PATCH", `/api/admin/food-orders/${order.id}`, {
      token: kitchen, body: { status: "PENDING", expectedStatus: "PENDING", kitchenNote: "แพ้ถั่ว" },
    });
    assert.equal(noteOnly.data.kitchenNote, "แพ้ถั่ว");

    const finance = await staff(h, ["payments.verify"]);
    await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, {
      token: finance, body: { amountSatang: b.totalSatang, method: "CASH", paidAt: "2027-01-10T02:00:00Z" },
    });

    const prep = await h.api("PATCH", `/api/admin/food-orders/${order.id}`, { token: kitchen, body: { status: "PREPARING", expectedStatus: "PENDING" } });
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    const stale = await h.api("PATCH", `/api/admin/food-orders/${order.id}`, { token: kitchen, body: { status: "READY", expectedStatus: "PENDING" } });
    assert.equal(stale.error?.code, "ORDER_CHANGED");
    const back = await h.api("PATCH", `/api/admin/food-orders/${order.id}`, { token: kitchen, body: { status: "CONFIRMED", expectedStatus: "PREPARING" } });
    assert.equal(back.error?.code, "FOOD_ORDER_STATUS_TRANSITION");
    const cancel = await h.api("PATCH", `/api/admin/food-orders/${order.id}`, { token: kitchen, body: { status: "CANCELLED", expectedStatus: "PREPARING" } });
    assert.equal(cancel.error?.code, "ORDER_CANCEL_VIA_BOOKING");
    const served = await h.api("PATCH", `/api/admin/food-orders/${order.id}`, { token: kitchen, body: { status: "SERVED", expectedStatus: "PREPARING" } });
    assert.equal(served.status, 200);
    assert.equal(h.audits("UPDATE_FOOD_ORDER").length, 3);

    // DB guard (migration 0015): no step backwards even with direct SQL.
    assert.throws(() => h.db.run("UPDATE food_orders SET status = 'READY' WHERE id = ?", order.id), /FOOD_ORDER_STATUS_TRANSITION/);

    const viewer = await staff(h, ["food_orders.view"]);
    assert.equal((await h.api("PATCH", `/api/admin/food-orders/${order.id}`, { token: viewer, body: { status: "SERVED", expectedStatus: "SERVED" } })).status, 403);
    const filtered = await orders(h, viewer, "from=2027-01-12&to=2027-01-13&status=SERVED");
    assert.equal(filtered.data.orders.length, 1);
    assert.equal((await orders(h, viewer, "from=2027-01-12&to=2027-01-13&status=EATEN")).status, 422);
  });

  it("booking cancellation still cancels kitchen orders in any state", async () => {
    const h = new Harness({ seed: true });
    const admin = await staff(h, ["food_orders.view", "food_orders.manage", "payments.verify", "bookings.cancel"]);
    const b = await bookWithDinner(h);
    await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, {
      token: admin, body: { amountSatang: b.totalSatang, method: "CASH", paidAt: "2027-01-10T02:00:00Z" },
    });
    const order = (await orders(h, admin)).data.orders[0]!;
    await h.api("PATCH", `/api/admin/food-orders/${order.id}`, { token: admin, body: { status: "READY", expectedStatus: "PENDING" } });
    const cancel = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: admin, body: { reason: "guest asked" } });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal((await orders(h, admin)).data.orders[0]!.status, "CANCELLED");
  });
});

describe("daily food capacity (spec §22)", () => {
  it("shows used vs limit per day and refuses a limit below portions sold", async () => {
    const h = new Harness({ seed: true });
    const chef = await staff(h, ["food.view", "food.edit"]);
    await bookWithDinner(h, 3);
    const cap = await h.api<FoodCapacityDto>("GET", "/api/admin/food/capacity?from=2027-01-12&to=2027-01-14", { token: chef });
    assert.equal(cap.status, 200, JSON.stringify(cap.body));
    const dinner = cap.data.cells.find((c) => c.categoryId === "dev_food_dinner" && c.date === "2027-01-12")!;
    assert.deepEqual([dinner.max, dinner.used, dinner.overridden], [50, 3, false]);
    assert.equal(cap.data.cells.find((c) => c.categoryId === "dev_food_other")?.max, null, "unlimited category");

    const below = await h.api("PUT", "/api/admin/food/capacity/dev_food_dinner/2027-01-12", { token: chef, body: { maxQuantity: 2 } });
    assert.equal(below.error?.code, "CAPACITY_BELOW_USED");
    const unlimited = await h.api("PUT", "/api/admin/food/capacity/dev_food_other/2027-01-12", { token: chef, body: { maxQuantity: 5 } });
    assert.equal(unlimited.error?.code, "CATEGORY_UNLIMITED");
    const past = await h.api("PUT", "/api/admin/food/capacity/dev_food_dinner/2027-01-01", { token: chef, body: { maxQuantity: 5 } });
    assert.equal(past.error?.details?.date, "DATE_IN_PAST");
    const set = await h.api<FoodCapacityDto>("PUT", "/api/admin/food/capacity/dev_food_dinner/2027-01-12", { token: chef, body: { maxQuantity: 3 } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.data.cells.find((c) => c.categoryId === "dev_food_dinner")?.overridden, true);

    // Full now: a new dinner for that day is refused by the booking flow.
    const q = await h.api("POST", "/api/public/bookings/quote", { body: {
      checkIn: "2027-01-12", checkOut: "2027-01-13", adults: 1, children: 0, lang: "th", stay: { kind: "UNIT", unitId: "dev_vip_01" },
      food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-12", adults: 1 }],
    } });
    assert.equal(q.error?.code, "FOOD_CAPACITY_EXCEEDED");

    const reset = await h.api<FoodCapacityDto>("PUT", "/api/admin/food/capacity/dev_food_dinner/2027-01-12", { token: chef, body: { maxQuantity: null } });
    assert.equal(reset.data.cells.find((c) => c.categoryId === "dev_food_dinner")?.max, 50);
    const viewer = await staff(h, ["food.view"]);
    assert.equal((await h.api("PUT", "/api/admin/food/capacity/dev_food_dinner/2027-01-12", { token: viewer, body: { maxQuantity: 9 } })).status, 403);
  });
});
