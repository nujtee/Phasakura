import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLandscapeMessages } from "../../../shared/i18n/admin-landscape-messages.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import {
  validateLandscapeDocument,
  type LandscapeDocument, type LandscapeLayoutDto, type LandscapeObject, type LandscapeObjectKind, type LandscapeOverviewDto, type LandscapeTemplateDto,
} from "../../../shared/landscape-types.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { uploadImage } from "../../media/prepareImage.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, errorMessage } from "../ui.tsx";
import { fromWorld, mapShape, shapeBox, shapeCenter, toWorld, worldSize, type Size } from "../../landscape/geometry.ts";
import { KIND_INFO, PALETTE } from "../../landscape/kinds.ts";
import {
  commit, deleteObjects, duplicateObjects, expandGroups, groupObjects, initHistory, isEditable, moveObjects, newObjectId, redo, undo, ungroupObjects,
  type History, type Scene,
} from "../../landscape/editor-state.ts";
import { EditorCanvas, isTyping, type CanvasApi, type Tool } from "./EditorCanvas.tsx";
import { LayersPanel, PropertiesPanel, TemplatesPanel } from "./EditorPanels.tsx";

const AUTOSAVE_MS = 2500;
type SaveState = { kind: "saved"; at: string } | { kind: "dirty" } | { kind: "saving" } | { kind: "error"; text: string }
  | { kind: "invalid"; field: string } | { kind: "conflict"; name: string; at: string };
interface LocalCopy { baseRevision: number; document: LandscapeDocument; at: string }

const localKey = (id: string) => `landscape-draft:${id}`;
function readLocal(id: string): LocalCopy | null {
  try {
    const raw = localStorage.getItem(localKey(id));
    return raw ? JSON.parse(raw) as LocalCopy : null;
  } catch {
    return null;
  }
}
function writeLocal(id: string, copy: LocalCopy | null): void {
  try {
    if (copy) localStorage.setItem(localKey(id), JSON.stringify(copy));
    else localStorage.removeItem(localKey(id));
  } catch {
    // private mode / storage full: the server copy still saves
  }
}

/** Accommodation → Site plan → a plan: the editor (landscape, phase L2). */
export function LandscapeEditorPage({ id }: { id: string }) {
  const { t, locale, href } = useAdmin();
  const m = getLandscapeMessages(locale.code);
  const [data, setData] = useState<{ layout: LandscapeLayoutDto; overview: LandscapeOverviewDto; templates: LandscapeTemplateDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [layout, overview, templates] = await Promise.all([
        apiGet<LandscapeLayoutDto>(`/api/admin/landscape/layouts/${encodeURIComponent(id)}`),
        apiGet<LandscapeOverviewDto>("/api/admin/landscape"),
        apiGet<LandscapeTemplateDto[]>("/api/admin/landscape/templates"),
      ]);
      setData({ layout, overview, templates });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }, [id, t]);
  useEffect(() => void load(), [load]);

  if (error) return <section><p><Link to={href("landscape")}>{m.editor.back}</Link></p><Alert kind="error">{error}</Alert></section>;
  if (!data) return <p role="status">{t.common.loading}</p>;
  return <Editor key={`${data.layout.id}:${data.layout.draftRevision}`} {...data} reload={load} />;
}

function Editor({ layout, overview, templates: initialTemplates, reload }: {
  layout: LandscapeLayoutDto; overview: LandscapeOverviewDto; templates: LandscapeTemplateDto[]; reload: () => Promise<void>;
}) {
  const { t, locale, href, can } = useAdmin();
  const m = getLandscapeMessages(locale.code);
  const e = m.editor;
  const readOnly = !overview.enabled || !can("landscape.edit") || layout.backgroundKind === "SATELLITE";
  const [bgSize, setBgSize] = useState(layout.backgroundSize);
  const [bgUrl, setBgUrl] = useState(layout.backgroundUrl);
  const [imageUrls, setImageUrls] = useState(layout.imageUrls);
  const size: Size = worldSize(layout.draft, bgSize);
  const [history, setHistory] = useState<History>(() => initHistory({
    objects: toWorld(layout.draft, worldSize(layout.draft, layout.backgroundSize)), layers: layout.draft.layers, background: layout.draft.background,
  }));
  const scene = history.present;
  const [selected, setSelected] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [kind, setKind] = useState<LandscapeObjectKind>("TREE");
  const [snapOn, setSnapOn] = useState(true);
  const [polyPoints, setPolyPoints] = useState<[number, number][] | null>(null);
  const [panel, setPanel] = useState<"props" | "layers" | "background" | "templates">("props");
  const [name, setName] = useState(layout.name);
  const [revision, setRevision] = useState(layout.draftRevision);
  const [save, setSave] = useState<SaveState>({ kind: "saved", at: layout.draftUpdatedAt });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [templates, setTemplates] = useState(initialTemplates);
  const [confirm, setConfirm] = useState<{ message: string; label: string; run: () => void } | null>(null);
  const [recovery, setRecovery] = useState<LocalCopy | null>(() => {
    const local = readLocal(layout.id);
    if (!local || readOnly) return null;
    return JSON.stringify(local.document) !== JSON.stringify(layout.draft) ? local : null;
  });
  const canvas = useRef<CanvasApi>(null);
  const lastMerge = useRef<{ key: string; at: number } | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const grid = scene.background.kind === "BLANK" ? scene.background.gridM : size.w / 100;
  const doc = useCallback((s: Scene = scene, sz: Size = size): LandscapeDocument =>
    fromWorld({ version: 1, crs: layout.draft.crs, background: s.background, layers: s.layers, objects: [] }, s.objects, sz), [scene, size, layout.draft.crs]);

  /** One finished action: a step back, the selection, and the copy kept in this browser until saved. */
  const apply = useCallback((next: Scene, select?: string[], mergeKey?: string) => {
    if (readOnly) return;
    setHistory((h) => {
      const now = Date.now();
      const merge = mergeKey && lastMerge.current?.key === mergeKey && now - lastMerge.current.at < 1500;
      lastMerge.current = mergeKey ? { key: mergeKey, at: now } : null;
      return merge ? { ...h, present: next } : commit(h, next);
    });
    if (select) setSelected(select);
    setSave((s) => (s.kind === "conflict" ? s : { kind: "dirty" }));
  }, [readOnly]);

  // Keep a copy in this browser on every change (recoverable after a crash or a closed tab).
  useEffect(() => {
    if (readOnly || save.kind === "saved") return;
    writeLocal(layout.id, { baseRevision: revision, document: doc(), at: new Date().toISOString() });
  }, [scene, readOnly, save.kind, layout.id, revision, doc]);

  const saveNow = useCallback(async (force = false) => {
    if (readOnly) return;
    const document = doc();
    const errors = validateLandscapeDocument(document, { backgroundKind: layout.backgroundKind });
    const first = Object.keys(errors)[0];
    if (first) { setSave({ kind: "invalid", field: first }); return; }
    let base = revision;
    if (force) base = (await apiGet<LandscapeLayoutDto>(`/api/admin/landscape/layouts/${encodeURIComponent(layout.id)}`)).draftRevision;
    setSave({ kind: "saving" });
    const sent = scene;
    try {
      const res = await apiRequest<LandscapeLayoutDto>("PUT", `/api/admin/landscape/layouts/${encodeURIComponent(layout.id)}/draft`, {
        baseRevision: base, name: name.trim() || layout.name, document,
      });
      setRevision(res.draftRevision);
      setImageUrls((u) => ({ ...u, ...res.imageUrls }));
      // Changes made while saving are still to save.
      if (sceneRef.current === sent) {
        setSave({ kind: "saved", at: res.draftUpdatedAt });
        writeLocal(layout.id, null);
      } else setSave({ kind: "dirty" });
    } catch (err) {
      if (err instanceof ApiError && err.code === "DRAFT_CONFLICT") {
        setSave({ kind: "conflict", name: err.details?.updatedBy || e.someone, at: err.details?.updatedAt ?? "" });
      } else if (err instanceof ApiError && err.code === "LANDSCAPE_OFF") {
        setSave({ kind: "error", text: m.errors.LANDSCAPE_OFF! });
      } else {
        const code = err instanceof ApiError ? Object.values(err.details ?? {})[0] : undefined;
        setSave({ kind: "error", text: code && m.errors[code] ? m.errors[code]! : errorMessage(t, err) });
      }
    }
  }, [readOnly, doc, layout, revision, scene, name, e.someone, m.errors, t]);

  // Autosave a moment after the last change.
  useEffect(() => {
    if (save.kind !== "dirty") return;
    const timer = setTimeout(() => void saveNow(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [save.kind, scene, saveNow]);

  // Leaving with unsaved work: the browser asks first.
  useEffect(() => {
    const warn = (ev: BeforeUnloadEvent) => { if (save.kind !== "saved") { ev.preventDefault(); ev.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save.kind]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (isTyping(ev)) return;
      const mod = ev.ctrlKey || ev.metaKey;
      const k = ev.key.toLowerCase();
      if (mod && k === "s") { ev.preventDefault(); void saveNow(); return; }
      if (readOnly) return;
      if (mod && k === "z" && !ev.shiftKey) { ev.preventDefault(); setHistory(undo); setSave({ kind: "dirty" }); return; }
      if (mod && (k === "y" || (k === "z" && ev.shiftKey))) { ev.preventDefault(); setHistory(redo); setSave({ kind: "dirty" }); return; }
      if (mod && k === "d" && selected.length) { ev.preventDefault(); const r = duplicateObjects(scene, selected, Math.max(size.w, size.h) / 60); apply(r.scene, r.ids); return; }
      if (mod && k === "g" && selected.length) { ev.preventDefault(); apply(ev.shiftKey ? ungroupObjects(scene, selected) : groupObjects(scene, selected), selected); return; }
      if (mod && k === "a") { ev.preventDefault(); setSelected(scene.objects.filter((o) => isEditable(scene, o)).map((o) => o.id)); return; }
      if (polyPoints) return; // the canvas handles Enter / Backspace / Escape while drawing
      if ((ev.key === "Delete" || ev.key === "Backspace") && selected.length) { ev.preventDefault(); apply(deleteObjects(scene, selected), []); return; }
      if (ev.key === "Escape") { setSelected([]); setTool("select"); return; }
      if (ev.key.startsWith("Arrow") && selected.length) {
        ev.preventDefault();
        const step = (ev.shiftKey ? 10 : 1) * (snapOn ? grid : size.w / 500);
        const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
        const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
        apply(moveObjects(scene, selected, dx, dy), selected, `nudge:${selected.join(",")}`);
        return;
      }
      if (mod) return;
      const keys: Record<string, Tool> = { v: "select", h: "hand", r: "rect", c: "circle", p: "polygon", l: "path", s: "symbol" };
      if (keys[k]) setTool(keys[k]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, scene, selected, apply, saveNow, snapOn, grid, size, polyPoints]);

  function pickKind(k: LandscapeObjectKind) {
    setKind(k);
    setTool(KIND_INFO[k].draw);
    setPolyPoints(null);
  }

  async function uploadObjectImage(file: File, ids: string[]) {
    setBusy(true);
    setMsg({ kind: "info", text: e.uploading });
    try {
      const img = await uploadImage(file, "OTHER");
      setImageUrls((u) => ({ ...u, [img.id]: img.url }));
      apply({ ...scene, objects: scene.objects.map((o) => (ids.includes(o.id) ? { ...o, imageAssetId: img.id } : o)) }, ids);
      setMsg(null);
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  async function uploadBackground(file: File) {
    if (scene.background.kind !== "PHOTO") return;
    setBusy(true);
    setMsg({ kind: "info", text: e.uploading });
    try {
      const img = await uploadImage(file, "OTHER");
      const newSize: Size = img.width && img.height ? { w: img.width, h: img.height } : size;
      // Objects keep their place relative to the photo (same 0…1 position), whatever its new pixel size.
      const asDoc = fromWorld({ ...doc(), background: scene.background }, scene.objects, size);
      const next: Scene = { ...scene, background: { ...scene.background, assetId: img.id }, objects: toWorld(asDoc, newSize) };
      setBgUrl(img.url);
      setBgSize(img.width && img.height ? { width: img.width, height: img.height } : bgSize);
      apply(next);
      setMsg(scene.background.assetId ? { kind: "success", text: e.bgReplaced } : null);
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate(o: LandscapeObject, templateName: string) {
    // Kept at a unit size around 0.5 / 0.5 so it fits any plan; placed at the plan's size for its kind.
    const b = shapeBox(o.shape);
    const c = shapeCenter(o.shape);
    const scale = 1 / Math.max(b.w, b.h, 1e-9);
    const shape = mapShape(o.shape, ([x, y]) => [round6(0.5 + (x - c[0]) * scale), round6(0.5 + (y - c[1]) * scale)], (l) => round6(l * scale));
    const object = { kind: o.kind, shape, rotation: o.rotation, style: o.style, label: o.label, locked: false, imageAssetId: o.imageAssetId };
    setBusy(true);
    try {
      const tpl = await apiRequest<LandscapeTemplateDto>("POST", "/api/admin/landscape/templates", { name: templateName, object });
      setTemplates((list) => [...list, tpl].sort((a, b2) => a.name.localeCompare(b2.name)));
      setMsg({ kind: "success", text: t.common.saved });
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  function insertTemplate(tpl: LandscapeTemplateDto) {
    const target = KIND_INFO[tpl.object.kind].size * size.w * (tpl.object.shape.type === "symbol" ? 1 : 1.5);
    const [cx, cy] = canvas.current?.center() ?? [size.w / 2, size.h / 2];
    const shape = mapShape(tpl.object.shape, ([x, y]) => [cx + (x - 0.5) * target, cy + (y - 0.5) * target], (l) => l * target);
    const layer = scene.layers.find((l) => l.id === KIND_INFO[tpl.object.kind].layer && !l.locked && l.visible) ?? scene.layers.find((l) => !l.locked && l.visible) ?? scene.layers[0]!;
    const o: LandscapeObject = { ...tpl.object, id: newObjectId(), layerId: layer.id, groupId: null, link: null, shape };
    if (tpl.imageUrl && tpl.object.imageAssetId) setImageUrls((u) => ({ ...u, [tpl.object.imageAssetId!]: tpl.imageUrl! }));
    apply({ ...scene, objects: [...scene.objects, o] }, [o.id]);
    setPanel("props");
  }

  function deleteTemplate(tpl: LandscapeTemplateDto) {
    setConfirm({
      message: `${e.deleteTemplate}: ${tpl.name}?`, label: e.deleteTemplate,
      run: () => void apiRequest("DELETE", `/api/admin/landscape/templates/${encodeURIComponent(tpl.id)}`)
        .then(() => setTemplates((list) => list.filter((x) => x.id !== tpl.id)))
        .catch((err: unknown) => setMsg({ kind: "error", text: errorMessage(t, err) })),
    });
  }

  const statusText = useMemo(() => {
    const time = (iso: string) => new Intl.DateTimeFormat(locale.code, { timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(iso));
    switch (save.kind) {
      case "saved": return format(e.status.saved, { time: time(save.at) });
      case "saving": return e.status.saving;
      case "dirty": return e.status.dirty;
      case "error": return `${e.status.error}: ${save.text}`;
      case "invalid": return format(e.status.invalid, { field: save.field });
      case "conflict": return e.status.error;
    }
  }, [save, e, locale.code]);

  const bg = scene.background;
  return (
    <section className="lse">
      <div className="lse-top">
        <Link to={href("landscape")}>{e.back}</Link>
        <input className="lse-name" aria-label={m.name} value={name} maxLength={80} disabled={readOnly}
          onChange={(ev) => { setName(ev.target.value); setSave({ kind: "dirty" }); }} />
        <span className={`lse-status lse-status--${save.kind}`} role="status" aria-live="polite">{readOnly ? e.status.readOnly : statusText}</span>
        {!readOnly && (
          <>
            <Button variant="secondary" disabled={!history.past.length} onClick={() => { setHistory(undo); setSave({ kind: "dirty" }); }} aria-label={e.undo} title={e.undo}>↶</Button>
            <Button variant="secondary" disabled={!history.future.length} onClick={() => { setHistory(redo); setSave({ kind: "dirty" }); }} aria-label={e.redo} title={e.redo}>↷</Button>
            <Button disabled={save.kind === "saving" || save.kind === "saved"} onClick={() => void saveNow()}>{save.kind === "error" ? e.retry : e.save}</Button>
          </>
        )}
      </div>

      {!overview.enabled && <Alert kind="info">{e.off}</Alert>}
      {layout.backgroundKind === "SATELLITE" && <Alert kind="info">{e.satelliteSoon}</Alert>}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {recovery && (
        <Alert kind="info">
          {format(e.recoverTitle, { time: new Intl.DateTimeFormat(locale.code, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(recovery.at)) })}
          {recovery.baseRevision !== layout.draftRevision && <> — {e.recoverNewer}</>}
          {" "}
          <Button variant="secondary" onClick={() => {
            const copy = recovery;
            setRecovery(null);
            apply({ objects: toWorld(copy.document, size), layers: copy.document.layers, background: copy.document.background });
          }}>{e.recover}</Button>
          <Button variant="ghost" onClick={() => { writeLocal(layout.id, null); setRecovery(null); }}>{e.discard}</Button>
        </Alert>
      )}
      {save.kind === "conflict" && (
        <Alert kind="error">
          {format(e.conflictTitle, { name: save.name, time: save.at ? new Intl.DateTimeFormat(locale.code, { timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(save.at)) : "" })}
          {" "}
          <Button variant="secondary" onClick={() => setConfirm({ message: e.reloadConfirm, label: e.conflictReload, run: () => { writeLocal(layout.id, null); void reload(); } })}>{e.conflictReload}</Button>
          <Button variant="danger" onClick={() => setConfirm({ message: format(e.conflictOverwriteConfirm, { name: save.name }), label: e.conflictOverwrite, run: () => void saveNow(true) })}>{e.conflictOverwrite}</Button>
        </Alert>
      )}

      {!readOnly && (
        <div className="lse-toolbar" role="toolbar" aria-label={e.panels.props}>
          {(["select", "hand", "rect", "circle", "polygon", "path", "symbol"] as Tool[]).map((tl) => (
            <button key={tl} type="button" className={`lse-tool${tool === tl ? " is-active" : ""}`} aria-pressed={tool === tl} title={e.tools[tl]}
              onClick={() => { setTool(tl); setPolyPoints(null); }}>{TOOL_ICON[tl]}<span className="visually-hidden">{e.tools[tl]}</span></button>
          ))}
          <span className="lse-sep" />
          {PALETTE.map((g) => (
            <span key={g.group} className="lse-palette" role="group" aria-label={e.groups[g.group]}>
              {g.kinds.map((k) => (
                <button key={k} type="button" className={`lse-kind${kind === k ? " is-active" : ""}`} aria-pressed={kind === k} onClick={() => pickKind(k)}>
                  <span className="lse-swatch" data-kind={k} />{e.kinds[k]}
                </button>
              ))}
            </span>
          ))}
          <span className="lse-sep" />
          <label className="adm-check adm-small"><input type="checkbox" checked={snapOn} onChange={(ev) => setSnapOn(ev.target.checked)} /> {e.snap}</label>
        </div>
      )}
      <p className="adm-small adm-muted lse-hint">{e.hints[tool] ?? ""}</p>

      <div className="lse-body">
        <div className="lse-stage">
          <EditorCanvas ref={canvas} scene={scene} size={size} backgroundUrl={bgUrl} imageUrls={imageUrls} tool={readOnly ? "select" : tool} kind={kind}
            snapOn={snapOn} grid={grid} selected={selected} readOnly={readOnly} label={format(e.canvas, { name })}
            emptyPhotoText={bg.kind === "PHOTO" && !bgUrl ? e.bgNone : null}
            onSelect={(ids) => setSelected(expandGroups(scene, ids))} onCommit={apply}
            onDrawn={() => { if (tool !== "symbol") setTool("select"); }}
            drafting={polyPoints} setDrafting={setPolyPoints} />
          <div className="lse-zoom">
            <Button variant="secondary" onClick={() => canvas.current?.zoom(1.25)} aria-label={e.zoomIn}>+</Button>
            <Button variant="secondary" onClick={() => canvas.current?.zoom(0.8)} aria-label={e.zoomOut}>−</Button>
            <Button variant="secondary" onClick={() => canvas.current?.fit()}>{e.fit}</Button>
          </div>
        </div>

        <aside className="lse-side">
          <div className="lse-tabs" role="tablist">
            {(["props", "layers", "background", "templates"] as const).map((p) => (
              <button key={p} type="button" role="tab" aria-selected={panel === p} className={`lse-tab${panel === p ? " is-active" : ""}`} onClick={() => setPanel(p)}>{e.panels[p]}</button>
            ))}
          </div>
          <div className="lse-panel" role="tabpanel">
            {panel === "props" && (
              <PropertiesPanel e={e} scene={scene} selected={selected} units={overview.units} campingEnabled={overview.campingEnabled} readOnly={readOnly}
                doc={{ ...layout.draft, background: scene.background }} size={size} imageUrls={imageUrls} busy={busy}
                onCommit={apply} onSelect={setSelected} onUploadImage={(f, ids) => void uploadObjectImage(f, ids)} onSaveTemplate={(o, n) => void saveTemplate(o, n)} />
            )}
            {panel === "layers" && <LayersPanel e={e} scene={scene} readOnly={readOnly} onCommit={(s) => apply(s)} />}
            {panel === "templates" && <TemplatesPanel e={e} templates={templates} readOnly={readOnly} onInsert={insertTemplate} onDelete={deleteTemplate} />}
            {panel === "background" && bg.kind === "BLANK" && (
              <div>
                <NumberField label={e.bgWidth} value={bg.widthM} min={1} max={100000} disabled={readOnly} onCommit={(v) => apply({ ...scene, background: { ...bg, widthM: v } })} />
                <NumberField label={e.bgHeight} value={bg.heightM} min={1} max={100000} disabled={readOnly} onCommit={(v) => apply({ ...scene, background: { ...bg, heightM: v } })} />
                <NumberField label={e.bgGrid} value={bg.gridM} min={0} max={1000} disabled={readOnly} onCommit={(v) => apply({ ...scene, background: { ...bg, gridM: v } })} />
                <div className="adm-field">
                  <label htmlFor="lse-bgcolor">{e.bgColor}</label>
                  <input id="lse-bgcolor" type="color" disabled={readOnly} value={bg.color} onChange={(ev) => apply({ ...scene, background: { ...bg, color: ev.target.value } }, undefined, "bgcolor")} />
                </div>
                <p className="adm-small adm-muted">{e.bgSizeHint}</p>
              </div>
            )}
            {panel === "background" && bg.kind === "PHOTO" && (
              <div>
                {!bgUrl && <p className="adm-muted">{e.bgNone}</p>}
                <label className={`adm-btn adm-btn--secondary${readOnly || busy ? " is-disabled" : ""}`}>
                  {bgUrl ? e.bgReplace : e.bgUpload}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="visually-hidden" disabled={readOnly || busy}
                    onChange={(ev) => { const f = ev.target.files?.[0]; if (f) void uploadBackground(f); ev.target.value = ""; }} />
                </label>
                <div className="adm-field">
                  <label htmlFor="lse-bgopacity">{e.bgOpacity}: {Math.round(bg.opacity * 100)}%</label>
                  <input id="lse-bgopacity" type="range" min={0.1} max={1} step={0.05} disabled={readOnly} value={bg.opacity}
                    onChange={(ev) => apply({ ...scene, background: { ...bg, opacity: Number(ev.target.value) } }, undefined, "bgopacity")} />
                </div>
                <NumberField label={e.bgMeasured} hint={e.bgMeasuredHint} value={bg.measuredWidthM} min={0.1} max={100000} optional disabled={readOnly}
                  onCommit={(v: number | null) => apply({ ...scene, background: { ...bg, measuredWidthM: v } })} />
              </div>
            )}
            {panel === "background" && bg.kind === "SATELLITE" && <p className="adm-muted">{e.satelliteSoon}</p>}
          </div>
        </aside>
      </div>
      <ConfirmDialog open={confirm !== null} danger message={confirm?.message ?? ""} confirmLabel={confirm?.label ?? ""}
        onCancel={() => setConfirm(null)} onConfirm={() => { const c = confirm; setConfirm(null); c?.run(); }} />
    </section>
  );
}

const TOOL_ICON: Record<Tool, string> = { select: "↖", hand: "✋", rect: "▭", circle: "◯", polygon: "⬠", path: "〰", symbol: "✿" };
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function NumberField({ label, hint, value, min, max, optional, disabled, onCommit }: {
  label: string; hint?: string; value: number | null; min: number; max: number; optional?: boolean; disabled?: boolean;
  onCommit: (v: number) => void;
} | {
  label: string; hint?: string; value: number | null; min: number; max: number; optional: true; disabled?: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const commitValue = onCommit as (v: number | null) => void;
  const done = () => {
    if (optional && text.trim() === "") { if (value !== null) commitValue(null); return; }
    const n = Number(text);
    if (Number.isFinite(n) && n >= min && n <= max && n !== value) commitValue(n);
    else setText(value === null ? "" : String(value));
  };
  return (
    <div className="adm-field">
      <label>
        {label}
        <input type="number" inputMode="decimal" min={min} max={max} step="any" disabled={disabled} value={text}
          onChange={(ev) => setText(ev.target.value)} onBlur={done} onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }} />
      </label>
      {hint && <p className="adm-field__hint">{hint}</p>}
    </div>
  );
}
