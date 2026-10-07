import { CMS_ENTITY_NAMES, type CmsEntityName } from "../../shared/cms-schema.ts";
import { requestMeta, withAuth, type ServicesFor } from "../http/auth-guard.ts";
import { NotFoundError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN } from "../validation.ts";

/** Long-form content (history body in three languages) needs more than the default 16 KB. */
export const CMS_MAX_JSON_BYTES = 96 * 1024;

function entity(ctx: RequestContext): CmsEntityName {
  const name = ctx.params.entity ?? "";
  if (!(CMS_ENTITY_NAMES as readonly string[]).includes(name)) throw new NotFoundError();
  return name as CmsEntityName;
}

function id(ctx: RequestContext): string {
  const value = ctx.params.id ?? "";
  if (!ID_PATTERN.test(value)) throw new NotFoundError("Record not found", "RECORD_NOT_FOUND");
  return value;
}

/** /api/admin/cms/:entity — generic back-office records (permissions checked per entity in CmsService). */
export function cmsController(services: ServicesFor) {
  return {
    list: withAuth(services, async (ctx, auth) => {
      const filter = Object.fromEntries([...ctx.url.searchParams.entries()].slice(0, 5));
      return jsonOk(await services(ctx).cms.list(auth, entity(ctx), filter, requestMeta(ctx)));
    }),
    get: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).cms.get(auth, entity(ctx), id(ctx), requestMeta(ctx)))),
    create: withAuth(services, async (ctx, auth) => {
      const name = entity(ctx);
      const body = await readJsonObject(ctx.request, CMS_MAX_JSON_BYTES);
      return jsonOk(await services(ctx).cms.create(auth, name, body, requestMeta(ctx)), { status: 201 });
    }),
    update: withAuth(services, async (ctx, auth) => {
      const name = entity(ctx);
      const body = await readJsonObject(ctx.request, CMS_MAX_JSON_BYTES);
      return jsonOk(await services(ctx).cms.update(auth, name, id(ctx), body, requestMeta(ctx)));
    }),
    remove: withAuth(services, async (ctx, auth) => {
      await services(ctx).cms.remove(auth, entity(ctx), id(ctx), requestMeta(ctx));
      return jsonOk({ deleted: true });
    }),
    reorder: withAuth(services, async (ctx, auth) => {
      const name = entity(ctx);
      const body = await readJsonObject(ctx.request);
      const keys = Object.keys(body);
      if (keys.some((k) => k !== "ids")) throw new ValidationError({ [keys.find((k) => k !== "ids")!]: "UNKNOWN_FIELD" });
      const ids = body.ids;
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new ValidationError({ ids: "EXPECTED_STRING_ARRAY" });
      return jsonOk(await services(ctx).cms.reorder(auth, name, ids as string[], requestMeta(ctx)));
    }),
    publish: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).cms.setPublished(auth, entity(ctx), id(ctx), true, requestMeta(ctx)))),
    unpublish: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).cms.setPublished(auth, entity(ctx), id(ctx), false, requestMeta(ctx)))),
  };
}
