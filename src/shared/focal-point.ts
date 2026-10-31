/**
 * Focal point of a photo: the spot that must stay visible when the picture is cropped to fill a frame
 * of another shape (`object-fit: cover`). Stored per image as percentages (0 = left/top, 100 = right/bottom)
 * and drawn with `object-position: x% y%` — which always keeps that spot inside the frame.
 *
 * Found without any service, from a small copy of the picture (≈100 px): people's skin weighs most
 * (faces, hands), then detail (edges) and strong colour — the approach of smartcrop.js, simplified.
 * The best window for a wide frame (desktop slideshow) decides the height; the best window for a
 * tall frame (phone) decides the left–right position; inside each window the point goes to the
 * centre of what matters there.
 */
export interface FocalPoint {
  x: number;
  y: number;
}

export const CENTER: FocalPoint = { x: 50, y: 50 };

/** Shapes the site crops to: the home slideshow on a computer (≈ 2.4 : 1) and on a phone (≈ 0.6 : 1). */
const WIDE = 2.4;
const TALL = 0.6;

const SKIN = [0.78, 0.57, 0.44] as const;
const SKIN_WEIGHT = 1.8;
const DETAIL_WEIGHT = 0.2;
const SATURATION_WEIGHT = 0.3;

export function isFocalPoint(v: unknown): v is FocalPoint {
  if (typeof v !== "object" || v === null) return false;
  const { x, y } = v as Record<string, unknown>;
  return Number.isInteger(x) && Number.isInteger(y) && (x as number) >= 0 && (x as number) <= 100 && (y as number) >= 0 && (y as number) <= 100;
}

/** "x% y%" for CSS object-position; undefined (browser default = centre) without a point. */
export function objectPosition(focal: FocalPoint | null | undefined): string | undefined {
  return focal ? `${focal.x}% ${focal.y}%` : undefined;
}

/** How much each pixel matters (RGBA bytes in, one weight per pixel out). */
export function importanceMap(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const n = width * height;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = (0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!) / 255;
  }
  const out = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const r = rgba[i * 4]! / 255;
      const g = rgba[i * 4 + 1]! / 255;
      const b = rgba[i * 4 + 2]! / 255;
      const l = lum[i]!;

      // Skin: colour direction close to a skin tone, not too dark.
      let skin = 0;
      const mag = Math.sqrt(r * r + g * g + b * b);
      if (mag > 0 && l > 0.2) {
        const d = Math.hypot(r / mag - SKIN[0], g / mag - SKIN[1], b / mag - SKIN[2]);
        const s = 1 - d;
        if (s > 0.8) skin = (s - 0.8) / 0.2;
      }

      // Detail: local contrast (Laplacian of brightness).
      const up = y > 0 ? lum[i - width]! : l;
      const down = y < height - 1 ? lum[i + width]! : l;
      const left = x > 0 ? lum[i - 1]! : l;
      const right = x < width - 1 ? lum[i + 1]! : l;
      const detail = Math.min(1, Math.abs(4 * l - up - down - left - right) * 2);

      // Saturation (HSL), ignoring near-black / near-white.
      let saturation = 0;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const light = (max + min) / 2;
      if (max !== min && light > 0.05 && light < 0.9) {
        const s = light > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
        if (s > 0.4) saturation = (s - 0.4) / 0.6;
      }
      out[i] = skin * SKIN_WEIGHT + detail * DETAIL_WEIGHT + saturation * SATURATION_WEIGHT;
    }
  }
  return out;
}

/**
 * Best position along one axis: profile[k] = importance of row (or column) k; a window of `size` rows slides along it.
 * Returns the importance-weighted centre inside the best window, as a percentage of the whole length.
 */
function bestAlong(profile: Float64Array, size: number): number {
  const n = profile.length;
  const total = profile.reduce((a, b) => a + b, 0);
  if (total <= 1e-6) return 50;
  if (size >= n) {
    let m = 0;
    for (let k = 0; k < n; k++) m += profile[k]! * (k + 0.5);
    return clampPct((m / total / n) * 100);
  }
  let sum = 0;
  for (let k = 0; k < size; k++) sum += profile[k]!;
  let best = sum;
  let bestStart = 0;
  const middle = (n - size) / 2;
  for (let start = 1; start + size <= n; start++) {
    sum += profile[start + size - 1]! - profile[start - 1]!;
    // Ties (or near ties, < 0.5 %) go to the window nearer the middle of the picture.
    const better = sum > best * 1.005 || (sum >= best * 0.995 && Math.abs(start - middle) < Math.abs(bestStart - middle));
    if (better) {
      best = Math.max(best, sum);
      bestStart = start;
    }
  }
  let mass = 0;
  let moment = 0;
  for (let k = bestStart; k < bestStart + size; k++) {
    mass += profile[k]!;
    moment += profile[k]! * (k + 0.5);
  }
  const centre = mass > 1e-6 ? moment / mass : bestStart + size / 2;
  return clampPct((centre / n) * 100);
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Focal point of a small RGBA picture (e.g. canvas getImageData of a ≈100 px copy). */
export function findFocalPoint(rgba: ArrayLike<number>, width: number, height: number): FocalPoint {
  if (width < 2 || height < 2 || rgba.length < width * height * 4) return CENTER;
  const weights = importanceMap(rgba, width, height);
  const rows = new Float64Array(height);
  const cols = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = weights[y * width + x]!;
      rows[y] = rows[y]! + w;
      cols[x] = cols[x]! + w;
    }
  }
  // Wide frame: full width, a band of rows → height. Tall frame: full height, a band of columns → left–right.
  const band = Math.max(1, Math.round(width / WIDE));
  const strip = Math.max(1, Math.round(height * TALL));
  return { x: bestAlong(cols, strip), y: bestAlong(rows, band) };
}
