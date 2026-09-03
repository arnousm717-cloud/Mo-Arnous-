import type { DealDashboardMetrics } from "@ai-revenue-os/crm";

/**
 * Milestone 3.5C — pure transform grouping the M3.5A `dealsByStage`
 * aggregate by pipeline for the dashboard's read-only overview. This is
 * NOT a second operational board (that stays /deals/board's job) — it
 * renders exact counts only, nothing mutable, nothing drag-and-droppable.
 *
 * Ordering is never recomputed here: `dealsByStage` already arrives
 * sorted `order by p.name, ps.sort_order` (packages/crm/src/
 * dashboard-metrics.ts) with every stage for a given pipeline
 * contiguous under that pipeline's own name-tie-break, so a single
 * grouping pass preserves both the pipeline order and each pipeline's
 * own stage order exactly as the domain layer produced them.
 *
 * An empty `pipelineGroups` result means literally zero non-deleted
 * pipeline_stages rows exist for this organization -- not "zero deals":
 * the domain query's own LEFT JOIN already guarantees every configured
 * stage appears here at dealCount 0, so a stage with no deals is always
 * present, never filtered out.
 */

export interface StageLine {
  stageId: string;
  stageName: string;
  dealCount: number;
}

export interface PipelineStageGroup {
  pipelineId: string;
  pipelineName: string;
  stages: StageLine[];
}

export interface StageOverviewViewModel {
  pipelineGroups: PipelineStageGroup[];
}

export function buildStageOverviewViewModel(metrics: DealDashboardMetrics): StageOverviewViewModel {
  const pipelineGroups: PipelineStageGroup[] = [];
  const groupByPipelineId = new Map<string, PipelineStageGroup>();

  for (const stage of metrics.dealsByStage) {
    let group = groupByPipelineId.get(stage.pipelineId);
    if (!group) {
      group = { pipelineId: stage.pipelineId, pipelineName: stage.pipelineName, stages: [] };
      groupByPipelineId.set(stage.pipelineId, group);
      pipelineGroups.push(group);
    }
    group.stages.push({ stageId: stage.stageId, stageName: stage.stageName, dealCount: stage.dealCount });
  }

  return { pipelineGroups };
}
