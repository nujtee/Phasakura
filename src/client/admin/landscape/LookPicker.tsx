import { LANDSCAPE_LOOKS, type LandscapeObjectKind } from "../../../shared/landscape-types.ts";
import { lookArt, LOOK_COLORS } from "../../landscape/art.tsx";

/**
 * Choose an object's illustrated look (Thai house, bell tent, pine…) from pictures, or flat (2D). Used in the
 * toolbar (what the next object looks like), in Properties (the selection) and for a palette kind.
 */
export function LookPicker({ kind, value, color, accent, names, flat, label, onPick, disabled, compact }: {
  kind: LandscapeObjectKind;
  value: string | null;
  color: string | null;
  accent?: string | null;
  names: Record<string, string>;
  flat: string;
  label: string;
  onPick: (look: string | null) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const looks = LANDSCAPE_LOOKS[kind];
  if (!looks) return null;
  return (
    <div className={`lse-looks${compact ? " lse-looks--compact" : ""}`} role="group" aria-label={label}>
      {!compact && <span className="lse-looks__label">{label}</span>}
      {looks.map((l) => (
        <button key={l} type="button" className={`lse-look${value === l ? " is-active" : ""}`} aria-pressed={value === l} disabled={disabled}
          title={names[l] ?? l} onClick={() => onPick(l)}>
          <svg viewBox="-4 -4 108 108" width="44" height="44" aria-hidden="true">{lookArt(kind, l, color, accent ?? null)}</svg>
          <span className="lse-look__name">{names[l] ?? l}</span>
        </button>
      ))}
      <button type="button" className={`lse-look${value === null ? " is-active" : ""}`} aria-pressed={value === null} disabled={disabled}
        title={flat} onClick={() => onPick(null)}>
        <svg viewBox="0 0 100 100" width="44" height="44" aria-hidden="true">
          <rect x={18} y={18} width={64} height={64} rx={8} fill={color ?? "#bdbdbd"} stroke="#555" strokeWidth={3} />
        </svg>
        <span className="lse-look__name">{flat}</span>
      </button>
    </div>
  );
}

/** One-tap colours for a kind (leaves, petals, roofs, fabrics); the fill colour field still takes any colour. */
export function QuickColors({ kind, value, label, onPick, disabled }: {
  kind: LandscapeObjectKind; value: string | null; label: string; onPick: (c: string) => void; disabled?: boolean;
}) {
  const colors = LOOK_COLORS[kind];
  if (!colors) return null;
  return (
    <div className="lse-quickcolors" role="group" aria-label={label}>
      {colors.map((c) => (
        <button key={c} type="button" className={`lse-qc${value?.toLowerCase() === c ? " is-active" : ""}`} aria-pressed={value?.toLowerCase() === c}
          aria-label={`${label} ${c}`} title={c} disabled={disabled} onClick={() => onPick(c)}>
          <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true"><circle cx={10} cy={10} r={8.5} fill={c} stroke="#555" strokeWidth={1} /></svg>
        </button>
      ))}
    </div>
  );
}
