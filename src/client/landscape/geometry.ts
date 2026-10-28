import type { LandscapeBackground, LandscapeDocument, LandscapeObject, LandscapeShape, Point } from "../../shared/landscape-types.ts";
import { distanceM, fitGeoref, georefDistanceM, imageToGeo, metresPerPixel, project, unproject, type Georef } from "../../shared/geo.ts";

/**
 * Plan geometry (landscape, phase L2), shared by the admin editor and the booking-page map.
 *
 * Drawing happens in "world" units: metres on a blank canvas, pixels of the photo on a photo plan. The document keeps
 * its own reference (metres / 0…1 of the image); `toWorld` / `fromWorld` convert exactly both ways, so a plan saved
 * and opened again is where it was. Lengths (circle radius, symbol size, path width) of a photo plan scale with the
 * photo's width.
 *
 * Satellite plans (phase L4): the document keeps [lon, lat] (lengths — radius, size, path width — in metres; a rect
 * is its north-west corner and its extent east / south in degrees). The world is Web Mercator pixels at the plan's
 * zoom, a frame of SATELLITE_FRAME around the plan's centre: what the map tiles are drawn in.
 */

export interface Size { w: number; h: number }
export interface Box { x: number; y: number; w: number; h: number }

/** A photo plan before its photo is known (or without one) is drawn on this frame. */
export const PHOTO_FALLBACK: Size = { w: 1600, h: 1000 };
/** Satellite plans: the area shown, in map pixels at the plan's zoom, centred on its centre. */
export const SATELLITE_FRAME: Size = { w: 1600, h: 1000 };

export function worldSize(doc: LandscapeDocument, photo: { width: number; height: number } | null): Size {
  if (doc.background.kind === "BLANK") return { w: doc.background.widthM, h: doc.background.heightM };
  if (doc.background.kind === "PHOTO") return photo ? { w: photo.width, h: photo.height } : PHOTO_FALLBACK;
  return SATELLITE_FRAME;
}

/** Satellite frame: [lon, lat] ↔ world pixels, metres ↔ pixels (at the centre's latitude). */
export interface SatelliteFrame {
  zoom: number;
  /** World pixel (at `zoom`) of the frame's top-left corner. */
  origin: Point;
  mpp: number;
  toPx(p: Point): Point;
  toLonLat(p: Point): Point;
}

export function satelliteFrame(bg: Extract<LandscapeBackground, { kind: "SATELLITE" }>): SatelliteFrame {
  const [cx, cy] = project(bg.center as [number, number], bg.zoom);
  const origin: Point = [cx - SATELLITE_FRAME.w / 2, cy - SATELLITE_FRAME.h / 2];
  return {
    zoom: bg.zoom,
    origin,
    mpp: metresPerPixel(bg.center[1], bg.zoom),
    toPx: (p) => { const [x, y] = project(p as [number, number], bg.zoom); return [x - origin[0], y - origin[1]]; },
    toLonLat: ([x, y]) => unproject([x + origin[0], y + origin[1]], bg.zoom),
  };
}

function geoToWorldShape(s: LandscapeShape, f: SatelliteFrame): LandscapeShape {
  const len = (m: number) => m / f.mpp;
  if (s.type === "rect") {
    const [x1, y1] = f.toPx([s.x, s.y]);
    const [x2, y2] = f.toPx([s.x + s.w, s.y - s.h]);
    return { type: "rect", x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  return mapShape(s, f.toPx, len);
}

function worldToGeoShape(s: LandscapeShape, f: SatelliteFrame, d: number): LandscapeShape {
  const p = (q: Point): Point => { const [lon, lat] = f.toLonLat(q); return [round(lon, d), round(lat, d)]; };
  const len = (px: number) => round(px * f.mpp, 3);
  if (s.type === "rect") {
    const b = shapeBox(s);
    const [w, n] = p([b.x, b.y]);
    const [e, so] = p([b.x + b.w, b.y + b.h]);
    return { type: "rect", x: w, y: n, w: round(e - w, d), h: round(n - so, d) };
  }
  return mapShape(s, p, len);
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

export function mapShape(s: LandscapeShape, p: (q: Point) => Point, len: (l: number) => number): LandscapeShape {
  switch (s.type) {
    case "rect": {
      const [x, y] = p([s.x, s.y]);
      const [x2, y2] = p([s.x + s.w, s.y + s.h]);
      return { type: "rect", x, y, w: x2 - x, h: y2 - y };
    }
    case "circle": { const [cx, cy] = p([s.cx, s.cy]); return { type: "circle", cx, cy, r: len(s.r) }; }
    case "polygon": return { type: "polygon", points: s.points.map(p) };
    case "path": return { type: "path", points: s.points.map(p), width: len(s.width) };
    case "symbol": { const [x, y] = p([s.x, s.y]); return { type: "symbol", x, y, size: len(s.size) }; }
  }
}

/** Document → world (what the editor draws and edits). */
export function toWorld(doc: LandscapeDocument, size: Size): LandscapeObject[] {
  if (doc.crs === "WGS84" && doc.background.kind === "SATELLITE") {
    const f = satelliteFrame(doc.background);
    return doc.objects.map((o) => ({ ...o, shape: geoToWorldShape(o.shape, f) }));
  }
  if (doc.crs !== "IMAGE_NORM") return doc.objects;
  return doc.objects.map((o) => ({ ...o, shape: mapShape(o.shape, ([x, y]) => [x * size.w, y * size.h], (l) => l * size.w) }));
}

/** World → document (what is saved). Rounded: 1 mm on a canvas, 1/10⁶ of a photo. */
export function fromWorld(doc: LandscapeDocument, objects: LandscapeObject[], size: Size): LandscapeDocument {
  if (doc.crs === "IMAGE_NORM") {
    const d = 6;
    return {
      ...doc,
      objects: objects.map((o) => ({
        ...o, shape: mapShape(o.shape, ([x, y]) => [round(x / size.w, d), round(y / size.h, d)], (l) => round(l / size.w, d)),
      })),
    };
  }
  if (doc.crs === "WGS84" && doc.background.kind === "SATELLITE") {
    const f = satelliteFrame(doc.background);
    return { ...doc, objects: objects.map((o) => ({ ...o, shape: worldToGeoShape(o.shape, f, 7), rotation: round(o.rotation, 2) })) };
  }
  const d = 3;
  return { ...doc, objects: objects.map((o) => ({ ...o, shape: mapShape(o.shape, ([x, y]) => [round(x, d), round(y, d)], (l) => round(l, d)), rotation: round(o.rotation, 2) })) };
}

export function shapeBox(s: LandscapeShape): Box {
  switch (s.type) {
    case "rect": return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
    case "circle": return { x: s.cx - s.r, y: s.cy - s.r, w: 2 * s.r, h: 2 * s.r };
    case "symbol": return { x: s.x - s.size / 2, y: s.y - s.size / 2, w: s.size, h: s.size };
    case "polygon":
    case "path": {
      const xs = s.points.map((q) => q[0]);
      const ys = s.points.map((q) => q[1]);
      const pad = s.type === "path" ? s.width / 2 : 0;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
    }
  }
}

export const boxCenter = (b: Box): Point => [b.x + b.w / 2, b.y + b.h / 2];
export const shapeCenter = (s: LandscapeShape): Point => boxCenter(shapeBox(s));

export function rotatePoint([x, y]: Point, [cx, cy]: Point, deg: number): Point {
  if (!deg) return [x, y];
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
}

/** Corners of an object's box on the page (its rotation applied). */
export function objectCorners(o: LandscapeObject): Point[] {
  const b = shapeBox(o.shape);
  const c = boxCenter(b);
  return ([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]] as Point[]).map((q) => rotatePoint(q, c, o.rotation));
}

export function objectsBox(objects: LandscapeObject[]): Box | null {
  if (!objects.length) return null;
  const pts = objects.flatMap(objectCorners);
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function inPolygon([x, y]: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance([x, y]: Point, [x1, y1]: Point, [x2, y2]: Point): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** Is a point on the object? `tolerance` in world units (a few screen pixels). */
export function hitTest(o: LandscapeObject, p: Point, tolerance = 0): boolean {
  const local = rotatePoint(p, shapeCenter(o.shape), -o.rotation);
  const s = o.shape;
  switch (s.type) {
    case "rect": { const b = shapeBox(s); return local[0] >= b.x - tolerance && local[0] <= b.x + b.w + tolerance && local[1] >= b.y - tolerance && local[1] <= b.y + b.h + tolerance; }
    case "circle": return Math.hypot(local[0] - s.cx, local[1] - s.cy) <= s.r + tolerance;
    case "symbol": return Math.hypot(local[0] - s.x, local[1] - s.y) <= s.size / 2 + tolerance;
    case "polygon": return inPolygon(local, s.points) || s.points.some((q, i) => segmentDistance(local, q, s.points[(i + 1) % s.points.length]!) <= tolerance);
    case "path": return s.points.slice(1).some((q, i) => segmentDistance(local, s.points[i]!, q) <= s.width / 2 + tolerance);
  }
}

export function moveShape(s: LandscapeShape, dx: number, dy: number): LandscapeShape {
  return mapShape(s, ([x, y]) => [x + dx, y + dy], (l) => l);
}

/** Maps a shape from one box to another (resize); radius / size follow the mean scale, a path keeps its width. */
export function scaleShape(s: LandscapeShape, from: Box, to: Box): LandscapeShape {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  const p = ([x, y]: Point): Point => [to.x + (x - from.x) * sx, to.y + (y - from.y) * sy];
  if (s.type === "path") return { type: "path", points: s.points.map(p), width: s.width };
  return mapShape(s, p, (l) => l * (Math.abs(sx) + Math.abs(sy)) / 2);
}

export function snap(v: number, grid: number): number {
  return grid > 0 ? Math.round(v / grid) * grid : v;
}

/** Resize handle positions: 0 nw, 1 n, 2 ne, 3 e, 4 se, 5 s, 6 sw, 7 w. */
export function handlePoints(b: Box): Point[] {
  const { x, y, w, h } = b;
  return [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]];
}

/**
 * New box when handle `i` of box `b` is dragged to `p` (in the shape's own, unrotated frame); the opposite side stays.
 * `keepRatio` for circles and symbols.
 */
export function resizeBox(b: Box, i: number, [px, py]: Point, keepRatio: boolean, min: number): Box {
  let x1 = b.x;
  let y1 = b.y;
  let x2 = b.x + b.w;
  let y2 = b.y + b.h;
  if (i === 0 || i === 6 || i === 7) x1 = Math.min(px, x2 - min);
  if (i === 2 || i === 3 || i === 4) x2 = Math.max(px, x1 + min);
  if (i === 0 || i === 1 || i === 2) y1 = Math.min(py, y2 - min);
  if (i === 4 || i === 5 || i === 6) y2 = Math.max(py, y1 + min);
  let out = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  if (keepRatio) {
    const side = i === 1 || i === 5 ? out.h : i === 3 || i === 7 ? out.w : Math.max(out.w, out.h);
    const ax = i === 0 || i === 6 || i === 7 ? x2 - side : i === 1 || i === 5 ? b.x + b.w / 2 - side / 2 : x1;
    const ay = i === 0 || i === 1 || i === 2 ? y2 - side : i === 3 || i === 7 ? b.y + b.h / 2 - side / 2 : y1;
    out = { x: ax, y: ay, w: side, h: side };
  }
  return out;
}

/** Angle (degrees, clockwise from "up") from the centre to a point — the rotation handle. */
export function angleFrom([cx, cy]: Point, [x, y]: Point): number {
  return (Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI;
}

/** The photo's fit to the earth from its control points (pixels of a photo of `size`); null when not georeferenced. */
export function photoGeoref(bg: LandscapeBackground, size: Size): Georef | null {
  if (bg.kind !== "PHOTO" || bg.controlPoints.length < 2) return null;
  return fitGeoref(bg.controlPoints.map((cp) => ({ image: [cp.image[0] * size.w, cp.image[1] * size.h], geo: cp.geo as [number, number] })));
}

/**
 * Real distance between two world points; null = illustrative only. A photo is measured by its control points when
 * it has them (they win over a typed width), else by its typed real width.
 */
export function measuredDistance(doc: LandscapeDocument, size: Size, a: Point, b: Point): number | null {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bg = doc.background;
  if (bg.kind === "BLANK") return d;
  if (bg.kind === "SATELLITE") {
    const f = satelliteFrame(bg);
    return distanceM(f.toLonLat(a) as [number, number], f.toLonLat(b) as [number, number]);
  }
  const g = photoGeoref(bg, size);
  if (g) return georefDistanceM(g, a as [number, number], b as [number, number]);
  if (bg.measuredWidthM) return (d / size.w) * bg.measuredWidthM;
  return null;
}

/**
 * A georeferenced photo plan as a new satellite plan (phase L4): every object goes where its control points put it on
 * the earth. Sizes follow the photo's scale; rectangles keep their shape and turn with the photo. The frame is centred
 * on the photo and zoomed so the whole photo fits. Links, labels, layers and pictures are kept.
 */
export function photoToSatellite(doc: LandscapeDocument, photo: Size, g: Georef): LandscapeDocument {
  const objects = toWorld(doc, photo);
  const center = imageToGeo(g, [photo.w / 2, photo.h / 2]);
  const widthM = g.scaleM * Math.max(photo.w, photo.h * (SATELLITE_FRAME.w / SATELLITE_FRAME.h));
  let zoom = 19;
  while (zoom > 13 && SATELLITE_FRAME.w * metresPerPixel(center[1], zoom) < widthM * 1.15) zoom--;
  const background: LandscapeBackground = { kind: "SATELLITE", center: [round(center[0], 7), round(center[1], 7)], zoom };
  const f = satelliteFrame(background);
  const k = g.scaleM / f.mpp;
  const at = (p: Point): Point => f.toPx(imageToGeo(g, p as [number, number]));
  const moved = objects.map((o): LandscapeObject => {
    const s = o.shape;
    switch (s.type) {
      case "rect": {
        const b = shapeBox(s);
        const [cx, cy] = at(boxCenter(b));
        const w = b.w * k;
        const h = b.h * k;
        return { ...o, shape: { type: "rect", x: cx - w / 2, y: cy - h / 2, w, h }, rotation: normAngle(o.rotation + g.rotationDeg) };
      }
      case "circle": { const [cx, cy] = at([s.cx, s.cy]); return { ...o, shape: { type: "circle", cx, cy, r: s.r * k } }; }
      case "symbol": { const [x, y] = at([s.x, s.y]); return { ...o, shape: { type: "symbol", x, y, size: s.size * k } }; }
      case "polygon": return { ...o, shape: { type: "polygon", points: s.points.map(at) } };
      case "path": return { ...o, shape: { type: "path", points: s.points.map(at), width: s.width * k } };
    }
  });
  return fromWorld({ version: 1, crs: "WGS84", background, layers: doc.layers, objects: [] }, moved, SATELLITE_FRAME);
}

function normAngle(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

/**
 * The "plan width" new objects, nudges and the grid are sized from (world units). A satellite plan uses 200 m (like a
 * default blank canvas): its frame covers a kilometre or more, and a house is not a tenth of that.
 */
export function planUnit(bg: LandscapeBackground, size: Size): number {
  return bg.kind === "SATELLITE" ? 200 / satelliteFrame(bg).mpp : size.w;
}
