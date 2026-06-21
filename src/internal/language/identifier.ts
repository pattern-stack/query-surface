// The canonical safe-identifier contract — the single source of truth for output aliases and any
// generated SQL name. Dialect-free: the validator side (`isIdentifier`/the Drizzle compiler's
// `assertIdent`) and the producer side (`toIdentifier`) share ONE rule, so a name that passes the
// producer always passes the validator. Avoids ad-hoc per-site regex.

/** A safe identifier: lowercase leading letter/underscore, then letters/digits/underscores. */
export const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

export const isIdentifier = (s: string): boolean => IDENTIFIER_RE.test(s);

/**
 * Coerce an arbitrary display name into a safe identifier — total and idempotent:
 *   `Amount.sum`      → `amount_sum`
 *   `Deal Size Band`  → `deal_size_band`
 *   `123abc`          → `_123abc`   (can't lead with a digit)
 *   `%$#`             → `_`         (nothing identifier-safe survives)
 * Lowercases, collapses every run of non-[a-z0-9_] to a single `_`, trims edge `_`, and guards the
 * leading-digit / empty cases. `toIdentifier(x)` always satisfies `isIdentifier`.
 */
export function toIdentifier(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug === '') return '_';
  return /^[a-z_]/.test(slug) ? slug : `_${slug}`;
}
