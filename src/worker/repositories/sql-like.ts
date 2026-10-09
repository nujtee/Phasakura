/**
 * Cloudflare D1 refuses a LIKE / GLOB pattern longer than 50 bytes ("LIKE or GLOB pattern too
 * complex"); local SQLite does not, so tests would never notice. Schema patterns are checked by
 * tests/db/schema.test.ts; search terms go through `containsPattern`.
 */
export const D1_PATTERN_MAX_BYTES = 50;

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;

/**
 * `%term%` for `LIKE ? ESCAPE '\'`, with %, _ and \ escaped, cut (by whole characters) so the pattern
 * stays within D1's limit — a longer term still finds everything that contains its first part.
 */
export function containsPattern(term: string): string {
  let escaped = "";
  for (const ch of term) {
    const piece = ch === "\\" || ch === "%" || ch === "_" ? `\\${ch}` : ch;
    if (bytes(`%${escaped}${piece}%`) > D1_PATTERN_MAX_BYTES) break;
    escaped += piece;
  }
  return `%${escaped}%`;
}
