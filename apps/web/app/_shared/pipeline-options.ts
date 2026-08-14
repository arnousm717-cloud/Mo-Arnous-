import { listPipelines, listPipelineStages, type Pipeline, type PipelineStage } from "@ai-revenue-os/crm";

/**
 * Milestone 2.2E. Mirrors company-options.ts's own shape and rationale.
 * listPipelines/listPipelineStages already exclude soft-deleted rows, so
 * neither can appear as a choice here without special-casing.
 *
 * There is no dedicated "list every active stage across an organization"
 * domain function in packages/crm — listPipelineStages is deliberately
 * per-pipeline (2.2B). listActiveStageOptions composes the existing
 * listPipelines + listPipelineStages calls in-process (ADR-004: reusing
 * established domain functions, not adding a new one merely for this
 * UI's convenience) rather than inventing a new packages/crm function for
 * a capability this milestone doesn't otherwise need.
 */
export interface PipelineOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface PipelineStageOption {
  id: string;
  pipelineId: string;
  name: string;
}

export async function listActivePipelineOptions(ctx: {
  userId: string;
  organizationId: string;
  roleKey: string;
}): Promise<PipelineOption[]> {
  const page = await listPipelines(ctx, { limit: 100 });
  return page.items.map((pipeline: Pipeline) => ({
    id: pipeline.id,
    name: pipeline.name,
    isDefault: pipeline.isDefault,
  }));
}

/** Fetches active stages for every pipeline in `pipelineIds`, flattened
 * into one list — each entry still carries its own pipelineId so a
 * consumer can filter/group client-side (e.g. a dependent stage
 * <select>). */
export async function listActiveStageOptions(
  ctx: { userId: string; organizationId: string; roleKey: string },
  pipelineIds: string[],
): Promise<PipelineStageOption[]> {
  const perPipeline = await Promise.all(pipelineIds.map((pipelineId) => listPipelineStages(ctx, pipelineId)));
  return perPipeline.flat().map((stage: PipelineStage) => ({
    id: stage.id,
    pipelineId: stage.pipelineId,
    name: stage.name,
  }));
}
