import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LandscapePaletteRowDto } from "../../src/shared/landscape-types.ts";
import { KIND_INFO } from "../../src/client/landscape/kinds.ts";
import { buildPalette, DEFAULT_PALETTE, entryInput, entryOf, swapOrder } from "../../src/client/landscape/palette.ts";

const row = (over: Partial<LandscapePaletteRowDto>): LandscapePaletteRowDto => ({
  id: "x", builtin: false, kind: "BUILDING", name: "Sala", draw: "rect", fill: "#aa8844", stroke: "#553311", opacity: 1,
  layer: "stays", size: 0.05, group: "site", sortOrder: null, hidden: false, ...over,
});

describe("landscape palette (built-in + staff kinds)", () => {
  it("as it ships: every built-in, in the shipped groups and order", () => {
    assert.equal(DEFAULT_PALETTE.length, 14);
    assert.deepEqual(DEFAULT_PALETTE.slice(0, 2).map((p) => p.id), ["GRASS", "TREE"]);
    const tree = DEFAULT_PALETTE.find((p) => p.id === "TREE")!;
    assert.deepEqual(tree.info, KIND_INFO.TREE);
    assert.equal(tree.changed, false);
  });

  it("a changed built-in takes the stored look; hidden kinds stay listed (objects may be one)", () => {
    const p = buildPalette([row({ id: "TREE", builtin: true, kind: "TREE", name: "Mango tree", fill: "#00ff00", draw: "circle", hidden: true })]);
    const tree = p.find((e) => e.id === "TREE")!;
    assert.equal(tree.name, "Mango tree");
    assert.equal(tree.info.draw, "circle");
    assert.equal(tree.info.style.fill, "#00ff00");
    assert.equal(tree.hidden, true);
    assert.equal(tree.changed, true);
  });

  it("staff kinds: own name, drawn as a base kind; ordered among the built-ins; entryOf falls back when deleted", () => {
    const p = buildPalette([row({ id: "ksala", sortOrder: 125 })]);
    const ids = p.filter((e) => e.group === "site").map((e) => e.id);
    assert.ok(ids.indexOf("ksala") === ids.indexOf("BUILDING") + 1, ids.join(","));
    assert.equal(entryOf(p, { kind: "BUILDING", typeId: "ksala" })!.name, "Sala");
    assert.equal(entryOf(DEFAULT_PALETTE, { kind: "BUILDING", typeId: "ksala" })!.id, "BUILDING", "kind deleted: its base kind");
    assert.equal(entryOf(p, { kind: "TREE" })!.id, "TREE", "objects from before the palette have no typeId");
    assert.deepEqual(entryInput(p.find((e) => e.id === "ksala")!).name, "Sala");
  });

  it("moving a kind up swaps places with the one above it in its group", () => {
    const swap = swapOrder(DEFAULT_PALETTE, "TREE", -1)!;
    assert.deepEqual(swap.map(([e, o]) => [e.id, o]), [["TREE", 10], ["GRASS", 20]]);
    assert.equal(swapOrder(DEFAULT_PALETTE, "GRASS", -1), null, "already first");
  });
});
