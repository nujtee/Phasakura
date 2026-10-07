import type { ApiErrorBody, ApiSuccess } from "../../src/shared/api-types.ts";
import { createApp } from "../../src/worker/index.ts";
import { hashPassword } from "../../src/worker/security/password.ts";
import type { PasswordResetDelivery } from "../../src/worker/services/password-link.service.ts";
import type { SlipVerifier } from "../../src/worker/slip/slip-verifier.ts";
import { makeEnv, MemoryBucket } from "./fake-env.ts";
import { FakeLine } from "./fake-line.ts";
import { signLineBody } from "../../src/worker/line/line-api.ts";
import { SqliteD1 } from "./sqlite-d1.ts";

/** Indirection so a test can set `h.verifier(...)` after the app is created. */
const harnessVerifier: { current: SlipVerifier | null } = { current: null };

export const ORIGIN = "https://phasakura.test";
export const STRONG_PASSWORD = "correct horse battery staple";

export interface ApiResult<T = unknown> {
  status: number;
  headers: Headers;
  body: { data?: T; error?: ApiErrorBody["error"] };
  data: T;
  error: ApiErrorBody["error"] | undefined;
  setCookie: string | null;
  token: string | null;
}

/**
 * Full-stack test harness: real migrations in SQLite, real services,
 * a controllable clock, and captured password-reset deliveries.
 */
export class Harness {
  readonly db: SqliteD1;
  now = new Date("2027-01-10T03:00:00.000Z");
  readonly delivered: { email: string; url: string }[] = [];
  private readonly delivery: PasswordResetDelivery = {
    deliver: async (input) => {
      this.delivered.push({ email: input.email, url: input.url });
      return true;
    },
  };
  /** Slip verification service used by the app (null = manual only). Tests may swap it. */
  slipVerifier: SlipVerifier | null = null;
  /** Fake LINE Messaging API (every call the app makes to api.line.me). */
  readonly line = new FakeLine();
  readonly app = createApp({
    requestId: () => "req",
    serviceOptions: {
      clock: () => new Date(this.now),
      delivery: this.delivery,
      get slipVerifier() {
        return harnessVerifier.current;
      },
      lineFetch: (input: string, init?: RequestInit) => this.line.fetch(input, init),
    },
  });
  readonly env: ReturnType<typeof makeEnv>;
  ip = "203.0.113.10";

  constructor(options: { seed?: boolean } = {}) {
    harnessVerifier.current = null;
    this.db = SqliteD1.migrated({ seed: options.seed });
    this.env = makeEnv(this.db);
  }

  get bucket(): MemoryBucket {
    return this.env.MEDIA_PUBLIC as MemoryBucket;
  }

  /** Multipart upload to /api/admin/media. */
  async upload<T = unknown>(token: string, file: { bytes: Uint8Array; name: string; type: string }, purpose: string, extra: Record<string, string> = {}) {
    const form = new FormData();
    form.set("file", new File([file.bytes as BlobPart], file.name, { type: file.type }));
    form.set("purpose", purpose);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    const res = await this.app.fetch(
      new Request(`${ORIGIN}/api/admin/media`, {
        method: "POST",
        headers: { Origin: ORIGIN, "X-Requested-With": "phasakura", Cookie: `__Host-sid=${token}` },
        body: form,
      }),
      this.env,
    );
    const body = (await res.json()) as { data?: T; error?: ApiErrorBody["error"] };
    return { status: res.status, data: body.data as T, error: body.error };
  }

  /** Raw GET of a non-API path (e.g. /media/…). */
  get(path: string, headers: Record<string, string> = {}, method = "GET") {
    return this.app.fetch(new Request(`${ORIGIN}${path}`, { method, headers }), this.env);
  }

  verifier(v: SlipVerifier | null) {
    this.slipVerifier = v;
    harnessVerifier.current = v;
  }

  /** Multipart slip upload (public). */
  async slip<T = unknown>(code: string, phone: string, file: { bytes: Uint8Array; name: string; type: string }) {
    const form = new FormData();
    form.set("bookingCode", code);
    form.set("phone", phone);
    form.set("file", new File([file.bytes as BlobPart], file.name, { type: file.type }));
    const res = await this.app.fetch(
      new Request(`${ORIGIN}/api/public/bookings/slip`, {
        method: "POST",
        headers: { Origin: ORIGIN, "X-Requested-With": "phasakura", "CF-Connecting-IP": this.ip },
        body: form,
      }),
      this.env,
    );
    const body = (await res.json()) as { data?: T; error?: ApiErrorBody["error"] };
    return { status: res.status, data: body.data as T, error: body.error };
  }

  /** LINE secrets as Cloudflare Secrets would provide them. */
  lineSecrets(token: string | null = "test-channel-token", secret: string | null = "test-channel-secret") {
    this.env.LINE_CHANNEL_ACCESS_TOKEN = token ?? undefined;
    this.env.LINE_CHANNEL_SECRET = secret ?? undefined;
  }

  /** Server-to-server call from LINE: signed body, no browser headers. */
  async webhook(body: unknown, opts: { signature?: string | null; raw?: string } = {}) {
    const raw = opts.raw ?? JSON.stringify(body);
    const signature = opts.signature === undefined ? await signLineBody(this.env.LINE_CHANNEL_SECRET ?? "", raw) : opts.signature;
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "LineBotWebhook/2.0", "CF-Connecting-IP": "147.92.150.192" };
    if (signature !== null) headers["x-line-signature"] = signature;
    const res = await this.app.fetch(new Request(`${ORIGIN}/api/line/webhook`, { method: "POST", headers, body: raw }), this.env);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as { data?: { handled: number }; error?: ApiErrorBody["error"] } };
  }

  advance(ms: number) {
    this.now = new Date(this.now.getTime() + ms);
  }

  /** Inserts a user directly (fast low-iteration hash; upgraded on first login). */
  async user(opts: {
    id: string;
    email?: string;
    password?: string;
    roles?: string[];
    status?: "ACTIVE" | "SUSPENDED";
    mustChange?: boolean;
    username?: string;
  }) {
    const email = opts.email ?? `${opts.id}@example.test`;
    this.db.run(
      `INSERT INTO users (id, email, username, display_name, password_hash, must_change_password, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      opts.id, email, opts.username ?? null, `User ${opts.id}`, await hashPassword(opts.password ?? STRONG_PASSWORD, 1000),
      opts.mustChange ? 1 : 0, opts.status ?? "ACTIVE",
    );
    for (const role of opts.roles ?? []) {
      this.db.run("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?", opts.id, role);
    }
    return email;
  }

  grant(userId: string, code: string, effect: "GRANT" | "DENY" = "GRANT") {
    this.db.run(
      "INSERT INTO user_permissions (user_id, permission_id, effect) SELECT ?, id, ? FROM permissions WHERE code = ?",
      userId, effect, code,
    );
  }

  async api<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string | null; headers?: Record<string, string>; rawBody?: string } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      Origin: ORIGIN,
      "X-Requested-With": "phasakura",
      "CF-Connecting-IP": this.ip,
      "User-Agent": "harness",
    };
    if (opts.body !== undefined || opts.rawBody !== undefined) headers["Content-Type"] = "application/json";
    if (opts.token) headers.Cookie = `__Host-sid=${opts.token}`;
    Object.assign(headers, opts.headers);
    for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];

    const res = await this.app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      }),
      this.env,
    );
    const text = await res.text();
    const body = (text ? JSON.parse(text) : {}) as ApiResult<T>["body"];
    const setCookie = res.headers.get("Set-Cookie");
    const token = setCookie?.match(/__Host-sid=([A-Za-z0-9_-]+)/)?.[1] ?? null;
    return {
      status: res.status,
      headers: res.headers,
      body,
      data: (body as ApiSuccess<T>).data,
      error: body.error,
      setCookie,
      token,
    };
  }

  async login(identifier: string, password = STRONG_PASSWORD, rememberMe = false): Promise<string> {
    const res = await this.api("POST", "/api/auth/login", { body: { identifier, password, rememberMe } });
    if (res.status !== 200 || !res.token) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.token;
  }

  events(type: string): { user_id: string | null; details_json: string | null }[] {
    return this.db.all("SELECT user_id, details_json FROM security_events WHERE event_type = ? ORDER BY created_at", type);
  }

  audits(action: string): { user_id: string | null; record_id: string | null; old_value: string | null; new_value: string | null }[] {
    return this.db.all("SELECT user_id, record_id, old_value, new_value FROM audit_logs WHERE action = ?", action);
  }
}

export function tokenFromLink(url: string): string {
  const token = new URL(url).hash.match(/token=([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error(`no token in ${url}`);
  return token;
}
