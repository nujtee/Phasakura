import { CENTER_API_VERSION } from "../../shared/center-protocol.ts";
import type { Services } from "../container.ts";
import { requestMeta } from "../http/auth-guard.ts";
import { PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { LATEST_MIGRATION } from "../services/health.service.ts";
import { Validator } from "../validation.ts";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const ACTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * /api/center/* — what Center Management may ask of a site. Every handler except `consumeSso` first verifies the
 * Ed25519 signature (CenterAccessService, phase C2). Reads are not audited (Center polls every few minutes);
 * writes (phase C3, CenterAdminService) need a reason and a Center role and are audited with the actor.
 */
export function centerController(services: (ctx: Pick<RequestContext, "request" | "env" | "url">) => Services) {
  const verify = (ctx: RequestContext) => services(ctx).center.verify(ctx.request, ctx.url, requestMeta(ctx));

  return {
    /** Handshake: which site this is, which API and schema it speaks. */
    hello: (async (ctx) => {
      const s = services(ctx);
      const { actor } = await verify(ctx);
      const [health, suspension] = await Promise.all([s.health.check(), s.centerAdmin.suspension()]);
      return jsonOk({
        apiVersion: CENTER_API_VERSION,
        site: { host: ctx.url.host, baseUrl: ctx.env.APP_BASE_URL?.trim() || null, environment: ctx.env.APP_ENV },
        schema: { expected: LATEST_MIGRATION, status: health.schema },
        suspended: suspension.suspended,
        time: health.time,
        actor: { id: actor.id, role: actor.role },
      }, NO_STORE);
    }) satisfies Handler,

    /** The back office's System status (health, readiness checks, cron, backlog, recent errors). */
    status: (async (ctx) => {
      await verify(ctx);
      return jsonOk({ apiVersion: CENTER_API_VERSION, ...(await services(ctx).monitoring.snapshot()) }, NO_STORE);
    }) satisfies Handler,

    /** The site's own admin accounts (no Center users, no password data). */
    users: (async (ctx) => {
      await verify(ctx);
      return jsonOk({ items: await services(ctx).centerAdmin.siteUsers() }, NO_STORE);
    }) satisfies Handler,

    getSuspension: (async (ctx) => {
      await verify(ctx);
      return jsonOk(await services(ctx).centerAdmin.suspension(), NO_STORE);
    }) satisfies Handler,

    /** `{ suspended: boolean, note?: string }` — PLATFORM_OWNER, unpaid service fees only. */
    setSuspension: (async (ctx) => {
      const req = await verify(ctx);
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["suspended", "note"]);
      if (typeof body.suspended !== "boolean") throw new ValidationError({ suspended: "REQUIRED" });
      const note = body.note === undefined || body.note === null ? null : typeof body.note === "string" ? body.note.trim() || null : undefined;
      if (note === undefined || (note && note.length > 300)) throw new ValidationError({ note: "INVALID" });
      v.assertValid();
      return jsonOk(await services(ctx).centerAdmin.setSuspension(req, body.suspended, note, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** OTA channels (phase O1): what is switched on, iCal links and problems. */
    getChannels: (async (ctx) => {
      await verify(ctx);
      return jsonOk(await services(ctx).channels.centerOverview(), NO_STORE);
    }) satisfies Handler,

    /** `{ ical: boolean }` — PLATFORM_OWNER / OPERATOR, reason; audited as the Center user. */
    setChannels: (async (ctx) => {
      const req = await verify(ctx);
      const body = await readJsonObject(ctx.request);
      new Validator(body).allowOnly(["ical"]).assertValid();
      if (typeof body.ical !== "boolean") throw new ValidationError({ ical: "REQUIRED" });
      const s = services(ctx);
      return jsonOk(await s.centerAdmin.setChannels(req, s.channels, { ical: body.ical }, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** Backups of this site's database in its private bucket (phase C8), newest first. */
    listBackups: (async (ctx) => {
      await verify(ctx);
      return jsonOk({ items: await services(ctx).centerAdmin.listBackups() }, NO_STORE);
    }) satisfies Handler,

    /** A backup now (PLATFORM_OWNER / OPERATOR, reason). */
    createBackup: (async (ctx) => {
      const req = await verify(ctx);
      return jsonOk(await services(ctx).centerAdmin.backupNow(req, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** `?name=` — the gzip file itself (PLATFORM_OWNER, reason; audited). */
    downloadBackup: (async (ctx) => {
      const req = await verify(ctx);
      const name = ctx.url.searchParams.get("name") ?? "";
      const file = await services(ctx).centerAdmin.downloadBackup(req, name, requestMeta(ctx));
      return new Response(file.body, {
        status: 200,
        headers: {
          "Content-Type": "application/gzip", "Content-Length": String(file.size), "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${name}"`, "X-Content-Type-Options": "nosniff",
        },
      });
    }) satisfies Handler,

    /** `{ email, name }` — a new site's first owner (PLATFORM_OWNER, phase C7): returns a one-time invite link. */
    inviteOwner: (async (ctx) => {
      const req = await verify(ctx);
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["email", "name"]);
      if (typeof body.email !== "string") throw new ValidationError({ email: "REQUIRED" });
      if (typeof body.name !== "string") throw new ValidationError({ name: "REQUIRED" });
      v.assertValid();
      return jsonOk(await services(ctx).centerAdmin.inviteOwner(req, { email: body.email, name: body.name }, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** `{ actorId?: string }` — sign out one Center user on this site, or all of them. */
    revokeSessions: (async (ctx) => {
      const req = await verify(ctx);
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["actorId"]);
      const actorId = body.actorId === undefined || body.actorId === null ? null : body.actorId;
      if (actorId !== null && (typeof actorId !== "string" || !ACTOR_ID.test(actorId))) throw new ValidationError({ actorId: "INVALID" });
      v.assertValid();
      return jsonOk(await services(ctx).centerAdmin.revokeSessions(req, actorId, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** A one-time ticket for the Center user's browser to post to `consumeUrl` (valid 60 s). */
    issueSso: (async (ctx) => {
      const req = await verify(ctx);
      const ticket = await services(ctx).centerAdmin.issueSso(req, requestMeta(ctx));
      return jsonOk({ ...ticket, consumeUrl: `${ctx.url.origin}/api/center/sso/consume` }, NO_STORE);
    }) satisfies Handler,

    /** Form post `ticket=…` from the Center user's browser → back-office session → /admin. */
    consumeSso: (async (ctx) => {
      const s = services(ctx);
      const ticket = await readTicket(ctx.request);
      const session = ticket ? await s.centerAdmin.consumeSso(ticket, requestMeta(ctx)) : null;
      if (!session) return ssoFailedPage();
      return new Response(null, {
        status: 303,
        headers: { Location: "/admin", "Set-Cookie": s.sessions.cookie(session), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      });
    }) satisfies Handler,
  };
}

async function readTicket(request: Request): Promise<string | null> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) throw new UnsupportedMediaTypeError();
  const text = await request.text();
  if (text.length > 1024) throw new PayloadTooLargeError();
  return new URLSearchParams(text).get("ticket");
}

function ssoFailedPage(): Response {
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Center</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6">
<h1 style="font-size:1.25rem">ลิงก์เข้าสู่ระบบจาก Center ใช้ไม่ได้</h1>
<p>ลิงก์หมดอายุหรือถูกใช้ไปแล้ว — กลับไปที่ Center แล้วกด “เข้าหลังบ้าน” อีกครั้ง</p>
<p lang="en" style="color:#555">This Center sign-in link has expired or was already used. Open the back office from Center again.</p>
</body></html>`;
  return new Response(html, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
