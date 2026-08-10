/**
 * Cheap defense-in-depth alongside the @supabase/ssr session cookie's own
 * sameSite: "lax" default (verified in node_modules by the M1.4 CSRF
 * review — Lax already blocks the cookie from being sent on a cross-site
 * POST, which is the actual CSRF-relevant protection). A present-but-
 * mismatched Origin header is rejected; a missing one is tolerated rather
 * than rejected, since some legitimate same-origin requests omit it — this
 * is additive hardening on top of the cookie behavior, not the sole
 * defense. Shared across every mutating v1 route (originally introduced
 * for POST /api/v1/organizations in M1.4) rather than reimplemented per
 * route.
 */
export function isSameOrigin(originHeader: string | null, requestUrl: string): boolean {
  if (!originHeader) return true;
  return originHeader === new URL(requestUrl).origin;
}
