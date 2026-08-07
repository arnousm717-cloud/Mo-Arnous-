import { withTenantContext } from "@ai-revenue-os/database";
import { getAuthenticatedUser } from "./session";

export interface ResolvedRequestContext {
  userId: string;
  organizationId?: string;
  agencyId?: string;
  roleKey?: string;
}

export interface OrganizationContext {
  organizationId: string;
  agencyId?: string;
  roleKey: string;
}

interface MembershipContextRow {
  organization_id: string;
  agency_id: string | null;
  role_key: string;
}

/**
 * Lower-level: resolves organization context for an already-known,
 * already-authenticated user id, without calling getAuthenticatedUser()
 * itself. Exists so a caller that needs both organization and agency
 * context in one request (e.g. GET /api/v1/organizations) can authenticate
 * once and resolve both, rather than re-authenticating per resolver — see
 * resolveAgencyContextForUser in ./agency-context.ts for the counterpart.
 */
export async function resolveOrganizationContextForUser(userId: string): Promise<OrganizationContext | null> {
  // get_my_membership_context() is a SECURITY DEFINER function scoped to
  // auth.uid() internally, callable safely with only userId set — it
  // solves the same bootstrapping problem ADR-003 solved for signup itself.
  const membership = await withTenantContext({ userId }, async (client) => {
    const r = await client.query<MembershipContextRow>("select * from public.get_my_membership_context()");
    return r.rows[0];
  });

  if (!membership) {
    return null;
  }

  // exactOptionalPropertyTypes forbids assigning `undefined` to an optional
  // property explicitly — it must be entirely omitted when there's no
  // agency, not present-with-undefined-value, hence the conditional spread.
  return {
    organizationId: membership.organization_id,
    ...(membership.agency_id ? { agencyId: membership.agency_id } : {}),
    roleKey: membership.role_key,
  };
}

/**
 * The per-request tenant-context resolution API middleware performs
 * (docs/03-Database-Architecture.md §5, ADR-004). Returns null if there is
 * no authenticated user at all; returns a context with only `userId` set
 * if the user is authenticated but has no organization yet (route that case
 * to onboarding, not an error page).
 */
export async function resolveRequestContext(): Promise<ResolvedRequestContext | null> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return null;
  }

  const org = await resolveOrganizationContextForUser(user.id);
  if (!org) {
    return { userId: user.id };
  }

  return { userId: user.id, ...org };
}
