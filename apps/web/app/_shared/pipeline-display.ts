import { getPipelineByIdIncludingDeleted, getPipelineStageByIdIncludingDeleted } from "@ai-revenue-os/crm";
import type { PipelineOption, PipelineStageOption } from "./pipeline-options";

/**
 * Milestone 2.2E. Mirrors company-display.ts's own shape and rationale —
 * a deal's pipelineId/stageId are preserved when the pipeline/stage is
 * later soft-deleted (the frozen Milestone 2.2 decision), so a naive
 * `find()` against the active-only options lists has no entry for
 * either. Never falls back to the raw id.
 */
export async function resolvePipelineDisplayName(
  ctx: { userId: string; organizationId: string; roleKey: string },
  pipelineId: string,
  activePipelineOptions: PipelineOption[],
): Promise<string> {
  const active = activePipelineOptions.find((p) => p.id === pipelineId);
  if (active) {
    return active.name;
  }
  const deleted = await getPipelineByIdIncludingDeleted(ctx, pipelineId);
  return deleted ? `${deleted.name} (deleted)` : "Deleted pipeline";
}

/** Stage resolution mirrors pipeline resolution — the only difference is
 * getPipelineStageByIdIncludingDeleted needs both pipelineId and stageId
 * (packages/crm's stages are always pipeline-scoped, 2.2B). */
export async function resolveStageDisplayName(
  ctx: { userId: string; organizationId: string; roleKey: string },
  pipelineId: string,
  stageId: string,
  activeStageOptions: PipelineStageOption[],
): Promise<string> {
  const active = activeStageOptions.find((s) => s.id === stageId);
  if (active) {
    return active.name;
  }
  const deleted = await getPipelineStageByIdIncludingDeleted(ctx, pipelineId, stageId);
  return deleted ? `${deleted.name} (deleted)` : "Deleted stage";
}
