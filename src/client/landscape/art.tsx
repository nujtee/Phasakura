import type { ReactNode } from "react";
import { isLook, type LandscapeObjectKind } from "../../shared/landscape-types.ts";

/**
 * Illustrated "3D" looks of plan objects (houses, tents, trees, shrubs, flowers): little 2.5D pictures seen from
 * above and a little in front, with light from the top-left and a soft shadow. Each is drawn in a 100 × 100 box and
 * stretched onto the object's box. `color` (the object's fill) is the main colour — roof, fabric, leaves, petals —
 * the other faces are shades of it; `accent` (its outline colour) is used for details such as fruit.
 * Plain SVG, no gradients or ids: safe to repeat hundreds of times and under the page's CSP.
 */

/** Mixes a #rrggbb colour with white (amount > 0) or black (amount < 0). */
export function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)));
  return `#${ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}

const OUT = "#2b2b2b";
const SW = 0.9;
const line = { stroke: OUT, strokeWidth: SW, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
const WALL = "#f4ead5";
const WOOD = "#9a6436";
const GLASS = "#a9d6ef";
const DARK = "#3e2f25";
const TRUNK = "#7b5534";
const LEAF = "#43a047";

const Shadow = ({ cx = 54, cy = 92, rx = 44, ry = 7 }: { cx?: number; cy?: number; rx?: number; ry?: number }) => (
  <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="#000" opacity={0.18} />
);

// ---------------------------------------------------------------- houses (color = roof)

function house(look: string, c: string): ReactNode {
  switch (look) {
    case "thai":
      return (
        <g>
          <Shadow cx={52} cy={95} rx={42} ry={5} />
          {[16, 38, 62, 84].map((x) => <rect key={x} x={x - 2} y={74} width={4} height={20} fill={shade(WOOD, -0.3)} {...line} />)}
          <rect x={10} y={50} width={80} height={28} fill={WOOD} {...line} />
          {[22, 46, 70].map((x) => <rect key={x} x={x} y={56} width={10} height={14} fill={DARK} {...line} />)}
          <polygon points="12,4 88,4 96,27 4,27" fill={shade(c, 0.18)} {...line} />
          <polygon points="4,27 96,27 88,54 12,54" fill={shade(c, -0.12)} {...line} />
          <path d="M4,27 Q0,20 2,12 M96,27 Q100,20 98,12" fill="none" stroke={shade(c, -0.35)} strokeWidth={2.4} strokeLinecap="round" />
          <line x1={4} y1={27} x2={96} y2={27} stroke={shade(c, -0.4)} strokeWidth={1.4} />
        </g>
      );
    case "modern":
      return (
        <g>
          <Shadow />
          <rect x={6} y={46} width={88} height={42} fill={WALL} {...line} />
          <rect x={6} y={46} width={88} height={42} fill="#000" opacity={0.06} />
          <rect x={12} y={54} width={46} height={28} fill={GLASS} {...line} />
          <line x1={27} y1={54} x2={27} y2={82} {...line} />
          <line x1={42} y1={54} x2={42} y2={82} {...line} />
          <rect x={66} y={58} width={16} height={30} fill={shade(WOOD, -0.15)} {...line} />
          <rect x={4} y={8} width={92} height={40} fill={shade(c, 0.1)} {...line} />
          <rect x={8} y={12} width={84} height={32} fill={shade(c, -0.08)} opacity={0.9} />
          <rect x={60} y={18} width={20} height={14} fill={shade(c, 0.35)} {...line} />
        </g>
      );
    case "aframe":
      return (
        <g>
          <Shadow cx={52} cy={92} rx={46} ry={6} />
          <polygon points="50,4 4,90 96,90" fill={shade(c, 0.05)} {...line} />
          <polygon points="50,4 4,90 50,90" fill={shade(c, -0.18)} />
          <polygon points="50,30 24,90 76,90" fill={GLASS} {...line} />
          <line x1={50} y1={30} x2={50} y2={90} {...line} />
          <line x1={34} y1={66} x2={66} y2={66} {...line} />
          <rect x={44} y={72} width={12} height={18} fill={shade(WOOD, -0.1)} {...line} />
          <polygon points="50,4 4,90 96,90" fill="none" {...line} />
        </g>
      );
    case "bungalow":
      return (
        <g>
          <Shadow cx={52} cy={95} rx={46} ry={5} />
          <rect x={2} y={80} width={96} height={12} fill={shade(WOOD, 0.15)} {...line} />
          {[14, 26, 38, 50, 62, 74, 86].map((x) => <line key={x} x1={x} y1={80} x2={x} y2={92} stroke={shade(WOOD, -0.2)} strokeWidth={0.6} />)}
          <rect x={10} y={50} width={80} height={30} fill={WOOD} {...line} />
          <rect x={20} y={56} width={14} height={12} fill={GLASS} {...line} />
          <rect x={66} y={56} width={14} height={12} fill={GLASS} {...line} />
          <rect x={44} y={56} width={12} height={24} fill={DARK} {...line} />
          <polygon points="4,8 96,8 70,26 30,26" fill={shade(c, 0.22)} {...line} />
          <polygon points="4,8 30,26 4,52" fill={shade(c, 0.02)} {...line} />
          <polygon points="96,8 70,26 96,52" fill={shade(c, -0.25)} {...line} />
          <polygon points="4,52 30,26 70,26 96,52" fill={shade(c, -0.1)} {...line} />
        </g>
      );
    case "cabin":
      return (
        <g>
          <Shadow />
          <rect x={8} y={50} width={84} height={40} fill={shade(WOOD, 0.08)} {...line} />
          {[56, 62, 68, 74, 80, 86].map((y) => <line key={y} x1={8} y1={y} x2={92} y2={y} stroke={shade(WOOD, -0.3)} strokeWidth={0.7} />)}
          <rect x={18} y={60} width={14} height={12} fill={GLASS} {...line} />
          <rect x={68} y={60} width={14} height={12} fill={GLASS} {...line} />
          <rect x={44} y={64} width={12} height={26} fill={DARK} {...line} />
          <rect x={70} y={2} width={9} height={18} fill="#8d8d8d" {...line} />
          <polygon points="4,8 96,8 98,30 2,30" fill={shade(c, 0.12)} {...line} />
          <polygon points="2,30 98,30 94,54 6,54" fill={shade(c, -0.18)} {...line} />
        </g>
      );
    default: // gable
      return (
        <g>
          <Shadow />
          <rect x={8} y={50} width={84} height={40} fill={WALL} {...line} />
          <rect x={16} y={60} width={14} height={12} fill={GLASS} {...line} />
          <line x1={23} y1={60} x2={23} y2={72} {...line} />
          <rect x={70} y={60} width={14} height={12} fill={GLASS} {...line} />
          <line x1={77} y1={60} x2={77} y2={72} {...line} />
          <rect x={43} y={64} width={14} height={26} fill={shade(WOOD, -0.1)} {...line} />
          <circle cx={54} cy={78} r={1} fill={OUT} />
          <polygon points="4,6 96,6 98,28 2,28" fill={shade(c, 0.2)} {...line} />
          <polygon points="2,28 98,28 94,56 6,56" fill={shade(c, -0.12)} {...line} />
          <line x1={2} y1={28} x2={98} y2={28} stroke={shade(c, -0.4)} strokeWidth={1.2} />
        </g>
      );
  }
}

// ---------------------------------------------------------------- tents (color = fabric)

function tent(look: string, c: string): ReactNode {
  switch (look) {
    case "dome":
      return (
        <g>
          <Shadow cx={54} cy={88} rx={46} ry={8} />
          <path d="M6,86 A44,62 0 0 1 94,86 Z" fill={shade(c, 0.05)} {...line} />
          <path d="M50,24 A44,62 0 0 1 94,86 L50,86 Z" fill="#000" opacity={0.1} />
          <path d="M14,86 Q50,4 86,86" fill="none" stroke={shade(c, -0.35)} strokeWidth={1} />
          <path d="M30,86 Q50,10 70,86" fill="none" stroke={shade(c, -0.35)} strokeWidth={1} />
          <path d="M36,86 A14,22 0 0 1 64,86 Z" fill={shade(c, -0.45)} {...line} />
        </g>
      );
    case "safari":
      return (
        <g>
          <Shadow cx={52} cy={95} rx={46} ry={4} />
          <rect x={2} y={80} width={96} height={13} fill={shade(WOOD, 0.15)} {...line} />
          <polygon points="10,12 90,12 96,34 4,34" fill={shade(c, 0.15)} {...line} />
          <polygon points="4,34 96,34 90,58 10,58" fill={shade(c, -0.1)} {...line} />
          <rect x={10} y={56} width={80} height={24} fill={shade(c, -0.02)} {...line} />
          <polygon points="38,56 62,56 66,80 34,80" fill={DARK} {...line} />
          <polygon points="38,56 30,80 34,80" fill={shade(c, -0.2)} {...line} />
          <polygon points="62,56 70,80 66,80" fill={shade(c, -0.2)} {...line} />
        </g>
      );
    case "tipi":
      return (
        <g>
          <Shadow cx={54} cy={91} rx={40} ry={6} />
          <line x1={50} y1={14} x2={38} y2={0} {...line} />
          <line x1={50} y1={14} x2={62} y2={0} {...line} />
          <line x1={50} y1={14} x2={50} y2={0} {...line} />
          <polygon points="50,10 10,90 90,90" fill={shade(c, 0.06)} {...line} />
          <polygon points="50,10 50,90 90,90" fill="#000" opacity={0.1} />
          <polygon points="24,62 76,62 80,70 20,70" fill={shade(c, -0.35)} />
          <polygon points="50,52 38,90 62,90" fill={DARK} {...line} />
        </g>
      );
    case "aframe":
      return (
        <g>
          <Shadow cx={56} cy={90} rx={44} ry={6} />
          <polygon points="50,22 64,6 98,72 90,88" fill={shade(c, -0.22)} {...line} />
          <polygon points="50,22 10,88 90,88" fill={shade(c, 0.08)} {...line} />
          <line x1={50} y1={34} x2={50} y2={88} stroke={shade(c, -0.45)} strokeWidth={1.4} />
          <polygon points="50,50 40,88 60,88" fill={shade(c, -0.4)} opacity={0.7} />
        </g>
      );
    case "bubble":
      return (
        <g>
          <Shadow cx={52} cy={92} rx={40} ry={6} />
          <rect x={26} y={56} width={48} height={22} rx={3} fill="#fafafa" {...line} />
          <rect x={26} y={56} width={48} height={7} rx={3} fill={shade(c, -0.1)} />
          <rect x={30} y={50} width={14} height={8} rx={3} fill="#ffffff" {...line} />
          <circle cx={50} cy={52} r={42} fill={c} opacity={0.28} stroke="#ffffff" strokeWidth={1.6} />
          <path d="M22,30 A34,34 0 0 1 46,14" fill="none" stroke="#ffffff" strokeWidth={3} strokeLinecap="round" opacity={0.8} />
        </g>
      );
    default: // bell
      return (
        <g>
          <Shadow cx={54} cy={90} rx={46} ry={7} />
          <path d="M6,74 Q14,40 50,8 Q86,40 94,74 Z" fill={shade(c, 0.08)} {...line} />
          <path d="M50,8 Q86,40 94,74 L50,74 Z" fill="#000" opacity={0.09} />
          <path d="M6,74 L6,86 L94,86 L94,74 Z" fill={shade(c, -0.08)} {...line} />
          {[26, 50, 74].map((x) => <path key={x} d={`M50,8 Q${x - 4},40 ${x},74`} fill="none" stroke={shade(c, -0.3)} strokeWidth={0.8} />)}
          <polygon points="40,74 60,74 56,86 44,86" fill={DARK} {...line} />
          <circle cx={50} cy={7} r={2.2} fill={WOOD} {...line} />
        </g>
      );
  }
}

// ---------------------------------------------------------------- trees (color = leaves, accent = fruit)

function tree(look: string, c: string, accent: string | null): ReactNode {
  const trunk = (x = 50, top = 66, w = 8) => <rect x={x - w / 2} y={top} width={w} height={92 - top} rx={2} fill={TRUNK} {...line} />;
  switch (look) {
    case "pine":
      return (
        <g>
          <Shadow cx={56} cy={93} rx={30} ry={5} />
          {trunk(50, 80, 7)}
          <polygon points="50,40 10,84 90,84" fill={shade(c, -0.12)} {...line} />
          <polygon points="50,22 18,62 82,62" fill={shade(c, -0.02)} {...line} />
          <polygon points="50,4 26,40 74,40" fill={shade(c, 0.12)} {...line} />
          <polygon points="50,4 50,84 90,84 82,62 74,40" fill="#000" opacity={0.12} />
        </g>
      );
    case "palm":
      return (
        <g>
          <Shadow cx={58} cy={94} rx={28} ry={4} />
          <path d="M52,94 Q46,70 50,40" fill="none" stroke={TRUNK} strokeWidth={7} strokeLinecap="round" />
          <path d="M52,94 Q46,70 50,40" fill="none" stroke={shade(TRUNK, -0.35)} strokeWidth={7} strokeDasharray="1.2 4" />
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <path key={a} transform={`rotate(${a} 50 38)`} d="M50,38 Q62,22 92,30 Q66,32 50,38 Z"
              fill={a % 120 === 0 ? shade(c, 0.1) : shade(c, -0.12)} {...line} />
          ))}
          {[[46, 42], [53, 43], [50, 37]].map(([x, y]) => <circle key={`${x}`} cx={x} cy={y} r={3.2} fill={accent ?? "#795548"} {...line} />)}
        </g>
      );
    case "rain":
      return (
        <g>
          <Shadow cx={54} cy={88} rx={46} ry={8} />
          {trunk(50, 56, 10)}
          <ellipse cx={50} cy={40} rx={48} ry={28} fill={shade(c, -0.08)} {...line} />
          {[[24, 40, 20], [76, 40, 20], [50, 26, 24], [38, 48, 16], [64, 48, 16]].map(([x, y, r]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill={shade(c, y! < 40 ? 0.12 : -0.02)} />
          ))}
          <ellipse cx={50} cy={40} rx={48} ry={28} fill="none" {...line} />
          <circle cx={36} cy={24} r={8} fill="#fff" opacity={0.18} />
        </g>
      );
    case "bamboo":
      return (
        <g>
          <Shadow cx={54} cy={93} rx={30} ry={5} />
          {[30, 40, 50, 60, 70].map((x, i) => (
            <g key={x}>
              <line x1={x} y1={92} x2={x + (i - 2) * 3} y2={8 + (i % 2) * 8} stroke={shade(c, 0.25)} strokeWidth={4} strokeLinecap="round" />
              {[30, 50, 70].map((y) => <line key={y} x1={x - 2.5} y1={y + i * 2} x2={x + 2.5} y2={y + i * 2} stroke={shade(c, -0.3)} strokeWidth={1} />)}
            </g>
          ))}
          {[[24, 20, -30], [76, 18, 30], [36, 34, -20], [66, 36, 25], [50, 10, 0], [22, 46, -35], [78, 50, 35]].map(([x, y, a]) => (
            <ellipse key={`${x}-${y}`} cx={x} cy={y} rx={10} ry={3} transform={`rotate(${a} ${x} ${y})`} fill={shade(c, -0.05)} {...line} />
          ))}
        </g>
      );
    case "fruit":
      return (
        <g>
          <Shadow cx={56} cy={92} rx={36} ry={6} />
          {trunk()}
          <circle cx={50} cy={40} r={34} fill={shade(c, -0.05)} {...line} />
          <circle cx={36} cy={30} r={14} fill={shade(c, 0.12)} />
          <circle cx={62} cy={48} r={14} fill={shade(c, -0.15)} />
          {[[32, 46], [58, 26], [66, 58], [44, 60], [72, 38], [40, 22], [54, 46]].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={3.6} fill={accent ?? "#ff9800"} {...line} />
          ))}
        </g>
      );
    case "cypress":
      return (
        <g>
          <Shadow cx={56} cy={93} rx={22} ry={4} />
          {trunk(50, 84, 6)}
          <ellipse cx={50} cy={46} rx={20} ry={42} fill={shade(c, 0.02)} {...line} />
          <path d="M50,4 A20,42 0 0 1 50,88 Z" fill="#000" opacity={0.14} />
          <path d="M42,20 Q38,46 44,74" fill="none" stroke="#fff" strokeWidth={2} opacity={0.25} strokeLinecap="round" />
        </g>
      );
    default: // round
      return (
        <g>
          <Shadow cx={56} cy={92} rx={36} ry={6} />
          {trunk()}
          <circle cx={50} cy={42} r={34} fill={c} {...line} />
          <circle cx={32} cy={50} r={17} fill={shade(c, -0.12)} />
          <circle cx={68} cy={50} r={17} fill={shade(c, -0.2)} />
          <circle cx={48} cy={26} r={19} fill={shade(c, 0.12)} />
          <circle cx={50} cy={42} r={34} fill="none" {...line} />
          <circle cx={40} cy={22} r={8} fill="#fff" opacity={0.2} />
        </g>
      );
  }
}

// ---------------------------------------------------------------- shrubs (color = leaves)

function shrub(look: string, c: string): ReactNode {
  switch (look) {
    case "hedge":
      return (
        <g>
          <Shadow cx={52} cy={88} rx={48} ry={6} />
          <rect x={4} y={34} width={92} height={50} rx={10} fill={shade(c, -0.1)} {...line} />
          <rect x={4} y={20} width={92} height={30} rx={10} fill={shade(c, 0.12)} {...line} />
          {[16, 34, 52, 70, 86].map((x) => <circle key={x} cx={x} cy={30} r={6} fill={shade(c, 0.2)} />)}
        </g>
      );
    case "topiary":
      return (
        <g>
          <Shadow cx={54} cy={92} rx={22} ry={4} />
          <polygon points="36,74 64,74 60,92 40,92" fill="#c1693c" {...line} />
          <line x1={50} y1={74} x2={50} y2={44} stroke={TRUNK} strokeWidth={3} />
          <circle cx={50} cy={58} r={14} fill={shade(c, -0.08)} {...line} />
          <circle cx={50} cy={28} r={20} fill={c} {...line} />
          <circle cx={43} cy={21} r={6} fill="#fff" opacity={0.2} />
        </g>
      );
    default: // round
      return (
        <g>
          <Shadow cx={54} cy={86} rx={44} ry={8} />
          <circle cx={30} cy={58} r={24} fill={shade(c, -0.12)} {...line} />
          <circle cx={70} cy={58} r={24} fill={shade(c, -0.2)} {...line} />
          <circle cx={50} cy={40} r={28} fill={shade(c, 0.08)} {...line} />
          <circle cx={42} cy={30} r={8} fill="#fff" opacity={0.2} />
        </g>
      );
  }
}

// ---------------------------------------------------------------- flowers (color = petals)

function blossom(cx: number, cy: number, r: number, c: string, petals = 5): ReactNode {
  return (
    <g>
      {Array.from({ length: petals }, (_, i) => {
        const a = (i * 2 * Math.PI) / petals;
        return <circle key={i} cx={cx + Math.sin(a) * r * 0.6} cy={cy - Math.cos(a) * r * 0.6} r={r * 0.55} fill={i % 2 ? shade(c, -0.1) : c} stroke={shade(c, -0.4)} strokeWidth={0.6} />;
      })}
      <circle cx={cx} cy={cy} r={r * 0.35} fill="#ffd54f" stroke="#b28704" strokeWidth={0.5} />
    </g>
  );
}

function flower(look: string, c: string): ReactNode {
  switch (look) {
    case "bed":
      return (
        <g>
          <Shadow cx={52} cy={88} rx={48} ry={6} />
          <rect x={4} y={24} width={92} height={60} rx={14} fill="#6d4c41" {...line} />
          <rect x={8} y={28} width={84} height={50} rx={12} fill={shade(LEAF, -0.1)} />
          {Array.from({ length: 24 }, (_, i) => {
            const x = 14 + (i % 8) * 10.5 + ((i >> 3) % 2) * 5;
            const y = 36 + Math.floor(i / 8) * 14;
            return <circle key={i} cx={x} cy={y} r={4} fill={i % 5 === 0 ? shade(c, 0.4) : c} stroke={shade(c, -0.35)} strokeWidth={0.5} />;
          })}
        </g>
      );
    case "tulip":
      return (
        <g>
          <Shadow cx={52} cy={90} rx={36} ry={5} />
          {([[28, 34], [50, 22], [72, 34], [39, 50], [61, 50]] as const).map(([x, y]) => (
            <g key={`${x}-${y}`}>
              <line x1={x} y1={y} x2={x} y2={88} stroke={shade(LEAF, -0.2)} strokeWidth={2} />
              <path d={`M${x - 4},${y + 30} Q${x - 12},${y + 18} ${x - 2},${y + 14}`} fill={LEAF} stroke={shade(LEAF, -0.3)} strokeWidth={0.6} />
              <path d={`M${x - 7},${y - 6} L${x - 7},${y + 4} Q${x},${y + 12} ${x + 7},${y + 4} L${x + 7},${y - 6} L${x + 3},${y - 1} L${x},${y - 8} L${x - 3},${y - 1} Z`} fill={c} {...line} />
            </g>
          ))}
        </g>
      );
    case "sunflower":
      return (
        <g>
          <Shadow cx={54} cy={90} rx={30} ry={5} />
          <line x1={50} y1={50} x2={50} y2={90} stroke={shade(LEAF, -0.2)} strokeWidth={3} />
          <path d="M50,74 Q30,60 24,72 Q36,80 50,74 Z" fill={LEAF} {...line} />
          {Array.from({ length: 14 }, (_, i) => (
            <ellipse key={i} cx={50} cy={22} rx={6} ry={14} transform={`rotate(${(i * 360) / 14} 50 38)`} fill={i % 2 ? shade(c, -0.08) : c} stroke={shade(c, -0.35)} strokeWidth={0.6} />
          ))}
          <circle cx={50} cy={38} r={13} fill="#5d4037" {...line} />
          <circle cx={46} cy={34} r={4} fill="#8d6e63" />
        </g>
      );
    case "pot":
      return (
        <g>
          <Shadow cx={54} cy={93} rx={28} ry={4} />
          <circle cx={50} cy={46} r={26} fill={shade(LEAF, -0.05)} {...line} />
          {blossom(38, 40, 13, c)}
          {blossom(62, 42, 12, c)}
          {blossom(50, 26, 12, c)}
          <polygon points="28,62 72,62 66,92 34,92" fill="#c1693c" {...line} />
          <rect x={25} y={60} width={50} height={8} rx={2} fill="#d98154" {...line} />
        </g>
      );
    default: // bloom
      return (
        <g>
          <Shadow cx={54} cy={88} rx={42} ry={7} />
          <circle cx={30} cy={58} r={22} fill={shade(LEAF, -0.15)} {...line} />
          <circle cx={70} cy={58} r={22} fill={shade(LEAF, -0.22)} {...line} />
          <circle cx={50} cy={42} r={26} fill={LEAF} {...line} />
          {blossom(32, 52, 14, c)}
          {blossom(66, 54, 13, c)}
          {blossom(50, 30, 15, c)}
        </g>
      );
  }
}

/** The illustration of an object's look (100 × 100 units), or null when it is drawn flat. */
export function lookArt(kind: LandscapeObjectKind, look: string | null | undefined, color: string | null, accent: string | null = null): ReactNode | null {
  if (!look || !isLook(kind, look)) return null;
  const c = color ?? DEFAULT_COLOR[kind] ?? "#9e9e9e";
  switch (kind) {
    case "HOUSE": return house(look, c);
    case "VIP_TENT": return tent(look, c);
    case "TREE": return tree(look, c, accent);
    case "SHRUB": return shrub(look, c);
    case "FLOWER": return flower(look, c);
    default: return null;
  }
}

const DEFAULT_COLOR: Partial<Record<LandscapeObjectKind, string>> = {
  HOUSE: "#b5523b", VIP_TENT: "#f3e3c3", TREE: "#2e7d32", SHRUB: "#558b2f", FLOWER: "#f06292",
};

/** Quick colours offered next to the fill colour, per kind (leaves in all seasons, petals, roofs, fabrics). */
export const LOOK_COLORS: Partial<Record<LandscapeObjectKind, string[]>> = {
  TREE: ["#2e7d32", "#1b5e20", "#558b2f", "#7cb342", "#9e9d24", "#ef6c00", "#c62828", "#f48fb1", "#ffffff"],
  SHRUB: ["#558b2f", "#2e7d32", "#7cb342", "#827717", "#6a1b9a", "#ad1457"],
  FLOWER: ["#e53935", "#f06292", "#ffeb3b", "#ff9800", "#8e24aa", "#ffffff", "#1e88e5", "#d81b60"],
  HOUSE: ["#b5523b", "#8d4a2f", "#c62828", "#37474f", "#1565c0", "#2e7d32", "#6d4c41", "#9e9e9e"],
  VIP_TENT: ["#f3e3c3", "#ffffff", "#d7c49e", "#a1887f", "#ef6c00", "#2e7d32", "#1565c0", "#c2185b"],
};
