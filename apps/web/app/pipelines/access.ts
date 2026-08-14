import { can } from "@ai-revenue-os/auth";

/**
 * Milestone 2.2F. Mirrors apps/web/app/deals/access.ts exactly — same
 * reasoning: a pure decision function, directly testable, not reachable
 * as an RPC endpoint. Gated on pipelines:read (the frozen 2.2C matrix
 * already grants this to org_admin/org_member/org_viewer only — no RBAC
 * change made or needed by this milestone).
 */
export interface PipelinesOrgContext {
  userId: string;
  organizationId: string;
  roleKey: string;
}

export type PipelinesConsoleAccessDecision =
  | { kind: "redirect"; to: "/login" }
  | { kind: "redirect"; to: "/dashboard" }
  | { kind: "allow"; orgContext: PipelinesOrgContext };

export function decidePipelinesConsoleAccess(
  userId: string | null,
  orgContext: Omit<PipelinesOrgContext, "userId"> | null,
): PipelinesConsoleAccessDecision {
  if (!userId) {
    return { kind: "redirect", to: "/login" };
  }
  if (!orgContext || !can({ userId, ...orgContext }, "pipelines:read")) {
    return { kind: "redirect", to: "/dashboard" };
  }
  return { kind: "allow", orgContext: { userId, ...orgContext } };
}
