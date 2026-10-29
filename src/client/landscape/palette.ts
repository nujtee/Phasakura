import {
  LANDSCAPE_OBJECT_KINDS, type LandscapeObjectKind, type LandscapePaletteInput, type LandscapePaletteRowDto, type PaletteGroup,
} from "../../shared/landscape-types.ts";
import { KIND_INFO, PALETTE, type KindInfo } from "./kinds.ts";

/**
 * The editor's palette (migration 0040): the built-in kinds, as staff changed them, plus the kinds staff made.
 * A built-in with no stored row is exactly as it ships; one with a row takes the row's non-empty fields.
 */
export interface PaletteEntry {
  /** Built-in: its code (TREE…). Staff kind: its id (k…). */
  id: string;
  builtin: boolean;
  /** What it is drawn as: decides booking links (HOUSE / VIP_TENT / CAMPING_AREA) and the symbol's look. */
  kind: LandscapeObjectKind;
  /** null: the built-in's own name in the editor's language. */
  name: string | null;
  info: KindInfo;
  group: PaletteGroup;
  sortOrder: number;
  hidden: boolean;
  /** A built-in that differs from how it ships. */
  changed: boolean;
}

/** Built-in groups and the order they ship in (10, 20, 30… so staff kinds can go in between). */
const BUILTIN_ORDER = new Map<LandscapeObjectKind, { group: PaletteGroup; order: number }>(
  PALETTE.flatMap((g) => g.kinds.map((k) => [k, { group: g.group, order: 0 }] as const))
    .map(([k, v], i) => [k, { ...v, order: (i + 1) * 10 }]),
);

export function buildPalette(rows: LandscapePaletteRowDto[]): PaletteEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const builtins = LANDSCAPE_OBJECT_KINDS.filter((k) => BUILTIN_ORDER.has(k)).map((k): PaletteEntry => {
    const base = KIND_INFO[k];
    const ship = BUILTIN_ORDER.get(k)!;
    const r = byId.get(k);
    return {
      id: k, builtin: true, kind: k, name: r?.name ?? null,
      info: {
        draw: r?.draw ?? base.draw,
        layer: r?.layer ?? base.layer,
        size: r?.size ?? base.size,
        style: r ? { fill: r.fill, stroke: r.stroke, opacity: r.opacity ?? base.style.opacity } : base.style,
      },
      group: r?.group ?? ship.group, sortOrder: r?.sortOrder ?? ship.order, hidden: r?.hidden ?? false, changed: !!r,
    };
  });
  const custom = rows.filter((r) => !r.builtin).map((r): PaletteEntry => ({
    id: r.id, builtin: false, kind: r.kind, name: r.name,
    info: { draw: r.draw ?? KIND_INFO[r.kind].draw, layer: r.layer ?? KIND_INFO[r.kind].layer, size: r.size ?? KIND_INFO[r.kind].size, style: { fill: r.fill, stroke: r.stroke, opacity: r.opacity ?? 1 } },
    group: r.group ?? "site", sortOrder: r.sortOrder ?? 10_000, hidden: r.hidden, changed: false,
  }));
  return [...builtins, ...custom].sort((a, b) => a.sortOrder - b.sortOrder || (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1));
}

/** The palette as it ships (before the stored rows load, or when they cannot). */
export const DEFAULT_PALETTE: PaletteEntry[] = buildPalette([]);

/** What a palette entry looks like as the form / API body. */
export function entryInput(e: PaletteEntry): LandscapePaletteInput {
  return {
    kind: e.kind, name: e.name, draw: e.info.draw, fill: e.info.style.fill, stroke: e.info.style.stroke, opacity: e.info.style.opacity,
    layer: e.info.layer, size: e.info.size, group: e.group, sortOrder: e.sortOrder, hidden: e.hidden,
  };
}

/** The entry an object was drawn as: its type (staff kind) if still there, else its built-in kind. */
export function entryOf(palette: PaletteEntry[], o: { kind: LandscapeObjectKind; typeId?: string | null }): PaletteEntry | undefined {
  return (o.typeId ? palette.find((p) => p.id === o.typeId) : undefined) ?? palette.find((p) => p.builtin && p.id === o.kind);
}

/** One step up / down among the entries of the same group: the new sort orders of the two that swap. */
export function swapOrder(palette: PaletteEntry[], id: string, dir: -1 | 1): [PaletteEntry, number][] | null {
  const e = palette.find((p) => p.id === id);
  if (!e) return null;
  const same = palette.filter((p) => p.group === e.group);
  const i = same.indexOf(e);
  const other = same[i + dir];
  if (!other) return null;
  const a = e.sortOrder === other.sortOrder ? other.sortOrder + dir : other.sortOrder;
  return [[e, a], [other, e.sortOrder]];
}
