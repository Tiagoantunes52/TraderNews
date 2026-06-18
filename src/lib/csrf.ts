// CSRF defence-in-depth (#23). Plain route handlers — unlike Server Actions — get no
// built-in Origin checking from Next.js. We already lean on Clerk's SameSite=Lax session
// cookie plus the JSON-body requirement, but a cross-site form/fetch can still carry the
// cookie. So for state-changing requests we additionally reject any whose `Origin` host
// doesn't match the request `Host`.
//
// Pure + primitive-typed so it's unit-testable without a NextRequest. The proxy passes
// the request's method / pathname / Origin / Host in.

export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * True when this is a cross-origin state-changing API request that should be blocked.
 *
 * - Non-mutating verbs (GET/HEAD/OPTIONS) → allowed (not a CSRF write vector).
 * - Non-`/api/*` paths → allowed (pages aren't state-changing handlers).
 * - `/api/pipeline/*` → allowed: authenticated by a shared header secret and called by
 *   GitHub Actions, which sends no browser `Origin`. Gating them would only risk false
 *   positives; the secret is the real guard.
 * - No `Origin` header → allowed: server-to-server / curl clients omit it, and they
 *   carry no ambient browser cookie to abuse. Browsers always send it on cross-site
 *   POST/DELETE/PATCH, which is the case we care about.
 * - Malformed `Origin` → blocked (can't prove same-origin).
 */
export function isCrossOriginMutation(
  method: string,
  pathname: string,
  origin: string | null,
  host: string | null,
): boolean {
  if (!MUTATING_METHODS.has(method)) return false;
  if (!pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/api/pipeline")) return false;
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  return originHost !== host;
}
