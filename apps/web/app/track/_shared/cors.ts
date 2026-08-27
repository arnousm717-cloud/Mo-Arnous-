/**
 * CORS contract for the public /track/* routes (Milestone 3.1C-C). These
 * are deliberately, correctly cross-origin-open by design — a tracking
 * beacon embedded on an arbitrary third-party site must be callable from
 * that site's own origin. This is the opposite security posture of every
 * existing authenticated /api/v1 route, which relies on
 * _shared/same-origin.ts's isSameOrigin() as CSRF defense-in-depth on top
 * of a session cookie — that helper must never be applied here, and no
 * origin allowlist is used: there is no session cookie at risk for an
 * anonymous, credential-less public write.
 *
 * Applied to EVERY response class (204/400/413/429/500) — a CORS-blocked
 * preflight would otherwise hide the real error from a legitimate
 * embedding page, defeating the whole point of the non-oracle response
 * design elsewhere in this milestone.
 */

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Expose-Headers": "Retry-After, X-RateLimit-Remaining",
};

/** Applies the CORS headers to an existing Headers instance, in place. */
export function applyCorsHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
}

/** The OPTIONS preflight response — 204, empty body, CORS headers only. */
export function corsPreflightResponse(): Response {
  const headers = new Headers();
  applyCorsHeaders(headers);
  return new Response(null, { status: 204, headers });
}
