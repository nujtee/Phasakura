import { useEffect, useRef, useState } from "react";
import { tilesFor, TILE } from "../../shared/geo.ts";
import {
  SATELLITE_MAX_TILE_ZOOM, SATELLITE_ZOOM_ABOVE, SATELLITE_ZOOM_BELOW, satelliteTileUrl, type LandscapeBackground,
} from "../../shared/landscape-types.ts";
import { satelliteFrame, SATELLITE_FRAME, type Box } from "./geometry.ts";

type SatelliteBg = Extract<LandscapeBackground, { kind: "SATELLITE" }>;

/** Most tiles drawn at once; above this the next coarser zoom is used. */
const MAX_TILES = 64;

/**
 * Satellite imagery under a satellite plan (landscape, phase L4), in world units (map pixels at the plan's zoom).
 * Sharper tiles as the view zooms in (up to SATELLITE_ZOOM_ABOVE levels), only the tiles on screen, and only inside
 * the area the Worker serves (the frame and one frame around it).
 */
export function SatelliteTiles({ bg, view, pxPerUnit, version, onError }: {
  bg: SatelliteBg;
  /** What is on screen, in world units. */
  view: Box;
  /** Screen pixels per world unit. */
  pxPerUnit: number;
  /** Changes the tile URLs (not the tiles): reload after the plan's area was saved. */
  version?: string | number;
  /** First tile that failed to load (its URL), to explain why. */
  onError?: (url: string) => void;
}) {
  const f = satelliteFrame(bg);
  const base = Math.round(bg.zoom);
  const area: Box = { x: -SATELLITE_FRAME.w, y: -SATELLITE_FRAME.h, w: SATELLITE_FRAME.w * 3, h: SATELLITE_FRAME.h * 3 };
  const x = Math.max(view.x, area.x);
  const y = Math.max(view.y, area.y);
  const visible: Box = { x, y, w: Math.min(view.x + view.w, area.x + area.w) - x, h: Math.min(view.y + view.h, area.y + area.h) - y };
  const reported = useRef(false);
  // A tile that failed is asked for once more a moment later (a plan saved a second ago may not be known yet).
  const [retried, setRetried] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  if (visible.w <= 0 || visible.h <= 0) return null;

  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  let tz = Math.max(base - SATELLITE_ZOOM_BELOW, Math.min(base + SATELLITE_ZOOM_ABOVE, SATELLITE_MAX_TILE_ZOOM,
    base + Math.round(Math.log2(Math.max(1e-6, pxPerUnit * dpr)))));
  // In map pixels at the plan's zoom (the world box shifted by the frame's origin).
  const box = { x: visible.x + f.origin[0], y: visible.y + f.origin[1], w: visible.w, h: visible.h };
  let tiles = tilesFor(box, bg.zoom, tz);
  while (tiles.length > MAX_TILES && tz > base - SATELLITE_ZOOM_BELOW) tiles = tilesFor(box, bg.zoom, --tz);
  const k = 2 ** (bg.zoom - tz);
  const side = TILE * k;

  return (
    <g aria-hidden="true" pointerEvents="none">
      {tiles.map((t) => {
        const key = `${tz}/${t.x}/${t.y}`;
        const again = retried.has(key);
        const url = satelliteTileUrl(tz, t.x, t.y, version);
        const href = again ? `${url}${url.includes("?") ? "&" : "?"}r=1` : url;
        return (
          // A hair larger: no seams between tiles at fractional screen positions.
          <image key={key} href={href} x={t.x * side - f.origin[0]} y={t.y * side - f.origin[1]}
            width={side * 1.002} height={side * 1.002} preserveAspectRatio="none"
            onError={() => {
              if (!again) {
                timers.current.push(window.setTimeout(() => setRetried((cur) => new Set(cur).add(key)), 1500));
                return;
              }
              if (!reported.current) { reported.current = true; onError?.(href); }
            }} />
        );
      })}
    </g>
  );
}

/** MapTiler's terms: the imagery's attribution stays visible on the map. */
export function SatelliteAttribution({ className }: { className?: string }) {
  return (
    <p className={className ?? "landscape-attribution"}>
      <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">© MapTiler</a>{" "}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>
    </p>
  );
}

/** Why the imagery did not load: the Worker answers with a short code (never the key). */
export async function tileProblem(url: string): Promise<string> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return "OK";
    const text = (await res.text()).trim();
    return /^[A-Z_0-9]{3,40}$/.test(text) ? text : `HTTP_${res.status}`;
  } catch {
    return "NETWORK";
  }
}
