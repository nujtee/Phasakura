import type { PermissionCode } from "../../shared/auth-types.ts";
import type { D1DatabaseLike, R2BucketLike } from "../env.ts";
import { HttpError, ValidationError } from "../http/errors.ts";
import { sniffImage } from "../media/image-sniff.ts";
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

  async upload(actor: AuthContext, file: File, purpose: MediaPurpose, meta: RequestMeta): Promise<MediaAssetDto> {
    const permission = UPLOAD_PERMISSIONS[purpose];
    if (!permission) throw new ValidationError({ purpose: "INVALID_VALUE" });
    await this.authz.requirePermission(actor, permission, meta);

    if (file.size <= 0) throw new ValidationError({ file: "REQUIRED" });
    if (file.size > MAX_IMAGE_BYTES) throw new HttpError(413, "FILE_TOO_LARGE", "Image must be 10 MB or smaller");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = sniffImage(bytes);
    if (!image) {
      await this.log.event("UPLOAD_REJECTED", "WARNING", meta, {
        userId: actor.userId, details: { reason: "not_an_allowed_image", declaredType: file.type.slice(0, 100), size: file.size },
      });
      throw new ValidationError({ file: "UNSUPPORTED_IMAGE" }, "Only JPEG, PNG, WebP or AVIF images are allowed");
    }
    if (image.width > MAX_DIMENSION || image.height > MAX_DIMENSION || image.width * image.height > MAX_PIXELS) {
      throw new ValidationError({ file: "IMAGE_TOO_LARGE_DIMENSIONS" });
    }

    const now = this.clock();
    const id = newId();
    // Server-generated key: the client's file name never reaches storage (no traversal, no overwrite).
    const key = `${FOLDER[purpose]}/${iso(now).slice(0, 4)}/${iso(now).slice(5, 7)}/${id}.${image.extension}`;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: image.mime, cacheControl: "public, max-age=31536000, immutable" },
    });
    try {
      await this.db.batch([
        this.repo.insertStatement({
          id, bucket: "PUBLIC", key, purpose, mime: image.mime, size: bytes.length,
          width: image.width, height: image.height, sha256, uploadedBy: actor.userId, now: iso(now),
        }),
        this.log.auditStatement(actor.userId, "UPLOAD", "media", id, null,
          { purpose, key, mime: image.mime, size: bytes.length, width: image.width, height: image.height }, meta),
      ]);
    } catch (error) {
      await this.bucket.delete(key).catch(() => undefined); // compensate: no orphan objects
      throw error;
    }
    return { id, url: this.url(key), mimeType: image.mime, sizeBytes: bytes.length, width: image.width, height: image.height, purpose };
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

  /** Streams a public asset. Unknown / deleted / private keys → null (404). */
  async serve(key: string, ifNoneMatch: string | null): Promise<Response | null> {
    const asset = await this.repo.findPublicByKey(key);
    if (!asset) return null;
    const etag = `"${asset.sha256}"`;
    const headers = new Headers({
      "Content-Type": asset.mime_type,
      "Cache-Control": "public, max-age=31536000, immutable",
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
