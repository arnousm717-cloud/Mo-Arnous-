import { createClientOrganizationForAgency } from "@ai-revenue-os/tenancy";

/**
 * Kept out of actions.ts ("use server") deliberately: every export of a
 * "use server" file becomes an independently callable RPC endpoint, so a
 * function that TRUSTS an already-resolved agencyContext parameter must
 * never live there — a client could otherwise invoke it directly with a
 * fabricated context, bypassing resolveAgencyRequestContext() entirely.
 * This plain module is only ever reachable via an internal import from
 * actions.ts, which resolves the real context itself before calling in —
 * same reasoning as apps/web/app/api/v1/organizations/handlers.ts's split
 * from route.ts, and it's what makes this directly testable too.
 */

export interface CreateClientOrgFormState {
  error?: string;
}

const AGENCY_WRITE_ROLES = new Set(["agency_owner", "agency_admin"]);

export async function createClientOrgForResolvedContext(
  agencyContext: { userId: string; agencyId: string; roleKey: string } | null,
  name: string,
): Promise<CreateClientOrgFormState> {
  if (!name.trim()) {
    return { error: "Organization name is required." };
  }
  if (!agencyContext || !AGENCY_WRITE_ROLES.has(agencyContext.roleKey)) {
    return { error: "You do not have permission to create client organizations." };
  }

  try {
    await createClientOrganizationForAgency(agencyContext.userId, agencyContext.agencyId, name.trim());
  } catch {
    return { error: "Failed to create the organization. Please try again." };
  }

  return {};
}
