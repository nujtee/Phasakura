import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AdminBookingDto, BookingMoveOptionsDto, BookingMoveRoomsDto, GuestMoveRequestDto, GuestMoveStartDto, MoveSettingsDto, PublicBookingDto, QuoteDto,
} from "../../src/shared/booking-types.ts";
import type { SlipQueueDto } from "../../src/shared/payment-types.ts";
import type { ProviderResult, SlipVerifier } from "../../src/worker/slip/slip-verifier.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

// Guests move their own stay (migration 0045). Harness clock: 2027-01-10T03:00Z (Bangkok 10:00).
// House 01 ฿3,500 / night, House 02 ฿3,200. Seed account 000-0-00000-0 / PromptPay 0000000000.
let seq = 0;
const key = () => `gmove-key-${String(++seq).padStart(9, "0")}`;
const PHONE = "0812345678";
const GROUP = `C${"f".repeat(32)}`;
const slipImage = (n: number) => ({ bytes: pngBytes(700 + n, 950), name: `move${n}.png`, type: "image/png" });

const verifier = (amountSatang: number): SlipVerifier => ({
  provider: "easyslip",
  verify: async (): Promise<ProviderResult> => ({
    kind: "OK",
    slip: {
      transactionRef: `MOVE${++seq}`, amountSatang, transferredAt: "2027-01-10T03:01:30.000Z", senderBank: "KBANK",
      receiverBank: "DEV", receiverAccountMasked: "xxx-x-x0000-x", receiverProxyMasked: null,
    },
  }),
});

async function setup() {
  const h = new Harness({ seed: true });
  const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const settings = (b: Partial<MoveSettingsDto> = {}) =>
    h.api<MoveSettingsDto>("PUT", "/api/admin/move-settings", { token: admin, body: { enabled: true, feeSatang: 30_000, minDaysBefore: 3, maxMoves: 1, payMinutes: 60, ...b } });
  /** A booking paid in full by staff (CONFIRMED), then a minute passes. */
  const confirmed = async (unitId = "dev_house_01", checkIn = "2027-02-01", checkOut = "2027-02-03", phone = PHONE) => {
    const body = { checkIn, checkOut, adults: 2, children: 0, stay: { kind: "UNIT", unitId }, food: [], lang: "th" };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Moving Guest", phone }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const paid = await h.api("POST", `/api/admin/bookings/${res.data.bookingCode}/payments`, {
      token: admin, body: { amountSatang: res.data.totalSatang, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:00:00Z" },
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    h.advance(60_000);
    return res.data;
  };
  const guest = (path: string, code: string, extra: Record<string, unknown> = {}, phone = PHONE) =>
    h.api<unknown>("POST", `/api/public/bookings/move${path}`, { body: { bookingCode: code, phone, ...extra } });
  const start = async (code: string) => (await guest("/start", code)) as { status: number; data: GuestMoveStartDto; error?: { code: string } };
  const ask = async (code: string, checkIn: string, rooms?: { itemId: string; unitId: string }[]) =>
    (await guest("", code, { checkIn, ...(rooms ? { rooms } : {}) })) as { status: number; data: GuestMoveRequestDto; error?: { code: string } };
  const sendSlip = (code: string, n: number) => h.multipart<{ outcome: string; move: GuestMoveStartDto }>(null, "/api/public/bookings/move/slip",
    [["bookingCode", code], ["phone", PHONE], ["file", slipImage(n)], ["channel", "PROMPTPAY"]]);
  const get = async (code: string) => (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${code}`, { token: admin })).data;
  const holds = () => h.db.all<{ unit_id: string; stay_date: string }>(
    "SELECT unit_id, stay_date FROM booking_unit_nights WHERE block_reason LIKE 'MOVE_HOLD:%' ORDER BY unit_id, stay_date").map((r) => `${r.unit_id}|${r.stay_date}`);
  const nights = (code: string) => h.db.all<{ unit_id: string; stay_date: string }>(
    "SELECT n.unit_id, n.stay_date FROM booking_unit_nights n JOIN bookings b ON b.id = n.booking_id WHERE b.booking_code = ? ORDER BY n.unit_id, n.stay_date", code)
    .map((r) => `${r.unit_id}|${r.stay_date}`);
  return { h, admin, settings, confirmed, guest, start, ask, sendSlip, get, holds, nights };
}

describe("guest moves the stay — settings and who may", () => {
  it("off until staff switch it on; Booking ID + phone; only confirmed bookings, far enough ahead, so many times", async () => {
    const { h, admin, settings, confirmed, start, guest } = await setup();
    const b = await confirmed();
    assert.equal((await start(b.bookingCode)).data.blocked, "MOVE_NOT_OFFERED");
    const first = await h.api<MoveSettingsDto>("GET", "/api/admin/move-settings", { token: admin });
    assert.deepEqual({ ...first.data, updatedAt: null }, { enabled: false, feeSatang: 0, minDaysBefore: 3, maxMoves: 1, payMinutes: 60, updatedAt: null });
    const saved = await settings();
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(h.audits("UPDATE_MOVE_SETTINGS").length, 1);
    for (const bad of [{ minDaysBefore: -1 }, { maxMoves: 0 }, { payMinutes: 5 }, { feeSatang: -1 }]) {
      assert.equal((await settings(bad)).status, 422, JSON.stringify(bad));
    }

    const s = await start(b.bookingCode);
    assert.equal(s.status, 200, JSON.stringify(s));
    assert.deepEqual([s.data.blocked, s.data.feeSatang, s.data.movesLeft, s.data.earliest], [null, 30_000, 1, "2027-01-13"]);
    assert.deepEqual(s.data.stays.map((x) => x.name), ["House 01 — บ้านซากุระ"]);
    // The wrong phone gets the same answer as an unknown booking.
    assert.equal((await guest("/start", b.bookingCode, {}, "0899999999")).status, 404);

    // Too close to the check-in: no.
    const soon = await confirmed("dev_house_02", "2027-01-12", "2027-01-13");
    assert.equal((await start(soon.bookingCode)).data.blocked, "MOVE_TOO_LATE");
  });

  it("calendar: days before the earliest read as past; a taken day as taken", async () => {
    const { settings, confirmed, guest } = await setup();
    await settings();
    const b = await confirmed();
    await confirmed("dev_house_01", "2027-02-10", "2027-02-12", "0811111111");
    const cal = (await guest("/calendar", b.bookingCode, { from: "2027-01-11", days: 31 })) as { status: number; data: BookingMoveOptionsDto };
    assert.equal(cal.status, 200, JSON.stringify(cal));
    const state = (d: string) => cal.data.days.find((x) => x.date === d)?.state;
    assert.equal(state("2027-01-12"), "PAST", "before the earliest");
    assert.equal(state("2027-01-20"), "OK");
    assert.equal(state("2027-02-01"), "CURRENT");
    assert.equal(state("2027-02-10"), "OTHER_UNITS", "House 01 taken, House 02 free");
  });
});

describe("guest moves the stay — request, slip, verified → moved", () => {
  it("holds the new nights, asks fee + nothing more (same price), moves once the slip is verified; staff and the money follow", async () => {
    const { h, admin, settings, confirmed, start, ask, sendSlip, get, holds, nights } = await setup();
    h.lineSecrets();
    h.db.run("UPDATE line_settings SET enabled = 1");
    await h.api("POST", "/api/admin/line/recipients", { token: admin, body: { targetId: GROUP, name: "Owners", language: "th", notifyPayment: false, notifyBooking: true } });
    await settings();
    const b = await confirmed();
    const req = await ask(b.bookingCode, "2027-02-15");
    assert.equal(req.status, 201, JSON.stringify(req));
    assert.deepEqual([req.data.status, req.data.feeSatang, req.data.diffSatang, req.data.amountSatang], ["AWAITING_PAYMENT", 30_000, 0, 30_000]);
    assert.equal(req.data.paymentInstructions?.amountDueSatang, 30_000);
    assert.ok(req.data.paymentInstructions?.promptpayPayload?.includes("5406300.00"), "PromptPay QR for the fee");
    assert.deepEqual(holds(), ["dev_house_01|2027-02-15", "dev_house_01|2027-02-16"]);
    assert.deepEqual(nights(b.bookingCode), ["dev_house_01|2027-02-01", "dev_house_01|2027-02-02"], "nothing moved yet");
    // Held: another guest cannot take those nights; the same guest cannot ask twice.
    const other = await h.api("POST", "/api/public/bookings/quote", {
      body: { checkIn: "2027-02-15", checkOut: "2027-02-16", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th" },
    });
    assert.equal(other.status, 409);
    assert.equal((await ask(b.bookingCode, "2027-02-20")).error?.code, "MOVE_REQUEST_OPEN");
    const asked = h.db.all<{ notification_type: string; payload_json: string }>("SELECT notification_type, payload_json FROM notification_logs WHERE notification_type = 'BOOKING_MOVE'");
    assert.equal(asked.length, 1);
    assert.equal(JSON.parse(asked[0]!.payload_json).event, "REQUESTED");

    // The slip: the request goes under review; staff see it in Slips as a move.
    const sent = await sendSlip(b.bookingCode, 1);
    assert.equal(sent.status, 201, JSON.stringify(sent.error));
    assert.equal(sent.data.outcome, "PENDING_REVIEW");
    assert.equal(sent.data.move.request?.status, "REVIEWING");
    const queue = await h.api<SlipQueueDto>("GET", "/api/admin/slips", { token: admin });
    const item = queue.data.items.find((x) => x.bookingCode === b.bookingCode)!;
    assert.equal(item.move, true);
    assert.equal(item.amountSatang, 30_000);

    const ok = await h.api("POST", `/api/admin/payments/${item.paymentId}/verify`, { token: admin, body: {} });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = await get(b.bookingCode);
    assert.deepEqual([after.checkIn, after.checkOut], ["2027-02-15", "2027-02-17"]);
    assert.equal(after.totalSatang, b.totalSatang + 30_000, "fee joins the booking");
    assert.equal(after.balanceSatang, 0, "and is paid");
    assert.deepEqual(after.moveCharges, [{ toCheckIn: "2027-02-15", feeSatang: 30_000, diffSatang: 0 }]);
    assert.equal(after.moveRequests?.[0]?.status, "APPROVED");
    assert.deepEqual(holds(), []);
    assert.deepEqual(nights(b.bookingCode), ["dev_house_01|2027-02-15", "dev_house_01|2027-02-16"]);
    const events = h.db.all<{ payload_json: string }>("SELECT payload_json FROM notification_logs WHERE notification_type = 'BOOKING_MOVE' ORDER BY created_at")
      .map((r) => JSON.parse(r.payload_json).event);
    assert.deepEqual(events, ["REQUESTED", "SLIP", "APPROVED"]);
    // One move allowed.
    assert.equal((await start(b.bookingCode)).data.blocked, "MOVE_LIMIT");
  });

  it("their house is taken on the new day: another free one; a dearer one adds the difference; an automatic slip check moves it", async () => {
    const { h, settings, confirmed, guest, ask, sendSlip, get, holds } = await setup();
    await settings();
    const b = await confirmed("dev_house_02");
    await confirmed("dev_house_02", "2027-02-20", "2027-02-22", "0811111111");
    const rooms = (await guest("/rooms", b.bookingCode, { checkIn: "2027-02-20" })) as { status: number; data: BookingMoveRoomsDto };
    assert.equal(rooms.status, 200, JSON.stringify(rooms));
    assert.equal(rooms.data.state, "OTHER_UNITS");
    const stay = rooms.data.stays[0]!;
    assert.equal(stay.suggested, "dev_house_01");
    const req = await ask(b.bookingCode, "2027-02-20", [{ itemId: stay.itemId, unitId: "dev_house_01" }]);
    assert.equal(req.status, 201, JSON.stringify(req));
    assert.deepEqual([req.data.diffSatang, req.data.amountSatang], [60_000, 90_000], "2 nights × ฿300 more + ฿300 fee");
    assert.deepEqual(req.data.rooms.map((r) => [r.fromUnitId, r.toUnitId]), [["dev_house_02", "dev_house_01"]]);

    h.verifier(verifier(90_000));
    const sent = await sendSlip(b.bookingCode, 2);
    assert.equal(sent.status, 201, JSON.stringify(sent.error));
    assert.equal(sent.data.outcome, "VERIFIED");
    assert.equal(sent.data.move.request?.status, "APPROVED");
    const after = await get(b.bookingCode);
    assert.deepEqual([after.checkIn, after.items[0]!.unitId], ["2027-02-20", "dev_house_01"]);
    assert.equal(after.totalSatang, b.totalSatang + 90_000);
    assert.equal(after.balanceSatang, 0);
    assert.deepEqual(holds(), []);
  });

  it("slip turned down: the request ends, the nights go back, the booking keeps its dates; not paid in time: expires", async () => {
    const { h, admin, settings, confirmed, ask, sendSlip, get, holds, start, guest } = await setup();
    await settings({ maxMoves: 3 });
    const b = await confirmed();
    await ask(b.bookingCode, "2027-02-15");
    await sendSlip(b.bookingCode, 3);
    const queue = await h.api<SlipQueueDto>("GET", "/api/admin/slips", { token: admin });
    const item = queue.data.items.find((x) => x.bookingCode === b.bookingCode)!;
    const cancelToo = await h.api("POST", `/api/admin/payments/${item.paymentId}/reject`, { token: admin, body: { reason: "Wrong amount", cancelBooking: true } });
    assert.equal(cancelToo.status, 409, "a move's slip never cancels the booking");
    const no = await h.api("POST", `/api/admin/payments/${item.paymentId}/reject`, { token: admin, body: { reason: "Wrong amount" } });
    assert.equal(no.status, 200, JSON.stringify(no.body));
    const after = await get(b.bookingCode);
    assert.deepEqual([after.status, after.checkIn, after.totalSatang], ["CONFIRMED", "2027-02-01", b.totalSatang]);
    assert.equal(after.moveRequests?.[0]?.status, "REJECTED");
    assert.equal(after.moveRequests?.[0]?.reason, "Wrong amount");
    assert.deepEqual(holds(), []);
    assert.equal((await start(b.bookingCode)).data.request?.status, "REJECTED");

    // Asked again, never paid: the cron ends it once its time is up.
    await ask(b.bookingCode, "2027-02-18");
    assert.equal(holds().length, 2);
    h.advance(61 * 60_000);
    await h.app.scheduled(h.env);
    assert.equal((await start(b.bookingCode)).data.request?.status, "EXPIRED");
    assert.deepEqual(holds(), []);
    const late = await sendSlip(b.bookingCode, 4);
    assert.equal(late.status, 409);

    // Given up by the guest.
    await ask(b.bookingCode, "2027-02-18");
    const gaveUp = (await guest("/cancel", b.bookingCode)) as { status: number; data: GuestMoveRequestDto };
    assert.equal(gaveUp.data.status, "CANCELLED");
    assert.deepEqual(holds(), []);
  });

  it("staff cannot move the dates while the guest's move is open; camping bookings cannot move online", async () => {
    const { h, admin, settings, confirmed, ask, start } = await setup();
    await settings();
    const b = await confirmed();
    await ask(b.bookingCode, "2027-02-15");
    const staff = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/move`, { token: admin, body: { checkIn: "2027-02-20" } });
    assert.equal(staff.status, 409);
    assert.equal((staff as { error?: { code: string } }).error?.code, "MOVE_REQUEST_OPEN");

    const body = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, stay: { kind: "CAMPING", tents: 1 }, food: [], lang: "th" };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    const camp = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Camper", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    await h.api("POST", `/api/admin/bookings/${camp.data.bookingCode}/payments`, {
      token: admin, body: { amountSatang: camp.data.totalSatang, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:00:00Z" },
    });
    assert.equal((await start(camp.data.bookingCode)).data.blocked, "MOVE_CAMPING");
  });
});
