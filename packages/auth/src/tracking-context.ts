import { withTenantContext } from "@ai-revenue-os/database";

/**
 * Tracking-site context resolution (Milestone 3.1C-B). The public-tracking
 * counterpart to resolveOrganizationContextForUser (./request-context.ts):
 * that function bootstraps organization context from an already-known,
 * already-authenticated user id; this one bootstraps it from a public
 * tracking-site credential instead — no session, no JWT, no user at all.
 * Mirrors it in shape deliberately (null on no-match, no existingClient,
 * a bare withTenantContext({}) bootstrap call) rather than inventing a new
 * pattern for what is structurally the same kind of problem.
 *
 * Wraps exactly one thing: public.resolve_tracking_site(uuid)
 * (20260820090200) — the one function in the schema with no auth.uid()
 * guard, by design, since a public site key has no caller identity to
 * check. Takes no organizationId parameter (there is nothing here to
 * misuse), performs no ingestion, no consent write, no rate limiting —
 * those are 3.1C-C's own orchestration, built on top of this primitive.
 */

export interface TrackingSiteContext {
  trackingSiteId: string;
  organizationId: string;
}

interface ResolveTrackingSiteRow {
  organization_id: string;
}

/**
 * Resolves a public tracking-site credential to its trusted
 * organizationId. Returns null for a revoked or nonexistent site key —
 * deliberately indistinguishable, matching resolve_tracking_site()'s own
 * doctrine (proven at the DB layer by tracking-site-resolver.test.ts). A
 * genuine DB failure propagates as an ordinary thrown error, unwrapped.
 *
 * No existingClient: this is the bootstrap step, called before any
 * organizationId is known — nothing can precede it with a transaction to
 * join. Always opens its own withTenantContext({}) transaction, exactly
 * like resolve_tracking_site()'s own tests exercise it.
 */
export async function resolveOrganizationContextForTrackingSite(
  siteKey: string,
): Promise<TrackingSiteContext | null> {
  const row = await withTenantContext({}, async (client) => {
    const r = await client.query<ResolveTrackingSiteRow>("select * from public.resolve_tracking_site($1)", [
      siteKey,
    ]);
    return r.rows[0];
  });

  if (!row) {
    return null;
  }

  return { trackingSiteId: siteKey, organizationId: row.organization_id };
}
