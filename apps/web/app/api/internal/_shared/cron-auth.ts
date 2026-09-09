import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared by every /api/internal/* cron-driven route (Milestone 3.3F's own
 * `dispatch-events` route originally defined this privately; Milestone
 * 4.1 Phase 5's recovery route needs the identical check, so this is
 * extracted here rather than duplicated a second time).
 *
 * Hashes both sides first, the same discipline `verifyApiKey`
 * (`packages/auth/src/api-keys.ts`) already established, so
 * `timingSafeEqual` never has to handle variable-length inputs (it throws
 * on a length mismatch, which would itself leak length information via
 * the exception path).
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a, "utf8").digest();
  const hashB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(hashA, hashB);
}
