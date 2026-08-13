import { can } from "@ai-revenue-os/auth";

/**
 * Kept out of page.tsx and out of any "use server" file — same reasoning
 * as apps/web/app/agency/access.ts / apps/web/app/data-subject-requests/
 * access.ts: a pure decision function, directly testable without a
 * running Next.js request context, not reachable as an RPC endpoint.
 */
export interface CompaniesOrgContext {
  userId: string;
  organizationId: string;
  roleKey: string;
}

export type CompaniesConsoleAccessDecision =
  | { kind: "redirect"; to: "/login" }
  | { kind: "redirect"; to: "/dashboard" }
  | { kind: "allow"; orgContext: CompaniesOrgContext };

/**
 * Not authenticated -> /login. Authenticated but without companies:read
 * (no org context at all — including a pure agency actor, who resolves to
 * null org context here exactly like the DSR console — or an org-scoped
 * role that simply isn't granted the key, though none currently exists
 * given the 2.1E matrix grants companies:read to every org-scoped role)
 * -> /dashboard, never Companies data.
 */
export function decideCompaniesConsoleAccess(
  userId: string | null,
  orgContext: Omit<CompaniesOrgContext, "userId"> | null,
): CompaniesConsoleAccessDecision {
  if (!userId) {
    return { kind: "redirect", to: "/login" };
  }
  if (!orgContext || !can({ userId, ...orgContext }, "companies:read")) {
    return { kind: "redirect", to: "/dashboard" };
  }
  return { kind: "allow", orgContext: { userId, ...orgContext } };
}
