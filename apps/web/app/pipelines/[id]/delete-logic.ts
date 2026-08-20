import { handleDeletePipeline } from "../../api/v1/pipelines/[id]/handlers";

/**
 * Milestone 2.2F. Mirrors ../../deals/[id]/delete-logic.ts exactly.
 * Reuses handleDeletePipeline in-process (ADR-004) — softDeletePipeline()
 * only, never a physical delete. When the target is the organization's
 * active default, handleDeletePipeline returns 409 with a domain error
 * message (CannotDeleteDefaultPipelineError) — surfaced here as-is, no
 * automatic replacement is ever picked (no frozen design supports
 * inventing that selection).
 */

export interface DeletePipelineFormState {
  error?: string;
  deleted?: boolean;
}

export async function deletePipelineForResolvedContext(
  userId: string | null,
  pipelineId: string,
): Promise<DeletePipelineFormState> {
  const response = await handleDeletePipeline(userId, pipelineId);
  if (response.status === 200) {
    return { deleted: true };
  }
  const data = (await response.json()) as { error?: { code: string; message: string; request_id: string } };
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to remove the pipeline. Please try again." };
}
