import { handleSetDefaultPipeline } from "../../api/v1/pipelines/[id]/set-default/handlers";

/**
 * Milestone 2.2F. Reuses handleSetDefaultPipeline in-process (ADR-004).
 * No Idempotency-Key — matching 2.2D's own decision that this route
 * carries none (the underlying setDefaultPipeline domain call already
 * no-ops when the target is already the default, so a retry is
 * naturally safe without the reservation/replay machinery).
 */

export interface SetDefaultPipelineFormState {
  error?: string;
  updatedId?: string;
}

export async function setDefaultPipelineForResolvedContext(
  userId: string | null,
  pipelineId: string,
): Promise<SetDefaultPipelineFormState> {
  const response = await handleSetDefaultPipeline(userId, pipelineId);
  const data = (await response.json()) as { pipeline?: { id: string }; error?: string };

  if (response.status === 200 && data.pipeline) {
    return { updatedId: data.pipeline.id };
  }
  return { error: typeof data.error === "string" ? data.error : "Failed to set this pipeline as default. Please try again." };
}
