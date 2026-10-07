import { FONT_FALLBACKS, FONT_STYLES, FONT_WEIGHTS, type CustomFontDto } from "../../shared/media-types.ts";
import { CUSTOM_FONT_FAMILY, customFontToken, type FontStackKey } from "../../shared/theme.ts";
import type { D1DatabaseLike } from "../env.ts";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors.ts";
import type { CustomFontRow, FontRepository } from "../repositories/font.repository.ts";
import type { MediaRepository } from "../repositories/media.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { MediaService } from "./media.service.ts";
import { publicMediaUrl } from "./media-url.ts";
import type { SecurityLogService } from "./security-log.service.ts";

/**
 * Uploaded web fonts (spec §37 "Fonts", §54): WOFF2 / WOFF files in R2, one row per face.
 * Managed with `settings.theme`; the theme picks a family by name (closed format, no CSS).
 * The admin is responsible for having a licence that allows web embedding.
 */
export class FontService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: FontRepository,
    private readonly media: MediaService,
    private readonly mediaRepo: MediaRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly mediaBaseUrl: string | undefined,
  ) {}

  private dto(f: CustomFontRow): CustomFontDto {
    return {
      id: f.id, family: f.family, weight: f.weight, style: f.style, fallback: f.fallback,
      url: publicMediaUrl(f.object_key, this.mediaBaseUrl) ?? "", format: f.mime_type === "font/woff" ? "woff" : "woff2",
      sizeBytes: f.size_bytes, token: customFontToken(f.family, f.fallback as FontStackKey), createdAt: f.created_at,
    };
  }

  async list(actor: AuthContext, meta: RequestMeta): Promise<CustomFontDto[]> {
    await this.authz.requirePermission(actor, "settings.theme", meta);
    return (await this.repo.list()).map((f) => this.dto(f));
  }

  /** Families a theme may use (server-side theme validation). */
  families(): Promise<string[]> {
    return this.repo.families();
  }

  async upload(actor: AuthContext, form: FormData, meta: RequestMeta): Promise<CustomFontDto> {
    await this.authz.requirePermission(actor, "settings.theme", meta);
    const unknown = [...form.keys()].filter((k) => !["file", "family", "weight", "style", "fallback"].includes(k));
    if (unknown.length) throw new ValidationError(Object.fromEntries(unknown.map((k) => [k, "UNKNOWN_FIELD"])));
    const errors: Record<string, string> = {};
    const file = form.get("file");
    const family = String(form.get("family") ?? "").trim().replace(/\s+/g, " ");
    const weight = Number(form.get("weight") ?? 400);
    const style = String(form.get("style") ?? "normal");
    const fallback = String(form.get("fallback") ?? "SANS");
    if (!(file instanceof File)) errors.file = "REQUIRED";
    if (!CUSTOM_FONT_FAMILY.test(family)) errors.family = family ? "INVALID_FORMAT" : "REQUIRED";
    if (!(FONT_WEIGHTS as readonly number[]).includes(weight)) errors.weight = "INVALID_VALUE";
    if (!(FONT_STYLES as readonly string[]).includes(style)) errors.style = "INVALID_VALUE";
    if (!(FONT_FALLBACKS as readonly string[]).includes(fallback)) errors.fallback = "INVALID_VALUE";
    if (Object.keys(errors).length) throw new ValidationError(errors);
    if ((await this.repo.list()).some((f) => f.family === family && f.weight === weight && f.style === style)) {
      throw new ConflictError("This family already has a file for that weight and style", "FONT_FACE_EXISTS");
    }

    const stored = await this.media.storeFont(actor.userId, file as File, meta);
    const id = newId();
    const now = iso(this.clock());
    try {
      await this.db.batch([
        ...stored.statements,
        this.repo.insertStatement({ id, family, weight, style, fallback, assetId: stored.id, actorId: actor.userId, now }),
        this.log.auditStatement(actor.userId, "UPLOAD_FONT", "theme", id, null, { family, weight, style, fallback, key: stored.key, size: stored.size }, meta),
      ]);
    } catch (error) {
      await this.media.deleteObjects([{ bucket: "PUBLIC", object_key: stored.key }]);
      if (/UNIQUE constraint failed: custom_fonts/.test(String(error))) throw new ConflictError("This family already has a file for that weight and style", "FONT_FACE_EXISTS");
      throw error;
    }
    return this.dto((await this.repo.list()).find((f) => f.id === id)!);
  }

  /** Refused while a draft or the published theme still uses the family and this is its last file. */
  async remove(actor: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, "settings.theme", meta);
    const fonts = await this.repo.list();
    const font = fonts.find((f) => f.id === id);
    if (!font) throw new NotFoundError("Font not found", "FONT_NOT_FOUND");
    const lastOfFamily = fonts.filter((f) => f.family === font.family).length === 1;
    if (lastOfFamily && (await this.repo.themesUsing(font.family)) > 0) {
      throw new ConflictError("The theme still uses this font", "FONT_IN_USE");
    }
    const objects = await this.mediaRepo.objectKeys(font.media_asset_id);
    await this.db.batch([
      this.repo.deleteStatement(id),
      this.mediaRepo.markDeletedStatement(font.media_asset_id, iso(this.clock())),
      this.log.auditStatement(actor.userId, "DELETE_FONT", "theme", id, { family: font.family, weight: font.weight, style: font.style }, null, meta),
    ]);
    await this.media.deleteObjects(objects);
  }
}
