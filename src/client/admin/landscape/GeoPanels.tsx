import { useEffect, useState } from "react";
import { format } from "../../../shared/i18n/admin-messages.ts";
import type { AdminLandscapeMessages } from "../../../shared/i18n/admin-landscape-messages.ts";
import { formatLatLon, parseLatLon, type Georef } from "../../../shared/geo.ts";
import { SATELLITE_PLAN_ZOOM, type LandscapeBackground, type Point } from "../../../shared/landscape-types.ts";
import { satelliteFrame, SATELLITE_FRAME } from "../../landscape/geometry.ts";
import { Button } from "../ui.tsx";

type E = AdminLandscapeMessages["editor"];
type SatelliteBg = Extract<LandscapeBackground, { kind: "SATELLITE" }>;
type PhotoBg = Extract<LandscapeBackground, { kind: "PHOTO" }>;

/** A [lon, lat] typed as "lat, lon" (as Google Maps copies it); committed on Enter / leaving the field. */
export function LatLonField({ id, label, hint, value, disabled, e, onCommit }: {
  id: string; label: string; hint?: string; value: Point | null; disabled?: boolean; e: E; onCommit: (v: Point) => void;
}) {
  const [text, setText] = useState(value ? formatLatLon(value) : "");
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(value ? formatLatLon(value) : ""); setBad(false); }, [value]);
  const done = () => {
    if (!text.trim()) return;
    const v = parseLatLon(text);
    if (!v) { setBad(true); return; }
    setBad(false);
    if (!value || v[0] !== value[0] || v[1] !== value[1]) onCommit(v);
  };
  return (
    <div className="adm-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="decimal" autoComplete="off" placeholder="13.756300, 100.501800" disabled={disabled} value={text}
        aria-invalid={bad || undefined} aria-describedby={bad ? `${id}-err` : hint ? `${id}-hint` : undefined}
        onChange={(ev) => setText(ev.target.value)} onBlur={done} onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); done(); } }} />
      {bad && <p id={`${id}-err`} className="adm-field__error">{e.satInvalid}</p>}
      {hint && !bad && <p id={`${id}-hint`} className="adm-field__hint">{hint}</p>}
    </div>
  );
}

/** Background panel of a satellite plan: where it is and how close. */
export function SatellitePanel({ e, bg, readOnly, onChange, viewCenter }: {
  e: E; bg: SatelliteBg; readOnly: boolean; onChange: (bg: SatelliteBg) => void;
  /** [lon, lat] of the middle of the screen. */
  viewCenter: () => Point | null;
}) {
  const f = satelliteFrame(bg);
  return (
    <div>
      <LatLonField id="lse-satcenter" label={e.satCenter} hint={e.satCenterHint} value={bg.center} disabled={readOnly} e={e}
        onCommit={(center) => onChange({ ...bg, center })} />
      <Button variant="secondary" disabled={readOnly} onClick={() => { const c = viewCenter(); if (c) onChange({ ...bg, center: c }); }}>{e.satUseView}</Button>
      <div className="adm-field">
        <label htmlFor="lse-satzoom">{e.satZoom}</label>
        <select id="lse-satzoom" disabled={readOnly} value={Math.round(bg.zoom)} onChange={(ev) => onChange({ ...bg, zoom: Number(ev.target.value) })}>
          {Array.from({ length: SATELLITE_PLAN_ZOOM.max - SATELLITE_PLAN_ZOOM.min + 1 }, (_, i) => SATELLITE_PLAN_ZOOM.min + i).map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
        <p className="adm-field__hint">{e.satZoomHint}</p>
      </div>
      <p className="adm-small adm-muted">{format(e.satFrame, { w: Math.round(SATELLITE_FRAME.w * f.mpp), h: Math.round(SATELLITE_FRAME.h * f.mpp) })}</p>
    </div>
  );
}

/** Control points of a photo plan: list, fit quality, the point being added. */
export function ControlPointsPanel({ e, bg, georef, readOnly, picking, pending, onPick, onAdd, onCancel, onUpdate, onRemove }: {
  e: E; bg: PhotoBg; georef: Georef | null; readOnly: boolean;
  picking: boolean;
  /** A point clicked on the photo, waiting for its coordinates. */
  pending: boolean;
  onPick: () => void; onAdd: (geo: Point) => void; onCancel: () => void;
  onUpdate: (i: number, geo: Point) => void; onRemove: (i: number) => void;
}) {
  const n = bg.controlPoints.length;
  const fmt = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
  const big = georef ? georef.residualsM.some((r) => r > Math.max(3, georef.rmsM * 2.5)) : false;
  return (
    <section className="lse-cp" aria-labelledby="lse-cp-title">
      <h3 id="lse-cp-title" className="lse-cp__title">{e.cpTitle}</h3>
      <p className="adm-small adm-muted">{e.cpHint}</p>
      <ol className="lse-cp__list">
        {bg.controlPoints.map((cp, i) => (
          <li key={i}>
            <LatLonField id={`lse-cp-${i}`} label={format(e.cpPoint, { n: i + 1 })} value={cp.geo} disabled={readOnly} e={e} onCommit={(g) => onUpdate(i, g)} />
            <div className="lse-cp__row">
              {georef && <span className={`adm-small${georef.residualsM[i]! > Math.max(3, georef.rmsM * 2.5) ? " lse-cp__bad" : " adm-muted"}`}>{format(e.cpResidual, { m: fmt(georef.residualsM[i]!) })}</span>}
              <Button variant="ghost" disabled={readOnly} onClick={() => onRemove(i)}>{e.cpRemove}</Button>
            </div>
          </li>
        ))}
      </ol>
      {pending ? (
        <div className="lse-cp__new">
          <LatLonField id="lse-cp-new" label={e.cpNew} hint={e.satCenterHint} value={null} disabled={readOnly} e={e} onCommit={onAdd} />
          <Button variant="ghost" onClick={onCancel}>{e.cpCancel}</Button>
        </div>
      ) : (
        <Button variant="secondary" disabled={readOnly || picking || n >= 12} onClick={onPick}>{picking ? e.cpPick : e.cpAdd}</Button>
      )}
      {n >= 2 && (georef
        ? <p className="adm-small">{format(e.cpFit, { kind: e.cpKinds[georef.kind] ?? georef.kind, scale: fmt(georef.scaleM), rms: fmt(georef.rmsM) })}</p>
        : <p className="adm-small lse-cp__bad">{e.cpNotFit}</p>)}
      {big && <p className="adm-small lse-cp__bad">{e.cpBigError}</p>}
      {georef && <p className="adm-small adm-muted">{e.cpWins}</p>}
    </section>
  );
}
