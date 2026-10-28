import { project, TILE } from "../../shared/geo.ts";
import { SATELLITE_TILE_PATH, SATELLITE_ZOOM_ABOVE, SATELLITE_ZOOM_BELOW, SATELLITE_MAX_TILE_ZOOM } from "../../shared/landscape-types.ts";
import type { FetchLike } from "../line/line-api.ts";
import type { TileCache } from "./map-tile.service.ts";

/**
 * GET /sat-tiles/<z>/<x>/<y> — satellite imagery for satellite site plans (landscape, phase L4), from MapTiler.
 *
 * Fetched by the Worker with the MAPTILER_API_KEY secret, so the key never reaches a browser and the page's CSP stays
 * as it is. Not an open proxy: only tiles around a satellite plan of this site (its frame and one frame around it, a
 * few zoom levels in and out) while the landscape feature is on; anything else is 404. Tiles keep MapTiler's own cache
 * time (at most 7 days) at Cloudflare's edge and in the browser; the attribution is shown on every map.
 */
const UPSTREAM = "https://api.maptiler.com/tiles";
const DEFAULT_TILESET = "satellite-v2";
const MAX_BYTES = 1_500_000;
const MAX_AGE = 604_800;
/** Plan frame (map pixels at the plan's zoom) and the margin allowed around it. */
const FRAME = { w: 1600, h: 1000 };
const AREA_MEMO_MS = 30_000;
const AREA_RECHECK_MS = 500;

export interface SatelliteTileOptions {
  apiKey: string | null;
  tileset?: string | null;
  fetch?: FetchLike;
  cache?: TileCache | null;
}

type Area = { lon: number; lat: number; zoom: number };

/** Plan areas per database, kept a few seconds across requests (a map view asks for dozens of tiles at once). */
const memos = new WeakMap<object, { at: number; areas: Area[] }>();

export class SatelliteTileService {
  constructor(
    private readonly areas: () => Promise<Area[]>,
    private readonly options: SatelliteTileOptions,
    private readonly now: () => number = Date.now,
    /** What the memo is kept for (the site's database). */
    private readonly memoKey: object = {},
  ) {}

  get configured(): boolean {
    return !!this.options.apiKey;
  }

  async serve(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    const m = SATELLITE_TILE_PATH.exec(url.pathname);
    if (!m) return plain(404, "Not found", "public, max-age=60");
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (z > SATELLITE_MAX_TILE_ZOOM || x >= 2 ** z || y >= 2 ** z) return plain(404, "Not found", "public, max-age=60");
    if (!this.options.apiKey) return plain(503, "MAP_NOT_CONFIGURED", "no-store");

    // One copy per tile (the editor adds ?v= to reload after a save; it is not part of the key).
    const key = new Request(`${url.origin}/sat-tiles/${z}/${x}/${y}`);
    const cached = await this.options.cache?.match(key).catch(() => undefined);
    if (cached) return cached;

    if (!(await this.allowed(z, x, y))) return plain(404, "Not found", "no-store");

    const fetchImpl = this.options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
    const tileset = (this.options.tileset?.trim() || DEFAULT_TILESET).replace(/[^A-Za-z0-9_-]/g, "");
    let upstream: Response;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      upstream = await fetchImpl(`${UPSTREAM}/${tileset}/${z}/${x}/${y}?key=${encodeURIComponent(this.options.apiKey)}`, { headers: { Accept: "image/*" } });
      if (upstream.status === 204) return plain(404, "Empty tile", "public, max-age=86400");
      // Never echo MapTiler's body or URL (it carries the key).
      if (upstream.status === 401 || upstream.status === 403) return unavailable(403, "MAP_KEY_REJECTED");
      if (upstream.status === 404) return unavailable(404, "MAP_TILESET_NOT_FOUND");
      if (!upstream.ok) return unavailable(502, `MAP_UPSTREAM_${upstream.status}`);
      bytes = new Uint8Array(await upstream.arrayBuffer());
    } catch (error) {
      return unavailable(502, `MAP_UPSTREAM_ERROR ${String(error).replace(/key=[^&\s]+/g, "key=…").slice(0, 120)}`);
    }
    const type = imageType(bytes);
    if (!type || bytes.length > MAX_BYTES) return unavailable(502, "MAP_NOT_AN_IMAGE");

    const response = new Response(bytes, {
      headers: {
        "Content-Type": type,
        "Cache-Control": `public, max-age=${cacheSeconds(upstream.headers.get("Cache-Control"))}`,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
    await this.options.cache?.put(key, response.clone()).catch(() => undefined);
    return response;
  }

  /** Is tile (z, x, y) near a satellite plan of this site, at a zoom that plan uses? */
  async allowed(z: number, x: number, y: number): Promise<boolean> {
    const read = async () => {
      const fresh = { at: this.now(), areas: await this.areas() };
      memos.set(this.memoKey, fresh);
      return fresh;
    };
    let memo = memos.get(this.memoKey);
    if (!memo || this.now() - memo.at > AREA_MEMO_MS || this.now() < memo.at) memo = await read();
    if (memo.areas.some((a) => tileNearArea(a, z, x, y))) return true;
    // A plan just moved or was published: look again (at most twice a second), not only after the memo runs out.
    if (this.now() - memo.at > AREA_RECHECK_MS) memo = await read();
    return memo.areas.some((a) => tileNearArea(a, z, x, y));
  }
}

export function tileNearArea(a: Area, z: number, x: number, y: number): boolean {
  const base = Math.round(a.zoom);
  if (z < base - SATELLITE_ZOOM_BELOW || z > Math.min(SATELLITE_MAX_TILE_ZOOM, base + SATELLITE_ZOOM_ABOVE)) return false;
  const [cx, cy] = project([a.lon, a.lat], a.zoom);
  // The frame and one more frame on every side, in map pixels at the plan's zoom.
  const left = cx - FRAME.w * 1.5;
  const top = cy - FRAME.h * 1.5;
  const k = 2 ** (a.zoom - z); // tile pixels at z → pixels at the plan's zoom
  const tx0 = x * TILE * k;
  const ty0 = y * TILE * k;
  return tx0 + TILE * k > left && tx0 < left + FRAME.w * 3 && ty0 + TILE * k > top && ty0 < top + FRAME.h * 3;
}

function cacheSeconds(header: string | null): number {
  const m = header ? /max-age=(\d+)/.exec(header) : null;
  const s = m ? Number(m[1]) : 86_400;
  return Math.max(3600, Math.min(MAX_AGE, s));
}

function imageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

function plain(status: number, text: string, cache: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": cache } });
}

/** The reason goes to the logs and to the editor (a short code, never the key). */
function unavailable(status: number, reason: string): Response {
  console.warn(JSON.stringify({ level: "warn", message: "satellite_tile_unavailable", reason }));
  return plain(status, reason.split(" ")[0]!, "no-store");
}
