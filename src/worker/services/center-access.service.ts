import {
  CENTER_HEADERS, CENTER_MAX_SKEW_SECONDS, CENTER_NONCE_TTL_SECONDS, base64UrlDecode, canonicalString, decodeActor,
  isValidKeyId, isValidNonce, parseCenterPublicKeys, sha256Hex, type Bytes, type CenterActor,
} from "../../shared/center-protocol.ts";
import { NotFoundError, UnauthorizedError } from "../http/errors.ts";
import type { CenterNonceRepository } from "../repositories/center.repository.ts";
import type { Clock, RequestMeta } from "./auth-context.ts";
import type { SecurityLogService } from "./security-log.service.ts";

/** A request Center signed and this site accepted. */
export interface CenterRequest {
  actor: CenterActor;
  keyId: string;
}

/** Largest body a Center request may carry (C3 writes are small JSON). */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The CENTER level of access (Center Management phase C2): above SUPER_ADMIN, and not a row in this site's
 * users table — a site's own admins cannot remove or change it. A request is Center's only when
 *  - CENTER_PUBLIC_KEYS has the key it names (no keys = the Center API does not exist: 404),
 *  - its Ed25519 signature covers method, this site's host, path, time, nonce, actor and body,
 *  - its time is within CENTER_MAX_SKEW_SECONDS of this site's clock,
 *  - its nonce has not been used before (center_nonces, migration 0030).
 * Every refusal is a security event (Administration → Security events) without the signature itself.
 */
export class CenterAccessService {
  private readonly keys: Map<string, Bytes>;
  private readonly imported = new Map<string, Promise<CryptoKey>>();

  constructor(
    publicKeys: string | undefined,
    private readonly nonces: CenterNonceRepository,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {
    this.keys = parseCenterPublicKeys(publicKeys);
  }

  /** The Center API exists on this site (at least one valid public key is configured). */
  get enabled(): boolean {
    return this.keys.size > 0;
  }

  async verify(request: Request, url: URL, meta: RequestMeta): Promise<CenterRequest> {
    if (!this.enabled) throw new NotFoundError();
    const h = (name: string) => request.headers.get(name)?.trim() ?? "";
    const keyId = h(CENTER_HEADERS.keyId);
    const timeText = h(CENTER_HEADERS.time);
    const nonce = h(CENTER_HEADERS.nonce);
    const actorHeader = h(CENTER_HEADERS.actor);
    const signature = base64UrlDecode(h(CENTER_HEADERS.signature));

    const refuse = async (reason: string): Promise<never> => {
      await this.log.event("CENTER_REQUEST_REFUSED", "WARNING", meta, {
        details: { reason, keyId: isValidKeyId(keyId) ? keyId : null, method: request.method, path: url.pathname.slice(0, 100) },
      });
      throw new UnauthorizedError("Center signature required", "CENTER_UNAUTHORIZED");
    };

    if (!isValidKeyId(keyId) || !/^\d{1,12}$/.test(timeText) || !isValidNonce(nonce) || !actorHeader || !signature || signature.length !== 64) {
      return refuse("MALFORMED");
    }
    const publicKey = this.keys.get(keyId);
    if (!publicKey) return refuse("UNKNOWN_KEY");
    const actor = decodeActor(actorHeader);
    if (!actor) return refuse("BAD_ACTOR");
    const nowSeconds = Math.floor(this.clock().getTime() / 1000);
    if (Math.abs(nowSeconds - Number(timeText)) > CENTER_MAX_SKEW_SECONDS) return refuse("CLOCK_SKEW");

    const body = new Uint8Array(await request.clone().arrayBuffer());
    if (body.length > MAX_BODY_BYTES) return refuse("BODY_TOO_LARGE");
    const message = canonicalString({
      method: request.method, host: url.host, pathAndQuery: url.pathname + url.search, time: timeText, nonce, actor: actorHeader,
      bodySha256: await sha256Hex(body),
    });
    let valid = false;
    try {
      valid = await crypto.subtle.verify({ name: "Ed25519" }, await this.cryptoKey(keyId, publicKey), signature, new TextEncoder().encode(message));
    } catch {
      valid = false;
    }
    if (!valid) return refuse("BAD_SIGNATURE");

    // Checked last, so a forged request cannot burn a nonce that a genuine one is about to use.
    const expires = new Date((nowSeconds + CENTER_NONCE_TTL_SECONDS) * 1000).toISOString();
    if (!(await this.nonces.remember(nonce, keyId, expires))) return refuse("REPLAYED_NONCE");
    return { actor, keyId };
  }

  /** Forget nonces older than their window (cron). */
  async purgeNonces(): Promise<void> {
    await this.nonces.purge(this.clock().toISOString());
  }

  private cryptoKey(keyId: string, raw: Bytes): Promise<CryptoKey> {
    let key = this.imported.get(keyId);
    if (!key) {
      key = crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
      this.imported.set(keyId, key);
    }
    return key;
  }
}
