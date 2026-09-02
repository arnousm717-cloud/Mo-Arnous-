import { createHash } from "node:crypto";
import { withTenantContext } from "@ai-revenue-os/database";

/**
 * Tenant-scoped rate limiting for enrichment triggers (Milestone 3.3,
 * Architecture Resolution Report §L). Reuses public.check_tracking_rate_limit()
 * (20260820110200) directly — Phase 0 of this milestone verified this
 * function is mechanically generic (an opaque bucket_hash string, a
 * window, and a limit; no tracking-specific coupling exists anywhere in
 * its actual SQL logic, only in its own name/comments) and therefore safe
 * to reuse for a second, unrelated surface without distorting anything —
 * bucket_hash is caller-computed with a namespace prefix ("enrichment:...")
 * distinct from every existing "<surface>:<dimension>:..." bucket, so
 * there is zero collision risk with the tracking rate-limit dimensions.
 *
 * Deliberately a separate module from apps/web/app/track/_shared/rate-limit.ts,
 * not an extension of it — that module's own header comment scopes it to
 * exactly one call-site family (the public /track/* routes); this
 * surface (an authenticated, machine-to-machine trigger) is a genuinely
 * different call-site family, even though it shares the same underlying
 * SQL primitive.
 */

const WINDOW_SECONDS = 60;
const LIMIT_PER_ORG_PER_MINUTE = 30;

interface CheckRateLimitRow {
  check_tracking_rate_limit: boolean;
}

function hashEnrichmentBucket(organizationId: string): string {
  return createHash("sha256").update(`enrichment:trigger:${organizationId}`, "utf8").digest("hex");
}

/**
 * Checks (and atomically increments) the enrichment-trigger rate limit
 * for one organization. Always opens its own independent, immediately-
 * committed transaction — same reasoning as checkTrackingRateLimit: a
 * rate-limit increment must remain committed even if the caller's later
 * work fails or rolls back.
 */
export async function checkEnrichmentTriggerRateLimit(organizationId: string): Promise<boolean> {
  const bucketHash = hashEnrichmentBucket(organizationId);
  return withTenantContext({}, async (client) => {
    const r = await client.query<CheckRateLimitRow>(
      "select public.check_tracking_rate_limit($1, $2, $3) as check_tracking_rate_limit",
      [bucketHash, WINDOW_SECONDS, LIMIT_PER_ORG_PER_MINUTE],
    );
    return r.rows[0]!.check_tracking_rate_limit;
  });
}
