import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";

/**
 * Milestone 3.5A — lead-score and identified-visitor aggregates for
 * Dashboard v1. Same discipline as packages/crm's dashboard-metrics.ts:
 * a small, fixed set of aggregate reads, not a generic analytics layer.
 *
 * `lead_scores` is historized/insert-only (packages/intelligence/src/
 * scoring.ts, 20260903090000_create_lead_scoring_schema.sql) — every
 * query in this module selects only the LATEST row per contact via
 * `DISTINCT ON (contact_id) ... ORDER BY contact_id, computed_at DESC,
 * id DESC` (using the existing lead_scores_org_contact_computed_idx),
 * never a naive `GROUP BY grade` over the full historized table, which
 * would double/triple-count any contact whose score changed over time.
 *
 * Identified-visitor semantics resolve the Milestone 3.5A hostile
 * check: `website_visitors.first_seen_at` is set once at row creation
 * and never updated on identification (packages/intelligence/src/
 * identify.ts never touches it), so it cannot honestly label "when was
 * this visitor identified". The true identification timestamp is each
 * visitor's own most recent `visitor_identifications` row with
 * `event_type = 'identified'` (`occurred_at`). "Identified Visitors
 * (last N days)" therefore means: currently identified
 * (`identified_contact_id is not null`) AND that visitor's own most
 * recent identification event occurred within the window — not merely
 * "row created within the window", which `first_seen_at` alone cannot
 * prove.
 */

export interface LeadScoreDistribution {
  grade: "A" | "B" | "C" | "D";
  contactCount: number;
}

export interface HighScoreContact {
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  score: number;
  grade: "A" | "B" | "C" | "D";
  computedAt: string;
}

export interface IdentifiedVisitorMetrics {
  identifiedVisitorCount: number;
  /** Currently-identified visitors whose most recent identification
   * event falls within the requested window — see module doc above. */
  identifiedInWindowCount: number;
  windowDays: number;
}

interface DistributionRow {
  grade: string;
  contact_count: string;
}

interface HighScoreRow {
  contact_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  score: number;
  grade: string;
  computed_at: string;
}

interface VisitorMetricsRow {
  identified_count: string;
  identified_in_window_count: string;
}

const LATEST_LEAD_SCORE_CTE = `
  with latest as (
    select distinct on (ls.contact_id)
      ls.contact_id, ls.score, ls.grade, ls.computed_at
    from public.lead_scores ls
    where ls.organization_id = $1
    order by ls.contact_id, ls.computed_at desc, ls.id desc
  )
`;

/**
 * Grade distribution (A/B/C/D) across every contact's latest score.
 * Excludes soft-deleted contacts via the join to `contacts` — a
 * contact's lead-score history is not purged on ordinary soft-delete,
 * only on GDPR hard-erasure (FK ON DELETE CASCADE), so this join filter
 * is required, not redundant.
 */
export async function getLeadScoreDistribution(
  ctx: RequestContext & { organizationId: string },
): Promise<LeadScoreDistribution[]> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<DistributionRow>(
      `${LATEST_LEAD_SCORE_CTE}
       select latest.grade, count(*)::text as contact_count
       from latest
       join public.contacts c
         on c.organization_id = $1 and c.id = latest.contact_id and c.deleted_at is null
       group by latest.grade
       order by latest.grade`,
      [ctx.organizationId],
    );
    return result.rows.map((r) => ({
      grade: r.grade as LeadScoreDistribution["grade"],
      contactCount: Number(r.contact_count),
    }));
  });
}

/**
 * Top contacts by latest score, highest first. Exposes only the fields
 * a dashboard list needs (name/email/score/grade/computedAt) — never
 * the scoring breakdown, raw enrichment data, or any field beyond what
 * this list requires, matching Milestone 3.5A's privacy-minimization
 * requirement.
 */
export async function getHighScoreContacts(
  ctx: RequestContext & { organizationId: string },
  limit: number,
): Promise<HighScoreContact[]> {
  const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), 100);
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<HighScoreRow>(
      `${LATEST_LEAD_SCORE_CTE}
       select
         c.id as contact_id,
         c.first_name,
         c.last_name,
         c.email,
         latest.score,
         latest.grade,
         latest.computed_at
       from latest
       join public.contacts c
         on c.organization_id = $1 and c.id = latest.contact_id and c.deleted_at is null
       order by latest.score desc, latest.computed_at desc, c.id asc
       limit $2`,
      [ctx.organizationId, boundedLimit],
    );
    return result.rows.map((r) => ({
      contactId: r.contact_id,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
      score: r.score,
      grade: r.grade as HighScoreContact["grade"],
      computedAt: r.computed_at,
    }));
  });
}

/**
 * `windowDays` bounded to a sane range — this is a dashboard metric
 * parameter, not user-supplied SQL, but an unbounded value could still
 * request an absurd `make_interval` span from a careless caller.
 */
export async function getIdentifiedVisitorMetrics(
  ctx: RequestContext & { organizationId: string },
  windowDays = 30,
): Promise<IdentifiedVisitorMetrics> {
  const boundedWindowDays = Math.min(Math.max(1, Math.trunc(windowDays)), 365);
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<VisitorMetricsRow>(
      `select
         count(*) filter (where wv.identified_contact_id is not null)::text as identified_count,
         count(*) filter (
           where wv.identified_contact_id is not null
             and latest_id.occurred_at >= now() - make_interval(days => $2::int)
         )::text as identified_in_window_count
       from public.website_visitors wv
       left join lateral (
         select vi.occurred_at
         from public.visitor_identifications vi
         where vi.organization_id = $1
           and vi.website_visitor_id = wv.id
           and vi.event_type = 'identified'
         order by vi.occurred_at desc
         limit 1
       ) latest_id on true
       where wv.organization_id = $1`,
      [ctx.organizationId, boundedWindowDays],
    );
    const row = result.rows[0]!;
    return {
      identifiedVisitorCount: Number(row.identified_count),
      identifiedInWindowCount: Number(row.identified_in_window_count),
      windowDays: boundedWindowDays,
    };
  });
}
