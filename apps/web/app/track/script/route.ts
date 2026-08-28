import { withRequestLogging } from "../../api/v1/_shared/logger";
import { TRACKER_SCRIPT_SOURCE } from "./tracker-source";

// Node.js runtime is already this app's default for Route Handlers — see
// collect/route.ts's own identical comment. Declared explicitly for the
// same correctness-insurance reason, even though this handler itself
// touches no Node-only API.
export const runtime = "nodejs";

/**
 * GET /track/script (Milestone 3.1D). Serves the fixed, tenant-independent
 * tracking script verbatim — no DB lookup, no authentication, no secret,
 * no per-site generation. The site key is supplied by the installing
 * page's own `data-site-key` attribute, read by the script itself at
 * runtime; this route never sees or needs it.
 *
 * No CORS headers: unlike /track/collect and /track/consent (fetch/XHR
 * calls, genuinely CORS-governed), loading a script via <script src>
 * is not subject to CORS at all — applying the collect/consent
 * CORS_HEADERS here would be both unnecessary and semantically wrong
 * (this route accepts no cross-origin fetch, only classic script-tag
 * loading). No OPTIONS handler for the same reason — no preflight is
 * ever issued for a script-tag GET.
 */
const SCRIPT_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/javascript; charset=utf-8",
  // Fixed, tenant-independent content — safe to cache aggressively.
  // No cache-busting/versioning scheme exists yet, so this stays a
  // moderate, not maximal (non-"immutable"), duration.
  "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
};

function scriptResponse(): Response {
  return new Response(TRACKER_SCRIPT_SOURCE, { status: 200, headers: SCRIPT_RESPONSE_HEADERS });
}

export const GET = withRequestLogging("GET", "/track/script", (): Response => scriptResponse());
