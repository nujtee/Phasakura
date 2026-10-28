import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyLandscape, LANDSCAPE_LOOKS, validateLandscapeDocument, validatePaletteInput, type LandscapeObject, type LandscapeObjectKind } from "../../src/shared/landscape-types.ts";
import { lookArt, LOOK_COLORS, shade } from "../../src/client/landscape/art.tsx";
import { ShapeView } from "../../src/client/landscape/ShapeView.tsx";
import { buildPalette, DEFAULT_PALETTE } from "../../src/client/landscape/palette.ts";

const obj = (over: Partial<LandscapeObject>): LandscapeObject => ({
  id: "a", layerId: "stays", kind: "HOUSE", shape: { type: "rect", x: 10, y: 20, w: 30, h: 20 }, rotation: 0,
  style: { fill: "#c0623f", stroke: "#6d4c41", opacity: 1 }, label: null, link: null, groupId: null, locked: false, imageAssetId: null, ...over,
});
const svg = (o: LandscapeObject, highlight: Parameters<typeof ShapeView>[0]["highlight"] = null) =>
  renderToStaticMarkup(createElement("svg", null, createElement(ShapeView, { o, labelSize: 2, highlight })));

describe("illustrated looks (3D-style houses, tents, trees, shrubs, flowers)", () => {
  it("every look of every kind draws, in its colour, with no ids or inline styles (repeatable, CSP-safe)", () => {
    for (const [kind, looks] of Object.entries(LANDSCAPE_LOOKS) as [LandscapeObjectKind, readonly string[]][]) {
      for (const look of looks) {
        const html = renderToStaticMarkup(createElement("svg", null, lookArt(kind, look, "#123456")));
        assert.ok(html.length > 300, `${kind}/${look} draws`);
        assert.ok(/#123456|#[0-9a-f]{6}/.test(html), `${kind}/${look} coloured`);
        assert.ok(!/ id=| style=/.test(html), `${kind}/${look}: no ids / inline styles`);
      }
    }
    assert.equal(lookArt("HOUSE", "nope", "#123456"), null, "unknown look: flat");
    assert.equal(lookArt("PATH", "round", "#123456"), null, "kinds without looks: flat");
    assert.ok(Object.keys(LOOK_COLORS).every((k) => LANDSCAPE_LOOKS[k as LandscapeObjectKind]), "quick colours only for kinds with looks");
  });

  it("drawn in the object's box; the main colour follows its fill (a tree turns red, a flower yellow)", () => {
    const house = svg(obj({ look: "thai" }));
    assert.match(house, /translate\(10 20\) scale\(0\.3 0\.2\)/);
    const red = svg(obj({ kind: "TREE", look: "round", shape: { type: "symbol", x: 50, y: 50, size: 6 }, style: { fill: "#c62828", stroke: null, opacity: 1 } }));
    assert.ok(red.includes("#c62828"), "leaves in the chosen colour");
    const yellow = svg(obj({ kind: "FLOWER", look: "tulip", shape: { type: "symbol", x: 50, y: 50, size: 3 }, style: { fill: "#ffeb3b", stroke: null, opacity: 1 } }));
    assert.ok(yellow.includes("#ffeb3b"));
    assert.ok(!svg(obj({})).includes("translate("), "no look: the flat drawing, as before");
    assert.ok(svg(obj({ look: "gable" }), "picked").includes("#e65100"), "booking-map highlight still shows");
    assert.equal(shade("#808080", 1), "#ffffff");
    assert.equal(shade("#808080", -1), "#000000");
  });

  it("looks are checked: per kind, in plans and palette kinds; built-ins ship with their first look", () => {
    const doc = (o: Partial<LandscapeObject>) => ({ ...emptyLandscape("BLANK"), objects: [obj(o)] });
    assert.deepEqual(validateLandscapeDocument(doc({ look: "cabin" }), { backgroundKind: "BLANK" }), {});
    assert.deepEqual(validateLandscapeDocument(doc({ look: null }), { backgroundKind: "BLANK" }), {});
    assert.equal(validateLandscapeDocument(doc({ look: "pine" }), { backgroundKind: "BLANK" })["objects.0.look"], "INVALID_VALUE", "a house is not a pine");
    const input = { kind: "TREE", name: "Pine", draw: "symbol", fill: "#1b5e20", stroke: null, opacity: 1, layer: "plants", size: 0.03, group: "nature", sortOrder: null, hidden: false };
    assert.deepEqual(validatePaletteInput({ ...input, look: "pine" }, false), {});
    assert.equal(validatePaletteInput({ ...input, look: "gable" }, false).look, "INVALID_VALUE");
    assert.equal(DEFAULT_PALETTE.find((p) => p.id === "HOUSE")!.look, "gable");
    assert.equal(DEFAULT_PALETTE.find((p) => p.id === "GRASS")!.look, null);
    const custom = buildPalette([{ id: "kpine", builtin: false, kind: "TREE", name: "Pine", draw: "symbol", fill: "#1b5e20", stroke: null, opacity: 1, layer: "plants", size: 0.03, group: "nature", sortOrder: 25, hidden: false, look: "pine" }]);
    assert.equal(custom.find((p) => p.id === "kpine")!.look, "pine");
  });
});
