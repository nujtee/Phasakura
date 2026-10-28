import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { LandscapeObject, LandscapeObjectKind, LandscapeShape, Point } from "../../../shared/landscape-types.ts";
import {
  angleFrom, boxCenter, handlePoints, hitTest, moveShape, objectCorners, objectsBox, resizeBox, rotatePoint, scaleShape, shapeBox,
  planUnit, shapeCenter, snap, type Box, type Size,
} from "../../landscape/geometry.ts";
import { KIND_INFO } from "../../landscape/kinds.ts";
import { ShapeView } from "../../landscape/ShapeView.tsx";
import { SatelliteTiles } from "../../landscape/SatelliteTiles.tsx";
import { drawOrder, expandGroups, isEditable, moveObjects, newObjectId, type Scene } from "../../landscape/editor-state.ts";

export type Tool = "select" | "hand" | "controlpoint" | LandscapeShape["type"];

export interface CanvasApi {
  fit(): void;
  zoom(factor: number): void;
  /** Centre of what is on screen (world units): where a template is placed. */
  center(): Point;
  /** Finishes the polygon / path being drawn (the "Finish" button: no Enter or double-click on an iPad). */
  finishDrawing(): void;
}

interface View { x: number; y: number; scale: number }

type Drag =
  | { kind: "pan"; sx: number; sy: number; view: View }
  | { kind: "move"; start: Point; ids: string[]; base: Scene; moved: boolean }
  | { kind: "resize"; handle: number; base: Scene; obj: LandscapeObject; box: Box; center: Point }
  | { kind: "rotate"; base: Scene; obj: LandscapeObject; center: Point; startAngle: number }
  | { kind: "vertex"; base: Scene; obj: LandscapeObject; index: number; center: Point }
  | { kind: "marquee"; start: Point; current: Point; add: boolean }
  | { kind: "draw"; shape: "rect" | "circle"; start: Point; current: Point }
  /** A finger tap that places something (symbol, polygon point, control point): done when the finger lifts, so the
   * first finger of a pinch never leaves a stray tree or point. */
  | { kind: "tap"; at: Point; sx: number; sy: number }
  /** Two fingers: pinch to zoom, move to pan (iPad / touch screens). */
  | { kind: "pinch"; ids: [number, number]; startDist: number; startMid: Point; view: View };

const MIN_SCALE = 1e-4;
const MAX_SCALE = 1e4;

/**
 * The plan canvas (landscape, phase L2): SVG in world units, pan / zoom, selection (click, Shift+click, box), move,
 * resize, rotate, vertex editing and drawing. It never saves: finished actions are handed up as a new scene (onCommit),
 * the drag in progress is only previewed here.
 */
export const EditorCanvas = forwardRef<CanvasApi, {
  scene: Scene;
  size: Size;
  backgroundUrl: string | null;
  imageUrls: Record<string, string>;
  tool: Tool;
  kind: LandscapeObjectKind;
  snapOn: boolean;
  grid: number;
  selected: string[];
  readOnly: boolean;
  label: string;
  emptyPhotoText: string | null;
  onSelect: (ids: string[]) => void;
  onCommit: (scene: Scene, select?: string[]) => void;
  /** After a shape is drawn (tools other than symbol go back to "select"). */
  onDrawn: () => void;
  /** Polygon / path points while drawing (shown, finished with Enter / double-click). */
  drafting: Point[] | null;
  setDrafting: (points: Point[] | null) => void;
  /** Satellite plans: reloads the imagery after the plan's area was saved; first failed tile. */
  tileVersion?: string | number;
  onTileError?: (url: string) => void;
  /** Taps add to / take from the selection (Shift+click without a keyboard: iPad). */
  multi?: boolean;
  /** Control points of a photo (phase L4): where they are, numbered; the tool "controlpoint" picks a new one. */
  markers?: { label: string; at: Point; pending?: boolean }[];
  onPickPoint?: (p: Point) => void;
}>(function EditorCanvas(props, ref) {
  const { scene, size, tool, selected, readOnly } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [preview, setPreview] = useState<Scene | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [space, setSpace] = useState(false);
  const finishRef = useRef<() => void>(() => undefined);
  const fitted = useRef(false);
  /** Fingers / pens / mouse buttons down now (screen positions), for two-finger pinch and pan. */
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  /** Touch or pen in use: larger handles and a larger grab distance. */
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(any-pointer: coarse)").matches
    && !window.matchMedia?.("(pointer: fine)").matches);


  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const update = () => setBox({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) });
    update();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const fit = useCallback(() => {
    const scale = Math.min(box.w / size.w, box.h / size.h) * 0.92;
    setView({ scale, x: size.w / 2 - box.w / scale / 2, y: size.h / 2 - box.h / scale / 2 });
  }, [box, size]);

  useEffect(() => {
    if (!fitted.current && box.w > 1) { fit(); fitted.current = true; }
  }, [box, fit]);
  // A new photo (another size): show all of it.
  const sizeKey = `${size.w}x${size.h}`;
  const lastSize = useRef(sizeKey);
  useEffect(() => {
    if (lastSize.current !== sizeKey) { lastSize.current = sizeKey; fit(); }
  }, [sizeKey, fit]);

  const zoomAt = useCallback((factor: number, sx?: number, sy?: number) => {
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const px = sx ?? box.w / 2;
      const py = sy ?? box.h / 2;
      const wx = v.x + px / v.scale;
      const wy = v.y + py / v.scale;
      return { scale, x: wx - px / scale, y: wy - py / scale };
    });
  }, [box]);

  useImperativeHandle(ref, () => ({
    fit,
    zoom: (f) => zoomAt(f),
    center: () => [view.x + box.w / view.scale / 2, view.y + box.h / view.scale / 2],
    finishDrawing: () => finishRef.current(),
  }), [fit, zoomAt, view, box]);

  // Wheel zoom (passive listeners cannot prevent the page from scrolling).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Space held = pan.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && !isTyping(e)) { setSpace(true); e.preventDefault(); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setSpace(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const r = wrap.current!.getBoundingClientRect();
    return [view.x + (e.clientX - r.left) / view.scale, view.y + (e.clientY - r.top) / view.scale];
  };
  const snapPoint = ([x, y]: Point): Point => (props.snapOn ? [snap(x, props.grid), snap(y, props.grid)] : [x, y]);
  const tol = (coarse ? 14 : 6) / view.scale;
  const current = preview ?? scene;
  const ordered = drawOrder(current);
  const single = selected.length === 1 ? current.objects.find((o) => o.id === selected[0]) ?? null : null;
  const singleEditable = !readOnly && single && isEditable(current, single) ? single : null;

  function pick(p: Point): LandscapeObject | null {
    for (let i = ordered.length - 1; i >= 0; i--) if (hitTest(ordered[i]!, p, tol)) return ordered[i]!;
    return null;
  }

  function newObject(shape: LandscapeShape): LandscapeObject {
    const info = KIND_INFO[props.kind];
    const layer = scene.layers.find((l) => l.id === info.layer && l.visible && !l.locked) ?? scene.layers.slice().reverse().find((l) => l.visible && !l.locked) ?? scene.layers[0]!;
    return {
      id: newObjectId(), layerId: layer.id, kind: props.kind, shape, rotation: 0, style: { ...info.style },
      label: props.kind === "LABEL" ? "Text" : null, link: null, groupId: null, locked: false, imageAssetId: null,
    };
  }

  const unit = planUnit(scene.background, size);
  const defaultSize = () => KIND_INFO[props.kind].size * unit;

  finishRef.current = () => finishPolygon(props.drafting ?? []);
  function finishPolygon(points: Point[]) {
    const isPath = tool === "path";
    if (points.length < (isPath ? 2 : 3)) return;
    const shape: LandscapeShape = isPath ? { type: "path", points, width: Math.max(defaultSize(), unit * 0.004) } : { type: "polygon", points };
    const o = newObject(shape);
    props.setDrafting(null);
    props.onCommit({ ...scene, objects: [...scene.objects, o] }, [o.id]);
    props.onDrawn();
  }

  function startPinch(): boolean {
    const touches = [...pointers.current.entries()].filter(([, q]) => q.type !== "mouse");
    if (touches.length < 2) return false;
    const [ida, a] = touches[0]!;
    const [idb, b] = touches[1]!;
    const r = wrap.current!.getBoundingClientRect();
    // Whatever the first finger started is dropped: no half move, no tap.
    setPreview(null);
    setDrag({
      kind: "pinch", ids: [ida, idb], startDist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      startMid: [(a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top], view,
    });
    return true;
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button === 2) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const isCoarse = e.pointerType === "touch" || e.pointerType === "pen";
    if (isCoarse !== coarse) setCoarse(isCoarse);
    wrap.current?.setPointerCapture(e.pointerId);
    if (e.pointerType === "touch" && pointers.current.size >= 2) { startPinch(); return; }
    if (drag?.kind === "pinch") return;
    const shift = e.shiftKey || !!props.multi;
    const p = toWorld(e);
    if (e.button === 1 || tool === "hand" || space) {
      setDrag({ kind: "pan", sx: e.clientX, sy: e.clientY, view });
      return;
    }
    const placing = tool === "controlpoint" || tool === "polygon" || tool === "path" || tool === "symbol";
    if (placing && e.pointerType === "touch" && !readOnly) {
      setDrag({ kind: "tap", at: p, sx: e.clientX, sy: e.clientY });
      return;
    }
    if (tool === "controlpoint") {
      if (!readOnly) props.onPickPoint?.(p);
      return;
    }
    if (readOnly) {
      const hit = pick(p);
      props.onSelect(hit ? expandGroups(scene, [hit.id]) : []);
      return;
    }
    if (tool === "polygon" || tool === "path") {
      const points = [...(props.drafting ?? []), snapPoint(p)];
      if (e.detail >= 2) { finishPolygon(props.drafting ?? []); return; }
      props.setDrafting(points);
      return;
    }
    if (tool === "symbol") {
      const [x, y] = snapPoint(p);
      const o = newObject({ type: "symbol", x, y, size: defaultSize() });
      props.onCommit({ ...scene, objects: [...scene.objects, o] }, [o.id]);
      return;
    }
    if (tool === "rect" || tool === "circle") {
      const s = snapPoint(p);
      setDrag({ kind: "draw", shape: tool, start: s, current: s });
      return;
    }
    // Select tool: handles of the single selection first.
    const target = (e.target as Element).closest("[data-handle]") as SVGElement | null;
    if (target && singleEditable) {
      const h = target.dataset.handle!;
      const center = shapeCenter(singleEditable.shape);
      if (h === "rotate") { setDrag({ kind: "rotate", base: scene, obj: singleEditable, center, startAngle: angleFrom(center, p) }); return; }
      if (h.startsWith("v")) { setDrag({ kind: "vertex", base: scene, obj: singleEditable, index: Number(h.slice(1)), center }); return; }
      setDrag({ kind: "resize", handle: Number(h), base: scene, obj: singleEditable, box: shapeBox(singleEditable.shape), center });
      return;
    }
    const hit = pick(p);
    if (!hit) {
      setDrag({ kind: "marquee", start: p, current: p, add: shift });
      if (!shift) props.onSelect([]);
      return;
    }
    const group = expandGroups(scene, [hit.id]);
    let ids = selected;
    if (shift) ids = group.every((id) => selected.includes(id)) ? selected.filter((id) => !group.includes(id)) : [...new Set([...selected, ...group])];
    else if (!selected.includes(hit.id)) ids = group;
    props.onSelect(ids);
    if (!shift) setDrag({ kind: "move", start: p, ids, base: scene, moved: false });
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const p = toWorld(e);
    if (props.drafting && e.pointerType === "mouse") setHover(snapPoint(p));
    if (!drag) return;
    switch (drag.kind) {
      case "pinch": {
        const a = pointers.current.get(drag.ids[0]);
        const b = pointers.current.get(drag.ids[1]);
        if (!a || !b) return;
        const r = wrap.current!.getBoundingClientRect();
        const mid: Point = [(a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top];
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, drag.view.scale * (Math.hypot(b.x - a.x, b.y - a.y) / drag.startDist)));
        // The plan point under the fingers' first middle stays under their middle now.
        const wx = drag.view.x + drag.startMid[0] / drag.view.scale;
        const wy = drag.view.y + drag.startMid[1] / drag.view.scale;
        setView({ scale, x: wx - mid[0] / scale, y: wy - mid[1] / scale });
        return;
      }
      case "pan": {
        const dx = (e.clientX - drag.sx) / drag.view.scale;
        const dy = (e.clientY - drag.sy) / drag.view.scale;
        setView({ ...drag.view, x: drag.view.x - dx, y: drag.view.y - dy });
        return;
      }
      case "move": {
        let dx = p[0] - drag.start[0];
        let dy = p[1] - drag.start[1];
        if (props.snapOn) { dx = snap(dx, props.grid); dy = snap(dy, props.grid); }
        if (!drag.moved && Math.hypot(dx, dy) * view.scale < 3) return;
        if (!drag.moved) setDrag({ ...drag, moved: true });
        setPreview(moveObjects(drag.base, drag.ids, dx, dy));
        return;
      }
      case "resize": {
        const local = rotatePoint(snapPoint(p), drag.center, -drag.obj.rotation);
        const keep = drag.obj.shape.type === "circle" || drag.obj.shape.type === "symbol";
        const nb = resizeBox(drag.box, drag.handle, local, keep, tol);
        let shape = scaleShape(drag.obj.shape, drag.box, nb);
        // The opposite handle stays where it was on the page, rotation included.
        const opposite = (drag.handle + 4) % 8;
        const before = rotatePoint(handlePoints(drag.box)[opposite]!, drag.center, drag.obj.rotation);
        const after = rotatePoint(handlePoints(nb)[opposite]!, boxCenter(nb), drag.obj.rotation);
        shape = moveShape(shape, before[0] - after[0], before[1] - after[1]);
        setPreview(replace(drag.base, { ...drag.obj, shape }));
        return;
      }
      case "rotate": {
        let r = drag.obj.rotation + angleFrom(drag.center, p) - drag.startAngle;
        if (props.snapOn || e.shiftKey) r = Math.round(r / 15) * 15;
        r = ((((r + 180) % 360) + 360) % 360) - 180;
        setPreview(replace(drag.base, { ...drag.obj, rotation: Math.round(r * 10) / 10 }));
        return;
      }
      case "vertex": {
        const s = drag.obj.shape;
        if (s.type !== "polygon" && s.type !== "path") return;
        const local = rotatePoint(snapPoint(p), drag.center, -drag.obj.rotation);
        const points = s.points.map((q, i) => (i === drag.index ? local : q));
        setPreview(replace(drag.base, { ...drag.obj, shape: { ...s, points } }));
        return;
      }
      case "marquee":
      case "draw":
        setDrag({ ...drag, current: drag.kind === "draw" ? snapPoint(p) : p });
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (drag?.kind === "pinch") {
      // One finger still down: it pans from here; none: done.
      const left = [...pointers.current.entries()].find(([, q]) => q.type !== "mouse");
      setDrag(left ? { kind: "pan", sx: left[1].x, sy: left[1].y, view } : null);
      return;
    }
    if (!drag) return;
    const d = drag;
    if (d.kind === "tap") {
      setDrag(null);
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 12) return; // a swipe, not a tap
      if (tool === "controlpoint") props.onPickPoint?.(d.at);
      else if (tool === "symbol") {
        const [x, y] = snapPoint(d.at);
        const o = newObject({ type: "symbol", x, y, size: defaultSize() });
        props.onCommit({ ...scene, objects: [...scene.objects, o] }, [o.id]);
      } else props.setDrafting([...(props.drafting ?? []), snapPoint(d.at)]);
      return;
    }
    setDrag(null);
    if (d.kind === "marquee") {
      const b = norm(d.start, d.current);
      if (b.w * view.scale < 3 && b.h * view.scale < 3) return;
      const inside = drawOrder(scene).filter((o) => {
        const ob = objectsBox([o])!;
        return ob.x >= b.x && ob.y >= b.y && ob.x + ob.w <= b.x + b.w && ob.y + ob.h <= b.y + b.h;
      }).map((o) => o.id);
      props.onSelect(expandGroups(scene, d.add ? [...new Set([...selected, ...inside])] : inside));
      return;
    }
    if (d.kind === "draw") {
      const small = Math.hypot(d.current[0] - d.start[0], d.current[1] - d.start[1]) * view.scale < 6;
      const sz = defaultSize();
      let shape: LandscapeShape;
      if (d.shape === "rect") {
        const b = small ? { x: d.start[0] - sz / 2, y: d.start[1] - sz * 0.35, w: sz, h: sz * 0.7 } : norm(d.start, d.current);
        shape = { type: "rect", ...b };
      } else {
        shape = { type: "circle", cx: d.start[0], cy: d.start[1], r: small ? sz / 2 : Math.hypot(d.current[0] - d.start[0], d.current[1] - d.start[1]) };
      }
      const o = newObject(shape);
      props.onCommit({ ...scene, objects: [...scene.objects, o] }, [o.id]);
      props.onDrawn();
      return;
    }
    if (preview) {
      const next = preview;
      setPreview(null);
      props.onCommit(next);
    }
  }

  // Polygon / path: Enter finishes, Backspace removes the last point, Escape cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!props.drafting || isTyping(e)) return;
      if (e.key === "Enter") { e.preventDefault(); finishPolygon(props.drafting); }
      else if (e.key === "Backspace") { e.preventDefault(); props.setDrafting(props.drafting.slice(0, -1)); }
      else if (e.key === "Escape") props.setDrafting(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const vb = `${view.x} ${view.y} ${box.w / view.scale} ${box.h / view.scale}`;
  const hs = (coarse ? 11 : 5) / view.scale; // handle half-size (finger-sized on touch)
  const labelSize = scene.background.kind === "SATELLITE" ? unit / 25 : Math.max(size.w, size.h) / 70;
  const bg = current.background;
  const gridOn = props.grid > 0 && props.grid * view.scale >= 8;
  const cursor = drag?.kind === "pan" || space || tool === "hand" ? "grab" : tool === "select" ? "default" : "crosshair";
  const multiBox = selected.length > 1 ? objectsBox(current.objects.filter((o) => selected.includes(o.id))) : null;

  return (
    <div ref={wrap} className="lse-canvas" style={{ cursor }} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onContextMenu={(e) => e.preventDefault()}>
      <svg width={box.w} height={box.h} viewBox={vb} role="img" aria-label={props.label} preserveAspectRatio="none">
        <defs>
          <pattern id="lse-grid" width={props.grid || 1} height={props.grid || 1} patternUnits="userSpaceOnUse">
            <path d={`M ${props.grid || 1} 0 L 0 0 0 ${props.grid || 1}`} fill="none" stroke="#000" strokeOpacity={0.08} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          </pattern>
        </defs>
        {bg.kind === "BLANK" && <rect x={0} y={0} width={size.w} height={size.h} fill={bg.color} />}
        {bg.kind === "PHOTO" && (props.backgroundUrl
          ? <image href={props.backgroundUrl} x={0} y={0} width={size.w} height={size.h} opacity={bg.opacity} preserveAspectRatio="none" />
          : (
            <g>
              <rect x={0} y={0} width={size.w} height={size.h} fill="#f5f5f5" stroke="#bdbdbd" vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
              {props.emptyPhotoText && <text x={size.w / 2} y={size.h / 2} fontSize={labelSize * 1.4} textAnchor="middle" fill="#757575">{props.emptyPhotoText}</text>}
            </g>
          ))}
        {bg.kind === "SATELLITE" && (
          <SatelliteTiles bg={bg} view={{ x: view.x, y: view.y, w: box.w / view.scale, h: box.h / view.scale }} pxPerUnit={view.scale}
            version={props.tileVersion} onError={props.onTileError} />
        )}
        {gridOn && <rect x={0} y={0} width={size.w} height={size.h} fill="url(#lse-grid)" pointerEvents="none" />}
        <rect x={0} y={0} width={size.w} height={size.h} fill="none" stroke="#9e9e9e" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
        {ordered.map((o) => (
          <ShapeView key={o.id} o={o} labelSize={labelSize} imageUrl={o.imageAssetId ? props.imageUrls[o.imageAssetId] ?? null : null}
            highlight={selected.includes(o.id) ? "selected" : null} />
        ))}
        {/* Selection outlines and handles */}
        {current.objects.filter((o) => selected.includes(o.id)).map((o) => (
          <polygon key={`sel-${o.id}`} points={objectCorners(o).map((q) => q.join(",")).join(" ")} fill="none" stroke="#1565c0"
            strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
        ))}
        {multiBox && <rect x={multiBox.x} y={multiBox.y} width={multiBox.w} height={multiBox.h} fill="none" stroke="#1565c0" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
        {singleEditable && tool === "select" && (() => {
          const o = singleEditable;
          const b = shapeBox(o.shape);
          const c = boxCenter(b);
          const rot = (q: Point) => rotatePoint(q, c, o.rotation);
          const top = rot([c[0], b.y]);
          const knob = rot([c[0], b.y - 24 / view.scale]);
          return (
            <g>
              <line x1={top[0]} y1={top[1]} x2={knob[0]} y2={knob[1]} stroke="#1565c0" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <circle data-handle="rotate" cx={knob[0]} cy={knob[1]} r={hs * 1.2} fill="#fff" stroke="#1565c0" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="lse-handle lse-handle--rotate" />
              {handlePoints(b).map((q, i) => {
                const [x, y] = rot(q);
                return <rect key={i} data-handle={String(i)} x={x - hs} y={y - hs} width={hs * 2} height={hs * 2} fill="#fff" stroke="#1565c0" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="lse-handle" />;
              })}
              {(o.shape.type === "polygon" || o.shape.type === "path") && o.shape.points.map((q, i) => {
                const [x, y] = rot(q);
                return <circle key={`v${i}`} data-handle={`v${i}`} cx={x} cy={y} r={hs * 0.9} fill="#1565c0" stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" className="lse-handle" />;
              })}
            </g>
          );
        })()}
        {drag?.kind === "marquee" && (() => {
          const b = norm(drag.start, drag.current);
          return <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="#1565c0" fillOpacity={0.08} stroke="#1565c0" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
        })()}
        {drag?.kind === "draw" && (drag.shape === "rect"
          ? (() => { const b = norm(drag.start, drag.current); return <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={KIND_INFO[props.kind].style.fill ?? "none"} fillOpacity={0.5} stroke="#1565c0" vectorEffect="non-scaling-stroke" />; })()
          : <circle cx={drag.start[0]} cy={drag.start[1]} r={Math.hypot(drag.current[0] - drag.start[0], drag.current[1] - drag.start[1])} fill={KIND_INFO[props.kind].style.fill ?? "none"} fillOpacity={0.5} stroke="#1565c0" vectorEffect="non-scaling-stroke" />)}
        {props.drafting && props.drafting.length > 0 && (
          <g pointerEvents="none">
            <polyline points={[...props.drafting, ...(hover ? [hover] : [])].map((q) => q.join(",")).join(" ")} fill={tool === "polygon" ? (KIND_INFO[props.kind].style.fill ?? "none") : "none"}
              fillOpacity={0.35} stroke="#1565c0" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
            {props.drafting.map((q, i) => <circle key={i} cx={q[0]} cy={q[1]} r={hs * 0.8} fill="#1565c0" />)}
          </g>
        )}
        {props.markers?.map((mk) => (
          <g key={mk.label} pointerEvents="none" className="lse-marker">
            <circle cx={mk.at[0]} cy={mk.at[1]} r={9 / view.scale} fill={mk.pending ? "#fff" : "#d32f2f"} stroke={mk.pending ? "#d32f2f" : "#fff"}
              strokeWidth={2} vectorEffect="non-scaling-stroke" />
            <text x={mk.at[0]} y={mk.at[1]} fontSize={11 / view.scale} textAnchor="middle" dominantBaseline="central" fill={mk.pending ? "#d32f2f" : "#fff"} fontWeight={700}>{mk.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
});

function replace(scene: Scene, o: LandscapeObject): Scene {
  return { ...scene, objects: scene.objects.map((x) => (x.id === o.id ? o : x)) };
}

function norm(a: Point, b: Point): Box {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}
