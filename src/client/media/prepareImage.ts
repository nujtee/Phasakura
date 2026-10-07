import { IMAGE_PROFILES, type ImageProfilePurpose } from "../../shared/media-types.ts";
import { apiUpload } from "../api/client.ts";

/**
 * Browser-side image preparation (Phase 12 "Compression" + "Responsive Images").
 *
 * The Worker cannot run image codecs without a paid image service, so the admin's browser does
 * it before uploading: the photo is decoded (orientation applied), scaled to the purpose's
 * maximum width and re-encoded as WebP (JPEG where the browser cannot encode WebP). Re-encoding
 * also drops camera metadata such as GPS location. Smaller renditions for `srcset` are made from
 * the same decoded picture. The server re-checks every file from its bytes.
 * Anything that fails here falls back to uploading the original unchanged.
 */

export interface PreparedImage {
  file: File;
  variants: File[];
  /** false = original uploaded unchanged (logo, QR code, or the browser could not decode it). */
  processed: boolean;
}

let webpSupport: Promise<boolean> | null = null;

function canvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function toBlob(c: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  if ("convertToBlob" in c) return c.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => (c as HTMLCanvasElement).toBlob(resolve, type, quality));
}

/** Can this browser encode WebP? (Some only decode it and silently return PNG.) */
export function canEncodeWebp(): Promise<boolean> {
  webpSupport ??= (async () => {
    const c = canvas(2, 2);
    // An OffscreenCanvas without a rendering context cannot be exported at all.
    const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return false;
    ctx.fillRect(0, 0, 2, 2);
    const blob = await toBlob(c, "image/webp", 0.8);
    return blob?.type === "image/webp";
  })().catch(() => false);
  return webpSupport;
}

async function encode(bitmap: ImageBitmap, width: number, height: number, type: string, quality: number): Promise<Blob | null> {
  const c = canvas(width, height);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  if (type === "image/jpeg") {
    // JPEG has no transparency: paint white instead of black behind transparent pixels.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await toBlob(c, type, quality);
  return blob && blob.type === type ? blob : null;
}

function baseName(name: string): string {
  const stem = name.replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "-").slice(0, 60);
  return stem || "image";
}

export async function prepareImage(file: File, purpose: ImageProfilePurpose): Promise<PreparedImage> {
  const profile = IMAGE_PROFILES[purpose];
  const unchanged: PreparedImage = { file, variants: [], processed: false };
  if (!profile?.compress || typeof createImageBitmap !== "function") return unchanged;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return unchanged;
  }
  try {
    const scale = Math.min(1, profile.maxWidth / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const type = profile.format === "image/webp" && (await canEncodeWebp()) ? "image/webp" : "image/jpeg";
    const ext = type === "image/webp" ? "webp" : "jpg";
    const main = await encode(bitmap, width, height, type, profile.quality);
    if (!main) return unchanged;
    const name = baseName(file.name);
    const variants: File[] = [];
    for (const w of profile.widths) {
      if (w >= width) continue;
      const blob = await encode(bitmap, w, Math.max(1, Math.round((height * w) / width)), type, profile.quality);
      if (blob) variants.push(new File([blob], `${name}-${w}.${ext}`, { type }));
    }
    return { file: new File([main], `${name}.${ext}`, { type }), variants, processed: true };
  } catch {
    return unchanged;
  } finally {
    bitmap.close();
  }
}

export interface UploadedImage {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  mimeType: string;
  variants: { url: string; width: number }[];
}

/** Prepares (compresses + renditions) and uploads one image for a purpose. */
export async function uploadImage(file: File, purpose: ImageProfilePurpose): Promise<UploadedImage> {
  const prepared = await prepareImage(file, purpose);
  const form = new FormData();
  form.set("file", prepared.file);
  form.set("purpose", purpose);
  for (const v of prepared.variants) form.append("variant", v);
  return apiUpload<UploadedImage>("/api/admin/media", form);
}
