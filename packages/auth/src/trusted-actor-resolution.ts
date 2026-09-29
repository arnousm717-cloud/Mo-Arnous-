import { withTenantContext } from "@ai-revenue-os/database";
import { PERMISSION_MATRIX, type Actor } from "./permissions";

/**
 * M4.3 Step 2A — trusted worker-side Actor resolution (docs/13-Technical-
 * Design-Review.md "Milestone 4.3" Step 2 design audit's §5 RBAC gap).
 *
 * Every existing resolver in this package (resolveRequestContext,
 * resolveOrganizationContextForUser, resolveAgencyContextForUser) starts
 * from a live, browser-issued Supabase session (getAuthenticatedUser()).
 * A future background worker executing an agent_runs row has no such
 * session — there is no browser, no cookie, no JWT to re-verify. This
 * resolver exists for exactly that caller: a trusted, non-request-scoped
 * server process that already knows a real userId (agent_runs.triggered_by)
 * and the exact organizationId the run itself is scoped to (agent_runs.
 * organization_id), and needs the same Actor shape can() already expects.
 *
 * This does NOT introduce a new authorization model. It reuses the exact
 * same primitives every other resolver in this file already uses:
 * withTenantContext (sets request.jwt.claims/app.current_org exactly like
 * every Route Handler already does — nothing here is a new trust
 * mechanism), the real memberships/roles/organizations schema, the
 * existing Actor type, and the existing PERMISSION_MATRIX as the single
 * source of truth for which role keys are real. can()/PermissionKey are
 * completely untouched by this file.
 *
 * SECURITY MODEL: this function verifies EXACT membership in the CALLER-
 * SUPPLIED organizationId, never "any organization this user belongs to."
 * get_my_membership_context() (the existing session-based resolver's own
 * underlying SQL function) cannot be reused here for that reason — it
 * resolves only a user's single default_organization_id membership, with
 * no parameter to cross-check against a specific expected org, which is
 * exactly the multi-org bleed this function exists to prevent. A caller
 * with a real, active membership in some OTHER organization must never
 * resolve an Actor scoped to the organization actually being asked about.
 *
 * No new SQL function was added for this. RLS's own memberships_tenant_
 * isolation_select policy already scopes visible rows to
 * organization_id = current_org() (set here to the caller's own
 * expectedOrganizationId), and the query below repeats both userId and
 * organizationId explicitly in its own WHERE clause on top of that — the
 * same "neither layer alone is trusted as sufficient" defense-in-depth
 * docs/08-Security.md §2 already establishes for can()'s own
 * ResourceContext check. A SECURITY DEFINER RPC was deliberately not
 * introduced: nothing here needs to run with elevated privilege beyond
 * what the ordinary authenticated-role, RLS-scoped path already grants
 * once both trusted inputs are known up front, unlike
 * get_my_membership_context()'s own genuine chicken-and-egg bootstrap
 * problem (organizationId is never unknown here — the caller always
 * supplies it).
 *
 * NULL triggered_by: agent_runs.triggered_by is `string | null`. This
 * function's own signature requires a real userId string — a caller with
 * a null triggered_by must reject before ever calling this function (or
 * pass no call at all); there is deliberately no "system actor" fallback
 * here. A scheduled/autonomous trigger with no human actor is an
 * unresolved design question for a future milestone, not something this
 * resolver papers over with an invented permission-bearing identity.
 * ServiceActor (service-auth.ts) is a distinct, deliberately separate
 * mechanism for machine API-key credentials — never reused as a stand-in
 * human Actor here, per that file's own explicit "NOT an Actor" doctrine.
 */

interface MembershipLookupRow {
  role_key: string;
  agency_id: string | null;
}

function isKnownRoleKey(roleKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(PERMISSION_MATRIX, roleKey);
}

/**
 * Resolves a trusted, already-known userId to an Actor, scoped to and
 * verified against the caller-supplied expectedOrganizationId only.
 *
 * Returns null (never throws) for: an empty/missing userId or
 * organizationId, no membership row for that exact (user, org) pair, a
 * membership whose status is not 'active' (invited/removed both fail
 * closed, matching get_my_membership_context()'s own identical status
 * filter), or a role_key this package's own PERMISSION_MATRIX doesn't
 * recognize. A genuine database failure still propagates as an ordinary
 * thrown error, unwrapped — same contract resolveServiceActorFromApiKey
 * already documents for itself.
 */
export async function resolveTrustedActorForOrganization(
  userId: string,
  organizationId: string,
): Promise<Actor | null> {
  if (!userId || !organizationId) {
    return null;
  }

  const row = await withTenantContext({ userId, organizationId }, async (client) => {
    const r = await client.query<MembershipLookupRow>(
      `select r.key as role_key, o.agency_id
         from public.memberships m
         join public.roles r on r.id = m.role_id
         join public.organizations o on o.id = m.organization_id
        where m.user_id = $1
          and m.organization_id = $2
          and m.status = 'active'`,
      [userId, organizationId],
    );
    return r.rows[0];
  });

  if (!row) {
    return null;
  }

  if (!isKnownRoleKey(row.role_key)) {
    return null;
  }

  return {
    userId,
    roleKey: row.role_key,
    organizationId,
    ...(row.agency_id ? { agencyId: row.agency_id } : {}),
  };
}
