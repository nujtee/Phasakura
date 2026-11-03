import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicUnitDto } from "../../src/shared/accommodation-types.ts";
import { bedsNeeded, withAutoBeds, type Pick } from "../../src/client/booking/StayPicks.tsx";

const unit = (over: Partial<PublicUnitDto> = {}) => ({ id: "u1", standardGuests: 2, maxGuests: 3, maxAdults: null, ...over }) as PublicUnitDto;
const pick = (adults: number, children = 0, extra: Partial<Extract<Pick, { kind: "UNIT" }>> = {}): Pick => ({ kind: "UNIT", unit: unit(), adults, children, ...extra });
const offer = { maxPerUnit: 2 };

describe("extra beds added on their own", () => {
  it("guests beyond the usual number → that many beds, within the limit; none when not offered or off for the unit", () => {
    assert.equal(bedsNeeded(pick(2), offer), 0);
    assert.equal(bedsNeeded(pick(2, 1), offer), 1, "children count too");
    assert.equal(bedsNeeded(pick(3), offer), 1);
    assert.equal(bedsNeeded({ ...pick(5), unit: unit({ maxGuests: 6 }) } as Pick, offer), 2, "limit per unit");
    assert.equal(bedsNeeded(pick(3), null), 0);
    assert.equal(bedsNeeded(pick(3), { maxPerUnit: 2, offUnitIds: ["u1"] }), 0);
    assert.equal(bedsNeeded({ kind: "CAMPING", tents: 1, tarp: false, adults: 4, children: 0 }, offer), 0);
  });

  it("set when the guests change; a number the guest changed by hand stays until the guests change again", () => {
    const first = withAutoBeds([pick(3)], offer);
    assert.deepEqual([first[0]!.kind === "UNIT" && first[0]!.extraBeds, first[0]!.kind === "UNIT" && first[0]!.autoBedsFor], [1, 3]);
    assert.equal(withAutoBeds(first, offer), first, "nothing changed → same array (no render loop)");
    const byHand = [{ ...first[0]!, extraBeds: 0 } as Pick];
    assert.equal(withAutoBeds(byHand, offer), byHand, "kept");
    const fewer = withAutoBeds([{ ...byHand[0]!, adults: 2 } as Pick], offer);
    assert.equal(fewer[0]!.kind === "UNIT" && fewer[0]!.extraBeds, 0);
    assert.equal(withAutoBeds([pick(3)], null)[0]!.kind === "UNIT" && (withAutoBeds([pick(3)], null)[0] as { extraBeds?: number }).extraBeds, undefined);
  });
});
