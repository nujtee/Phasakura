import { useMemo } from "react";
import { encodeQr, qrSvgPath } from "../../shared/qr.ts";

const QUIET = 4;

/** A QR code drawn as one SVG path (sharp at any size, no image request). */
export function QrCode({ value, label, size = 220 }: { value: string; label: string; size?: number }) {
  const modules = useMemo(() => {
    try {
      return encodeQr(value, "M");
    } catch {
      return null;
    }
  }, [value]);
  if (!modules) return null;
  const n = modules.length + QUIET * 2;
  return (
    <svg className="qr" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={qrSvgPath(modules, QUIET)} fill="#000000" />
    </svg>
  );
}

/** PNG of the QR (white margin) for "save image" — banking apps can scan a QR from the photo gallery. */
export function qrPngDataUrl(value: string, scale = 10): string | null {
  if (typeof document === "undefined") return null;
  let modules: boolean[][];
  try {
    modules = encodeQr(value, "M");
  } catch {
    return null;
  }
  const n = modules.length + QUIET * 2;
  const canvas = document.createElement("canvas");
  canvas.width = n * scale;
  canvas.height = n * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) ctx.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale);
  }));
  return canvas.toDataURL("image/png");
}
