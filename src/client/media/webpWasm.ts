/**
 * WebP encoder in WebAssembly (libwebp, via @jsquash/webp) for browsers whose canvas cannot write WebP — Safari,
 * so every iPad and iPhone. Loaded only when needed (its own file, about 300 kB), and only in the back office: the
 * admin pages' policy allows WebAssembly, the public pages' does not.
 */
import encode from "@jsquash/webp/encode";

/** `quality` 0–1 as for a canvas. */
export async function encodeWebp(image: ImageData, quality: number): Promise<ArrayBuffer> {
  return encode(image, { quality: Math.round(quality * 100) });
}
