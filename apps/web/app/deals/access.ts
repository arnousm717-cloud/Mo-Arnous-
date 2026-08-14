import { can } from "@ai-revenue-os/auth";

/**
 * Milestone 2.2E. Mirrors apps/web/app/contacts/access.ts exactly — same
 * reasoning: a pure decision function, directly testable, not reachable
 * as an RPC endpoint.
 */
export interface DealsOrgContext {
  userId: string;
  organizationId: string;
  roleKey: string;
}

export type DealsConsoleAccessDecision =
  | { kind: "redirect"; to: "/login" }
  | { kind: "redirect"; to: "/dashboard" }
  | { kind: "allow"; orgContext: DealsOrgContext };

export function decideDealsConsoleAccess(
  userId: string | null,
  orgContext: Omit<DealsOrgContext, "userId"> | null,
): DealsConsoleAccessDecision {
  if (!userId) {
    return { kind: "redirect", to: "/login" };
  }
  if (!orgContext || !can({ userId, ...orgContext }, "deals:read")) {
    return { kind: "redirect", to: "/dashboard" };
  }
  return { kind: "allow", orgContext: { userId, ...orgContext } };
}
