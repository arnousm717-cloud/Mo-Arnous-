import type { PoolClient } from "pg";
import { runInClientOrTransaction, type RequestContext } from "@ai-revenue-os/database";

/**
 * Consent check (Milestone 3.1B). Never SELECTs consent_records
 * directly — that table's own RLS is org_admin-only (M1.6), which the
 * role-less ingestion pathway can never satisfy (proven empirically
 * during the 3.1B pre-implementation audit). The only access path is
 * the narrow, purpose-built check_visitor_cookie_tracking_consent()
 * SECURITY DEFINER function (20260820100100) — this function does not,
 * and must not, loosen or bypass that table's existing policies for any
 * other caller.
 *
 * Returns a plain boolean, deliberately indistinguishable between "no
 * consent recorded" and "latest consent withdrawn" — mirrors the
 * database function's own doctrine, not re-decided here.
 */
export async function checkCookieTrackingConsent(
  ctx: RequestContext & { organizationId: string },
  anonymousId: string,
  existingClient?: PoolClient,
): Promise<boolean> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const r = await client.query<{ check_visitor_cookie_tracking_consent: boolean }>(
      "select public.check_visitor_cookie_tracking_consent($1, $2) as check_visitor_cookie_tracking_consent",
      [ctx.organizationId, anonymousId],
    );
    return r.rows[0]!.check_visitor_cookie_tracking_consent;
  });
}
