/**
 * Identifies an uploaded image from its BYTES (never from the file name or the
 * browser-declared Content-Type) and reads its dimensions from the header.
 * Only raster formats are accepted — SVG (scriptable), HTML, executables etc.
 * are rejected by construction.
 */

export type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/avif";

export interface SniffedImage {
  mime: ImageType;
  extension: "jpg" | "png" | "webp" | "avif";
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function png(b: Uint8Array): SniffedImage | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v) || ascii(b, 12, 4) !== "IHDR") return null;
  return { mime: "image/png", extension: "png", width: u32be(b, 16), height: u32be(b, 20) };
}

function jpeg(b: Uint8Array): SniffedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      o += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = u16be(b, o + 2);
    if (length < 2) return null;
    // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { mime: "image/jpeg", extension: "jpg", height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    o += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array): SniffedImage | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return { mime: "image/webp", extension: "webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { mime: "image/webp", extension: "webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { mime: "image/webp", extension: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function avif(b: Uint8Array): SniffedImage | null {
  if (b.length < 16 || ascii(b, 4, 4) !== "ftyp") return null;
  const boxSize = u32be(b, 0);
  const brands: string[] = [ascii(b, 8, 4)];
  for (let o = 16; o + 4 <= Math.min(boxSize, b.length); o += 4) brands.push(ascii(b, o, 4));
  if (!brands.some((x) => x === "avif" || x === "avis")) return null;
  // Image spatial extents ('ispe') box: size(4) 'ispe'(4) version/flags(4) width(4) height(4)
  const limit = Math.min(b.length - 16, 64 * 1024);
  for (let o = 0; o < limit; o++) {
    if (b[o] === 0x69 && ascii(b, o, 4) === "ispe") {
      return { mime: "image/avif", extension: "avif", width: u32be(b, o + 8), height: u32be(b, o + 12) };
    }
  }
  return null;
}

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const result = png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? avif(bytes);
  if (!result || result.width < 1 || result.height < 1) return null;
  return result;
}
