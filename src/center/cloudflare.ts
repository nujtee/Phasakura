import type { FetchLike } from "../worker/line/line-api.ts";
import type { CenterEnv } from "./env.ts";

/**
 * Domains for new sites, straight from Center ("เพิ่มเว็บใหม่"). Secret CENTER_CF_TOKEN: a Cloudflare API token with
 * Zone › Zone › Edit and Zone › DNS › Edit on the platform's account only — no Workers, D1 or R2 rights. The account
 * is the one the existing sites' zones belong to, so nothing else needs configuring. Center never deletes a zone.
 */
const API = "https://api.cloudflare.com/client/v4";

export interface ZoneInfo {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  accountId: string | null;
}

export interface DnsRecord { id: string; type: string; name: string; content: string }

export type CfResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The domain as a zone name: trimmed, lower-case, no scheme / www / path. */
export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
}

export function validDomain(domain: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && domain.length <= 253;
}

export class CloudflareZones {
  /**
   * Wrapped, never the bare global: Workers throw "Illegal invocation" when the runtime's fetch is called as a
   * method of another object (this.fetchFn(...)).
   */
  private readonly fetchFn: FetchLike;

  constructor(private readonly env: CenterEnv, fetchFn?: FetchLike) {
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  get configured(): boolean {
    return !!this.env.CENTER_CF_TOKEN?.trim();
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<CfResult<T>> {
    const token = this.env.CENTER_CF_TOKEN?.trim();
    if (!token) return { ok: false, reason: "ยังไม่ได้ตั้ง secret CENTER_CF_TOKEN ใน Worker center" };
    try {
      const res = await this.fetchFn(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] };
      if (res.ok && json.success !== false) return { ok: true, value: json.result as T };
      const e = json.errors?.[0];
      if (res.status === 401 || res.status === 403 || e?.code === 9109 || e?.code === 10000) return { ok: false, reason: "Cloudflare ไม่รับ token หรือ token ไม่มีสิทธิ์ (ต้องมี Zone: Edit และ DNS: Edit)" };
      return { ok: false, reason: `Cloudflare: ${String(e?.message ?? `HTTP ${res.status}`).slice(0, 200)}${e?.code ? ` (${e.code})` : ""}` };
    } catch (error) {
      return { ok: false, reason: `ติดต่อ Cloudflare ไม่ได้: ${String(error).slice(0, 120)}` };
    }
  }

  private static zone(z: Record<string, unknown>): ZoneInfo {
    return {
      id: String(z.id ?? ""), name: String(z.name ?? ""), status: String(z.status ?? ""),
      nameServers: Array.isArray(z.name_servers) ? (z.name_servers as unknown[]).map(String) : [],
      accountId: (z.account as { id?: string } | undefined)?.id ?? null,
    };
  }

  async findZone(domain: string): Promise<CfResult<ZoneInfo | null>> {
    const r = await this.call<Record<string, unknown>[]>("GET", `/zones?name=${encodeURIComponent(domain)}`);
    if (!r.ok) return r;
    const z = r.value.find((x) => x.name === domain);
    return { ok: true, value: z ? CloudflareZones.zone(z) : null };
  }

  async getZone(id: string): Promise<CfResult<ZoneInfo>> {
    const r = await this.call<Record<string, unknown>>("GET", `/zones/${id}`);
    return r.ok ? { ok: true, value: CloudflareZones.zone(r.value) } : r;
  }

  /** The platform's account: the account of the zones the token can see (the existing sites' domains). */
  async accountId(knownDomain: string): Promise<CfResult<string>> {
    const z = await this.findZone(knownDomain);
    if (!z.ok) return z;
    if (!z.value?.accountId) return { ok: false, reason: `token มองไม่เห็นโดเมน ${knownDomain} — เลือก "All zones from an account" ของบัญชีแพลตฟอร์มตอนสร้าง token` };
    return { ok: true, value: z.value.accountId };
  }

  /** Adds the domain to the account. Cloudflare imports the existing DNS records (e-mail keeps working). */
  async createZone(domain: string, accountId: string): Promise<CfResult<ZoneInfo>> {
    const r = await this.call<Record<string, unknown>>("POST", "/zones", { name: domain, account: { id: accountId }, type: "full", jump_start: true });
    return r.ok ? { ok: true, value: CloudflareZones.zone(r.value) } : r;
  }

  /**
   * The site's Worker becomes the apex and www (custom domains), which fails while A / AAAA / CNAME records exist
   * there — e.g. the old host's records Cloudflare imported. Those are removed; everything else (MX, TXT, other
   * names) is left alone. Returns what was removed.
   */
  async clearSiteHostnames(zoneId: string, domain: string): Promise<CfResult<DnsRecord[]>> {
    const list = await this.call<Record<string, unknown>[]>("GET", `/zones/${zoneId}/dns_records?per_page=500`);
    if (!list.ok) return list;
    const targets = list.value
      .map((r) => ({ id: String(r.id), type: String(r.type), name: String(r.name), content: String(r.content ?? "") }))
      .filter((r) => (r.name === domain || r.name === `www.${domain}`) && ["A", "AAAA", "CNAME"].includes(r.type));
    for (const r of targets) {
      const d = await this.call("DELETE", `/zones/${zoneId}/dns_records/${r.id}`);
      if (!d.ok) return d;
    }
    return { ok: true, value: targets };
  }

  /** Asks Cloudflare to look at the nameservers again now (it also checks by itself, more slowly). */
  async activationCheck(zoneId: string): Promise<void> {
    await this.call("PUT", `/zones/${zoneId}/activation_check`);
  }
}
