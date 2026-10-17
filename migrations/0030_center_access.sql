-- Migration 0030: Center access (Center Management phase C2).
--
-- Center, the platform's console over every booking site, signs each request to /api/center/* with
-- Ed25519 (src/shared/center-protocol.ts). A nonce is accepted once: this table remembers the nonces seen
-- in the last few minutes (rows older than CENTER_NONCE_TTL_SECONDS are purged by the cron), so a captured
-- request cannot be replayed. Nothing else changes; additive only — the code runs before and after it.
CREATE TABLE center_nonces (
  nonce      TEXT PRIMARY KEY CHECK (length(nonce) BETWEEN 16 AND 64 AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'),
  key_id     TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 32),
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX ix_center_nonces_expires ON center_nonces (expires_at);
