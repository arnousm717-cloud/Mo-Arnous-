import { can } from "@ai-revenue-os/auth";

// Combines userId with the organization context, mirroring
// ResolvedAgencyContext's shape (packages/auth/src/agency-context.ts) —
// OrganizationContext alone (request-context.ts) deliberately omits userId
// since it's designed to be spread alongside a separately-known one, but
// every call site here needs the two together.
export interface DsrOrgContext {
  userId: string;
  organizationId: string;
  roleKey: string;
}

/**
 * Kept out of page.tsx and out of any "use server" file — same reasoning as
 * apps/web/app/agency/access.ts: a pure decision function, directly
 * testable without a running Next.js request context.
 */
export type DsrConsoleAccessDecision =
  | { kind: "redirect"; to: "/login" }
  | { kind: "redirect"; to: "/dashboard" }
  | { kind: "allow"; orgContext: DsrOrgContext };

/**
 * Not authenticated -> /login. Authenticated but not an org_admin of an
 * organization (no membership, or a lower-privilege role) -> /dashboard,
 * never DSR data (M1.6 Decision F: org_admin-only, and agency-scoped roles
 * get none of this either — this page has no agency-context branch at all).
 */
export function decideDsrConsoleAccess(
  userId: string | null,
  orgContext: Omit<DsrOrgContext, "userId"> | null,
): DsrConsoleAccessDecision {
  if (!userId) {
    return { kind: "redirect", to: "/login" };
  }
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:read")) {
    return { kind: "redirect", to: "/dashboard" };
  }
  return { kind: "allow", orgContext: { userId, ...orgContext } };
}
