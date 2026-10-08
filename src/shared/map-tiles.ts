/**
 * Footer map thumbnail: OpenStreetMap tiles around the site's coordinates (Settings → Website →
 * latitude / longitude), served through the Worker (`/map-tiles/…`, see map-tile.service.ts) so
 * visitors' browsers never contact a third party. Web Mercator tile maths shared by the server
 * (which tiles it may fetch) and the client (where to draw them).
 */

export const MAP_PREVIEW_ZOOM = 15;
export const MAP_TILE_SIZE = 256;

/**
 * Half of the largest thumbnail, in tiles, with the point in the middle: 320 × 160 CSS px (the
 * footer's max-width and 2:1 ratio in layout.css) plus 2 px for rounding.
 */
const HALF = { x: 162 / MAP_TILE_SIZE, y: 82 / MAP_TILE_SIZE } as const;

/** Position of a point in tile units at a zoom level (x / y = column / row, fraction = within the tile). */
export function tilePoint(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const lat = (Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI) / 180;
  return {
    x: ((longitude + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  };
}

export interface PreviewTile {
  /** Tile column / row at MAP_PREVIEW_ZOOM. */
  x: number;
  y: number;
  /** Top-left corner of the tile in CSS px, relative to the point (the middle of the thumbnail). */
  left: number;
  top: number;
}

/** The tiles a thumbnail centred on the point needs (usually 2 × 2, never more than 3 × 2). */
export function previewTiles(latitude: number, longitude: number): PreviewTile[] {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const p = tilePoint(latitude, longitude, MAP_PREVIEW_ZOOM);
  const n = 2 ** MAP_PREVIEW_ZOOM;
  // Offsets are rounded once, so neighbouring tiles always meet exactly (no 1 px seams).
  const left0 = Math.round(-p.x * MAP_TILE_SIZE);
  const top0 = Math.round(-p.y * MAP_TILE_SIZE);
  const tiles: PreviewTile[] = [];
  for (let ty = Math.floor(p.y - HALF.y); ty <= Math.floor(p.y + HALF.y); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(p.x - HALF.x); tx <= Math.floor(p.x + HALF.x); tx++) {
      tiles.push({ x: ((tx % n) + n) % n, y: ty, left: left0 + tx * MAP_TILE_SIZE, top: top0 + ty * MAP_TILE_SIZE });
    }
  }
  return tiles;
}

export function mapTilePath(x: number, y: number): string {
  return `/map-tiles/${MAP_PREVIEW_ZOOM}/${x}/${y}.png`;
}

/** Server-side gate: only the thumbnail's own tiles are fetched (the Worker is not an open tile proxy). */
export function isPreviewTile(latitude: number, longitude: number, z: number, x: number, y: number): boolean {
  return z === MAP_PREVIEW_ZOOM && previewTiles(latitude, longitude).some((t) => t.x === x && t.y === y);
}
