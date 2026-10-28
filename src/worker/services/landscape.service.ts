import {
  CRS_OF, LANDSCAPE_BACKGROUNDS, LANDSCAPE_LIMITS, emptyLandscape, validateLandscapeDocument,
  type LandscapeBackgroundKind, type LandscapeDocument, type LandscapeLayoutDto, type LandscapeLayoutSummaryDto,
  type LandscapeObject, type LandscapeOverviewDto, type LandscapeTemplateDto, type LandscapeVersionDto, type PublicLandscapeDto,
} from "../../shared/landscape-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "../http/errors.ts";
import type { LandscapeLayoutRow, LandscapeRepository } from "../repositories/landscape.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import { publicMediaUrl } from "./media-url.ts";
import type { SecurityLogService } from "./security-log.service.ts";

/**
 * Landscape — the property's site plan (phase L1, migration 0039).
 *
 * OFF until a SUPER_ADMIN (landscape.toggle) switches it on. Off: the booking page shows no plan and the editor
 * refuses changes (what was drawn is kept). Drafts are saved with optimistic concurrency (the revision the editor
 * started from); publishing freezes the draft as a numbered version — never changed, never deleted — and rollback
 * publishes an older version again as a new one. Nothing here reads or writes a booking: the plan links to units,
 * and the booking page asks the booking API for their availability and price.
 */
export class LandscapeService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: LandscapeRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly mediaBaseUrl: string | undefined,
  ) {}

  // ================================================================ admin

  async overview(actor: AuthContext, meta: RequestMeta): Promise<LandscapeOverviewDto> {
    await this.authz.requirePermission(actor, "landscape.view", meta);
    const settings = await this.settingsOrThrow();
    const [layouts, units, campingEnabled] = await Promise.all([this.repo.layouts(), this.repo.units(), this.repo.campingEnabled()]);
    return {
      enabled: settings.enabled === 1,
      canToggle: this.authz.can(actor, "landscape.toggle"),
      canEdit: this.authz.can(actor, "landscape.edit"),
      canPublish: this.authz.can(actor, "landscape.publish"),
      publicLayoutId: settings.public_layout_id,
      layouts: layouts.map((l) => this.summary(l, settings.public_layout_id)),
      units: units.map((u) => ({ id: u.id, code: u.unit_code, type: u.unit_type, name: u.name, status: u.status })),
      campingEnabled,
      updatedAt: settings.updated_at,
    };
  }

  /** SUPER_ADMIN (landscape.toggle). */
  async setEnabled(actor: AuthContext, enabled: boolean, meta: RequestMeta): Promise<LandscapeOverviewDto> {
    await this.authz.requirePermission(actor, "landscape.toggle", meta);
    await this.switchEnabled(enabled, actor.userId, [], meta);
    return this.overview(actor, meta);
  }

  /** The switch, from the site's SUPER_ADMIN or from Center (audited as the Center user, with its reason). */
  async switchEnabled(enabled: boolean, userId: string | null, extraStatements: D1PreparedStatementLike[], meta: RequestMeta, audit: Record<string, unknown> = {}): Promise<void> {
    const before = await this.settingsOrThrow();
    const now = iso(this.clock());
    await this.db.batch([
      ...extraStatements,
      this.repo.setEnabledStatement(enabled, userId, now),
      this.log.auditStatement(userId, enabled ? "LANDSCAPE_ON" : "LANDSCAPE_OFF", "landscape", "settings",
        { enabled: before.enabled === 1 }, { enabled, ...audit }, meta),
    ]);
  }

  /** For Center: on / off, how many plans, which one the booking page shows. null before migration 0039. */
  async centerStatus(): Promise<{ enabled: boolean; layouts: number; publicLayout: string | null; publicVersion: number | null } | null> {
    const settings = await this.repo.settings();
    if (!settings) return null;
    const layouts = await this.repo.layouts();
    const pub = layouts.find((l) => l.id === settings.public_layout_id) ?? null;
    return { enabled: settings.enabled === 1, layouts: layouts.length, publicLayout: pub?.name ?? null, publicVersion: pub?.published_version_no ?? null };
  }

  async create(actor: AuthContext, input: { name: string; backgroundKind: LandscapeBackgroundKind }, meta: RequestMeta): Promise<LandscapeLayoutDto> {
    await this.requireEditable(actor, "landscape.edit", meta);
    if (!(LANDSCAPE_BACKGROUNDS as readonly string[]).includes(input.backgroundKind)) throw new ValidationError({ backgroundKind: "INVALID_VALUE" });
    const id = newId();
    const now = iso(this.clock());
    const doc = emptyLandscape(input.backgroundKind);
    await this.db.batch([
      this.repo.insertLayoutStatement({ id, name: input.name, kind: input.backgroundKind, json: JSON.stringify(doc), userId: actor.userId, now }),
      this.log.auditStatement(actor.userId, "LANDSCAPE_CREATE", "landscape_layouts", id, null, { name: input.name, background: input.backgroundKind }, meta),
    ]);
    return this.layout(actor, id, meta);
  }

  async layout(actor: AuthContext, id: string, meta: RequestMeta): Promise<LandscapeLayoutDto> {
    await this.authz.requirePermission(actor, "landscape.view", meta);
    const settings = await this.settingsOrThrow();
    const row = await this.layoutOr404(id);
    const draft = JSON.parse(row.draft_json) as LandscapeDocument;
    return { ...this.summary(row, settings.public_layout_id), draft, ...(await this.backgroundImage(draft)) };
  }

  /**
   * Saves the editor's draft on top of `baseRevision`. Someone else saved in between → 409 DRAFT_CONFLICT with who
   * and the current revision, and nothing is overwritten (the editor keeps its copy so nothing is lost).
   */
  async saveDraft(actor: AuthContext, id: string, input: { baseRevision: number; name?: string; document: unknown }, meta: RequestMeta): Promise<LandscapeLayoutDto> {
    await this.requireEditable(actor, "landscape.edit", meta);
    const row = await this.layoutOr404(id);
    const errors = validateLandscapeDocument(input.document, { backgroundKind: row.background_kind });
    if (Object.keys(errors).length) throw new ValidationError(prefix(errors, "document"));
    const doc = input.document as LandscapeDocument;
    await this.checkImages(doc);
    const json = JSON.stringify(doc);
    if (json.length > LANDSCAPE_LIMITS.json) throw new ValidationError({ document: "TOO_LARGE" });
    const name = input.name ?? row.name;
    const now = iso(this.clock());
    const results = await this.db.batch([
      this.repo.saveDraftStatement({ id, baseRevision: input.baseRevision, json, name, userId: actor.userId, now }),
    ]);
    if (!results[0]?.results.length) {
      const current = await this.layoutOr404(id);
      throw new HttpError(409, "DRAFT_CONFLICT", "Someone else saved this layout meanwhile", {
        revision: String(current.draft_revision), updatedBy: current.draft_updated_by_name ?? "", updatedAt: current.draft_updated_at,
      });
    }
    return this.layout(actor, id, meta);
  }

  /** Checks the draft at `revision` for booking links, freezes it as the next version, and points the layout at it. */
  async publish(actor: AuthContext, id: string, input: { revision: number; note: string | null; makePublic: boolean }, meta: RequestMeta): Promise<LandscapeLayoutDto> {
    await this.requireEditable(actor, "landscape.publish", meta);
    const row = await this.layoutOr404(id);
    if (row.draft_revision !== input.revision) {
      throw new HttpError(409, "DRAFT_CONFLICT", "The draft changed since you looked at it", {
        revision: String(row.draft_revision), updatedBy: row.draft_updated_by_name ?? "", updatedAt: row.draft_updated_at,
      });
    }
    const doc = JSON.parse(row.draft_json) as LandscapeDocument;
    await this.checkLinks(doc, row.background_kind);
    const versionId = newId();
    const now = iso(this.clock());
    const results = await this.db.batch([
      ...this.repo.publishStatements({ versionId, layoutId: id, revision: input.revision, json: row.draft_json, note: input.note, restoredFrom: null, userId: actor.userId, now }),
      ...(input.makePublic ? [this.repo.setPublicStatement(id, actor.userId, now, versionId)] : []),
      this.log.auditStatement(actor.userId, "LANDSCAPE_PUBLISH", "landscape_layouts", id, null,
        { versionId, revision: input.revision, objects: doc.objects.length, note: input.note, makePublic: input.makePublic }, meta),
    ]);
    if (!results[0]?.results.length) throw new HttpError(409, "DRAFT_CONFLICT", "The draft changed since you looked at it", { revision: "" });
    return this.layout(actor, id, meta);
  }

  async versions(actor: AuthContext, id: string, meta: RequestMeta): Promise<LandscapeVersionDto[]> {
    await this.authz.requirePermission(actor, "landscape.view", meta);
    await this.layoutOr404(id);
    return (await this.repo.versions(id)).map((v) => ({
      id: v.id, versionNo: v.version_no, note: v.note, restoredFromNo: v.restored_from_no, publishedAt: v.published_at,
      publishedBy: v.published_by_name, objects: (JSON.parse(v.document_json) as LandscapeDocument).objects.length,
    }));
  }

  /** Rollback: an older version is published again, as a new version (history stays complete). */
  async republish(actor: AuthContext, id: string, versionId: string, meta: RequestMeta): Promise<LandscapeLayoutDto> {
    await this.requireEditable(actor, "landscape.publish", meta);
    await this.layoutOr404(id);
    const old = await this.repo.version(versionId);
    if (!old || old.layout_id !== id) throw new NotFoundError("Version not found", "LANDSCAPE_VERSION_NOT_FOUND");
    const row = await this.layoutOr404(id);
    // Units may have been removed since: the links are checked again.
    await this.checkLinks(JSON.parse(old.document_json) as LandscapeDocument, row.background_kind);
    const newVersion = newId();
    const now = iso(this.clock());
    await this.db.batch([
      ...this.repo.publishStatements({ versionId: newVersion, layoutId: id, revision: null, json: old.document_json, note: null, restoredFrom: versionId, userId: actor.userId, now }),
      this.log.auditStatement(actor.userId, "LANDSCAPE_ROLLBACK", "landscape_layouts", id, null, { versionId: newVersion, restoredFrom: versionId, versionNo: old.version_no }, meta),
    ]);
    return this.layout(actor, id, meta);
  }

  /** An older version back into the draft (to edit from there); saved like any draft, so nobody's work is overwritten. */
  async restoreToDraft(actor: AuthContext, id: string, versionId: string, baseRevision: number, meta: RequestMeta): Promise<LandscapeLayoutDto> {
    const old = await this.repo.version(versionId);
    if (!old || old.layout_id !== id) throw new NotFoundError("Version not found", "LANDSCAPE_VERSION_NOT_FOUND");
    return this.saveDraft(actor, id, { baseRevision, document: JSON.parse(old.document_json) }, meta);
  }

  /** The layout the booking page shows (or none). */
  async setPublic(actor: AuthContext, layoutId: string | null, meta: RequestMeta): Promise<LandscapeOverviewDto> {
    await this.requireEditable(actor, "landscape.publish", meta);
    const now = iso(this.clock());
    const results = await this.db.batch([
      this.repo.setPublicStatement(layoutId, actor.userId, now),
      this.log.auditStatement(actor.userId, "LANDSCAPE_SET_PUBLIC", "landscape", "settings", null, { layoutId }, meta),
    ]);
    if (!results[0]?.results.length) throw new ConflictError("Publish this layout first", "LANDSCAPE_NOT_PUBLISHED");
    return this.overview(actor, meta);
  }

  async archive(actor: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.requireEditable(actor, "landscape.publish", meta);
    const row = await this.layoutOr404(id);
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.archiveStatement(id),
      this.repo.clearPublicIfStatement(id, now),
      this.log.auditStatement(actor.userId, "LANDSCAPE_ARCHIVE", "landscape_layouts", id, { name: row.name }, null, meta),
    ]);
  }

  // ---------------------------------------------------------------- templates

  async templates(actor: AuthContext, meta: RequestMeta): Promise<LandscapeTemplateDto[]> {
    await this.authz.requirePermission(actor, "landscape.view", meta);
    const rows = (await this.repo.templates()).map((t) => ({ id: t.id, name: t.name, object: JSON.parse(t.object_json) as LandscapeTemplateDto["object"] }));
    const urls = await this.imageUrls(rows.map((r) => r.object.imageAssetId));
    return rows.map((r) => ({ ...r, imageUrl: r.object.imageAssetId ? urls[r.object.imageAssetId] ?? null : null }));
  }

  /** Keeps an object (shape, style, picture — not its place in a plan or its booking link) for reuse. */
  async addTemplate(actor: AuthContext, name: string, object: unknown, meta: RequestMeta): Promise<LandscapeTemplateDto> {
    await this.requireEditable(actor, "landscape.edit", meta);
    // Checked as a one-object BLANK document: the same rules as any drawing.
    const probe = { ...emptyLandscape("BLANK"), objects: [{ ...(object as object), id: "t", layerId: "ground", groupId: null, link: null }] };
    const errors = validateLandscapeDocument(probe, { backgroundKind: "BLANK" });
    if (Object.keys(errors).length) throw new ValidationError(prefix(errors, "object"));
    const o = probe.objects[0] as LandscapeObject;
    await this.checkImages({ ...probe, objects: [o] } as LandscapeDocument);
    const stored = { kind: o.kind, shape: o.shape, rotation: o.rotation, style: o.style, label: o.label, locked: false, imageAssetId: o.imageAssetId };
    const id = newId();
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.insertTemplateStatement({ id, name, json: JSON.stringify(stored), userId: actor.userId, now }),
      this.log.auditStatement(actor.userId, "LANDSCAPE_TEMPLATE_ADD", "landscape_templates", id, null, { name }, meta),
    ]);
    return { id, name, object: stored, imageUrl: o.imageAssetId ? (await this.imageUrls([o.imageAssetId]))[o.imageAssetId] ?? null : null };
  }

  async deleteTemplate(actor: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.requireEditable(actor, "landscape.edit", meta);
    const results = await this.db.batch([
      this.repo.deleteTemplateStatement(id),
      this.log.auditStatement(actor.userId, "LANDSCAPE_TEMPLATE_DELETE", "landscape_templates", id, null, null, meta),
    ]);
    if (!results[0]?.results.length) throw new NotFoundError("Template not found", "LANDSCAPE_TEMPLATE_NOT_FOUND");
  }

  // ================================================================ public (booking page)

  /** The published plan, without hidden layers; `enabled: false` (and no layout) while the feature is off. */
  async publicLayout(): Promise<PublicLandscapeDto> {
    const settings = await this.repo.settings();
    if (!settings || settings.enabled !== 1 || !settings.public_layout_id) return { enabled: settings?.enabled === 1, layout: null };
    const row = await this.repo.layout(settings.public_layout_id);
    if (!row?.published_json || row.published_version_no === null) return { enabled: true, layout: null };
    const doc = JSON.parse(row.published_json) as LandscapeDocument;
    const visible = new Set(doc.layers.filter((l) => l.visible).map((l) => l.id));
    const document: LandscapeDocument = {
      ...doc,
      layers: doc.layers.filter((l) => visible.has(l.id)).map((l) => ({ ...l, locked: true })),
      objects: doc.objects.filter((o) => visible.has(o.layerId)),
    };
    return { enabled: true, layout: { name: row.name, versionNo: row.published_version_no, document, ...(await this.backgroundImage(document)) } };
  }

  // ================================================================ helpers

  private async settingsOrThrow() {
    const settings = await this.repo.settings();
    if (!settings) throw new ConflictError("Run the database migrations first", "SCHEMA_OUTDATED");
    return settings;
  }

  /** Changes need the permission and the feature switched on. */
  private async requireEditable(actor: AuthContext, permission: "landscape.edit" | "landscape.publish", meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, permission, meta);
    if ((await this.settingsOrThrow()).enabled !== 1) throw new ConflictError("The landscape feature is switched off", "LANDSCAPE_OFF");
  }

  private async layoutOr404(id: string): Promise<LandscapeLayoutRow> {
    const row = await this.repo.layout(id);
    if (!row) throw new NotFoundError("Layout not found", "LANDSCAPE_NOT_FOUND");
    return row;
  }

  private summary(l: LandscapeLayoutRow, publicId: string | null): LandscapeLayoutSummaryDto {
    return {
      id: l.id, name: l.name, backgroundKind: l.background_kind, draftRevision: l.draft_revision, draftUpdatedAt: l.draft_updated_at,
      draftUpdatedBy: l.draft_updated_by_name, publishedVersionNo: l.published_version_no, publishedAt: l.published_at,
      unpublishedChanges: l.published_json !== l.draft_json, isPublic: publicId === l.id,
    };
  }

  /** Every picture the document uses must be an active public image of this site. */
  private async checkImages(doc: LandscapeDocument): Promise<void> {
    const ids = new Set<string>();
    if (doc.background.kind === "PHOTO" && doc.background.assetId) ids.add(doc.background.assetId);
    for (const o of doc.objects) if (o.imageAssetId) ids.add(o.imageAssetId);
    if (ids.size > 50) throw new ValidationError({ document: "TOO_MANY_IMAGES" });
    for (const id of ids) {
      if (!(await this.repo.publicImage(id))) throw new ValidationError({ [doc.background.kind === "PHOTO" && doc.background.assetId === id ? "document.background.assetId" : "document.objects"]: "INVALID_IMAGE" });
    }
  }

  private async checkLinks(doc: LandscapeDocument, kind: LandscapeBackgroundKind): Promise<void> {
    const [units, campingEnabled] = await Promise.all([this.repo.units(), this.repo.campingEnabled()]);
    const errors = validateLandscapeDocument(doc, {
      backgroundKind: kind, publish: true, campingEnabled,
      units: units.map((u) => ({ id: u.id, type: u.unit_type, status: u.status })),
    });
    if (Object.keys(errors).length) throw new ValidationError(prefix(errors, "document"));
    if (doc.crs !== CRS_OF[kind]) throw new ValidationError({ "document.crs": "MUST_MATCH_BACKGROUND" });
  }

  private async backgroundImage(doc: LandscapeDocument): Promise<{
    backgroundUrl: string | null; backgroundSize: { width: number; height: number } | null; imageUrls: Record<string, string>;
  }> {
    const imageUrls = await this.imageUrls(doc.objects.map((o) => o.imageAssetId));
    if (doc.background.kind !== "PHOTO" || !doc.background.assetId) return { backgroundUrl: null, backgroundSize: null, imageUrls };
    const image = await this.repo.publicImage(doc.background.assetId);
    if (!image) return { backgroundUrl: null, backgroundSize: null, imageUrls };
    return {
      backgroundUrl: publicMediaUrl(image.object_key, this.mediaBaseUrl),
      backgroundSize: image.width && image.height ? { width: image.width, height: image.height } : null,
      imageUrls,
    };
  }

  private async imageUrls(ids: (string | null)[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const id of new Set(ids.filter((x): x is string => !!x))) {
      const image = await this.repo.publicImage(id);
      const url = image ? publicMediaUrl(image.object_key, this.mediaBaseUrl) : null;
      if (url) out[id] = url;
    }
    return out;
  }

}

function prefix(errors: Record<string, string>, p: string): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).slice(0, 50).map(([k, v]) => [k === "document" ? p : `${p}.${k}`, v]));
}
