import { CENTER_API_VERSION } from "../../shared/center-protocol.ts";
import type { Services } from "../container.ts";
import { requestMeta } from "../http/auth-guard.ts";
import { PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { LATEST_MIGRATION } from "../services/health.service.ts";
import { Validator } from "../validation.ts";
import { centerFeatures } from "../services/center-admin.service.ts";
import { CENTER_FEATURES, type CenterFeature } from "../../shared/channel-types.ts";
import { CREDIT_PLANS, MAX_CREDIT_AMOUNT, type CenterCreditQr, type CreditPlan } from "../../shared/credit-types.ts";
import { parseCreditSettings } from "./credit.controller.ts";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
/** The credit settings call carries the QR picture (≤ 2 MB, base64). */
export const CENTER_CREDITS_MAX_BODY = 3_200_000;

/** `{ ical?: boolean, channex?: boolean }` — at least one. */
export function switches(body: Record<string, unknown>): { ical?: boolean; channex?: boolean } {
  const out: { ical?: boolean; channex?: boolean } = {};
  for (const key of ["ical", "channex"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") throw new ValidationError({ [key]: "REQUIRED" });
    out[key] = body[key] as boolean;
  }
  if (out.ical === undefined && out.channex === undefined) throw new ValidationError({ ical: "REQUIRED" });
  return out;
}
const ACTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOPUP_ID = /^[A-Za-z0-9_-]{1,64}$/;

function centerTopupId(ctx: RequestContext): string {
  const id = ctx.params.id ?? "";
  if (!TOPUP_ID.test(id)) throw new ValidationError({ id: "INVALID_ID" });
  return id;
}

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

    /** `{ ical?: boolean, channex?: boolean }` — PLATFORM_OWNER / OPERATOR, reason; audited as the Center user. */
    setChannels: (async (ctx) => {
      const req = await verify(ctx);
      const body = await readJsonObject(ctx.request);
      new Validator(body).allowOnly(["ical", "channex"]).assertValid();
      const change = switches(body);
      const s = services(ctx);
      return jsonOk(await s.centerAdmin.setChannels(req, s.channels, change, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** Site plan / credit system: on or off, and what is set up (super-admin switches other than the OTA channels). */
    getFeatures: (async (ctx) => {
      await verify(ctx);
      const s = services(ctx);
      return jsonOk(await centerFeatures({ landscape: s.landscape, credits: s.credits }), NO_STORE);
    }) satisfies Handler,

    /** `{ landscape?: boolean, credits?: boolean }` — PLATFORM_OWNER / OPERATOR, reason; audited as the Center user. */
    setFeatures: (async (ctx) => {
      const req = await verify(ctx);
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly([...CENTER_FEATURES]);
      const change: Partial<Record<CenterFeature, boolean>> = {};
      for (const key of CENTER_FEATURES) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== "boolean") v.errors[key] = "EXPECTED_BOOLEAN";
        else change[key] = body[key] as boolean;
      }
      if (!Object.keys(change).length && !Object.keys(v.errors).length) v.errors.landscape = "REQUIRED";
      v.assertValid();
      const s = services(ctx);
      return jsonOk(await s.centerAdmin.setFeatures(req, change, { landscape: s.landscape, credits: s.credits }, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** Credit settings and where this site stands (migration 0060): for Center's credit page. */
    getCredits: (async (ctx) => {
      await verify(ctx);
      return jsonOk(await services(ctx).credits.centerOverview(), NO_STORE);
    }) satisfies Handler,

    /**
     * `{ settings, qr: { sha256, mime, data } | null, version }` — Center's shared credit settings (PLATFORM_OWNER, reason).
     * The settings are checked exactly like the site's own form; on / off is not part of it.
     */
    setCredits: (async (ctx) => {
      const req = await services(ctx).center.verify(ctx.request, ctx.url, requestMeta(ctx), CENTER_CREDITS_MAX_BODY);
      const body = await readJsonObject(ctx.request, CENTER_CREDITS_MAX_BODY);
      const v = new Validator(body).allowOnly(["settings", "qr", "version"]);
      const raw = body.settings;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError({ settings: "REQUIRED" });
      const parsed = parseCreditSettings({ ...(raw as Record<string, unknown>), enabled: false, qrAssetId: null });
      const { enabled: _e, qrAssetId: _q, ...settings } = parsed;
      const version = v.string("version", { required: true, pattern: /^[A-Za-z0-9_.:-]{1,64}$/ })!;
      let qr: CenterCreditQr | null = null;
      if (body.qr !== null && body.qr !== undefined) {
        const q = body.qr as Record<string, unknown>;
        if (typeof q !== "object" || typeof q.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(q.sha256)
          || typeof q.mime !== "string" || !/^image\/(png|jpeg|webp)$/.test(q.mime) || typeof q.data !== "string" || q.data.length > 3_000_000) {
          v.errors.qr = "INVALID";
        } else qr = { sha256: q.sha256, mime: q.mime, data: q.data };
      }
      v.assertValid();
      const s = services(ctx);
      return jsonOk(await s.centerAdmin.setCredits(req, s.credits, { settings, qr, version }, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** `{ unlocked }` — Theme for this site whatever its plan (migration 0065); reason required. */
    setThemeUnlock: (async (ctx) => {
      const req = await verify(ctx);
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["unlocked"]);
      if (typeof body.unlocked !== "boolean") v.errors.unlocked = "REQUIRED";
      v.assertValid();
      const s = services(ctx);
      return jsonOk(await s.centerAdmin.setThemeUnlock(req, s.credits, body.unlocked as boolean, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** `{ enabled, feeBaht }` — one app fee per booking with several stays (migration 0064); reason required. */
    setMultiStay: (async (ctx) => {
      const req = await verify(ctx);
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["enabled", "feeBaht"]);
      if (typeof body.enabled !== "boolean") v.errors.enabled = "REQUIRED";
      if (typeof body.feeBaht !== "number" || !Number.isInteger(body.feeBaht) || body.feeBaht < 1 || body.feeBaht > 100_000) v.errors.feeBaht = "OUT_OF_RANGE";
      v.assertValid();
      const s = services(ctx);
      return jsonOk(await s.centerAdmin.setMultiStay(req, s.credits, { enabled: body.enabled as boolean, feeBaht: body.feeBaht as number }, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** Top-up requests of this site (stage 3): every one waiting and the latest decided. */
    getTopups: (async (ctx) => {
      await verify(ctx);
      return jsonOk(await services(ctx).credits.centerTopups(), NO_STORE);
    }) satisfies Handler,

    topupSlip: (async (ctx) => {
      const req = await verify(ctx);
      const s = services(ctx);
      return s.centerAdmin.topupSlip(req, s.credits, centerTopupId(ctx), requestMeta(ctx));
    }) satisfies Handler,

    /** `{ amount?, plan? }` — the actor's reason is required and recorded. */
    approveTopup: (async (ctx) => {
      const req = await verify(ctx);
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["amount", "plan"]);
      let amount: number | null = null;
      if (body.amount !== undefined && body.amount !== null) {
        if (typeof body.amount !== "number" || !Number.isInteger(body.amount) || body.amount < 1 || body.amount > MAX_CREDIT_AMOUNT) v.errors.amount = "OUT_OF_RANGE";
        else amount = body.amount;
      }
      const plan = (v.oneOf("plan", CREDIT_PLANS) as CreditPlan | undefined) ?? null;
      v.assertValid();
      const s = services(ctx);
      return jsonOk(await s.centerAdmin.approveTopup(req, s.credits, centerTopupId(ctx), { amount, plan }, requestMeta(ctx)), NO_STORE);
    }) satisfies Handler,

    /** No body: the actor's reason is the rejection reason the site's staff see. */
    rejectTopup: (async (ctx) => {
      const req = await verify(ctx);
      const s = services(ctx);
      return jsonOk(await s.centerAdmin.rejectTopup(req, s.credits, centerTopupId(ctx), requestMeta(ctx)), NO_STORE);
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
