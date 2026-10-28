import type { LandscapeDocument, LandscapeObject, LandscapeShape, Point } from "../../shared/landscape-types.ts";

/**
 * Plan geometry (landscape, phase L2), shared by the admin editor and the booking-page map.
 *
 * Drawing happens in "world" units: metres on a blank canvas, pixels of the photo on a photo plan. The document keeps
 * its own reference (metres / 0…1 of the image); `toWorld` / `fromWorld` convert exactly both ways, so a plan saved
 * and opened again is where it was. Lengths (circle radius, symbol size, path width) of a photo plan scale with the
 * photo's width.
 */

export interface Size { w: number; h: number }
export interface Box { x: number; y: number; w: number; h: number }

/** A photo plan before its photo is known (or without one) is drawn on this frame. */
export const PHOTO_FALLBACK: Size = { w: 1600, h: 1000 };

export function worldSize(doc: LandscapeDocument, photo: { width: number; height: number } | null): Size {
  if (doc.background.kind === "BLANK") return { w: doc.background.widthM, h: doc.background.heightM };
  if (doc.background.kind === "PHOTO") return photo ? { w: photo.width, h: photo.height } : PHOTO_FALLBACK;
  return { w: 1, h: 1 };
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
  const d = doc.crs === "WGS84" ? 7 : 3;
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

/** Real distance between two world points, when the plan is measured; null = illustrative only. */
export function measuredDistance(doc: LandscapeDocument, size: Size, a: Point, b: Point): number | null {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (doc.background.kind === "BLANK") return d;
  if (doc.background.kind === "PHOTO" && doc.background.measuredWidthM) return (d / size.w) * doc.background.measuredWidthM;
  return null;
}
