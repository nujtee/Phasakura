/**
 * Landscape (site plan) — one document model for every background (phase L1, migration 0039).
 *
 * Coordinate reference, fixed by the background and stored with the document (never guessed):
 *  - BLANK     → "CANVAS_M": metres from the top-left corner of a canvas of widthM × heightM.
 *  - PHOTO     → "IMAGE_NORM": 0…1 across the photo's width and height (independent of its pixel size).
 *  - SATELLITE → "WGS84": [longitude, latitude] in degrees; lengths (radius, symbol size, path width) in metres; a rect
 *                is its north-west corner [lon, lat] and its extent east (w) and south (h) in degrees.
 * Every point of every object is in the document's own reference. Changing the background never moves an object
 * silently: it needs a transformation (georeferencing, phase L4) or the objects stay as they are.
 *
 * Booking link: HOUSE / VIP_TENT objects may point at an existing unit (accommodation_units.id); a CAMPING_AREA at the
 * own-tent camping ground. The plan never decides availability or price — the booking page asks the booking API.
 */

export const LANDSCAPE_BACKGROUNDS = ["BLANK", "PHOTO", "SATELLITE"] as const;
export type LandscapeBackgroundKind = (typeof LANDSCAPE_BACKGROUNDS)[number];

export type LandscapeCrs = "CANVAS_M" | "IMAGE_NORM" | "WGS84";
export const CRS_OF: Record<LandscapeBackgroundKind, LandscapeCrs> = { BLANK: "CANVAS_M", PHOTO: "IMAGE_NORM", SATELLITE: "WGS84" };

export const LANDSCAPE_OBJECT_KINDS = [
  "GRASS", "TREE", "SHRUB", "FLOWER", "WATER", "PATH",
  "HOUSE", "VIP_TENT", "CAMPING_AREA", "PARKING", "FACILITY", "BUILDING", "LABEL", "OTHER",
] as const;
export type LandscapeObjectKind = (typeof LANDSCAPE_OBJECT_KINDS)[number];
/** Objects a guest can book from the plan. */
export const RESERVABLE_KINDS: readonly LandscapeObjectKind[] = ["HOUSE", "VIP_TENT", "CAMPING_AREA"];

export type Point = [number, number];

export type LandscapeShape =
  | { type: "rect"; x: number; y: number; w: number; h: number }
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "polygon"; points: Point[] }
  | { type: "path"; points: Point[]; width: number }
  | { type: "symbol"; x: number; y: number; size: number };

export type LandscapeLink = { type: "UNIT"; unitId: string } | { type: "CAMPING" } | null;

export interface LandscapeStyle {
  fill: string | null;
  stroke: string | null;
  opacity: number;
}

export interface LandscapeObject {
  id: string;
  layerId: string;
  kind: LandscapeObjectKind;
  shape: LandscapeShape;
  /** Degrees, clockwise, around the shape's centre. */
  rotation: number;
  style: LandscapeStyle;
  label: string | null;
  link: LandscapeLink;
  groupId: string | null;
  locked: boolean;
  /** Image of a reusable template (media asset), drawn inside the shape. */
  imageAssetId: string | null;
  /**
   * The palette entry it was drawn as (a staff-made kind such as "Sala", or null / absent = the built-in `kind`).
   * Only a name in the editor: kind and style are the object's own, so deleting a palette entry changes nothing drawn.
   */
  typeId?: string | null;
  /**
   * Illustrated "3D" look (LANDSCAPE_LOOKS of its kind: a Thai house, a bell tent, a pine…), drawn in the shape's box
   * with its fill as the main colour. null / absent = the flat drawing (plans from before looks existed).
   */
  look?: string | null;
}

/** The illustrated looks each kind offers; the first is what a new object gets. */
export const LANDSCAPE_LOOKS: Partial<Record<LandscapeObjectKind, readonly string[]>> = {
  HOUSE: ["gable", "thai", "modern", "aframe", "bungalow", "cabin"],
  VIP_TENT: ["bell", "dome", "safari", "tipi", "aframe", "bubble"],
  TREE: ["round", "pine", "palm", "rain", "bamboo", "fruit", "cypress"],
  SHRUB: ["round", "hedge", "topiary"],
  FLOWER: ["bloom", "bed", "tulip", "sunflower", "pot"],
};

export function isLook(kind: LandscapeObjectKind, look: unknown): boolean {
  return typeof look === "string" && (LANDSCAPE_LOOKS[kind] ?? []).includes(look);
}

export interface LandscapeLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
}

export type LandscapeBackground =
  | { kind: "BLANK"; widthM: number; heightM: number; gridM: number; color: string }
  | {
    kind: "PHOTO"; assetId: string | null; opacity: number;
    /** Real size of the photo's width in metres when measured; null = drawings are illustrative only. */
    measuredWidthM: number | null;
    /** Georeferencing control points (phase L4): a pixel position ↔ a place on the earth. */
    controlPoints: { image: Point; geo: Point }[];
  }
  | { kind: "SATELLITE"; center: Point; zoom: number };

export interface LandscapeDocument {
  version: 1;
  crs: LandscapeCrs;
  background: LandscapeBackground;
  /** Bottom to top. */
  layers: LandscapeLayer[];
  /** Drawing order within a layer = order here. */
  objects: LandscapeObject[];
}

export const LANDSCAPE_LIMITS = {
  objects: 2000,
  layers: 30,
  points: 500,
  controlPoints: 12,
  label: 80,
  name: 80,
  json: 600_000,
  /** Kinds staff may add to the palette. */
  paletteKinds: 60,
  paletteName: 40,
} as const;

// ---------------------------------------------------------------- palette (migration 0040)

export const PALETTE_GROUPS = ["nature", "stays", "site"] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];
export const PALETTE_LAYERS = ["ground", "plants", "stays", "labels"] as const;
export type PaletteLayer = (typeof PALETTE_LAYERS)[number];
export const SHAPE_TYPES = ["rect", "circle", "polygon", "path", "symbol"] as const;

/**
 * One row of the palette as stored: an override of a built-in kind (`builtin`, id = its code; null fields keep the
 * built-in value) or a kind staff made (every field set).
 */
export interface LandscapePaletteRowDto {
  id: string;
  builtin: boolean;
  kind: LandscapeObjectKind;
  name: string | null;
  draw: LandscapeShape["type"] | null;
  fill: string | null;
  stroke: string | null;
  opacity: number | null;
  layer: PaletteLayer | null;
  size: number | null;
  group: PaletteGroup | null;
  sortOrder: number | null;
  hidden: boolean;
  /** Illustrated look new objects of this kind get (migration 0041); null = flat. */
  look: string | null;
}

/** What the editor sends to add or change a palette entry. */
export interface LandscapePaletteInput {
  kind: LandscapeObjectKind;
  name: string | null;
  draw: LandscapeShape["type"];
  fill: string | null;
  stroke: string | null;
  opacity: number;
  layer: PaletteLayer;
  size: number;
  group: PaletteGroup;
  sortOrder: number | null;
  hidden: boolean;
  look: string | null;
}

/** Field errors of a palette entry (`builtin`: the name may be empty = the built-in name). */
export function validatePaletteInput(raw: unknown, builtin: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { body: "INVALID" };
  const r = raw as Record<string, unknown>;
  if (!(LANDSCAPE_OBJECT_KINDS as readonly unknown[]).includes(r.kind)) e.kind = "INVALID_VALUE";
  if (r.name === null || r.name === undefined || (typeof r.name === "string" && !r.name.trim())) {
    if (!builtin) e.name = "REQUIRED";
  } else if (typeof r.name !== "string" || r.name.trim().length > LANDSCAPE_LIMITS.paletteName) e.name = "TOO_LONG";
  if (!(SHAPE_TYPES as readonly unknown[]).includes(r.draw)) e.draw = "INVALID_VALUE";
  for (const k of ["fill", "stroke"] as const) if (r[k] !== null && (typeof r[k] !== "string" || !/^#[0-9a-fA-F]{6}$/.test(r[k] as string))) e[k] = "INVALID_COLOR";
  if (typeof r.opacity !== "number" || !(r.opacity >= 0 && r.opacity <= 1)) e.opacity = "OUT_OF_RANGE";
  if (!(PALETTE_LAYERS as readonly unknown[]).includes(r.layer)) e.layer = "INVALID_VALUE";
  if (typeof r.size !== "number" || !(r.size >= 0.002 && r.size <= 0.5)) e.size = "OUT_OF_RANGE";
  if (!(PALETTE_GROUPS as readonly unknown[]).includes(r.group)) e.group = "INVALID_VALUE";
  if (r.sortOrder !== null && (typeof r.sortOrder !== "number" || !Number.isInteger(r.sortOrder) || Math.abs(r.sortOrder) > 100_000)) e.sortOrder = "INVALID";
  if (typeof r.hidden !== "boolean") e.hidden = "EXPECTED_BOOLEAN";
  if (r.look !== undefined && r.look !== null && !isLook(r.kind as LandscapeObjectKind, r.look)) e.look = "INVALID_VALUE";
  return e;
}

// ---------------------------------------------------------------- API

export interface LandscapeLayoutSummaryDto {
  id: string;
  name: string;
  backgroundKind: LandscapeBackgroundKind;
  draftRevision: number;
  draftUpdatedAt: string;
  draftUpdatedBy: string | null;
  publishedVersionNo: number | null;
  publishedAt: string | null;
  /** The draft differs from what is published. */
  unpublishedChanges: boolean;
  isPublic: boolean;
}

/** Satellite imagery (phase L4): served by the Worker from MapTiler, around this site's satellite plans only. */
export const SATELLITE_TILE_PATH = /^\/sat-tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/;
export const SATELLITE_MAX_TILE_ZOOM = 20;
/** Tile zooms served around a plan of zoom z: z − below … z + above. */
export const SATELLITE_ZOOM_BELOW = 1;
export const SATELLITE_ZOOM_ABOVE = 3;
/** Plan zooms the editor offers (a site, not a city). */
export const SATELLITE_PLAN_ZOOM = { min: 13, max: 19 } as const;

export function satelliteTileUrl(z: number, x: number, y: number, version?: string | number): string {
  return `/sat-tiles/${z}/${x}/${y}${version === undefined ? "" : `?v=${version}`}`;
}

export interface LandscapeOverviewDto {
  enabled: boolean;
  /** MAPTILER_API_KEY is set: satellite plans can be made and shown. */
  satelliteReady: boolean;
  canToggle: boolean;
  canEdit: boolean;
  canPublish: boolean;
  publicLayoutId: string | null;
  layouts: LandscapeLayoutSummaryDto[];
  /** Units a HOUSE / VIP_TENT object can be linked to. */
  units: { id: string; code: string; type: "HOUSE" | "VIP_TENT"; name: string; status: string }[];
  campingEnabled: boolean;
  updatedAt: string | null;
}

export interface LandscapeLayoutDto extends LandscapeLayoutSummaryDto {
  draft: LandscapeDocument;
  /** Background photo (PHOTO): URL and pixel size (the plan's 0…1 coordinates are drawn over it). */
  backgroundUrl: string | null;
  backgroundSize: { width: number; height: number } | null;
  /** Pictures of objects (template images): asset id → URL. */
  imageUrls: Record<string, string>;
}

export interface LandscapeVersionDto {
  id: string;
  versionNo: number;
  note: string | null;
  restoredFromNo: number | null;
  publishedAt: string;
  publishedBy: string | null;
  objects: number;
}

/** GET /api/public/landscape — what the booking page draws. Nothing private: no admin names, no hidden layers. */
export interface PublicLandscapeDto {
  enabled: boolean;
  layout: {
    name: string;
    versionNo: number;
    document: LandscapeDocument;
    backgroundUrl: string | null;
    backgroundSize: { width: number; height: number } | null;
    imageUrls: Record<string, string>;
  } | null;
}

export interface LandscapeTemplateDto {
  id: string;
  name: string;
  object: Omit<LandscapeObject, "id" | "layerId" | "groupId" | "link">;
  imageUrl: string | null;
}

// ---------------------------------------------------------------- validation (shared: the editor shows the same errors)

const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Bounds a point may take in each reference (generous: objects may hang over the canvas / photo edge). */
function inBounds(crs: LandscapeCrs, bg: LandscapeBackground, [x, y]: Point): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (crs === "WGS84") return x >= -180 && x <= 180 && y >= -90 && y <= 90;
  if (crs === "IMAGE_NORM") return x >= -1 && x <= 2 && y >= -1 && y <= 2;
  const w = bg.kind === "BLANK" ? bg.widthM : 1;
  const h = bg.kind === "BLANK" ? bg.heightM : 1;
  return x >= -w && x <= 2 * w && y >= -h && y <= 2 * h;
}

/** Points of a shape (to check bounds), and its size fields. */
function shapePoints(s: LandscapeShape): Point[] {
  switch (s.type) {
    case "rect": return [[s.x, s.y], [s.x + s.w, s.y + s.h]];
    case "circle": return [[s.cx, s.cy]];
    case "polygon":
    case "path": return s.points;
    case "symbol": return [[s.x, s.y]];
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPoint = (v: unknown): v is Point => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);

/**
 * Checks a document from the outside world (JSON). Returns field errors ({ "objects.3.shape": "INVALID" }) — empty
 * when the document is sound. `publish` adds the booking-link rules that a draft may still break while drawing:
 * every reservable link points at a unit that exists (and fits the kind), each unit at most once.
 */
export function validateLandscapeDocument(raw: unknown, ctx: {
  backgroundKind: LandscapeBackgroundKind;
  units?: { id: string; type: "HOUSE" | "VIP_TENT"; status: string }[];
  campingEnabled?: boolean;
  publish?: boolean;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!isObj(raw)) return { document: "INVALID" };
  if (raw.version !== 1) errors.version = "UNSUPPORTED";
  const crs = CRS_OF[ctx.backgroundKind];
  if (raw.crs !== crs) errors.crs = "MUST_MATCH_BACKGROUND";

  const bg = raw.background;
  if (!isObj(bg) || bg.kind !== ctx.backgroundKind) errors.background = "MUST_MATCH_BACKGROUND";
  else if (bg.kind === "BLANK") {
    if (!num(bg.widthM) || bg.widthM < 1 || bg.widthM > 100_000) errors["background.widthM"] = "OUT_OF_RANGE";
    if (!num(bg.heightM) || bg.heightM < 1 || bg.heightM > 100_000) errors["background.heightM"] = "OUT_OF_RANGE";
    if (!num(bg.gridM) || bg.gridM < 0 || bg.gridM > 1000) errors["background.gridM"] = "OUT_OF_RANGE";
    if (typeof bg.color !== "string" || !COLOR.test(bg.color)) errors["background.color"] = "INVALID_COLOR";
  } else if (bg.kind === "PHOTO") {
    if (bg.assetId !== null && (typeof bg.assetId !== "string" || !ID.test(bg.assetId))) errors["background.assetId"] = "INVALID_ID";
    if (!num(bg.opacity) || bg.opacity < 0 || bg.opacity > 1) errors["background.opacity"] = "OUT_OF_RANGE";
    if (bg.measuredWidthM !== null && (!num(bg.measuredWidthM) || bg.measuredWidthM <= 0 || bg.measuredWidthM > 100_000)) {
      errors["background.measuredWidthM"] = "OUT_OF_RANGE";
    }
    const cps = bg.controlPoints;
    if (!Array.isArray(cps) || cps.length > LANDSCAPE_LIMITS.controlPoints) errors["background.controlPoints"] = "INVALID";
    else cps.forEach((cp, i) => {
      if (!isObj(cp) || !isPoint(cp.image) || !isPoint(cp.geo) || !inBounds("IMAGE_NORM", bg as LandscapeBackground, cp.image)
        || !inBounds("WGS84", bg as LandscapeBackground, cp.geo)) errors[`background.controlPoints.${i}`] = "INVALID";
    });
  } else if (bg.kind === "SATELLITE") {
    if (!isPoint(bg.center) || !inBounds("WGS84", bg as LandscapeBackground, bg.center)) errors["background.center"] = "INVALID";
    if (!num(bg.zoom) || bg.zoom < 1 || bg.zoom > 22) errors["background.zoom"] = "OUT_OF_RANGE";
  }
  const background = (errors.background ? null : bg) as LandscapeBackground | null;

  const layers = raw.layers;
  const layerIds = new Set<string>();
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > LANDSCAPE_LIMITS.layers) errors.layers = "INVALID";
  else layers.forEach((l, i) => {
    if (!isObj(l) || typeof l.id !== "string" || !ID.test(l.id) || layerIds.has(l.id)) { errors[`layers.${i}`] = "INVALID"; return; }
    layerIds.add(l.id);
    if (typeof l.name !== "string" || !l.name.trim() || l.name.length > LANDSCAPE_LIMITS.name) errors[`layers.${i}.name`] = "INVALID";
    if (typeof l.visible !== "boolean" || typeof l.locked !== "boolean") errors[`layers.${i}`] = "INVALID";
  });

  const objects = raw.objects;
  const ids = new Set<string>();
  const linkedUnits = new Map<string, number>();
  if (!Array.isArray(objects) || objects.length > LANDSCAPE_LIMITS.objects) { errors.objects = "TOO_MANY"; return errors; }
  objects.forEach((o, i) => {
    const at = (k: string) => `objects.${i}${k ? `.${k}` : ""}`;
    if (!isObj(o) || typeof o.id !== "string" || !ID.test(o.id) || ids.has(o.id)) { errors[at("")] = "INVALID"; return; }
    ids.add(o.id);
    if (typeof o.layerId !== "string" || !layerIds.has(o.layerId)) errors[at("layerId")] = "UNKNOWN_LAYER";
    if (!(LANDSCAPE_OBJECT_KINDS as readonly unknown[]).includes(o.kind)) errors[at("kind")] = "INVALID_VALUE";
    if (!num(o.rotation) || o.rotation < -360 || o.rotation > 360) errors[at("rotation")] = "OUT_OF_RANGE";
    if (typeof o.locked !== "boolean") errors[at("locked")] = "INVALID";
    if (o.groupId !== null && (typeof o.groupId !== "string" || !ID.test(o.groupId))) errors[at("groupId")] = "INVALID";
    if (o.imageAssetId !== null && (typeof o.imageAssetId !== "string" || !ID.test(o.imageAssetId))) errors[at("imageAssetId")] = "INVALID_ID";
    if (o.typeId !== undefined && o.typeId !== null && (typeof o.typeId !== "string" || !ID.test(o.typeId))) errors[at("typeId")] = "INVALID_ID";
    if (o.look !== undefined && o.look !== null && !isLook(o.kind as LandscapeObjectKind, o.look)) errors[at("look")] = "INVALID_VALUE";
    if (o.label !== null && (typeof o.label !== "string" || o.label.length > LANDSCAPE_LIMITS.label)) errors[at("label")] = "TOO_LONG";
    const st = o.style;
    if (!isObj(st) || (st.fill !== null && (typeof st.fill !== "string" || !COLOR.test(st.fill)))
      || (st.stroke !== null && (typeof st.stroke !== "string" || !COLOR.test(st.stroke))) || !num(st.opacity) || st.opacity < 0 || st.opacity > 1) {
      errors[at("style")] = "INVALID";
    }
    const s = o.shape;
    let shapeOk = isObj(s);
    if (shapeOk) {
      const sh = s as Record<string, unknown>;
      switch (sh.type) {
        case "rect": shapeOk = num(sh.x) && num(sh.y) && num(sh.w) && num(sh.h) && sh.w > 0 && sh.h > 0; break;
        case "circle": shapeOk = num(sh.cx) && num(sh.cy) && num(sh.r) && sh.r > 0; break;
        case "polygon": shapeOk = Array.isArray(sh.points) && sh.points.length >= 3 && sh.points.length <= LANDSCAPE_LIMITS.points && sh.points.every(isPoint); break;
        case "path": shapeOk = Array.isArray(sh.points) && sh.points.length >= 2 && sh.points.length <= LANDSCAPE_LIMITS.points
          && sh.points.every(isPoint) && num(sh.width) && sh.width > 0; break;
        case "symbol": shapeOk = num(sh.x) && num(sh.y) && num(sh.size) && sh.size > 0; break;
        default: shapeOk = false;
      }
    }
    if (!shapeOk) errors[at("shape")] = "INVALID";
    else if (background && !shapePoints(s as LandscapeShape).every((p) => inBounds(crs, background, p))) errors[at("shape")] = "OUT_OF_BOUNDS";

    // Booking link.
    const link = o.link;
    const kind = o.kind as LandscapeObjectKind;
    if (link === null) return;
    if (!isObj(link)) { errors[at("link")] = "INVALID"; return; }
    if (link.type === "UNIT") {
      if (kind !== "HOUSE" && kind !== "VIP_TENT") { errors[at("link")] = "NOT_RESERVABLE"; return; }
      if (typeof link.unitId !== "string" || !ID.test(link.unitId)) { errors[at("link")] = "INVALID_ID"; return; }
      linkedUnits.set(link.unitId, (linkedUnits.get(link.unitId) ?? 0) + 1);
      if (ctx.publish && ctx.units) {
        const unit = ctx.units.find((u) => u.id === link.unitId && u.status !== "DELETED");
        if (!unit) errors[at("link")] = "UNKNOWN_UNIT";
        else if (unit.type !== kind) errors[at("link")] = "UNIT_TYPE_MISMATCH";
      }
    } else if (link.type === "CAMPING") {
      if (kind !== "CAMPING_AREA") errors[at("link")] = "NOT_RESERVABLE";
      else if (ctx.publish && ctx.campingEnabled === false) errors[at("link")] = "CAMPING_DISABLED";
    } else errors[at("link")] = "INVALID";
  });
  if (ctx.publish) {
    objects.forEach((o, i) => {
      const link = isObj(o) ? o.link : null;
      if (isObj(link) && link.type === "UNIT" && (linkedUnits.get(link.unitId as string) ?? 0) > 1) errors[`objects.${i}.link`] = "UNIT_LINKED_TWICE";
    });
  }
  return errors;
}

/** A new, empty document for a background. */
export function emptyLandscape(kind: LandscapeBackgroundKind): LandscapeDocument {
  const background: LandscapeBackground = kind === "BLANK"
    ? { kind, widthM: 200, heightM: 120, gridM: 5, color: "#f3f1e8" }
    : kind === "PHOTO"
      ? { kind, assetId: null, opacity: 1, measuredWidthM: null, controlPoints: [] }
      : { kind, center: [100.5018, 13.7563], zoom: 17 };
  return {
    version: 1,
    crs: CRS_OF[kind],
    background,
    layers: [
      { id: "ground", name: "Ground", visible: true, locked: false },
      { id: "plants", name: "Plants", visible: true, locked: false },
      { id: "stays", name: "Stays", visible: true, locked: false },
      { id: "labels", name: "Labels", visible: true, locked: false },
    ],
    objects: [],
  };
}
