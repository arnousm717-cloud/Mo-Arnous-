import { withTenantContext } from "@ai-revenue-os/database";
import { getAuthenticatedUser } from "./session";

export interface ResolvedRequestContext {
  userId: string;
  organizationId?: string;
  agencyId?: string;
  roleKey?: string;
}

interface MembershipContextRow {
  organization_id: string;
  agency_id: string | null;
  role_key: string;
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

  // get_my_membership_context() is a SECURITY DEFINER function scoped to
  // auth.uid() internally, callable safely with only userId set — it
  // solves the same bootstrapping problem ADR-003 solved for signup itself.
  const membership = await withTenantContext({ userId: user.id }, async (client) => {
    const r = await client.query<MembershipContextRow>("select * from public.get_my_membership_context()");
    return r.rows[0];
  });

  if (!membership) {
    return { userId: user.id };
  }

  // exactOptionalPropertyTypes forbids assigning `undefined` to an optional
  // property explicitly — it must be entirely omitted when there's no
  // agency, not present-with-undefined-value, hence the conditional spread.
  return {
    userId: user.id,
    organizationId: membership.organization_id,
    ...(membership.agency_id ? { agencyId: membership.agency_id } : {}),
    roleKey: membership.role_key,
  };
}
