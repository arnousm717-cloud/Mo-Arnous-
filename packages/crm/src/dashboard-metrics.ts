import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";

/**
 * Milestone 3.5A — organization-wide deal aggregates for Dashboard v1.
 * Deliberately narrow: this is not a generic analytics/query framework,
 * only the handful of aggregate reads Dashboard v1 actually needs, each
 * a single SQL aggregate query, never a fetch-everything-then-sum-in-Node
 * pattern (packages/crm has no precedent for that, and neither does this
 * module).
 *
 * Product decisions locked for Milestone 3.5 (this module enforces every
 * one of them structurally, not merely by convention):
 *   - Never label a sum "revenue" — this module's own naming is
 *     `wonDealValueByCurrency`, not `revenue`; there is no realized-
 *     revenue ledger anywhere in this schema (no invoice/payment/
 *     subscription table exists) to back that stronger claim.
 *   - Currencies are NEVER combined — every monetary aggregate is grouped
 *     by `currency` and returned as a per-currency array, never summed
 *     into one number. `deals.currency` is validated only against the
 *     three-letter format (packages/crm/src/deals.ts), not a fixed
 *     single-currency enum, so a single organization can genuinely hold
 *     deals in more than one currency — this module never assumes
 *     otherwise.
 *   - Organization-wide across ALL active pipelines — no pipeline filter
 *     is applied anywhere in this module; a future pipeline-scoped view
 *     is explicitly out of this milestone's scope.
 *   - No weighted pipeline, no forecast, no velocity, no period-based
 *     "won revenue" — `deals` has no `won_at`/`lost_at`/`closed_at`
 *     column and no stage-transition history table exists anywhere in
 *     this schema (verified directly against every migration), so none
 *     of those are truthfully derivable. `updated_at` is never used as a
 *     stand-in — it changes on any field edit, not only a status
 *     transition, and would misrepresent when a deal was actually won.
 */

export interface CurrencyAmount {
  currency: string;
  /** Postgres `numeric` comes back as a string — matched honestly here,
   * same discipline `deals.ts`'s own `Deal.amount` already established. */
  totalAmount: string;
}

export interface DealsByStageMetric {
  stageId: string;
  stageName: string;
  pipelineId: string;
  pipelineName: string;
  dealCount: number;
}

export interface DealDashboardMetrics {
  openDealCount: number;
  /** Open deals with `amount IS NULL` — NULL is never treated as zero
   * anywhere in this module; this count exists so a caller can disclose
   * how many open deals were excluded from the value/average sums below. */
  openDealsWithNullAmountCount: number;
  openPipelineValueByCurrency: CurrencyAmount[];
  averageOpenDealSizeByCurrency: CurrencyAmount[];
  wonDealCount: number;
  lostDealCount: number;
  /** `won / (won + lost)`, never `won / (won + lost + open)` — an open
   * deal has no outcome yet and must never dilute the ratio. `null` when
   * the denominator is zero (no closed deals at all) — never `0`, which
   * would falsely read as "no wins" rather than "no data yet". */
  winRate: number | null;
  wonDealValueByCurrency: CurrencyAmount[];
  dealsByStage: DealsByStageMetric[];
}

interface StatusCountsRow {
  open_count: string;
  won_count: string;
  lost_count: string;
  open_null_amount_count: string;
}

interface CurrencyAggregateRow {
  currency: string;
  total_amount: string;
}

interface StageRow {
  stage_id: string;
  stage_name: string;
  pipeline_id: string;
  pipeline_name: string;
  deal_count: string;
}

/**
 * The one entry point this module exposes. Organization scope comes
 * exclusively from `ctx.organizationId`, resolved server-side by the
 * caller exactly like every other `packages/crm` function — this
 * function has no parameter through which a caller could supply a
 * different organization id. Every query excludes soft-deleted deals
 * (`deleted_at is null`) and soft-deleted pipelines/stages, matching the
 * established convention every other list function in this package
 * already applies.
 */
export async function getDealDashboardMetrics(
  ctx: RequestContext & { organizationId: string },
): Promise<DealDashboardMetrics> {
  return withTenantContext(ctx, async (client) => {
    const statusCounts = await client.query<StatusCountsRow>(
      `select
         count(*) filter (where status = 'open')::text as open_count,
         count(*) filter (where status = 'won')::text as won_count,
         count(*) filter (where status = 'lost')::text as lost_count,
         count(*) filter (where status = 'open' and amount is null)::text as open_null_amount_count
       from public.deals
       where organization_id = $1 and deleted_at is null`,
      [ctx.organizationId],
    );
    const counts = statusCounts.rows[0]!;
    const openDealCount = Number(counts.open_count);
    const wonDealCount = Number(counts.won_count);
    const lostDealCount = Number(counts.lost_count);
    const openDealsWithNullAmountCount = Number(counts.open_null_amount_count);
    const closedCount = wonDealCount + lostDealCount;
    const winRate = closedCount === 0 ? null : wonDealCount / closedCount;

    const openValueRows = await client.query<CurrencyAggregateRow & { average_amount: string }>(
      `select currency, sum(amount)::text as total_amount, avg(amount)::text as average_amount
       from public.deals
       where organization_id = $1 and deleted_at is null and status = 'open' and amount is not null
       group by currency
       order by currency`,
      [ctx.organizationId],
    );
    const openPipelineValueByCurrency: CurrencyAmount[] = openValueRows.rows.map((r) => ({
      currency: r.currency,
      totalAmount: r.total_amount,
    }));
    const averageOpenDealSizeByCurrency: CurrencyAmount[] = openValueRows.rows.map((r) => ({
      currency: r.currency,
      totalAmount: r.average_amount,
    }));

    const wonValueRows = await client.query<CurrencyAggregateRow>(
      `select currency, sum(amount)::text as total_amount
       from public.deals
       where organization_id = $1 and deleted_at is null and status = 'won' and amount is not null
       group by currency
       order by currency`,
      [ctx.organizationId],
    );
    const wonDealValueByCurrency: CurrencyAmount[] = wonValueRows.rows.map((r) => ({
      currency: r.currency,
      totalAmount: r.total_amount,
    }));

    // Organization-wide across every active pipeline (Milestone 3.5
    // locked decision #3) — no pipeline filter anywhere in this query.
    // A left join keeps a stage with zero deals visible at count 0,
    // rather than silently disappearing from the result.
    const stageRows = await client.query<StageRow>(
      `select
         ps.id as stage_id,
         ps.name as stage_name,
         ps.pipeline_id as pipeline_id,
         p.name as pipeline_name,
         count(d.id)::text as deal_count
       from public.pipeline_stages ps
       join public.pipelines p
         on p.id = ps.pipeline_id and p.organization_id = ps.organization_id
       left join public.deals d
         on d.stage_id = ps.id and d.organization_id = ps.organization_id and d.deleted_at is null
       where ps.organization_id = $1 and ps.deleted_at is null and p.deleted_at is null
       group by ps.id, ps.name, ps.pipeline_id, p.name, ps.sort_order
       order by p.name, ps.sort_order`,
      [ctx.organizationId],
    );
    const dealsByStage: DealsByStageMetric[] = stageRows.rows.map((r) => ({
      stageId: r.stage_id,
      stageName: r.stage_name,
      pipelineId: r.pipeline_id,
      pipelineName: r.pipeline_name,
      dealCount: Number(r.deal_count),
    }));

    return {
      openDealCount,
      openDealsWithNullAmountCount,
      openPipelineValueByCurrency,
      averageOpenDealSizeByCurrency,
      wonDealCount,
      lostDealCount,
      winRate,
      wonDealValueByCurrency,
      dealsByStage,
    };
  });
}
