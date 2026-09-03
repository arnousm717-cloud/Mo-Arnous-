import type { DealDashboardMetrics, CurrencyAmount } from "@ai-revenue-os/crm";

/**
 * Milestone 3.5B — pure transform from the M3.5A domain aggregate into
 * display-ready strings. No currency conversion or combination happens
 * here, or anywhere else in this codebase (Milestone 3.5 locked decision
 * #2) — every monetary value stays tagged with its own currency, exactly
 * as packages/crm/src/dashboard-metrics.ts already grouped it.
 *
 * Amounts render as "<formatted number> <currency code>" — the same
 * suffix convention apps/web/app/deals/board/page.tsx already uses for
 * a deal's amountLabel — never Intl's currency-symbol style.
 * `deals.currency` is only regex-validated as three uppercase letters
 * (packages/crm/src/deals.ts), not restricted to real ISO 4217 codes, and
 * `Intl.NumberFormat(..., { style: "currency", currency })` throws for an
 * unrecognized code — a crash this dashboard must never risk over a
 * data-entry quirk. `toLocaleString` without a currency style never
 * validates the code at all, so it can't fail this way.
 */

export interface CurrencyLine {
  currency: string;
  formattedAmount: string;
}

export interface DealKpiViewModel {
  openDealCount: number;
  openPipelineValueLines: CurrencyLine[];
  nullAmountDisclosure: string | null;
  winRateLabel: string;
  averageOpenDealSizeLines: CurrencyLine[];
}

// Fixed locale, deliberately not `undefined` (the process/ICU default) --
// this dashboard must render identical digit grouping regardless of the
// server's own locale environment, not vary by deployment.
const AMOUNT_LOCALE = "en-US";

/** Exported for reuse by ./recent-deals-view-model.ts (Milestone 3.5F) --
 * identical formatting need, not duplicated. */
export function formatAmount(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value)
    ? value.toLocaleString(AMOUNT_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : amount;
}

function toCurrencyLines(amounts: CurrencyAmount[]): CurrencyLine[] {
  return amounts.map((a) => ({ currency: a.currency, formattedAmount: formatAmount(a.totalAmount) }));
}

function formatNullAmountDisclosure(count: number): string | null {
  if (count <= 0) {
    return null;
  }
  return count === 1 ? "1 open deal has no amount set." : `${count} open deals have no amount set.`;
}

/** `null` denominator (no closed deals at all) renders as a truthful
 * "no data yet" label, never "0%" — matching getDealDashboardMetrics'
 * own null-over-zero discipline exactly. */
function formatWinRateLabel(winRate: number | null): string {
  if (winRate === null) {
    return "No closed deals yet";
  }
  return `${Math.round(winRate * 100)}%`;
}

export function buildDealKpiViewModel(metrics: DealDashboardMetrics): DealKpiViewModel {
  return {
    openDealCount: metrics.openDealCount,
    openPipelineValueLines: toCurrencyLines(metrics.openPipelineValueByCurrency),
    nullAmountDisclosure: formatNullAmountDisclosure(metrics.openDealsWithNullAmountCount),
    winRateLabel: formatWinRateLabel(metrics.winRate),
    averageOpenDealSizeLines: toCurrencyLines(metrics.averageOpenDealSizeByCurrency),
  };
}
