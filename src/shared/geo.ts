/**
 * Earth geometry for site plans (landscape, phase L4): Web Mercator (the projection of map tiles), distances, and
 * georeferencing a photo from control points (a pixel on the photo ↔ a place on the earth).
 *
 * Shared by the editor, the booking-page map and the Worker (tile area check). Pure functions, no dependencies.
 */

export type LonLat = [number, number];
export type Xy = [number, number];

/** Tiles are 256 × 256 "world pixels" at each zoom (the size of the image file does not matter). */
export const TILE = 256;
export const EARTH_RADIUS_M = 6_378_137;
const MAX_LAT = 85.05112878;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** [lon, lat] → Web Mercator world pixels at zoom `z` (origin top-left of the world, y down). */
export function project([lon, lat]: LonLat, z: number): Xy {
  const n = TILE * 2 ** z;
  const phi = rad(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)));
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n];
}

export function unproject([x, y]: Xy, z: number): LonLat {
  const n = TILE * 2 ** z;
  return [(x / n) * 360 - 180, deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))))];
}

/** Ground metres per world pixel at a latitude and zoom. */
export function metresPerPixel(lat: number, z: number): number {
  return (2 * Math.PI * EARTH_RADIUS_M * Math.cos(rad(lat))) / (TILE * 2 ** z);
}

/** Great-circle distance in metres. */
export function distanceM([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Tiles (x, y) of zoom `tz` that cover a box of world pixels at zoom `z`. */
export function tilesFor(box: { x: number; y: number; w: number; h: number }, z: number, tz: number): { x: number; y: number }[] {
  const k = 2 ** (tz - z);
  const n = 2 ** tz;
  const x0 = Math.max(0, Math.floor((box.x * k) / TILE));
  const y0 = Math.max(0, Math.floor((box.y * k) / TILE));
  const x1 = Math.min(n - 1, Math.floor(((box.x + box.w) * k) / TILE));
  const y1 = Math.min(n - 1, Math.floor(((box.y + box.h) * k) / TILE));
  const out: { x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
  return out;
}

/**
 * "13.7563, 100.5018" (latitude first, as Google Maps copies it) or "100.5018 13.7563E…" — the first two numbers,
 * read as latitude, longitude. Null when it is not a place on the earth.
 */
export function parseLatLon(text: string): LonLat | null {
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return null;
  const lat = Number(nums[0]);
  const lon = Number(nums[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

export function formatLatLon([lon, lat]: LonLat): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

// ------------------------------------------------------------------ georeferencing (photo ↔ earth)

/**
 * A fitted transform from photo pixels to local ground metres (east, south) around `origin`, and back.
 * Two control points: similarity (move, turn, scale — the photo's shape is kept). Three or more: affine (also
 * stretch / skew, for photos taken at an angle), fitted by least squares; `residualsM` show how far each control
 * point lands from where it was said to be.
 */
export interface Georef {
  kind: "SIMILARITY" | "AFFINE";
  /** x' = a·x + b·y + c,  y' = d·x + e·y + f  (pixels → metres east / south of origin). */
  m: [number, number, number, number, number, number];
  origin: LonLat;
  /** Metres per photo pixel (mean). */
  scaleM: number;
  /** Turn of the photo against north-up, degrees clockwise. */
  rotationDeg: number;
  residualsM: number[];
  rmsM: number;
}

function toLocal([lon, lat]: LonLat, [lon0, lat0]: LonLat): Xy {
  return [rad(lon - lon0) * EARTH_RADIUS_M * Math.cos(rad(lat0)), -rad(lat - lat0) * EARTH_RADIUS_M];
}

function fromLocal([x, y]: Xy, [lon0, lat0]: LonLat): LonLat {
  return [lon0 + deg(x / (EARTH_RADIUS_M * Math.cos(rad(lat0)))), lat0 - deg(y / EARTH_RADIUS_M)];
}

/** Solves a 3 × 3 linear system (Cramer); null when singular (points on one line). */
function solve3(A: number[][], b: number[]): number[] | null {
  const det = (m: number[][]) => m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!)
    - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!)
    + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const D = det(A);
  if (Math.abs(D) < 1e-12 * Math.max(1, Math.abs(A[0]![0]!) ** 3)) return null;
  return [0, 1, 2].map((i) => det(A.map((row, r) => row.map((v, c) => (c === i ? b[r]! : v)))) / D);
}

/** Fits photo pixels → earth from control points; null with fewer than 2 points or when they cannot define it. */
export function fitGeoref(points: { image: Xy; geo: LonLat }[]): Georef | null {
  if (points.length < 2) return null;
  const origin: LonLat = [points.reduce((s, p) => s + p.geo[0], 0) / points.length, points.reduce((s, p) => s + p.geo[1], 0) / points.length];
  const src = points.map((p) => p.image);
  const dst = points.map((p) => toLocal(p.geo, origin));
  let m: Georef["m"];
  let kind: Georef["kind"];
  if (points.length === 2 || collinear(src)) {
    // Similarity by least squares: x' = a x − b y + c, y' = b x + a y + d (centred).
    const sx = mean(src.map((p) => p[0])); const sy = mean(src.map((p) => p[1]));
    const dx = mean(dst.map((p) => p[0])); const dy = mean(dst.map((p) => p[1]));
    let num1 = 0; let num2 = 0; let den = 0;
    src.forEach(([x, y], i) => {
      const u = x - sx; const v = y - sy;
      const X = dst[i]![0] - dx; const Y = dst[i]![1] - dy;
      num1 += u * X + v * Y; num2 += u * Y - v * X; den += u * u + v * v;
    });
    if (den === 0) return null;
    const a = num1 / den; const b = num2 / den;
    if (a === 0 && b === 0) return null;
    m = [a, -b, dx - a * sx + b * sy, b, a, dy - b * sx - a * sy];
    kind = "SIMILARITY";
  } else {
    const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const bx = [0, 0, 0]; const by = [0, 0, 0];
    src.forEach(([x, y], i) => {
      const row = [x, y, 1];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) AtA[r]![c]! += row[r]! * row[c]!;
        bx[r]! += row[r]! * dst[i]![0];
        by[r]! += row[r]! * dst[i]![1];
      }
    });
    const px = solve3(AtA, bx); const py = solve3(AtA, by);
    if (!px || !py) return null;
    m = [px[0]!, px[1]!, px[2]!, py[0]!, py[1]!, py[2]!];
    kind = "AFFINE";
  }
  const residualsM = src.map((p, i) => {
    const q = applyLinear(m, p);
    return Math.hypot(q[0] - dst[i]![0], q[1] - dst[i]![1]);
  });
  const det = m[0] * m[4] - m[1] * m[3];
  if (!Number.isFinite(det) || det === 0) return null;
  return {
    kind, m, origin,
    scaleM: Math.sqrt(Math.abs(det)),
    rotationDeg: deg(Math.atan2(m[3], m[0])),
    residualsM,
    rmsM: Math.sqrt(residualsM.reduce((s, r) => s + r * r, 0) / residualsM.length),
  };
}

function mean(v: number[]): number { return v.reduce((s, x) => s + x, 0) / v.length; }

function collinear(pts: Xy[]): boolean {
  const [a, b] = pts;
  if (!a || !b) return true;
  const span = Math.max(...pts.map((p) => Math.hypot(p[0] - a[0], p[1] - a[1])), 1);
  return pts.every((p) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / span < span * 1e-3);
}

function applyLinear(m: Georef["m"], [x, y]: Xy): Xy {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

/** Photo pixel → [lon, lat]. */
export function imageToGeo(g: Georef, p: Xy): LonLat {
  return fromLocal(applyLinear(g.m, p), g.origin);
}

/** [lon, lat] → photo pixel. */
export function geoToImage(g: Georef, geo: LonLat): Xy {
  const [X, Y] = toLocal(geo, g.origin);
  const [a, b, c, d, e, f] = g.m;
  const det = a * e - b * d;
  const x = X - c; const y = Y - f;
  return [(e * x - b * y) / det, (-d * x + a * y) / det];
}

/** Ground distance in metres between two photo pixels. */
export function georefDistanceM(g: Georef, p: Xy, q: Xy): number {
  const a = applyLinear(g.m, p); const b = applyLinear(g.m, q);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
