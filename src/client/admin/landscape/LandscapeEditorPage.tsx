import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLandscapeMessages } from "../../../shared/i18n/admin-landscape-messages.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import {
  validateLandscapeDocument,
  type LandscapeDocument, type LandscapeLayoutDto, type LandscapeObject, type LandscapeOverviewDto, type LandscapePaletteRowDto, type LandscapeTemplateDto,
} from "../../../shared/landscape-types.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { uploadImage } from "../../media/prepareImage.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, errorMessage } from "../ui.tsx";
import {
  fromWorld, mapShape, photoGeoref, photoToSatellite, planUnit, satelliteFrame, shapeBox, shapeCenter, toWorld, worldSize, type Size,
} from "../../landscape/geometry.ts";
import { SatelliteAttribution, tileProblem } from "../../landscape/SatelliteTiles.tsx";
import { ControlPointsPanel, SatellitePanel } from "./GeoPanels.tsx";
import { buildPalette, entryOf, type PaletteEntry } from "../../landscape/palette.ts";
import { PalettePanel, Swatch } from "./PalettePanel.tsx";
import {
  commit, deleteObjects, duplicateObjects, expandGroups, groupObjects, initHistory, isEditable, moveObjects, newObjectId, redo, undo, ungroupObjects,
  type History, type Scene,
} from "../../landscape/editor-state.ts";
import { EditorCanvas, isTyping, type CanvasApi, type Tool } from "./EditorCanvas.tsx";
import { LayersPanel, PropertiesPanel, TemplatesPanel } from "./EditorPanels.tsx";
import type { Point } from "../../../shared/landscape-types.ts";

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
  const [data, setData] = useState<{
    layout: LandscapeLayoutDto; overview: LandscapeOverviewDto; templates: LandscapeTemplateDto[]; palette: LandscapePaletteRowDto[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [layout, overview, templates, palette] = await Promise.all([
        apiGet<LandscapeLayoutDto>(`/api/admin/landscape/layouts/${encodeURIComponent(id)}`),
        apiGet<LandscapeOverviewDto>("/api/admin/landscape"),
        apiGet<LandscapeTemplateDto[]>("/api/admin/landscape/templates"),
        // Before the palette table exists (release not finished): the built-in palette.
        apiGet<LandscapePaletteRowDto[]>("/api/admin/landscape/palette").catch(() => [] as LandscapePaletteRowDto[]),
      ]);
      setData({ layout, overview, templates, palette });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }, [id, t]);
  useEffect(() => void load(), [load]);

  if (error) return <section><p><Link to={href("landscape")}>{m.editor.back}</Link></p><Alert kind="error">{error}</Alert></section>;
  if (!data) return <p role="status">{t.common.loading}</p>;
  return <Editor key={`${data.layout.id}:${data.layout.draftRevision}`} {...data} reload={load} />;
}

function Editor({ layout, overview, templates: initialTemplates, palette: initialPalette, reload }: {
  layout: LandscapeLayoutDto; overview: LandscapeOverviewDto; templates: LandscapeTemplateDto[]; palette: LandscapePaletteRowDto[];
  reload: () => Promise<void>;
}) {
  const { t, locale, href, can, go } = useAdmin();
  const m = getLandscapeMessages(locale.code);
  const e = m.editor;
  const satelliteOff = layout.backgroundKind === "SATELLITE" && !overview.satelliteReady;
  const readOnly = !overview.enabled || !can("landscape.edit") || satelliteOff;
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
  const [paletteRows, setPaletteRows] = useState(initialPalette);
  const palette = useMemo(() => buildPalette(paletteRows), [paletteRows]);
  const [entryId, setEntryId] = useState("TREE");
  const entry: PaletteEntry = palette.find((p) => p.id === entryId) ?? palette.find((p) => !p.hidden) ?? palette[0]!;
  const entryName = useCallback((p: PaletteEntry) => p.name ?? m.editor.kinds[p.kind] ?? p.kind, [m]);
  const [snapOn, setSnapOn] = useState(true);
  /** iPad: taps add to the selection (what Shift+click does with a keyboard). */
  const [multi, setMulti] = useState(false);
  const [polyPoints, setPolyPoints] = useState<[number, number][] | null>(null);
  const [panel, setPanel] = useState<"props" | "layers" | "background" | "templates" | "palette">("props");
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
  /** Satellite imagery is served around the saved area only: reload the tiles after a save that moved the plan. */
  const [tileVersion, setTileVersion] = useState(layout.draftRevision);
  const savedBg = useRef(JSON.stringify(layout.draft.background));
  const tileReported = useRef(false);
  /** A control point clicked on the photo (world units), waiting for its coordinates. */
  const [cpPending, setCpPending] = useState<Point | null>(null);
  const lastMerge = useRef<{ key: string; at: number } | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const unit = planUnit(scene.background, size);
  const grid = scene.background.kind === "BLANK" ? scene.background.gridM : unit / 100;
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
      const bgNow = JSON.stringify(sent.background);
      if (bgNow !== savedBg.current) { savedBg.current = bgNow; setTileVersion(res.draftRevision); tileReported.current = false; }
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
      if (mod && k === "d" && selected.length) { ev.preventDefault(); const r = duplicateObjects(scene, selected, unit / 60); apply(r.scene, r.ids); return; }
      if (mod && k === "g" && selected.length) { ev.preventDefault(); apply(ev.shiftKey ? ungroupObjects(scene, selected) : groupObjects(scene, selected), selected); return; }
      if (mod && k === "a") { ev.preventDefault(); setSelected(scene.objects.filter((o) => isEditable(scene, o)).map((o) => o.id)); return; }
      if (polyPoints) return; // the canvas handles Enter / Backspace / Escape while drawing
      if ((ev.key === "Delete" || ev.key === "Backspace") && selected.length) { ev.preventDefault(); apply(deleteObjects(scene, selected), []); return; }
      if (ev.key === "Escape") { setSelected([]); setTool("select"); return; }
      if (ev.key.startsWith("Arrow") && selected.length) {
        ev.preventDefault();
        const step = (ev.shiftKey ? 10 : 1) * (snapOn ? grid : unit / 500);
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
  }, [readOnly, scene, selected, apply, saveNow, snapOn, grid, unit, polyPoints]);

  function pickKind(p: PaletteEntry) {
    setEntryId(p.id);
    setTool(p.info.draw);
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
    const object = { kind: o.kind, shape, rotation: o.rotation, style: o.style, label: o.label, locked: false, imageAssetId: o.imageAssetId, typeId: o.typeId ?? null };
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
    const info = (entryOf(palette, tpl.object) ?? entry).info;
    const target = info.size * unit * (tpl.object.shape.type === "symbol" ? 1 : 1.5);
    const [cx, cy] = canvas.current?.center() ?? [size.w / 2, size.h / 2];
    const shape = mapShape(tpl.object.shape, ([x, y]) => [cx + (x - 0.5) * target, cy + (y - 0.5) * target], (l) => l * target);
    const layer = scene.layers.find((l) => l.id === info.layer && !l.locked && l.visible) ?? scene.layers.find((l) => !l.locked && l.visible) ?? scene.layers[0]!;
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

  /** Satellite: a new centre / zoom; objects keep their place on the earth (re-drawn in the new frame). Saved at once. */
  function changeSatellite(next: Extract<Scene["background"], { kind: "SATELLITE" }>) {
    const asDoc = fromWorld({ ...doc(), background: scene.background }, scene.objects, size);
    apply({ ...scene, background: next, objects: toWorld({ ...asDoc, background: next }, size) });
    setMsg(null);
  }

  function viewCenterLonLat(): Point | null {
    if (scene.background.kind !== "SATELLITE") return null;
    const c = canvas.current?.center();
    if (!c) return null;
    const [lon, lat] = satelliteFrame(scene.background).toLonLat(c);
    return [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
  }

  function onTileError(url: string) {
    if (tileReported.current) return;
    tileReported.current = true;
    void tileProblem(url).then((code) => {
      if (code === "OK") return;
      setMsg({ kind: "error", text: format(e.satTile, { reason: e.satReasons[code] ?? e.satReasons.other! }) });
    });
  }

  const georef = photoGeoref(scene.background, size);

  function setControlPoints(points: Extract<Scene["background"], { kind: "PHOTO" }>["controlPoints"]) {
    if (scene.background.kind !== "PHOTO") return;
    apply({ ...scene, background: { ...scene.background, controlPoints: points } });
  }

  function addControlPoint(geo: Point) {
    if (scene.background.kind !== "PHOTO" || !cpPending) return;
    const image: Point = [round6(cpPending[0] / size.w), round6(cpPending[1] / size.h)];
    setControlPoints([...scene.background.controlPoints, { image, geo }]);
    setCpPending(null);
  }

  async function convertToSatellite() {
    if (!georef || scene.background.kind !== "PHOTO") return;
    setBusy(true);
    setMsg(null);
    try {
      const document = photoToSatellite(doc(), size, georef);
      const made = await apiRequest<LandscapeLayoutDto>("POST", "/api/admin/landscape/layouts", {
        name: format(e.toSatelliteName, { name: name.trim() || layout.name }).slice(0, 80), backgroundKind: "SATELLITE",
      });
      await apiRequest<LandscapeLayoutDto>("PUT", `/api/admin/landscape/layouts/${encodeURIComponent(made.id)}/draft`, { baseRevision: made.draftRevision, document });
      go("landscape", made.id);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setMsg({ kind: "error", text: m.errors[code] ?? errorMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  const markers = scene.background.kind === "PHOTO"
    ? [
      ...scene.background.controlPoints.map((cp, i) => ({ label: String(i + 1), at: [cp.image[0] * size.w, cp.image[1] * size.h] as Point })),
      ...(cpPending ? [{ label: "+", at: cpPending, pending: true }] : []),
    ]
    : undefined;

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
      {satelliteOff && <Alert kind="info">{e.satNotReady}</Alert>}
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
          {(["nature", "stays", "site"] as const).map((g) => (
            <span key={g} className="lse-palette" role="group" aria-label={e.groups[g]}>
              {palette.filter((p) => p.group === g && !p.hidden).map((p) => (
                <button key={p.id} type="button" className={`lse-kind${entry.id === p.id ? " is-active" : ""}`} aria-pressed={entry.id === p.id} onClick={() => pickKind(p)}>
                  <Swatch entry={p} />{entryName(p)}
                </button>
              ))}
            </span>
          ))}
          <span className="lse-sep" />
          <label className="adm-check adm-small"><input type="checkbox" checked={snapOn} onChange={(ev) => setSnapOn(ev.target.checked)} /> {e.snap}</label>
          <label className="adm-check adm-small"><input type="checkbox" checked={multi} onChange={(ev) => setMulti(ev.target.checked)} /> {e.multiSelect}</label>
        </div>
      )}
      <p className="adm-small adm-muted lse-hint">{e.hints[tool] ?? ""}<span className="lse-hint-touch"> · {e.touchHint}</span></p>

      <div className="lse-body">
        <div className="lse-stage">
          <EditorCanvas ref={canvas} scene={scene} size={size} backgroundUrl={bgUrl} imageUrls={imageUrls} tool={readOnly ? "select" : tool} entry={entry}
            snapOn={snapOn} grid={grid} selected={selected} readOnly={readOnly} label={format(e.canvas, { name })}
            emptyPhotoText={bg.kind === "PHOTO" && !bgUrl ? e.bgNone : null}
            onSelect={(ids) => setSelected(expandGroups(scene, ids))} onCommit={apply}
            onDrawn={() => { if (tool !== "symbol") setTool("select"); }}
            drafting={polyPoints} setDrafting={setPolyPoints}
            tileVersion={tileVersion} onTileError={onTileError}
            multi={multi} markers={markers} onPickPoint={(p) => { setCpPending(p); setTool("select"); setPanel("background"); }} />
          {bg.kind === "SATELLITE" && <SatelliteAttribution className="lse-attribution" />}
          {polyPoints && polyPoints.length > 0 && !readOnly && (
            // Finishing a polygon / path without a keyboard or double-click (iPad).
            <div className="lse-drawbar" role="group" aria-label={e.tools[tool] ?? ""}>
              <Button onClick={() => canvas.current?.finishDrawing()} disabled={polyPoints.length < (tool === "path" ? 2 : 3)}>{e.drawFinish}</Button>
              <Button variant="secondary" onClick={() => setPolyPoints(polyPoints.length > 1 ? polyPoints.slice(0, -1) : null)}>{e.drawUndoPoint}</Button>
              <Button variant="ghost" onClick={() => setPolyPoints(null)}>{e.drawCancel}</Button>
            </div>
          )}
          <div className="lse-zoom">
            <Button variant="secondary" onClick={() => canvas.current?.zoom(1.25)} aria-label={e.zoomIn}>+</Button>
            <Button variant="secondary" onClick={() => canvas.current?.zoom(0.8)} aria-label={e.zoomOut}>−</Button>
            <Button variant="secondary" onClick={() => canvas.current?.fit()}>{e.fit}</Button>
          </div>
        </div>

        <aside className="lse-side">
          <div className="lse-tabs" role="tablist">
            {(["props", "layers", "background", "templates", "palette"] as const).map((p) => (
              <button key={p} type="button" role="tab" aria-selected={panel === p} className={`lse-tab${panel === p ? " is-active" : ""}`} onClick={() => setPanel(p)}>{e.panels[p]}</button>
            ))}
          </div>
          <div className="lse-panel" role="tabpanel">
            {panel === "props" && (
              <PropertiesPanel e={e} palette={palette} entryName={entryName} scene={scene} selected={selected} units={overview.units} campingEnabled={overview.campingEnabled} readOnly={readOnly}
                doc={{ ...layout.draft, background: scene.background }} size={size} imageUrls={imageUrls} busy={busy}
                onCommit={apply} onSelect={setSelected} onUploadImage={(f, ids) => void uploadObjectImage(f, ids)} onSaveTemplate={(o, n) => void saveTemplate(o, n)} />
            )}
            {panel === "layers" && <LayersPanel e={e} scene={scene} readOnly={readOnly} onCommit={(s) => apply(s)} />}
            {panel === "palette" && (
              <PalettePanel e={e} palette={palette} entryName={entryName} readOnly={readOnly} onChange={setPaletteRows}
                confirm={(message, label, run) => setConfirm({ message, label, run })} />
            )}
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
                <ControlPointsPanel e={e} bg={bg} georef={georef} readOnly={readOnly || !bgUrl} picking={tool === "controlpoint"} pending={cpPending !== null}
                  onPick={() => { setTool("controlpoint"); setPolyPoints(null); }} onAdd={addControlPoint} onCancel={() => setCpPending(null)}
                  onUpdate={(i, geo) => setControlPoints(bg.controlPoints.map((cp, j) => (j === i ? { ...cp, geo } : cp)))}
                  onRemove={(i) => setControlPoints(bg.controlPoints.filter((_, j) => j !== i))} />
                {georef && (
                  <div className="lse-cp__convert">
                    <Button variant="secondary" disabled={busy || !overview.satelliteReady || save.kind !== "saved"} onClick={() => void convertToSatellite()}>{e.toSatellite}</Button>
                    <p className="adm-small adm-muted">{overview.satelliteReady ? e.toSatelliteHint : e.toSatelliteNeedsKey}</p>
                  </div>
                )}
              </div>
            )}
            {panel === "background" && bg.kind === "SATELLITE" && (
              <SatellitePanel e={e} bg={bg} readOnly={readOnly} onChange={changeSatellite} viewCenter={viewCenterLonLat} />
            )}
          </div>
        </aside>
      </div>
      <ConfirmDialog open={confirm !== null} danger message={confirm?.message ?? ""} confirmLabel={confirm?.label ?? ""}
        onCancel={() => setConfirm(null)} onConfirm={() => { const c = confirm; setConfirm(null); c?.run(); }} />
    </section>
  );
}

const TOOL_ICON: Record<Tool, string> = { select: "↖", hand: "✋", rect: "▭", circle: "◯", polygon: "⬠", path: "〰", symbol: "✿", controlpoint: "⌖" };
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
