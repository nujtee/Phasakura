import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AvailabilityDto, PublicAccommodationsDto, PublicUnitDto } from "../../shared/accommodation-types.ts";
import type { PublicLandscapeDto } from "../../shared/landscape-types.ts";
import { apiGet } from "../api/client.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { drawable, mapScene, mapTargets, type MapTarget, type StayStatus } from "../landscape/booking-map.ts";
import { shapeBox, shapeCenter } from "../landscape/geometry.ts";
import { ShapeView } from "../landscape/ShapeView.tsx";
import type { Pick } from "./StayPicks.tsx";
import { useBookingT } from "./useBookingT.ts";

const ZOOMS = [1, 1.5, 2, 3, 4];

/**
 * Site map on the booking page (landscape, phase L3): the published plan, read-only. Houses, VIP tents and the
 * camping area linked in the editor can be tapped (or reached with Tab + Enter) to see them and choose them; the
 * list of stays below stays the full alternative. Shown only while the Super Admin has the feature switched on and
 * a plan is public.
 */
export function LandscapeMap({ data, availability, picks, renderUnit, onCamping, listId }: {
  data: PublicAccommodationsDto;
  availability: AvailabilityDto | null;
  picks: Pick[];
  /** The unit card with its choose / remove button, as in the list. */
  renderUnit: (unit: PublicUnitDto) => ReactNode;
  onCamping: () => void;
  /** Element the "skip the map" link moves to. */
  listId: string;
}) {
  const bt = useBookingT();
  const m = bt.map;
  const [plan, setPlan] = useState<PublicLandscapeDto | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** Where the middle of the view was (0…1), kept while zooming. */
  const middle = useRef<[number, number]>([0.5, 0.5]);

  useEffect(() => {
    const controller = new AbortController();
    // No plan, or the request failed: the page simply has no map (the list works as before).
    apiGet<PublicLandscapeDto>("/api/public/landscape", controller.signal).then(setPlan, () => undefined);
    return () => controller.abort();
  }, []);

  const layout = plan?.enabled ? plan.layout : null;
  const scene = useMemo(() => (layout && drawable(layout.document) ? mapScene(layout.document, layout.backgroundSize) : null), [layout]);
  const pickedIds = useMemo(() => new Set(picks.flatMap((p) => (p.kind === "UNIT" ? [p.unit.id] : []))), [picks]);
  const targets = useMemo(() => (scene ? mapTargets(scene.objects, {
    units: [...data.houses, ...data.vipTents],
    availability,
    pickedIds,
    campingEnabled: data.camping.enabled,
    campingPicked: picks.some((p) => p.kind === "CAMPING"),
  }) : new Map<string, MapTarget>()), [scene, data, availability, pickedIds, picks]);

  // After the details are on screen: keyboard users land in them; a tap only scrolls them into view.
  const opened = useRef<"keyboard" | "pointer" | null>(null);
  const [openCount, setOpenCount] = useState(0);
  useEffect(() => {
    const how = opened.current;
    opened.current = null;
    if (how === "keyboard") panel.current?.focus();
    else if (how === "pointer") panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [openCount]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = middle.current[0] * el.scrollWidth - el.clientWidth / 2;
    el.scrollTop = middle.current[1] * el.scrollHeight - el.clientHeight / 2;
  }, [zoomIndex]);

  if (!layout || !scene) return null;
  const doc = layout.document;
  const { size, objects } = scene;
  const labelSize = Math.max(size.w, size.h) / 60;
  const current = selected ? targets.get(selected) ?? null : null;
  const statusText: Record<StayStatus, string> = { available: m.available, unavailable: m.unavailable, picked: m.picked, unknown: m.notChecked };
  const illustrative = doc.background.kind === "PHOTO" && !doc.background.measuredWidthM;

  const zoom = (next: number) => {
    const el = scroller.current;
    if (el && el.scrollWidth) {
      middle.current = [(el.scrollLeft + el.clientWidth / 2) / el.scrollWidth, (el.scrollTop + el.clientHeight / 2) / el.scrollHeight];
    }
    setZoomIndex(Math.max(0, Math.min(ZOOMS.length - 1, next)));
  };

  const open = (id: string, byKeyboard: boolean) => {
    opened.current = byKeyboard ? "keyboard" : "pointer";
    setSelected(id);
    setOpenCount((n) => n + 1);
  };

  const name = (t: MapTarget) => (t.kind === "UNIT" ? t.unit.name : data.camping.name ?? t.object.label ?? m.campingGo);

  return (
    <section className="bmap" aria-labelledby="bmap-title">
      <div className="bmap__head">
        <h2 id="bmap-title" className="section-title">{m.title}</h2>
        <a className="bmap__skip" href={`#${listId}`} onClick={(e) => {
          e.preventDefault();
          const el = document.getElementById(listId);
          el?.scrollIntoView({ behavior: "smooth", block: "start" });
          el?.focus({ preventScroll: true });
        }}>{m.skip}</a>
      </div>
      <p className="bmap__hint">{availability ? m.hint : m.searchFirst}</p>

      <div className="bmap__frame">
        <div className="bmap__zoom" role="group" aria-label={m.title}>
          <button type="button" className="bmap__zbtn" aria-label={m.zoomIn} disabled={zoomIndex >= ZOOMS.length - 1} onClick={() => zoom(zoomIndex + 1)}>+</button>
          <button type="button" className="bmap__zbtn" aria-label={m.zoomOut} disabled={zoomIndex === 0} onClick={() => zoom(zoomIndex - 1)}>−</button>
          <button type="button" className="bmap__zbtn bmap__zbtn--text" disabled={zoomIndex === 0} onClick={() => { middle.current = [0.5, 0.5]; setZoomIndex(0); }}>{m.zoomFit}</button>
        </div>
        <div className="bmap__scroll" ref={scroller}>
          <svg className="bmap__svg" viewBox={`0 0 ${size.w} ${size.h}`} style={{ width: `${ZOOMS[zoomIndex]! * 100}%` }}
            role="group" aria-label={fill(m.label, { name: layout.name })}>
            {doc.background.kind === "BLANK" && <rect x={0} y={0} width={size.w} height={size.h} fill={doc.background.color} />}
            {doc.background.kind === "PHOTO" && (layout.backgroundUrl
              ? <image href={layout.backgroundUrl} x={0} y={0} width={size.w} height={size.h} opacity={doc.background.opacity} preserveAspectRatio="none" />
              : <rect x={0} y={0} width={size.w} height={size.h} fill="#eeeeee" />)}
            {objects.map((o) => {
              const imageUrl = o.imageAssetId ? layout.imageUrls[o.imageAssetId] ?? null : null;
              const target = targets.get(o.id);
              if (!target) {
                return <g key={o.id} aria-hidden="true"><ShapeView o={o} labelSize={labelSize} imageUrl={imageUrl} /></g>;
              }
              const highlight = selected === o.id ? "selected" : target.status === "unknown" ? null : target.status;
              const box = shapeBox(o.shape);
              const [cx, cy] = shapeCenter(o.shape);
              const badge = Math.min(Math.max(box.w, box.h) * 0.3, labelSize * 1.6);
              return (
                <g key={o.id} className={`bmap__target bmap__target--${target.status}`} role="button" tabIndex={0}
                  aria-label={`${name(target)} — ${statusText[target.status]}`} aria-expanded={selected === o.id}
                  aria-controls="bmap-panel" data-target={o.id}
                  onClick={() => open(o.id, false)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(o.id, true); }
                  }}>
                  <ShapeView o={o} labelSize={labelSize} imageUrl={imageUrl} highlight={highlight} />
                  {target.status === "picked" && (
                    <g transform={o.rotation ? `rotate(${o.rotation} ${cx} ${cy})` : undefined} pointerEvents="none">
                      <circle cx={box.x + box.w} cy={box.y} r={badge / 2} fill="#e65100" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                      <text x={box.x + box.w} y={box.y} fontSize={badge * 0.7} textAnchor="middle" dominantBaseline="central" fill="#fff" fontWeight={700}>✓</text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <ul className="bmap__legend" aria-label={m.title}>
        <li><span className="bmap__swatch bmap__swatch--available" aria-hidden="true" />{m.available}</li>
        <li><span className="bmap__swatch bmap__swatch--unavailable" aria-hidden="true" />{m.unavailable}</li>
        <li><span className="bmap__swatch bmap__swatch--picked" aria-hidden="true" />{m.picked}</li>
        {illustrative && <li className="bmap__note">{m.illustrative}</li>}
      </ul>

      <div id="bmap-panel" ref={panel} tabIndex={-1} className="bmap__panel" aria-live="polite" hidden={!current}>
        {current && (
          <>
            <div className="bmap__panel-head">
              <strong>{name(current)}</strong>
              <span className={`bmap__chip bmap__chip--${current.status}`}>{statusText[current.status]}</span>
              <button type="button" className="button button--ghost bmap__close" onClick={() => setSelected(null)}>{m.close}</button>
            </div>
            {current.kind === "UNIT" ? (
              <div className="bmap__unit">
                {!availability && <p className="notice" role="note">{m.searchFirst}</p>}
                {renderUnit(current.unit)}
              </div>
            ) : (
              <div className="bmap__camping">
                <p>{!availability ? m.searchFirst
                  : availability.camping.enabled && availability.camping.remaining > 0 ? fill(m.campingLeft, { n: availability.camping.remaining })
                    : availability.camping.enabled ? m.campingFull : m.campingOff}</p>
                <button type="button" className="button button--primary" onClick={onCamping}>{m.campingGo}</button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
