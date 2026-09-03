import { can } from "@ai-revenue-os/auth";

export interface DashboardActor {
  userId: string;
  organizationId: string;
  roleKey: string;
}

/**
 * Milestone 3.5D — content gate only, mirrors ./kpi-access.ts's exact
 * reasoning: /dashboard itself never redirects on this, only the Lead
 * Intelligence section's rendering (and the two domain calls behind it)
 * are skipped for a denied actor.
 *
 * contacts:read, not deals:read -- lead-score/contact intelligence is
 * fundamentally contact data (packages/intelligence/src/dashboard-
 * metrics.ts's getLeadScoreDistribution/getHighScoreContacts both join
 * against public.contacts), so the correct boundary is "can this actor
 * read contacts", not the deals permission the KPI/stage sections use.
 * No new dashboard-specific permission — contacts:read is granted to the
 * exact same three roles (org_admin/org_member/org_viewer) as deals:read
 * (packages/auth/src/permissions.ts), so this never diverges from the
 * KPI/stage sections' own visibility in practice today, but is the
 * semantically correct key to check.
 */
export function canViewLeadIntelligence(actor: DashboardActor | null): boolean {
  return can(actor, "contacts:read");
}
