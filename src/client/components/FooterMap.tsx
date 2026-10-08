import { useState } from "react";
import { MAP_TILE_SIZE, mapTilePath, previewTiles } from "../../shared/map-tiles.ts";

interface Props {
  label: string;
  /** Settings → Website map link; without one the thumbnail opens OpenStreetMap at the same point. */
  mapUrl: string | null;
  coordinates: { latitude: number; longitude: number } | null | undefined;
}

/**
 * "Map" in the footer contact block: the link, and under it a small map of the place when the
 * coordinates are set (Settings → Website). The tiles come from this site (/map-tiles/…, OpenStreetMap
 * through the Worker); if one cannot be loaded the thumbnail is left out and the link stays.
 */
export function FooterMap({ label, mapUrl, coordinates }: Props) {
  const [failed, setFailed] = useState(false);
  const tiles = coordinates ? previewTiles(coordinates.latitude, coordinates.longitude) : [];
  const href = mapUrl ?? (coordinates ? osmLink(coordinates.latitude, coordinates.longitude) : null);
  if (!href) return null;

  if (failed || tiles.length === 0) {
    return <p><a href={href} rel="noopener noreferrer" target="_blank">{label}</a></p>;
  }

  return (
    <div className="footer-map">
      {/* One link: the word and the picture (a single tab stop; the picture is decorative). */}
      <a className="footer-map__link" href={href} rel="noopener noreferrer" target="_blank">
        <span className="footer-map__label">{label}</span>
        <span className="footer-map__view">
          <span className="footer-map__tiles">
            {tiles.map((t) => (
              <img
                key={`${t.x}/${t.y}`}
                src={mapTilePath(t.x, t.y)}
                alt=""
                width={MAP_TILE_SIZE}
                height={MAP_TILE_SIZE}
                loading="lazy"
                decoding="async"
                draggable={false}
                style={{ left: `${t.left}px`, top: `${t.top}px` }}
                onError={() => setFailed(true)}
              />
            ))}
          </span>
          <svg className="footer-map__pin" viewBox="0 0 24 32" width="24" height="32" aria-hidden="true" focusable="false">
            <path d="M12 1C6.2 1 1.5 5.6 1.5 11.3 1.5 19 12 31 12 31s10.5-12 10.5-19.7C22.5 5.6 17.8 1 12 1Z" />
            <circle cx="12" cy="11.5" r="4" />
          </svg>
        </span>
      </a>
      {/* OpenStreetMap licence: the attribution stays visible on the map. */}
      <small className="footer-map__credit">
        © <a href="https://www.openstreetmap.org/copyright" rel="noopener noreferrer" target="_blank">OpenStreetMap</a>
      </small>
    </div>
  );
}

function osmLink(latitude: number, longitude: number): string {
  const lat = latitude.toFixed(6);
  const lng = longitude.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}
