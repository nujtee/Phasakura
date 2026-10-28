import { useEffect, useState } from "react";
import type { AdminLandscapeMessages } from "../../../shared/i18n/admin-landscape-messages.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import {
  LANDSCAPE_LIMITS, LANDSCAPE_OBJECT_KINDS, RESERVABLE_KINDS,
  type LandscapeLayer, type LandscapeObject, type LandscapeObjectKind, type LandscapeOverviewDto, type LandscapeTemplateDto,
} from "../../../shared/landscape-types.ts";
import { objectsBox, measuredDistance, planUnit, type Size } from "../../landscape/geometry.ts";
import {
  deleteObjects, duplicateObjects, groupObjects, moveLayer, newObjectId, removeLayer, reorderObjects, ungroupObjects, updateObjects, type Scene,
} from "../../landscape/editor-state.ts";
import { Button } from "../ui.tsx";
import type { LandscapeDocument } from "../../../shared/landscape-types.ts";

type E = AdminLandscapeMessages["editor"];

/** Properties of the selection: kind, text, colours, rotation, layer, booking link, lock, picture, order, group. */
export function PropertiesPanel({ e, scene, selected, units, campingEnabled, readOnly, doc, size, imageUrls, onCommit, onSelect, onUploadImage, onSaveTemplate, busy }: {
  e: E;
  scene: Scene;
  selected: string[];
  units: LandscapeOverviewDto["units"];
  campingEnabled: boolean;
  readOnly: boolean;
  doc: LandscapeDocument;
  size: Size;
  imageUrls: Record<string, string>;
  onCommit: (scene: Scene, select?: string[], mergeKey?: string) => void;
  onSelect: (ids: string[]) => void;
  onUploadImage: (file: File, ids: string[]) => void;
  onSaveTemplate: (o: LandscapeObject, name: string) => void;
  busy: boolean;
}) {
  const objs = scene.objects.filter((o) => selected.includes(o.id));
  const one = objs.length === 1 ? objs[0]! : null;
  const [label, setLabel] = useState(one?.label ?? "");
  const [templateName, setTemplateName] = useState("");
  useEffect(() => setLabel(one?.label ?? ""), [one?.id, one?.label]);

  if (!objs.length) return <p className="adm-small adm-muted">{e.nothingSelected}</p>;
  const set = (f: (o: LandscapeObject) => LandscapeObject, key?: string) => onCommit(updateObjects(scene, selected, f), selected, key && `${key}:${selected.join(",")}`);
  const first = objs[0]!;
  const box = objectsBox(objs)!;
  const w = measuredDistance(doc, size, [box.x, box.y], [box.x + box.w, box.y]);
  const h = measuredDistance(doc, size, [box.x, box.y], [box.x, box.y + box.h]);
  const linkedIds = new Set(scene.objects.filter((o) => o.link?.type === "UNIT" && !selected.includes(o.id)).map((o) => (o.link as { unitId: string }).unitId));
  const dis = readOnly || busy;

  return (
    <div className="lse-props">
      {objs.length > 1 && <p className="adm-small"><strong>{format(e.selectedN, { n: objs.length })}</strong></p>}
      <div className="adm-field">
        <label htmlFor="lse-kind">{e.kind}</label>
        <select id="lse-kind" disabled={dis} value={objs.every((o) => o.kind === first.kind) ? first.kind : ""}
          onChange={(ev) => {
            const kind = ev.target.value as LandscapeObjectKind;
            set((o) => ({ ...o, kind, link: RESERVABLE_KINDS.includes(kind) && o.kind === kind ? o.link : null }));
          }}>
          {objs.some((o) => o.kind !== first.kind) && <option value="">—</option>}
          {LANDSCAPE_OBJECT_KINDS.map((k) => <option key={k} value={k}>{e.kinds[k]}</option>)}
        </select>
      </div>
      {one && (
        <div className="adm-field">
          <label htmlFor="lse-label">{e.label}</label>
          <input id="lse-label" disabled={dis} maxLength={LANDSCAPE_LIMITS.label} value={label} onChange={(ev) => setLabel(ev.target.value)}
            onBlur={() => { if ((one.label ?? "") !== label.trim()) set((o) => ({ ...o, label: label.trim() || null })); }}
            onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }} />
        </div>
      )}
      <div className="lse-row">
        <ColorField id="lse-fill" label={e.fill} none={e.none} disabled={dis} value={first.style.fill} onChange={(fill) => set((o) => ({ ...o, style: { ...o.style, fill } }), "fill")} />
        <ColorField id="lse-stroke" label={e.stroke} none={e.none} disabled={dis} value={first.style.stroke} onChange={(stroke) => set((o) => ({ ...o, style: { ...o.style, stroke } }), "stroke")} />
      </div>
      <div className="adm-field">
        <label htmlFor="lse-opacity">{e.opacity}: {Math.round(first.style.opacity * 100)}%</label>
        <input id="lse-opacity" type="range" min={0.1} max={1} step={0.05} disabled={dis} value={first.style.opacity}
          onChange={(ev) => set((o) => ({ ...o, style: { ...o.style, opacity: Number(ev.target.value) } }), "opacity")} />
      </div>
      {one && (
        <div className="adm-field">
          <label htmlFor="lse-rot">{e.rotation}</label>
          <input id="lse-rot" type="number" min={-180} max={180} step={1} disabled={dis} value={Math.round(one.rotation)}
            onChange={(ev) => { const r = Number(ev.target.value); if (Number.isFinite(r) && r >= -360 && r <= 360) set((o) => ({ ...o, rotation: r }), "rotation"); }} />
        </div>
      )}
      <div className="adm-field">
        <label htmlFor="lse-layer">{e.layer}</label>
        <select id="lse-layer" disabled={dis} value={objs.every((o) => o.layerId === first.layerId) ? first.layerId : ""}
          onChange={(ev) => set((o) => ({ ...o, layerId: ev.target.value }))}>
          {objs.some((o) => o.layerId !== first.layerId) && <option value="">—</option>}
          {scene.layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {one && (one.kind === "HOUSE" || one.kind === "VIP_TENT") && (
        <div className="adm-field">
          <label htmlFor="lse-link">{e.link}</label>
          <select id="lse-link" disabled={dis} value={one.link?.type === "UNIT" ? one.link.unitId : ""}
            onChange={(ev) => set((o) => ({ ...o, link: ev.target.value ? { type: "UNIT", unitId: ev.target.value } : null }))}>
            <option value="">{e.noLink}</option>
            {units.filter((u) => u.type === one.kind).map((u) => (
              <option key={u.id} value={u.id} disabled={linkedIds.has(u.id)}>
                {u.name} ({u.code}){linkedIds.has(u.id) ? ` — ${e.linkedElsewhere}` : ""}{u.status !== "ACTIVE" ? ` — ${e.inactive}` : ""}
              </option>
            ))}
          </select>
          <p className="adm-field__hint">{one.link ? e.reservableHint : e.decorative}</p>
        </div>
      )}
      {one && one.kind === "CAMPING_AREA" && (
        <label className="adm-check">
          <input type="checkbox" disabled={dis || (!campingEnabled && one.link === null)} checked={one.link?.type === "CAMPING"}
            onChange={(ev) => set((o) => ({ ...o, link: ev.target.checked ? { type: "CAMPING" } : null }))} /> {e.linkCamping}
        </label>
      )}
      {one && !RESERVABLE_KINDS.includes(one.kind) && <p className="adm-small adm-muted">{e.decorative}</p>}

      <p className="adm-small">
        {e.size}: {w !== null && h !== null ? format(e.measured, { w: w.toFixed(1), h: h.toFixed(1) }) : e.illustrative}
      </p>
      <label className="adm-check">
        <input type="checkbox" disabled={readOnly || busy} checked={objs.every((o) => o.locked)} onChange={(ev) => onCommit(updateObjects(scene, selected, (o) => ({ ...o, locked: ev.target.checked })), selected)} /> {e.lock}
      </label>

      {one && (
        <div className="adm-field">
          <span className="adm-label">{e.image}</span>
          {one.imageAssetId && imageUrls[one.imageAssetId] && <img src={imageUrls[one.imageAssetId]} alt="" className="lse-thumb" />}
          <div className="lse-row">
            <label className={`adm-btn adm-btn--secondary${dis ? " is-disabled" : ""}`}>
              {e.addImage}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="visually-hidden" disabled={dis}
                onChange={(ev) => { const f = ev.target.files?.[0]; if (f) onUploadImage(f, [one.id]); ev.target.value = ""; }} />
            </label>
            {one.imageAssetId && <Button variant="ghost" disabled={dis} onClick={() => set((o) => ({ ...o, imageAssetId: null }))}>{e.removeImage}</Button>}
          </div>
        </div>
      )}

      <div className="lse-actions">
        <Button variant="secondary" disabled={dis} onClick={() => { const r = duplicateObjects(scene, selected, planUnit(scene.background, size) / 60); onCommit(r.scene, r.ids); }}>{e.duplicate}</Button>
        <Button variant="secondary" disabled={dis} onClick={() => onCommit(reorderObjects(scene, selected, "up"), selected)}>{e.forward}</Button>
        <Button variant="secondary" disabled={dis} onClick={() => onCommit(reorderObjects(scene, selected, "down"), selected)}>{e.backward}</Button>
        <Button variant="secondary" disabled={dis} onClick={() => onCommit(reorderObjects(scene, selected, "top"), selected)}>{e.toTop}</Button>
        <Button variant="secondary" disabled={dis} onClick={() => onCommit(reorderObjects(scene, selected, "bottom"), selected)}>{e.toBottom}</Button>
        {objs.length > 1 && <Button variant="secondary" disabled={dis} onClick={() => onCommit(groupObjects(scene, selected), selected)}>{e.group}</Button>}
        {objs.some((o) => o.groupId) && <Button variant="secondary" disabled={dis} onClick={() => onCommit(ungroupObjects(scene, selected), selected)}>{e.ungroup}</Button>}
        <Button variant="danger" disabled={dis} onClick={() => { onCommit(deleteObjects(scene, selected), []); onSelect([]); }}>{e.delete}</Button>
      </div>

      {one && !readOnly && (
        <form className="lse-row" onSubmit={(ev) => { ev.preventDefault(); if (templateName.trim()) { onSaveTemplate(one, templateName.trim()); setTemplateName(""); } }}>
          <input aria-label={e.templateName} placeholder={e.templateName} maxLength={60} value={templateName} onChange={(ev) => setTemplateName(ev.target.value)} />
          <Button type="submit" variant="secondary" disabled={busy || !templateName.trim()}>{e.saveTemplate}</Button>
        </form>
      )}
    </div>
  );
}

function ColorField({ id, label, none, value, disabled, onChange }: {
  id: string; label: string; none: string; value: string | null; disabled: boolean; onChange: (v: string | null) => void;
}) {
  return (
    <div className="adm-field lse-color">
      <label htmlFor={id}>{label}</label>
      <div className="lse-row">
        <input id={id} type="color" disabled={disabled || value === null} value={value ?? "#000000"} onChange={(ev) => onChange(ev.target.value)} />
        <label className="adm-check adm-small">
          <input type="checkbox" disabled={disabled} checked={value === null} onChange={(ev) => onChange(ev.target.checked ? null : "#888888")} /> {none}
        </label>
      </div>
    </div>
  );
}

/** Layers: top of the list is drawn on top. */
export function LayersPanel({ e, scene, readOnly, onCommit }: { e: E; scene: Scene; readOnly: boolean; onCommit: (s: Scene) => void }) {
  const setLayer = (id: string, patch: Partial<LandscapeLayer>) =>
    onCommit({ ...scene, layers: scene.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  const top = [...scene.layers].reverse();
  return (
    <div>
      <p className="adm-small adm-muted">{e.layersHint}</p>
      <ul className="lse-layers">
        {top.map((l) => {
          const count = scene.objects.filter((o) => o.layerId === l.id).length;
          return (
            <li key={l.id} className="lse-layer">
              <LayerName l={l} disabled={readOnly} onRename={(name) => setLayer(l.id, { name })} />
              <span className="adm-small adm-muted">{count}</span>
              <div className="lse-row">
                <Button variant="ghost" disabled={readOnly} aria-pressed={!l.visible} onClick={() => setLayer(l.id, { visible: !l.visible })}>{l.visible ? e.hide : e.show}</Button>
                <Button variant="ghost" disabled={readOnly} aria-pressed={l.locked} onClick={() => setLayer(l.id, { locked: !l.locked })}>{l.locked ? e.unlockLayer : e.lockLayer}</Button>
                <Button variant="ghost" disabled={readOnly} onClick={() => onCommit(moveLayer(scene, l.id, 1))} aria-label={`${e.up} ${l.name}`}>↑</Button>
                <Button variant="ghost" disabled={readOnly} onClick={() => onCommit(moveLayer(scene, l.id, -1))} aria-label={`${e.down} ${l.name}`}>↓</Button>
                <Button variant="ghost" disabled={readOnly || count > 0 || scene.layers.length < 2} title={count > 0 ? e.layerNotEmpty : undefined}
                  onClick={() => onCommit(removeLayer(scene, l.id))}>{e.removeLayer}</Button>
              </div>
            </li>
          );
        })}
      </ul>
      {!readOnly && scene.layers.length < LANDSCAPE_LIMITS.layers && (
        <Button variant="secondary" onClick={() => onCommit({ ...scene, layers: [...scene.layers, { id: newObjectId("l"), name: e.newLayerName, visible: true, locked: false }] })}>{e.addLayer}</Button>
      )}
    </div>
  );
}

function LayerName({ l, disabled, onRename }: { l: LandscapeLayer; disabled: boolean; onRename: (n: string) => void }) {
  const [name, setName] = useState(l.name);
  useEffect(() => setName(l.name), [l.name]);
  return (
    <input className="lse-layer__name" aria-label={l.name} disabled={disabled} maxLength={LANDSCAPE_LIMITS.name} value={name}
      onChange={(ev) => setName(ev.target.value)} onBlur={() => { if (name.trim() && name.trim() !== l.name) onRename(name.trim()); else setName(l.name); }}
      onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }} />
  );
}

/** Templates: place one in the middle of the view, delete. */
export function TemplatesPanel({ e, templates, readOnly, onInsert, onDelete }: {
  e: E; templates: LandscapeTemplateDto[]; readOnly: boolean; onInsert: (t: LandscapeTemplateDto) => void; onDelete: (t: LandscapeTemplateDto) => void;
}) {
  return (
    <div>
      <p className="adm-small adm-muted">{e.templatesHint}</p>
      {!templates.length && <p className="adm-muted">{e.noTemplates}</p>}
      <ul className="lse-templates">
        {templates.map((t) => (
          <li key={t.id}>
            {t.imageUrl && <img src={t.imageUrl} alt="" className="lse-thumb" />}
            <span>{t.name} <span className="adm-small adm-muted">{e.kinds[t.object.kind]}</span></span>
            <span className="lse-row">
              <Button variant="secondary" disabled={readOnly} onClick={() => onInsert(t)}>{e.insert}</Button>
              <Button variant="ghost" disabled={readOnly} onClick={() => onDelete(t)}>{e.deleteTemplate}</Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
