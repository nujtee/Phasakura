import type { ReactNode } from "react";
import type { LandscapeObject } from "../../shared/landscape-types.ts";
import { shapeBox, shapeCenter } from "./geometry.ts";

/**
 * One plan object drawn in SVG (world units), as in the editor and on the booking page (landscape, phase L2).
 * Outlines keep a constant on-screen width (non-scaling stroke). `imageUrl`: a template picture drawn inside the box.
 */
export function ShapeView({ o, imageUrl, highlight, labelSize }: {
  o: LandscapeObject;
  imageUrl?: string | null;
  highlight?: "selected" | "available" | "unavailable" | "picked" | null;
  /** Font size of labels in world units. */
  labelSize: number;
}) {
  const s = o.shape;
  const [cx, cy] = shapeCenter(s);
  const fill = o.style.fill ?? "none";
  const stroke = highlight === "selected" ? "#1565c0" : highlight === "picked" ? "#2e7d32" : o.style.stroke ?? "none";
  const strokeWidth = highlight ? 3 : 1.5;
  const common = {
    fill, stroke, strokeWidth, opacity: o.style.opacity, vectorEffect: "non-scaling-stroke" as const,
  };
  let body: ReactNode;
  switch (s.type) {
    case "rect": {
      const b = shapeBox(s);
      body = <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(b.w, b.h) * 0.04} {...common} />;
      break;
    }
    case "circle":
      body = <circle cx={s.cx} cy={s.cy} r={s.r} {...common} />;
      break;
    case "polygon":
      body = <polygon points={s.points.map((p) => p.join(",")).join(" ")} {...common} strokeLinejoin="round" />;
      break;
    case "path":
      body = (
        <polyline points={s.points.map((p) => p.join(",")).join(" ")} fill="none" stroke={o.style.stroke ?? "#bcaaa4"} strokeWidth={s.width}
          strokeLinecap="round" strokeLinejoin="round" opacity={o.style.opacity} />
      );
      break;
    case "symbol":
      body = <SymbolGlyph kind={o.kind} x={s.x} y={s.y} size={s.size} fill={o.style.fill} stroke={o.style.stroke} opacity={o.style.opacity} />;
      break;
  }
  const box = shapeBox(s);
  return (
    <g transform={o.rotation ? `rotate(${o.rotation} ${cx} ${cy})` : undefined} data-id={o.id}>
      {body}
      {imageUrl && <image href={imageUrl} x={box.x} y={box.y} width={box.w} height={box.h} preserveAspectRatio="xMidYMid meet" />}
      {highlight === "unavailable" && (
        <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="#000" opacity={0.35} pointerEvents="none" />
      )}
      {s.type === "path" && highlight === "selected" && (
        <polyline points={s.points.map((p) => p.join(",")).join(" ")} fill="none" stroke="#1565c0" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      )}
      {o.label && (
        <text x={cx} y={o.kind === "LABEL" ? cy : cy + labelSize * 0.35} fontSize={o.kind === "LABEL" ? labelSize * 1.3 : labelSize} textAnchor="middle"
          dominantBaseline={o.kind === "LABEL" ? "middle" : undefined} className="landscape-label" pointerEvents="none">
          {o.label}
        </text>
      )}
    </g>
  );
}

/** Trees, shrubs, flowers and other point objects. */
function SymbolGlyph({ kind, x, y, size, fill, stroke, opacity }: {
  kind: LandscapeObject["kind"]; x: number; y: number; size: number; fill: string | null; stroke: string | null; opacity: number;
}) {
  const r = size / 2;
  const common = { stroke: stroke ?? "none", strokeWidth: 1, vectorEffect: "non-scaling-stroke" as const, opacity };
  switch (kind) {
    case "TREE":
      return (
        <g>
          <circle cx={x} cy={y} r={r} fill={fill ?? "#2e7d32"} {...common} />
          <circle cx={x - r * 0.3} cy={y - r * 0.3} r={r * 0.45} fill="#fff" opacity={0.15} />
          <circle cx={x} cy={y} r={r * 0.12} fill={stroke ?? "#1b5e20"} />
        </g>
      );
    case "SHRUB":
      return (
        <g>
          {[[-0.35, 0], [0.35, 0], [0, -0.35], [0, 0.3]].map(([dx, dy], i) => (
            <circle key={i} cx={x + dx! * r} cy={y + dy! * r} r={r * 0.6} fill={fill ?? "#558b2f"} {...common} />
          ))}
        </g>
      );
    case "FLOWER":
      return (
        <g>
          {[0, 72, 144, 216, 288].map((a) => {
            const rad = (a * Math.PI) / 180;
            return <circle key={a} cx={x + Math.sin(rad) * r * 0.55} cy={y - Math.cos(rad) * r * 0.55} r={r * 0.45} fill={fill ?? "#f06292"} {...common} />;
          })}
          <circle cx={x} cy={y} r={r * 0.3} fill="#ffeb3b" />
        </g>
      );
    case "LABEL":
      return <circle cx={x} cy={y} r={r * 0.15} fill="none" />;
    default:
      return <circle cx={x} cy={y} r={r} fill={fill ?? "#9e9e9e"} {...common} />;
  }
}
