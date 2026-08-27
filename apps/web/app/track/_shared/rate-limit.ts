import { createHash } from "node:crypto";
import { withTenantContext } from "@ai-revenue-os/database";

/**
 * Tracking rate-limit application wrapper (Milestone 3.1C-B). The one
 * caller of public.check_tracking_rate_limit() (20260820110200) — computes
 * an opaque bucket hash application-side (never a raw identifier reaching
 * the database, per that function's own storage contract) and supplies
 * the approved, trusted configuration for the six rate-limit dimensions
 * 3.1C-C's future collect/consent routes will need.
 *
 * Lives in apps/web, not a package — same reasoning as
 * apps/api/v1/_shared/idempotency.ts: a cross-cutting, HTTP-adjacent
 * utility with exactly one call site family (this app's own future
 * /track/* routes), not a reusable domain primitive any other package
 * needs.
 *
 * Hashing mirrors apps/web/app/api/v1/_shared/idempotency.ts's own
 * sha256Hex exactly (createHash("sha256").update(input, "utf8").digest
 * ("hex")) — not reinvented.
 */

export type RateLimitSurface = "collect" | "consent";
export type RateLimitDimension = "anon" | "ip" | "site";

// Fixed at exactly 60 — the approved production configuration for every
// dimension. Not a parameter: nothing here lets a caller supply a
// different value, closing off the exact caller-controlled-window class
// of bug 3.1C-A's own design review rejected at the database layer.
const WINDOW_SECONDS = 60;

// Trusted, hardcoded configuration — never derived from request data.
// collect: 60/600/6000 per minute (anon/IP/site). consent: 10/100/1000
// per minute. Both well under check_tracking_rate_limit()'s own <= 86400
// upper bound (60s here, vs. an 86400s ceiling).
const LIMITS: Record<RateLimitSurface, Record<RateLimitDimension, number>> = {
  collect: { anon: 60, ip: 600, site: 6000 },
  consent: { anon: 10, ip: 100, site: 1000 },
};

interface CheckRateLimitRow {
  check_tracking_rate_limit: boolean;
}

export interface RateLimitConfig {
  windowSeconds: number;
  limit: number;
}

/**
 * Exposes the trusted (surface, dimension) -> (windowSeconds, limit)
 * mapping as a small, pure, directly-testable function — so the six
 * approved numeric limits can be verified without either driving a real
 * request all the way to a 600/6000-call threshold in a test, or mocking
 * the database client. checkTrackingRateLimit itself always uses this
 * exact same configuration; nothing else in this module can diverge from
 * it, since both read from the same LIMITS/WINDOW_SECONDS source.
 */
export function getRateLimitConfig(surface: RateLimitSurface, dimension: RateLimitDimension): RateLimitConfig {
  return { windowSeconds: WINDOW_SECONDS, limit: LIMITS[surface][dimension] };
}

/**
 * Computes the opaque bucket hash for one (surface, dimension, identifier)
 * triple — canonical input "<surface>:<dimension>:<identifier>", then
 * SHA-256 lowercase hex. Exported narrowly (not the whole module's
 * internals) so the hashing contract itself — determinism, namespace
 * separation, no raw identifier ever appearing in the digest — is
 * directly unit-testable without a live database, mirroring
 * hashIdempotencyKey/computeRequestFingerprint's own exported-for-testing
 * precedent in idempotency.ts. No salt, no nonce: rate-limit keys must be
 * deterministic — the same identifier must always hash to the same
 * bucket, or the limiter would never accumulate a count against it.
 */
export function hashTrackingRateLimitBucket(
  surface: RateLimitSurface,
  dimension: RateLimitDimension,
  identifier: string,
): string {
  return createHash("sha256").update(`${surface}:${dimension}:${identifier}`, "utf8").digest("hex");
}

/**
 * Checks (and atomically increments) one rate-limit dimension. `identifier`
 * is the raw value for that dimension (an anonymousId, a normalized IP, or
 * — per the accepted trust-boundary contract — the RESOLVED, TRUSTED
 * trackingSiteId, never a pre-resolution request-supplied site key); this
 * function hashes it before it ever reaches a SQL parameter, so no raw
 * identifier is ever persisted into rate_limit_counters.
 *
 * window_seconds and limit are never caller-suppliable — both come
 * exclusively from this module's own trusted configuration, selected by
 * (surface, dimension). Always opens its own independent, immediately-
 * committed withTenantContext({}) transaction — no existingClient
 * parameter exists here at all, by design: a rate-limit increment must
 * remain committed even if later business logic (ingestion, consent
 * write) fails or rolls back, so it can never be composed into that
 * transaction. A genuine DB failure propagates as an ordinary thrown
 * error — never swallowed here.
 */
export async function checkTrackingRateLimit(
  surface: RateLimitSurface,
  dimension: RateLimitDimension,
  identifier: string,
): Promise<boolean> {
  const bucketHash = hashTrackingRateLimitBucket(surface, dimension, identifier);
  const limit = LIMITS[surface][dimension];

  return withTenantContext({}, async (client) => {
    const r = await client.query<CheckRateLimitRow>(
      "select public.check_tracking_rate_limit($1, $2, $3) as check_tracking_rate_limit",
      [bucketHash, WINDOW_SECONDS, limit],
    );
    return r.rows[0]!.check_tracking_rate_limit;
  });
}
