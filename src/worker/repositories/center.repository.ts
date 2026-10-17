import type { D1DatabaseLike } from "../env.ts";

/** Nonces of signed Center requests (migration 0030). */
export class CenterNonceRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** true = first time this nonce is seen; false = a replay. */
  async remember(nonce: string, keyId: string, expiresAt: string): Promise<boolean> {
    const row = await this.db
      .prepare("INSERT INTO center_nonces (nonce, key_id, expires_at) VALUES (?, ?, ?) ON CONFLICT (nonce) DO NOTHING RETURNING nonce")
      .bind(nonce, keyId, expiresAt)
      .first<{ nonce: string }>();
    return row !== null;
  }

  async purge(before: string): Promise<void> {
    await this.db.prepare("DELETE FROM center_nonces WHERE expires_at < ?").bind(before).run();
  }
}
