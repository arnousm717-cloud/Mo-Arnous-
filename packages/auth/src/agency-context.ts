import { withTenantContext } from "@ai-revenue-os/database";
import { getAuthenticatedUser } from "./session";

export interface ResolvedAgencyContext {
  userId: string;
  agencyId: string;
  roleKey: string;
}

export interface AgencyMembershipContext {
  agencyId: string;
  roleKey: string;
}

interface AgencyContextRow {
  agency_id: string;
  role_key: string;
}

/**
 * Agency-scoped counterpart to resolveOrganizationContextForUser
 * (./request-context.ts) — deliberately separate per ADR-005: organization
 * context and agency context answer different questions and are never
 * conflated into one ambiguous resolution path. Lower-level: takes an
 * already-known user id, doesn't re-authenticate.
 */
export async function resolveAgencyContextForUser(userId: string): Promise<AgencyMembershipContext | null> {
  // get_my_agency_context() is a SECURITY DEFINER function scoped to
  // auth.uid() internally (M1.4 foundation checkpoint) — same bootstrapping
  // reasoning as get_my_membership_context().
  const agency = await withTenantContext({ userId }, async (client) => {
    const r = await client.query<AgencyContextRow>("select * from public.get_my_agency_context()");
    return r.rows[0];
  });

  if (!agency) {
    return null;
  }

  return { agencyId: agency.agency_id, roleKey: agency.role_key };
}

/**
 * Full per-request agency-context resolution, for callers that only need
 * agency context (not both). Returns null if there is no authenticated
 * user, or the authenticated user has no agency-level membership at all.
 */
export async function resolveAgencyRequestContext(): Promise<ResolvedAgencyContext | null> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return null;
  }

  const agency = await resolveAgencyContextForUser(user.id);
  if (!agency) {
    return null;
  }

  return { userId: user.id, ...agency };
}
