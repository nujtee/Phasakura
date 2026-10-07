import { PERMISSION_CODES, type PermissionOverrideDto } from "../../shared/auth-types.ts";
import { LOCALE_CODES, parseLocale } from "../../shared/i18n/locales.ts";
import { requestMeta, withAuth, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { RequestContext } from "../router.ts";
import { PASSWORD_MAX_LENGTH } from "../security/password.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN, ROLE_CODE_PATTERN, USERNAME_PATTERN, Validator } from "../validation.ts";

function idParam(ctx: RequestContext): string {
  const id = ctx.params.id ?? "";
  if (!ID_PATTERN.test(id)) throw new ValidationError({ id: "INVALID_ID" });
  return id;
}

function languageParam(ctx: RequestContext): string {
  return parseLocale(ctx.url.searchParams.get("lang"))?.code ?? "th";
}

function intParam(ctx: RequestContext, name: string, fallback: number, min: number, max: number): number {
  const raw = ctx.url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError({ [name]: "OUT_OF_RANGE" });
  return n;
}

function optionalQuery(ctx: RequestContext, name: string, max: number, pattern?: RegExp): string | undefined {
  const raw = ctx.url.searchParams.get(name)?.trim();
  if (!raw) return undefined;
  if (raw.length > max || (pattern && !pattern.test(raw))) throw new ValidationError({ [name]: "INVALID_FORMAT" });
  return raw;
}

const LANGUAGE_VALUES = LOCALE_CODES as readonly string[];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function adminUsersController(services: ServicesFor) {
  return {
    /** GET /api/admin/users?status=&q=&page=&pageSize= */
    list: withPermission("users.view", services, async (ctx, auth) => {
      const statusRaw = optionalQuery(ctx, "status", 16);
      if (statusRaw && !["ACTIVE", "SUSPENDED", "DELETED"].includes(statusRaw)) {
        throw new ValidationError({ status: "INVALID_VALUE" });
      }
      const data = await services(ctx).users.list(
        auth,
        {
          status: statusRaw as "ACTIVE" | "SUSPENDED" | "DELETED" | undefined,
          query: optionalQuery(ctx, "q", 100),
          page: intParam(ctx, "page", 1, 1, 10_000),
          pageSize: intParam(ctx, "pageSize", 20, 1, 100),
        },
        requestMeta(ctx),
      );
      return jsonOk(data);
    }),

    /** GET /api/admin/users/:id */
    get: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).users.get(auth, idParam(ctx), requestMeta(ctx)))),

    /** POST /api/admin/users */
    create: withPermission("users.create", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly([
        "email", "username", "displayName", "preferredLanguage", "roles", "password",
      ]);
      const input = {
        email: v.email("email", { required: true }),
        username: v.string("username", { pattern: USERNAME_PATTERN }) ?? null,
        displayName: v.string("displayName", { required: true, min: 1, max: 100 }),
        preferredLanguage: v.oneOf("preferredLanguage", LANGUAGE_VALUES) ?? null,
        roles: v.stringArray("roles", { max: 10, pattern: ROLE_CODE_PATTERN }) ?? [],
        password: v.string("password", { max: PASSWORD_MAX_LENGTH, raw: true }) ?? null,
      };
      v.assertValid();
      const result = await services(ctx).users.create(auth, input, requestMeta(ctx));
      return jsonOk(result, { status: 201 });
    }),

    /** PATCH /api/admin/users/:id */
    update: withPermission("users.edit", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["email", "username", "displayName", "preferredLanguage"]);
      const input = {
        email: v.has("email") ? v.email("email", { required: true }) : undefined,
        username: v.has("username") ? (v.string("username", { pattern: USERNAME_PATTERN }) ?? null) : undefined,
        displayName: v.has("displayName") ? v.string("displayName", { required: true, min: 1, max: 100 }) : undefined,
        preferredLanguage: v.has("preferredLanguage") ? (v.oneOf("preferredLanguage", LANGUAGE_VALUES) ?? null) : undefined,
      };
      v.assertValid();
      return jsonOk(await services(ctx).users.update(auth, idParam(ctx), input, requestMeta(ctx)));
    }),

    /** PUT /api/admin/users/:id/roles  { roles: string[] } */
    setRoles: withPermission("users.manage_roles", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["roles"]);
      const roles = v.stringArray("roles", { required: true, max: 10, pattern: ROLE_CODE_PATTERN });
      v.assertValid();
      return jsonOk(await services(ctx).users.setRoles(auth, idParam(ctx), roles ?? [], requestMeta(ctx)));
    }),

    /** PUT /api/admin/users/:id/permissions  { overrides: [{ code, effect }] } */
    setPermissions: withPermission("users.manage_permissions", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      new Validator(body).allowOnly(["overrides"]).assertValid();
      const raw = body.overrides;
      if (!Array.isArray(raw) || raw.length > PERMISSION_CODES.length) throw new ValidationError({ overrides: "INVALID_FORMAT" });
      const overrides: PermissionOverrideDto[] = raw.map((item) => {
        const o = item as Record<string, unknown>;
        if (typeof o !== "object" || o === null || Object.keys(o).some((k) => k !== "code" && k !== "effect")
          || !(PERMISSION_CODES as readonly unknown[]).includes(o.code) || (o.effect !== "GRANT" && o.effect !== "DENY")) {
          throw new ValidationError({ overrides: "INVALID_FORMAT" });
        }
        return { code: o.code as PermissionOverrideDto["code"], effect: o.effect };
      });
      return jsonOk(await services(ctx).users.setPermissionOverrides(auth, idParam(ctx), overrides, requestMeta(ctx)));
    }),

    resetPassword: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).users.resetPassword(auth, idParam(ctx), requestMeta(ctx)))),
    suspend: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).users.suspend(auth, idParam(ctx), requestMeta(ctx)))),
    activate: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).users.activate(auth, idParam(ctx), requestMeta(ctx)))),
    forceLogout: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).users.forceLogout(auth, idParam(ctx), requestMeta(ctx)))),
    remove: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).users.delete(auth, idParam(ctx), requestMeta(ctx)))),
    restore: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).users.restore(auth, idParam(ctx), requestMeta(ctx)))),

    /** GET /api/admin/roles?lang= */
    roles: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).users.listRoles(auth, languageParam(ctx), requestMeta(ctx)))),

    /** PUT /api/admin/roles/:id/permissions  { permissions: string[] } */
    setRolePermissions: withPermission("users.manage_permissions", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["permissions"]);
      const permissions = v.stringArray("permissions", { required: true, max: PERMISSION_CODES.length });
      v.assertValid();
      if ((permissions ?? []).some((p) => !(PERMISSION_CODES as readonly string[]).includes(p))) {
        throw new ValidationError({ permissions: "UNKNOWN_PERMISSION" });
      }
      return jsonOk(await services(ctx).users.setRolePermissions(auth, idParam(ctx), permissions ?? [], languageParam(ctx), requestMeta(ctx)));
    }),

    /** GET /api/admin/permissions */
    permissions: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).users.listPermissions(auth, requestMeta(ctx)))),

    /** GET /api/admin/security-events?type=&userId=&before=&limit= */
    securityEvents: withPermission("security_events.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).logs.securityEvents(auth, {
        type: optionalQuery(ctx, "type", 64, /^[A-Z_]+$/),
        userId: optionalQuery(ctx, "userId", 64, ID_PATTERN),
        before: optionalQuery(ctx, "before", 30, ISO_TIMESTAMP),
        limit: intParam(ctx, "limit", 50, 1, 200),
      }, requestMeta(ctx)))),

    /** GET /api/admin/audit-logs?module=&recordId=&before=&limit= */
    auditLogs: withPermission("audit_logs.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).logs.auditLogs(auth, {
        module: optionalQuery(ctx, "module", 32, /^[a-z_]+$/),
        recordId: optionalQuery(ctx, "recordId", 64, ID_PATTERN),
        before: optionalQuery(ctx, "before", 30, ISO_TIMESTAMP),
        limit: intParam(ctx, "limit", 50, 1, 200),
      }, requestMeta(ctx)))),
  };
}
