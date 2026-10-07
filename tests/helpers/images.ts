/** Minimal valid image headers for tests (the sniffer only reads headers). */

function be32(n: number) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

export function pngBytes(width = 800, height = 600): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...new Array(64).fill(0),
  ]);
}

export function jpegBytes(width = 1024, height = 768): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0, // APP0
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3,
    ...new Array(9).fill(0), 0xff, 0xd9,
  ]);
}

export function webpBytes(width = 640, height = 480): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 30, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, // RIFF....WEBP
    0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, // VP8X, size, flags, reserved
    w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255,
    ...new Array(16).fill(0),
  ]);
}

export const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
export const htmlBytes = new TextEncoder().encode("<!doctype html><script>alert(document.cookie)</script>");
