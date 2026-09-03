import { can } from "@ai-revenue-os/auth";

export interface DashboardActor {
  userId: string;
  organizationId: string;
  roleKey: string;
}

/**
 * Milestone 3.5B — content gate only, never a page-level redirect.
 * /dashboard stays reachable by every authenticated user regardless of
 * role: it is the universal landing page and the redirect target every
 * decideXConsoleAccess (apps/web/app/{contacts,deals,companies}/access.ts)
 * falls back to for a denied actor. Redirecting away from here on a
 * missing deals:read would loop agency_owner/agency_admin/portal_customer
 * straight back to the page that just redirected them here.
 *
 * No new permission key — reuses the existing deals:read grant exactly
 * as apps/web/app/deals/board/page.tsx's own access decision does.
 */
export function canViewDealKpis(actor: DashboardActor | null): boolean {
  return can(actor, "deals:read");
}
