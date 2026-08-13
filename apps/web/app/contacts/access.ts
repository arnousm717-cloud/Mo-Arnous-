import { can } from "@ai-revenue-os/auth";

/**
 * Mirrors apps/web/app/companies/access.ts exactly — same reasoning: a
 * pure decision function, directly testable, not reachable as an RPC
 * endpoint.
 */
export interface ContactsOrgContext {
  userId: string;
  organizationId: string;
  roleKey: string;
}

export type ContactsConsoleAccessDecision =
  | { kind: "redirect"; to: "/login" }
  | { kind: "redirect"; to: "/dashboard" }
  | { kind: "allow"; orgContext: ContactsOrgContext };

export function decideContactsConsoleAccess(
  userId: string | null,
  orgContext: Omit<ContactsOrgContext, "userId"> | null,
): ContactsConsoleAccessDecision {
  if (!userId) {
    return { kind: "redirect", to: "/login" };
  }
  if (!orgContext || !can({ userId, ...orgContext }, "contacts:read")) {
    return { kind: "redirect", to: "/dashboard" };
  }
  return { kind: "allow", orgContext: { userId, ...orgContext } };
}
