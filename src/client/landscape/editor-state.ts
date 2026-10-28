import type { LandscapeBackground, LandscapeLayer, LandscapeObject } from "../../shared/landscape-types.ts";
import { moveShape } from "./geometry.ts";

/**
 * The editor's working state (landscape, phase L2): objects in world units, layers, background, and undo / redo.
 * Every finished action (a drag released, a property changed) is one step back; dragging itself is not recorded
 * step by step. Pure functions: the component keeps the state and the tests run them directly.
 */
export interface Scene {
  objects: LandscapeObject[];
  layers: LandscapeLayer[];
  background: LandscapeBackground;
}

export interface History {
  past: Scene[];
  present: Scene;
  future: Scene[];
}

export const HISTORY_LIMIT = 100;

export function initHistory(scene: Scene): History {
  return { past: [], present: scene, future: [] };
}

/** A new present; the old one becomes a step back (nothing is recorded when nothing changed). */
export function commit(h: History, next: Scene): History {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function undo(h: History): History {
  const prev = h.past.at(-1);
  return prev ? { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] } : h;
}

export function redo(h: History): History {
  const next = h.future[0];
  return next ? { past: [...h.past, h.present], present: next, future: h.future.slice(1) } : h;
}

let counter = 0;
/** Short unique ids for new objects / layers / groups (the server only checks the pattern and uniqueness). */
export function newObjectId(prefix = "o"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Objects that cannot be changed now: locked themselves, or on a locked / hidden layer. */
export function isEditable(scene: Scene, o: LandscapeObject): boolean {
  const layer = scene.layers.find((l) => l.id === o.layerId);
  return !o.locked && !!layer && !layer.locked && layer.visible;
}

/** Clicking one member of a group selects the whole group. */
export function expandGroups(scene: Scene, ids: string[]): string[] {
  const groups = new Set(scene.objects.filter((o) => ids.includes(o.id) && o.groupId).map((o) => o.groupId));
  return scene.objects.filter((o) => ids.includes(o.id) || (o.groupId && groups.has(o.groupId))).map((o) => o.id);
}

export function updateObjects(scene: Scene, ids: string[], f: (o: LandscapeObject) => LandscapeObject): Scene {
  const set = new Set(ids);
  return { ...scene, objects: scene.objects.map((o) => (set.has(o.id) ? f(o) : o)) };
}

export function moveObjects(scene: Scene, ids: string[], dx: number, dy: number): Scene {
  return updateObjects(scene, ids.filter((id) => isEditable(scene, scene.objects.find((o) => o.id === id)!)), (o) => ({ ...o, shape: moveShape(o.shape, dx, dy) }));
}

export function deleteObjects(scene: Scene, ids: string[]): Scene {
  const set = new Set(ids.filter((id) => isEditable(scene, scene.objects.find((o) => o.id === id)!)));
  return { ...scene, objects: scene.objects.filter((o) => !set.has(o.id)) };
}

/** Copies, a little offset, in the same layers; groups stay groups (new group ids); booking links are not copied. */
export function duplicateObjects(scene: Scene, ids: string[], offset: number): { scene: Scene; ids: string[] } {
  const groupMap = new Map<string, string>();
  const copies = scene.objects.filter((o) => ids.includes(o.id)).map((o) => {
    let groupId: string | null = null;
    if (o.groupId) {
      if (!groupMap.has(o.groupId)) groupMap.set(o.groupId, newObjectId("g"));
      groupId = groupMap.get(o.groupId)!;
    }
    return { ...o, id: newObjectId(), groupId, link: null, locked: false, shape: moveShape(o.shape, offset, offset) };
  });
  return { scene: { ...scene, objects: [...scene.objects, ...copies] }, ids: copies.map((c) => c.id) };
}

export function groupObjects(scene: Scene, ids: string[]): Scene {
  if (ids.length < 2) return scene;
  const groupId = newObjectId("g");
  return updateObjects(scene, ids, (o) => ({ ...o, groupId }));
}

export function ungroupObjects(scene: Scene, ids: string[]): Scene {
  return updateObjects(scene, ids, (o) => ({ ...o, groupId: null }));
}

/** Drawing order inside a layer: one step up / down, or to the top / bottom. */
export function reorderObjects(scene: Scene, ids: string[], where: "up" | "down" | "top" | "bottom"): Scene {
  const set = new Set(ids);
  const list = [...scene.objects];
  if (where === "top") return { ...scene, objects: [...list.filter((o) => !set.has(o.id)), ...list.filter((o) => set.has(o.id))] };
  if (where === "bottom") return { ...scene, objects: [...list.filter((o) => set.has(o.id)), ...list.filter((o) => !set.has(o.id))] };
  const order = where === "up" ? [...list.keys()].reverse() : [...list.keys()];
  for (const i of order) {
    const j = where === "up" ? i + 1 : i - 1;
    if (j < 0 || j >= list.length) continue;
    if (set.has(list[i]!.id) && !set.has(list[j]!.id) && list[j]!.layerId === list[i]!.layerId) [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return { ...scene, objects: list };
}

/** Objects drawn bottom → top: by layer order, then by their order in the list. Hidden layers are left out. */
export function drawOrder(scene: Scene): LandscapeObject[] {
  const rank = new Map(scene.layers.map((l, i) => [l.id, i]));
  const visible = new Set(scene.layers.filter((l) => l.visible).map((l) => l.id));
  return scene.objects
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => visible.has(o.layerId))
    .sort((a, b) => (rank.get(a.o.layerId)! - rank.get(b.o.layerId)!) || a.i - b.i)
    .map(({ o }) => o);
}

export function moveLayer(scene: Scene, id: string, dir: -1 | 1): Scene {
  const i = scene.layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= scene.layers.length) return scene;
  const layers = [...scene.layers];
  [layers[i], layers[j]] = [layers[j]!, layers[i]!];
  return { ...scene, layers };
}

/** A layer can go only when it is empty (its objects are never deleted silently) and is not the last one. */
export function removeLayer(scene: Scene, id: string): Scene {
  if (scene.layers.length < 2 || scene.objects.some((o) => o.layerId === id)) return scene;
  return { ...scene, layers: scene.layers.filter((l) => l.id !== id) };
}
