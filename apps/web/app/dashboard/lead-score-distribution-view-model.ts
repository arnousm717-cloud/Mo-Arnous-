import type { LeadScoreDistribution } from "@ai-revenue-os/intelligence";

/**
 * Milestone 3.5D — pure transform for the M3.5A grade-distribution
 * aggregate. `getLeadScoreDistribution` deliberately omits a grade
 * entirely from its result when zero contacts currently hold it (a plain
 * `GROUP BY grade` over only the rows that exist -- packages/intelligence/
 * src/dashboard-metrics.ts) rather than zero-filling at the SQL layer.
 *
 * Zero-filling here, in the view model, is still truthful and not an
 * invented threshold: `grade` is a closed, structurally-generated enum
 * over exactly {A, B, C, D} (lead_scores.grade, GENERATED ALWAYS AS a
 * fixed case expression over score -- 20260903090000_create_lead_scoring_
 * schema.sql), so a grade absent from the aggregate mathematically means
 * zero contacts hold it, never "unknown" or "not computed yet". This is
 * the display-layer analogue of packages/crm/dashboard-metrics.ts's own
 * LEFT JOIN zero-fill for dealsByStage, applied here in apps/web because
 * the domain contract itself intentionally stays a minimal aggregate.
 */

const GRADES = ["A", "B", "C", "D"] as const;

export interface GradeLine {
  grade: (typeof GRADES)[number];
  contactCount: number;
}

export interface LeadScoreDistributionViewModel {
  grades: GradeLine[];
  /** True only when zero contacts have any lead score at all -- distinct
   * from every grade being individually zero-filled by this function. */
  isEmpty: boolean;
}

export function buildLeadScoreDistributionViewModel(
  distribution: LeadScoreDistribution[],
): LeadScoreDistributionViewModel {
  const countByGrade = new Map(distribution.map((d) => [d.grade, d.contactCount]));
  const grades = GRADES.map((grade) => ({ grade, contactCount: countByGrade.get(grade) ?? 0 }));
  return { grades, isEmpty: distribution.length === 0 };
}
