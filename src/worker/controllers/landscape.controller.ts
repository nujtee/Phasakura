import { LANDSCAPE_BACKGROUNDS, LANDSCAPE_LIMITS } from "../../shared/landscape-types.ts";
import { requestMeta, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const PALETTE_FIELDS = ["kind", "name", "draw", "fill", "stroke", "opacity", "layer", "size", "group", "sortOrder", "hidden"];

/** A draft is a whole plan: up to LANDSCAPE_LIMITS.json of JSON (+ the envelope). */
const DRAFT_BYTES = LANDSCAPE_LIMITS.json + 4096;

function id(ctx: RequestContext, key = "id"): string {
  const value = ctx.params[key] ?? "";
  if (!ID_PATTERN.test(value)) throw new ValidationError({ [key]: "INVALID_ID" });
  return value;
}

function revision(v: Validator, body: Record<string, unknown>, key: string): number {
  const n = body[key];
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) { v.errors[key] = "REQUIRED"; return 0; }
  return n;
}

/** Landscape (site plan, phase L1): Accommodation → Landscape, and the plan the booking page draws. */
export function landscapeController(services: ServicesFor) {
  return {
    overview: withPermission("landscape.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).landscape.overview(auth, requestMeta(ctx)))),

    /** `{ enabled: boolean }` — SUPER_ADMIN (landscape.toggle). */
    setEnabled: withPermission("landscape.toggle", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["enabled"]);
      if (typeof body.enabled !== "boolean") v.errors.enabled = "EXPECTED_BOOLEAN";
      v.assertValid();
      return jsonOk(await services(ctx).landscape.setEnabled(auth, body.enabled as boolean, requestMeta(ctx)));
    }),

    /** `{ layoutId: string | null }` — the layout the booking page shows. */
    setPublic: withPermission("landscape.publish", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["layoutId"]);
      if (body.layoutId !== null && (typeof body.layoutId !== "string" || !ID_PATTERN.test(body.layoutId))) v.errors.layoutId = "INVALID_ID";
      v.assertValid();
      return jsonOk(await services(ctx).landscape.setPublic(auth, body.layoutId as string | null, requestMeta(ctx)));
    }),

    /** `{ name, backgroundKind: BLANK | PHOTO | SATELLITE }` */
    create: withPermission("landscape.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["name", "backgroundKind"]);
      const name = v.string("name", { required: true, max: LANDSCAPE_LIMITS.name });
      const backgroundKind = v.oneOf("backgroundKind", LANDSCAPE_BACKGROUNDS, { required: true });
      v.assertValid();
      return jsonOk(await services(ctx).landscape.create(auth, { name: name.trim(), backgroundKind: backgroundKind! }, requestMeta(ctx)), { status: 201 });
    }),

    layout: withPermission("landscape.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).landscape.layout(auth, id(ctx), requestMeta(ctx)))),

    /** `{ baseRevision, name?, document }` — refused with 409 DRAFT_CONFLICT when someone saved after baseRevision. */
    saveDraft: withPermission("landscape.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request, DRAFT_BYTES);
      const v = new Validator(body).allowOnly(["baseRevision", "name", "document"]);
      const baseRevision = revision(v, body, "baseRevision");
      const name = v.has("name") ? v.string("name", { required: true, max: LANDSCAPE_LIMITS.name })?.trim() : undefined;
      if (body.document === undefined) v.errors.document = "REQUIRED";
      v.assertValid();
      return jsonOk(await services(ctx).landscape.saveDraft(auth, id(ctx), { baseRevision, name, document: body.document }, requestMeta(ctx)));
    }),

    /** `{ revision, note?, makePublic? }` */
    publish: withPermission("landscape.publish", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["revision", "note", "makePublic"]);
      const rev = revision(v, body, "revision");
      const note = v.string("note", { max: 200 })?.trim() || null;
      const makePublic = v.boolean("makePublic", false);
      v.assertValid();
      return jsonOk(await services(ctx).landscape.publish(auth, id(ctx), { revision: rev, note, makePublic }, requestMeta(ctx)));
    }),

    versions: withPermission("landscape.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).landscape.versions(auth, id(ctx), requestMeta(ctx)))),

    republish: withPermission("landscape.publish", services, async (ctx, auth) =>
      jsonOk(await services(ctx).landscape.republish(auth, id(ctx), id(ctx, "versionId"), requestMeta(ctx)))),

    /** `{ baseRevision }` — an older version back into the draft. */
    restoreToDraft: withPermission("landscape.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["baseRevision"]);
      const baseRevision = revision(v, body, "baseRevision");
      v.assertValid();
      return jsonOk(await services(ctx).landscape.restoreToDraft(auth, id(ctx), id(ctx, "versionId"), baseRevision, requestMeta(ctx)));
    }),

    archive: withPermission("landscape.publish", services, async (ctx, auth) => {
      await services(ctx).landscape.archive(auth, id(ctx), requestMeta(ctx));
      return jsonOk({ archived: true });
    }),

    templates: withPermission("landscape.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).landscape.templates(auth, requestMeta(ctx)))),

    /** `{ name, object }` */
    addTemplate: withPermission("landscape.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request, 32 * 1024);
      const v = new Validator(body).allowOnly(["name", "object"]);
      const name = v.string("name", { required: true, max: 60 });
      if (!body.object || typeof body.object !== "object" || Array.isArray(body.object)) v.errors.object = "REQUIRED";
      v.assertValid();
      return jsonOk(await services(ctx).landscape.addTemplate(auth, name.trim(), body.object, requestMeta(ctx)), { status: 201 });
    }),

    deleteTemplate: withPermission("landscape.edit", services, async (ctx, auth) => {
      await services(ctx).landscape.deleteTemplate(auth, id(ctx), requestMeta(ctx));
      return jsonOk({ deleted: true });
    }),

    // Palette (migration 0040): the kinds staff draw — add, change, hide, delete (or a built-in back as it ships).
    palette: withPermission("landscape.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).landscape.palette(auth, requestMeta(ctx)))),

    /** `{ kind, name, draw, fill, stroke, opacity, layer, size, group, sortOrder, hidden }` — a new kind. */
    addPaletteKind: withPermission("landscape.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request, 4096);
      new Validator(body).allowOnly(PALETTE_FIELDS).assertValid();
      return jsonOk(await services(ctx).landscape.savePaletteKind(auth, null, body, requestMeta(ctx)), { status: 201 });
    }),

    /** Same body: change a built-in (id = its code, e.g. TREE) or a staff kind. */
    savePaletteKind: withPermission("landscape.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request, 4096);
      new Validator(body).allowOnly(PALETTE_FIELDS).assertValid();
      return jsonOk(await services(ctx).landscape.savePaletteKind(auth, id(ctx), body, requestMeta(ctx)));
    }),

    removePaletteKind: withPermission("landscape.edit", services, async (ctx, auth) =>
      jsonOk(await services(ctx).landscape.removePaletteKind(auth, id(ctx), requestMeta(ctx)))),

    paletteUsage: withPermission("landscape.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).landscape.paletteUsage(auth, id(ctx), requestMeta(ctx)))),

    /** GET /api/public/landscape — the published plan for the booking page (no private data). */
    publicLayout: (async (ctx) => jsonOk(await services(ctx).landscape.publicLayout(), { headers: { "Cache-Control": "no-store" } })) satisfies Handler,
  };
}
