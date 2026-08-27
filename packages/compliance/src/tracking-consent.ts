import type { PoolClient } from "pg";
import { runInClientOrTransaction } from "@ai-revenue-os/database";

/**
 * Visitor cookie-tracking consent writer (Milestone 3.1C-B). Deliberately
 * a separate file from ./consent.ts's staff-authenticated recordConsent()
 * — that function requires {userId, organizationId, roleKey} and is gated
 * by consent_records' own org_admin-only INSERT policy; this one is the
 * visitor's own, unauthenticated write path, with no tenant context to
 * receive at all. Keeping them visibly distinct mirrors how
 * packages/intelligence/src/consent.ts (a read-only counterpart) is its
 * own file rather than folded into anything else.
 *
 * Wraps exactly one thing: public.record_visitor_cookie_tracking_consent
 * (p_site_key, p_anonymous_id, p_status) (20260820110300) — no
 * organizationId, no IP, no userId, no roleKey, no arbitrary subject_type/
 * consent_type/source parameter exists here to misuse, because none
 * exists on the underlying function either.
 */

export type TrackingConsentStatus = "granted" | "withdrawn";

interface RecordConsentRow {
  record_visitor_cookie_tracking_consent: boolean;
}

/**
 * Records a visitor's own cookie-tracking consent decision for a given
 * public tracking-site credential. Returns false — never throws — for a
 * revoked or nonexistent site key, matching the underlying function's own
 * doctrine (indistinguishable, nothing written). status is restricted to
 * "granted" | "withdrawn" at the type level — no other value can compile,
 * so the database's own guard against an invalid status is unreachable
 * from a well-typed caller. A genuine DB failure propagates as an
 * ordinary thrown error, unwrapped.
 *
 * No ctx parameter: this pathway has no legitimate tenant context to
 * receive (organizationId is resolved internally by the SECURITY DEFINER
 * function itself, never supplied here), so runInClientOrTransaction is
 * called with a literal empty context, closing off even an accidental
 * organizationId pass-through. existingClient is optional, included for
 * consistency with every other DB-writing wrapper in this codebase
 * (recordConsent, packages/intelligence's own mutation functions) even
 * though no current caller composes this into a larger transaction.
 */
export async function recordVisitorCookieTrackingConsent(
  siteKey: string,
  anonymousId: string,
  status: TrackingConsentStatus,
  existingClient?: PoolClient,
): Promise<boolean> {
  return runInClientOrTransaction({}, existingClient, async (client) => {
    const r = await client.query<RecordConsentRow>(
      "select public.record_visitor_cookie_tracking_consent($1, $2, $3) as record_visitor_cookie_tracking_consent",
      [siteKey, anonymousId, status],
    );
    return r.rows[0]!.record_visitor_cookie_tracking_consent;
  });
}
