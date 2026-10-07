import type { PermissionCode } from "../../shared/auth-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike, R2BucketLike } from "../env.ts";
import { HttpError, ValidationError } from "../http/errors.ts";
import { sniffFont, sniffImage, type SniffedImage } from "../media/image-sniff.ts";
import { IMAGE_PROFILES, MAX_FONT_BYTES, MAX_VARIANTS, type ImageProfile } from "../../shared/media-types.ts";
import type { MediaPurpose, MediaRepository, MediaTranslationRow } from "../repositories/media.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import { publicMediaUrl } from "./media-url.ts";
import type { SecurityLogService } from "./security-log.service.ts";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 10_000;
const MAX_PIXELS = 50_000_000; // guards later processing against decompression bombs

/**
 * Public image purposes and the permission needed to upload for each.
 * Payment slips are private and are uploaded through the payment flow (Phase 8), never here.
 */
export const UPLOAD_PERMISSIONS: Partial<Record<MediaPurpose, PermissionCode>> = {
  ACCOMMODATION: "accommodation.edit",
  FOOD: "food.edit",
  GALLERY: "content.gallery",
  HOME_SLIDE: "content.home",
  HOME_SECTION: "content.home",
  HISTORY: "content.history",
  LOGO: "settings.branding",
  FAVICON: "settings.branding",
  OG_IMAGE: "seo.edit",
  PAYMENT_QR: "receiving_accounts.edit",
};

const FOLDER: Partial<Record<MediaPurpose, string>> = {
  ACCOMMODATION: "accommodation", FOOD: "food", GALLERY: "gallery", HOME_SLIDE: "home/slides",
  HOME_SECTION: "home/sections", HISTORY: "history", LOGO: "branding", FAVICON: "branding",
  OG_IMAGE: "seo", PAYMENT_QR: "payment-qr",
};

export interface MediaAssetDto {
  id: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  purpose: MediaPurpose;
  /** Responsive renditions stored with it (Phase 12). */
  variants: { url: string; width: number; height: number; sizeBytes: number; mimeType: string }[];
}

/** Total bytes of one upload (original + renditions). */
export const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES + MAX_VARIANTS * 4 * 1024 * 1024;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Same picture, just smaller: width below the original, aspect ratio within 1 %/2 px. */
function isRenditionOf(v: SniffedImage, main: SniffedImage): boolean {
  if (v.width >= main.width || v.height >= main.height) return false;
  const expectedHeight = (v.width * main.height) / main.width;
  return Math.abs(v.height - expectedHeight) <= Math.max(2, expectedHeight * 0.01);
}

export type { MediaTextDto } from "../../shared/accommodation-types.ts";
import type { MediaTextDto } from "../../shared/accommodation-types.ts";

export class MediaService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: MediaRepository,
    private readonly bucket: R2BucketLike,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly mediaBaseUrl: string | undefined,
    private readonly clock: Clock,
  ) {}

  url(key: string): string {
    return publicMediaUrl(key, this.mediaBaseUrl) ?? "";
  }

  /**
   * Public image upload. `variants` are smaller renditions made by the admin's browser
   * (Phase 12): each is checked from its bytes like the original and must be the same
   * picture at a smaller width. Everything is stored in one batch, or nothing is.
   */
  async upload(actor: AuthContext, file: File, purpose: MediaPurpose, meta: RequestMeta, variants: File[] = []): Promise<MediaAssetDto> {
    const permission = UPLOAD_PERMISSIONS[purpose];
    if (!permission) throw new ValidationError({ purpose: "INVALID_VALUE" });
    await this.authz.requirePermission(actor, permission, meta);
    if (variants.length > MAX_VARIANTS) throw new ValidationError({ variant: "TOO_MANY" });
    // Renditions only where the public site uses srcset (not for logos, favicons, QR codes, social cards).
    const profile = (IMAGE_PROFILES as Partial<Record<string, ImageProfile>>)[purpose];
    if (variants.length && !profile?.widths.length) throw new ValidationError({ variant: "NOT_ALLOWED" });

    const read = async (f: File, field: string) => {
      if (f.size <= 0) throw new ValidationError({ [field]: "REQUIRED" });
      if (f.size > MAX_IMAGE_BYTES) throw new HttpError(413, "FILE_TOO_LARGE", "Image must be 10 MB or smaller");
      const bytes = new Uint8Array(await f.arrayBuffer());
      const image = sniffImage(bytes);
      if (!image) {
        await this.log.event("UPLOAD_REJECTED", "WARNING", meta, {
          userId: actor.userId, details: { reason: "not_an_allowed_image", field, declaredType: f.type.slice(0, 100), size: f.size },
        });
        throw new ValidationError({ [field]: "UNSUPPORTED_IMAGE" }, "Only JPEG, PNG, WebP or AVIF images are allowed");
      }
      if (image.width > MAX_DIMENSION || image.height > MAX_DIMENSION || image.width * image.height > MAX_PIXELS) {
        throw new ValidationError({ [field]: "IMAGE_TOO_LARGE_DIMENSIONS" });
      }
      return { bytes, image };
    };

    const main = await read(file, "file");
    const extra: { bytes: Uint8Array; image: SniffedImage }[] = [];
    for (const v of variants) {
      const r = await read(v, "variant");
      if (!isRenditionOf(r.image, main.image)) throw new ValidationError({ variant: "NOT_A_RENDITION" });
      if (extra.some((x) => x.image.width === r.image.width)) throw new ValidationError({ variant: "DUPLICATE_WIDTH" });
      extra.push(r);
    }

    const now = this.clock();
    const at = iso(now);
    const id = newId();
    // Server-generated keys: the client's file names never reach storage (no traversal, no overwrite).
    const folder = `${FOLDER[purpose]}/${at.slice(0, 4)}/${at.slice(5, 7)}`;
    const items = [
      { id, key: `${folder}/${id}.${main.image.extension}`, ...main, parentId: null as string | null },
      ...extra.map((r) => ({ id: newId(), key: `${folder}/${id}-w${r.image.width}.${r.image.extension}`, ...r, parentId: id })),
    ];
    const stored: string[] = [];
    try {
      for (const it of items) {
        await this.bucket.put(it.key, it.bytes, { httpMetadata: { contentType: it.image.mime, cacheControl: "public, max-age=31536000, immutable" } });
        stored.push(it.key);
      }
      const statements = [];
      for (const it of items) {
        statements.push(this.repo.insertStatement({
          id: it.id, bucket: "PUBLIC", key: it.key, purpose, mime: it.image.mime, size: it.bytes.length, width: it.image.width,
          height: it.image.height, sha256: await sha256Hex(it.bytes), uploadedBy: actor.userId, now: at, parentId: it.parentId,
        }));
      }
      statements.push(this.log.auditStatement(actor.userId, "UPLOAD", "media", id, null, {
        purpose, key: items[0]!.key, mime: main.image.mime, size: main.bytes.length, width: main.image.width, height: main.image.height,
        variants: extra.map((r) => r.image.width),
      }, meta));
      await this.db.batch(statements);
    } catch (error) {
      for (const key of stored) await this.bucket.delete(key).catch(() => undefined); // compensate: no orphan objects
      throw error;
    }
    return {
      id, url: this.url(items[0]!.key), mimeType: main.image.mime, sizeBytes: main.bytes.length, width: main.image.width,
      height: main.image.height, purpose,
      variants: items.slice(1).map((it) => ({ url: this.url(it.key), width: it.image.width, height: it.image.height, sizeBytes: it.bytes.length, mimeType: it.image.mime })),
    };
  }

  /** Font file (WOFF2 / WOFF) for the theme — called by FontService, which owns the permission check. */
  async storeFont(actorId: string, file: File, meta: RequestMeta): Promise<{ id: string; key: string; mime: string; size: number; format: "woff2" | "woff"; statements: D1PreparedStatementLike[] }> {
    if (file.size <= 0) throw new ValidationError({ file: "REQUIRED" });
    if (file.size > MAX_FONT_BYTES) throw new HttpError(413, "FONT_TOO_LARGE", "Font must be 2 MB or smaller");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const font = sniffFont(bytes);
    if (!font) {
      await this.log.event("UPLOAD_REJECTED", "WARNING", meta, { userId: actorId, details: { reason: "not_a_web_font", size: file.size } });
      throw new ValidationError({ file: "UNSUPPORTED_FONT" }, "Only WOFF2 or WOFF fonts are allowed");
    }
    const at = iso(this.clock());
    const id = newId();
    const key = `fonts/${at.slice(0, 4)}/${at.slice(5, 7)}/${id}.${font.format}`;
    await this.bucket.put(key, bytes, { httpMetadata: { contentType: font.mime, cacheControl: "public, max-age=31536000, immutable" } });
    return {
      id, key, mime: font.mime, size: bytes.length, format: font.format,
      statements: [this.repo.insertStatement({
        id, bucket: "PUBLIC", key, purpose: "FONT", mime: font.mime, size: bytes.length, width: null, height: null,
        sha256: await sha256Hex(bytes), uploadedBy: actorId, now: at,
      })],
    };
  }

  /** Deletes the R2 objects of a retired asset and its renditions (after the D1 change committed). */
  async deleteObjects(keys: { bucket: string; object_key: string }[]): Promise<void> {
    for (const k of keys) if (k.bucket === "PUBLIC") await this.bucket.delete(k.object_key).catch(() => undefined);
  }

  async setTexts(
    actor: AuthContext,
    assetId: string,
    texts: Record<string, MediaTextDto>,
    meta: RequestMeta,
  ): Promise<Record<string, MediaTextDto>> {
    const asset = await this.repo.findById(assetId);
    if (!asset || asset.status !== "ACTIVE" || asset.bucket !== "PUBLIC") throw new HttpError(404, "MEDIA_NOT_FOUND", "Image not found");
    const permission = UPLOAD_PERMISSIONS[asset.purpose];
    if (!permission) throw new HttpError(404, "MEDIA_NOT_FOUND", "Image not found");
    await this.authz.requirePermission(actor, permission, meta);

    const before = groupTexts(await this.repo.translationsFor([assetId]))[assetId] ?? {};
    await this.db.batch([
      ...Object.entries(texts).map(([languageCode, t]) =>
        this.repo.upsertTranslationStatement({ mediaAssetId: assetId, languageCode, ...t })),
      this.log.auditStatement(actor.userId, "UPDATE_TEXT", "media", assetId, before, texts, meta),
    ]);
    return groupTexts(await this.repo.translationsFor([assetId]))[assetId] ?? {};
  }

  /**
   * Streams a public asset. Unknown / deleted / private keys → null (404).
   * An image whose content is not published (draft gallery photo, future slide, inactive house…)
   * is shown only to signed-in staff (admin previews), never cached by shared caches.
   */
  async serve(key: string, ifNoneMatch: string | null, isStaff: () => Promise<boolean> = async () => false): Promise<Response | null> {
    const asset = await this.repo.findServable(key, iso(this.clock()));
    if (!asset) return null;
    const visible = asset.is_public === 1;
    if (!visible && !(await isStaff())) return null;
    const etag = `"${asset.sha256}"`;
    const headers = new Headers({
      "Content-Type": asset.mime_type,
      "Cache-Control": visible ? "public, max-age=31536000, immutable" : "private, no-store",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-site",
    });
    if (ifNoneMatch === etag) return new Response(null, { status: 304, headers });
    const object = await this.bucket.get(asset.object_key);
    if (!object) return null;
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }
}

export function groupTexts(rows: MediaTranslationRow[]): Record<string, Record<string, MediaTextDto>> {
  const out: Record<string, Record<string, MediaTextDto>> = {};
  for (const r of rows) {
    (out[r.media_asset_id] ??= {})[r.language_code] = { altText: r.alt_text, title: r.title, caption: r.caption };
  }
  return out;
}
