import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { objectPosition, type FocalPoint } from "../../../shared/focal-point.ts";
import { apiRequest } from "../../api/client.ts";
import { detectFocal } from "../../media/prepareImage.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Button, detailMessage } from "../ui.tsx";

/**
 * Focal point of an uploaded photo (migration 0046): click the photo to choose the spot that must stay in view;
 * the two frames show how the public site will crop it on a computer and on a phone. Saved at once.
 */
export function FocalPicker({ assetId, url, focal, onChange, disabled }: {
  assetId: string;
  url: string;
  focal: FocalPoint | null;
  onChange: (focal: FocalPoint | null) => void;
  disabled?: boolean;
}) {
  const { t, c } = useAdmin();
  const img = useRef<HTMLImageElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const point = focal ?? { x: 50, y: 50 };

  async function save(next: FocalPoint | null) {
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
    void save({ x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) });
  };

  // Keyboard: arrows move the point by 5 %.
  const nudge = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step: Record<string, [number, number]> = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] };
    const d = step[e.key];
    if (!d || disabled || busy) return;
    e.preventDefault();
    void save({ x: Math.max(0, Math.min(100, point.x + d[0])), y: Math.max(0, Math.min(100, point.y + d[1])) });
  };

  const auto = () => {
    const el = img.current;
    if (!el || !el.naturalWidth) return;
    const found = detectFocal(el, el.naturalWidth, el.naturalHeight);
    if (found) void save(found);
  };

  const pos = objectPosition(point);
  return (
    <div className="adm-focal">
      <div className="adm-focal__head">
        <strong>{c.ui.focalTitle}</strong>
        <span className="adm-focal__value">{focal ? `${focal.x}% · ${focal.y}%` : c.ui.focalNone}</span>
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
            <div className="adm-focal__frame adm-focal__frame--wide"><img src={url} alt="" style={{ objectPosition: pos }} /></div>
            <figcaption>{c.ui.focalDesktop}</figcaption>
          </figure>
          <figure>
            <div className="adm-focal__frame adm-focal__frame--tall"><img src={url} alt="" style={{ objectPosition: pos }} /></div>
            <figcaption>{c.ui.focalMobile}</figcaption>
          </figure>
        </div>
      </div>
      {!disabled && (
        <div className="adm-focal__actions">
          <Button variant="secondary" busy={busy} onClick={auto}>{c.ui.focalAuto}</Button>
          {focal && <Button variant="ghost" disabled={busy} onClick={() => void save(null)}>{c.ui.focalReset}</Button>}
        </div>
      )}
      {message && <p className={message.ok ? "adm-field__hint adm-focal__ok" : "adm-field__error"} role={message.ok ? "status" : "alert"}>{message.text}</p>}
    </div>
  );
}
