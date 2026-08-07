import type { ResolvedAgencyContext } from "@ai-revenue-os/auth";

/**
 * Kept out of page.tsx and out of any "use server" file deliberately: a
 * pure decision function, not reachable as an RPC endpoint the way an
 * exported "use server" function would be, and not dependent on
 * next/headers (unlike getAuthenticatedUser()/resolveAgencyRequestContext()
 * themselves), so it's directly testable without a running Next.js request
 * context.
 */
export type AgencyConsoleAccessDecision =
  | { kind: "redirect"; to: "/login" }
  | { kind: "redirect"; to: "/dashboard" }
  | { kind: "allow"; agencyContext: ResolvedAgencyContext };

/**
 * Not authenticated at all -> /login. Authenticated but not agency staff
 * (an ordinary org-level user, or no membership at all) -> /dashboard,
 * never agency console data. These are deliberately different redirects —
 * collapsing them into one would either wrongly log out a legitimately
 * signed-in org-level user, or risk exposing agency data to one.
 */
export function decideAgencyConsoleAccess(
  userId: string | null,
  agencyContext: ResolvedAgencyContext | null,
): AgencyConsoleAccessDecision {
  if (!userId) {
    return { kind: "redirect", to: "/login" };
  }
  if (!agencyContext) {
    return { kind: "redirect", to: "/dashboard" };
  }
  return { kind: "allow", agencyContext };
}
