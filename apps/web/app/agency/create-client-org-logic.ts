import { can } from "@ai-revenue-os/auth";
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

export async function createClientOrgForResolvedContext(
  agencyContext: { userId: string; agencyId: string; roleKey: string } | null,
  name: string,
): Promise<CreateClientOrgFormState> {
  if (!name.trim()) {
    return { error: "Organization name is required." };
  }
  // The role check goes through can() (M1.5's RBAC facade) rather than an
  // inline role-string comparison — same permission key
  // ("organizations:create-client") the API route checks, so both entry
  // points into the same underlying action stay behaviorally identical.
  // The explicit `!agencyContext` here is redundant with can()'s own null
  // handling at runtime (can(null, ...) already denies) — it's here purely
  // so TypeScript narrows agencyContext to non-null for the code below;
  // can() itself doesn't narrow, being just a boolean-returning function.
  if (!agencyContext || !can(agencyContext, "organizations:create-client")) {
    return { error: "You do not have permission to create client organizations." };
  }

  try {
    await createClientOrganizationForAgency(agencyContext.userId, agencyContext.agencyId, name.trim());
  } catch {
    return { error: "Failed to create the organization. Please try again." };
  }

  return {};
}
