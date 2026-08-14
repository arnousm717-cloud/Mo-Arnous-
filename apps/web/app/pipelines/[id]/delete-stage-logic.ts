import { handleDeletePipelineStage } from "../../api/v1/pipelines/[id]/stages/[stageId]/handlers";

/**
 * Milestone 2.2F. Reuses handleDeletePipelineStage in-process (ADR-004).
 * softDeletePipelineStage() only — the frozen 2.2B design permits
 * soft-deleting a stage even while active deals still reference it; this
 * file does not move, null, or otherwise touch any deal, and never
 * hard-deletes.
 */

export interface DeleteStageFormState {
  error?: string;
  deleted?: boolean;
}

export async function deleteStageForResolvedContext(
  userId: string | null,
  pipelineId: string,
  stageId: string,
): Promise<DeleteStageFormState> {
  const response = await handleDeletePipelineStage(userId, pipelineId, stageId);
  if (response.status === 200) {
    return { deleted: true };
  }
  const data = (await response.json()) as { error?: string };
  return { error: typeof data.error === "string" ? data.error : "Failed to remove the stage. Please try again." };
}
