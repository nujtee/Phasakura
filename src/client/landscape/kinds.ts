import type { LandscapeObjectKind, LandscapeShape, LandscapeStyle } from "../../shared/landscape-types.ts";

/** How a new object of each kind starts (landscape, phase L2): its look, the shape it is drawn as, its layer. */
export interface KindInfo {
  style: LandscapeStyle;
  /** The tool that draws it by default. */
  draw: LandscapeShape["type"];
  layer: "ground" | "plants" | "stays" | "labels";
  /** Size of a new object relative to the plan (fraction of its width). */
  size: number;
}

export const KIND_INFO: Record<LandscapeObjectKind, KindInfo> = {
  GRASS: { style: { fill: "#9ccc65", stroke: "#7cb342", opacity: 0.85 }, draw: "polygon", layer: "ground", size: 0.15 },
  WATER: { style: { fill: "#64b5f6", stroke: "#1e88e5", opacity: 0.85 }, draw: "polygon", layer: "ground", size: 0.12 },
  PATH: { style: { fill: null, stroke: "#bcaaa4", opacity: 1 }, draw: "path", layer: "ground", size: 0.01 },
  PARKING: { style: { fill: "#cfd8dc", stroke: "#78909c", opacity: 1 }, draw: "rect", layer: "ground", size: 0.08 },
  TREE: { style: { fill: "#2e7d32", stroke: "#1b5e20", opacity: 0.95 }, draw: "symbol", layer: "plants", size: 0.025 },
  SHRUB: { style: { fill: "#558b2f", stroke: "#33691e", opacity: 0.95 }, draw: "symbol", layer: "plants", size: 0.015 },
  FLOWER: { style: { fill: "#f06292", stroke: "#c2185b", opacity: 0.95 }, draw: "symbol", layer: "plants", size: 0.012 },
  HOUSE: { style: { fill: "#c0623f", stroke: "#6d4c41", opacity: 1 }, draw: "rect", layer: "stays", size: 0.06 },
  VIP_TENT: { style: { fill: "#fff3e0", stroke: "#ef6c00", opacity: 1 }, draw: "circle", layer: "stays", size: 0.035 },
  CAMPING_AREA: { style: { fill: "#c5e1a5", stroke: "#558b2f", opacity: 0.7 }, draw: "polygon", layer: "stays", size: 0.15 },
  FACILITY: { style: { fill: "#e1bee7", stroke: "#6a1b9a", opacity: 1 }, draw: "rect", layer: "stays", size: 0.04 },
  BUILDING: { style: { fill: "#e0e0e0", stroke: "#424242", opacity: 1 }, draw: "rect", layer: "stays", size: 0.05 },
  LABEL: { style: { fill: null, stroke: null, opacity: 1 }, draw: "symbol", layer: "labels", size: 0.02 },
  OTHER: { style: { fill: "#eeeeee", stroke: "#616161", opacity: 1 }, draw: "rect", layer: "ground", size: 0.04 },
};

/** Groups of the editor's palette. */
export const PALETTE: { group: "nature" | "stays" | "site"; kinds: LandscapeObjectKind[] }[] = [
  { group: "nature", kinds: ["GRASS", "TREE", "SHRUB", "FLOWER", "WATER"] },
  { group: "stays", kinds: ["HOUSE", "VIP_TENT", "CAMPING_AREA"] },
  { group: "site", kinds: ["PATH", "PARKING", "FACILITY", "BUILDING", "LABEL", "OTHER"] },
];
