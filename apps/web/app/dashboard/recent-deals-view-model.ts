import type { Deal } from "@ai-revenue-os/crm";
import { dealDisplayLabel } from "../deals/deal-display";
import { formatAmount } from "./kpi-view-model";

/**
 * Milestone 3.5F — pure transform for the "Recently Created Deals"
 * dashboard section. `listDeals` is reused completely unchanged
 * (packages/crm/src/deals.ts already guarantees organization scope,
 * `deleted_at is null` exclusion, `order by created_at desc, id desc`,
 * and a bounded limit) — no new dashboard-specific query, no new join.
 *
 * `deals` has no title/name column (documented limitation,
 * apps/web/app/deals/deal-display.ts's own top comment) -- this reuses
 * that exact existing label function, called with no company/contact
 * name (deliberately not resolved here: doing so would require a new
 * join purely for decorative context, which this sub-phase's own
 * instruction forbids), so every row falls through to its established
 * `Deal <id prefix>` fallback -- never a raw, full UUID.
 */

export interface RecentDealLine {
  dealId: string;
  label: string;
  statusLabel: string;
  /** "<amount> <currency>", or "No amount" when amount is NULL -- NULL
   * is never displayed as 0/0.00/€0, and a genuine numeric zero (if one
   * is ever stored) renders as "0.00 <currency>", staying distinguishable
   * from the NULL case. */
  amountLabel: string;
  createdAtLabel: string;
}

const STATUS_LABELS: Record<Deal["status"], string> = {
  open: "Open",
  won: "Won",
  lost: "Lost",
};

// Fixed locale, same reasoning as kpi-view-model.ts's own AMOUNT_LOCALE --
// deterministic across deployments, never the process/ICU default.
const CREATED_AT_LOCALE = "en-US";

function formatCreatedAt(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString(CREATED_AT_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * No `.sort()`/re-ordering anywhere in this function -- `deals` is
 * rendered in exactly the order `listDeals` returned it
 * (created_at DESC, id DESC), never recomputed here. `createdAt` is the
 * only timestamp used; `updatedAt` never appears in this module at all.
 */
export function buildRecentDealsViewModel(deals: Deal[]): RecentDealLine[] {
  return deals.map((deal) => ({
    dealId: deal.id,
    label: dealDisplayLabel(deal.id, null, null),
    statusLabel: STATUS_LABELS[deal.status],
    amountLabel: deal.amount !== null ? `${formatAmount(deal.amount)} ${deal.currency}` : "No amount",
    createdAtLabel: formatCreatedAt(deal.createdAt),
  }));
}
