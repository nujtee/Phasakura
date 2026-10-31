import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { objectPosition, ZOOM_MAX, ZOOM_MIN, zoomScale, type FocalPoint } from "../../../shared/focal-point.ts";
import { apiRequest } from "../../api/client.ts";
import { detectFocal } from "../../media/prepareImage.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Button, detailMessage } from "../ui.tsx";

/**
 * Focal point of an uploaded photo (migration 0046): click the photo to choose the spot that must stay in view;
 * the two frames show how the public site will crop it on a computer and on a phone. Saved at once.
 */
export function FocalPicker({ assetId, url, focal, onChange, disabled, allowZoom = false }: {
  assetId: string;
  url: string;
  focal: FocalPoint | null;
  onChange: (focal: FocalPoint | null) => void;
  disabled?: boolean;
  /** Zoom in / out of the frame too (the home slideshow draws it). */
  allowZoom?: boolean;
}) {
  const { t, c } = useAdmin();
  const img = useRef<HTMLImageElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const point = focal ?? { x: 50, y: 50 };
  const [zoom, setZoom] = useState(focal?.zoom ?? ZOOM_MIN);
  const zoomTimer = useRef<number | undefined>(undefined);
  /** A zoom change still waiting for its save (sent anyway if the form closes first). */
  const pending = useRef<FocalPoint | null>(null);
  useEffect(() => { setZoom(focal?.zoom ?? ZOOM_MIN); }, [focal?.zoom]);
  useEffect(() => () => {
    window.clearTimeout(zoomTimer.current);
    if (pending.current) void apiRequest("PUT", `/api/admin/media/${encodeURIComponent(assetId)}/focal`, { focal: pending.current }).catch(() => undefined);
  }, [assetId]);
  /** The point with the current zoom (kept when the point moves). */
  const withZoom = (p: { x: number; y: number }, z = zoom): FocalPoint => (allowZoom && z > ZOOM_MIN ? { ...p, zoom: z } : { x: p.x, y: p.y });

  // Zoom: shown at once, saved when the slider / buttons stop for a moment.
  const changeZoom = (z: number) => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z / 5) * 5));
    setZoom(next);
    window.clearTimeout(zoomTimer.current);
    pending.current = withZoom(point, next);
    zoomTimer.current = window.setTimeout(() => { pending.current = null; void save(withZoom(point, next)); }, 450);
  };

  async function save(next: FocalPoint | null) {
    window.clearTimeout(zoomTimer.current);
    pending.current = null;
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiRequest<{ focal: FocalPoint | null }>("PUT", `/api/admin/media/${encodeURIComponent(assetId)}/focal`, { focal: next });
      onChange(res.focal);
      setMessage({ ok: true, text: c.ui.focalSaved });
    } catch (err) {
      setMessage({ ok: false, text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  const pick = (e: MouseEvent<HTMLButtonElement>) => {
    if (disabled || busy) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - box.left) / box.width) * 100);
    const y = Math.round(((e.clientY - box.top) / box.height) * 100);
    void save(withZoom({ x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) }));
  };

  // Keyboard: arrows move the point by 5 %.
  const nudge = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step: Record<string, [number, number]> = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] };
    const d = step[e.key];
    if (!d || disabled || busy) return;
    e.preventDefault();
    void save(withZoom({ x: Math.max(0, Math.min(100, point.x + d[0])), y: Math.max(0, Math.min(100, point.y + d[1])) }));
  };

  const auto = () => {
    const el = img.current;
    if (!el || !el.naturalWidth) return;
    const found = detectFocal(el, el.naturalWidth, el.naturalHeight);
    if (found) void save(withZoom(found));
  };

  const pos = objectPosition(point);
  const frameStyle = { objectPosition: pos, transform: `scale(${zoomScale(allowZoom ? { ...point, zoom } : null)})`, transformOrigin: pos };
  return (
    <div className="adm-focal">
      <div className="adm-focal__head">
        <strong>{c.ui.focalTitle}</strong>
        <span className="adm-focal__value">{focal ? `${focal.x}% · ${focal.y}%` : c.ui.focalNone}{allowZoom && zoom > ZOOM_MIN ? ` · ${c.ui.focalZoom} ${zoom}%` : ""}</span>
      </div>
      <p className="adm-field__hint">{c.ui.focalHint}</p>
      <div className="adm-focal__body">
        <button type="button" className="adm-focal__pick" onClick={pick} onKeyDown={nudge} disabled={disabled || busy}
          aria-label={`${c.ui.focalTitle}: ${point.x}% · ${point.y}%`}>
          <img ref={img} src={url} alt="" draggable={false} />
          <span className="adm-focal__dot" style={{ left: `${point.x}%`, top: `${point.y}%` }} aria-hidden="true" />
        </button>
        <div className="adm-focal__frames" aria-hidden="true">
          <figure>
            <div className="adm-focal__frame adm-focal__frame--wide"><img src={url} alt="" style={frameStyle} /></div>
            <figcaption>{c.ui.focalDesktop}</figcaption>
          </figure>
          <figure>
            <div className="adm-focal__frame adm-focal__frame--tall"><img src={url} alt="" style={frameStyle} /></div>
            <figcaption>{c.ui.focalMobile}</figcaption>
          </figure>
        </div>
      </div>
      {allowZoom && (
        <div className="adm-focal__zoom">
          <span className="adm-label" id={`zoom-${assetId}`}>{c.ui.focalZoom}</span>
          <button type="button" className="adm-iconbtn" aria-label={c.ui.focalZoomOut} disabled={disabled || zoom <= ZOOM_MIN}
            onClick={() => changeZoom(zoom - 10)}>−</button>
          <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={5} value={zoom} disabled={disabled}
            aria-labelledby={`zoom-${assetId}`} aria-valuetext={`${zoom}%`} onChange={(e) => changeZoom(Number(e.currentTarget.value))} />
          <button type="button" className="adm-iconbtn" aria-label={c.ui.focalZoomIn} disabled={disabled || zoom >= ZOOM_MAX}
            onClick={() => changeZoom(zoom + 10)}>+</button>
          <output className="adm-focal__value" aria-live="polite">{zoom}%</output>
        </div>
      )}
      {!disabled && (
        <div className="adm-focal__actions">
          <Button variant="secondary" busy={busy} onClick={auto}>{c.ui.focalAuto}</Button>
          {(focal || zoom > ZOOM_MIN) && <Button variant="ghost" disabled={busy} onClick={() => { setZoom(ZOOM_MIN); void save(null); }}>{c.ui.focalReset}</Button>}
        </div>
      )}
      {message && <p className={message.ok ? "adm-field__hint adm-focal__ok" : "adm-field__error"} role={message.ok ? "status" : "alert"}>{message.text}</p>}
    </div>
  );
}
