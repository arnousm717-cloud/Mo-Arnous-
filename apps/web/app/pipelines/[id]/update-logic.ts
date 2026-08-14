import { handleUpdatePipeline } from "../../api/v1/pipelines/[id]/handlers";

/**
 * Milestone 2.2F. Mirrors apps/web/app/companies/[id]/update-logic.ts's
 * discipline. name-only, matching handleUpdatePipeline's own
 * extractUpdateInput, which has no code path for isDefault at all
 * (2.2D) — switching the default is exclusively ./set-default-logic.ts's
 * job, never reachable from this ordinary metadata PATCH even in
 * principle, since there is no field here for it to occupy.
 */

export interface UpdatePipelineFormState {
  error?: string;
  updatedId?: string;
}

export async function updatePipelineForResolvedContext(
  userId: string | null,
  pipelineId: string,
  formData: FormData,
): Promise<UpdatePipelineFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const nameValue = formData.get("name");
  const name = typeof nameValue === "string" ? nameValue.trim() : "";
  if (name === "") {
    return { error: "Name is required." };
  }

  const response = await handleUpdatePipeline(userId, pipelineId, { name }, idempotencyKey);
  const data = (await response.json()) as { pipeline?: { id: string }; error?: string };

  if (response.status === 200 && data.pipeline) {
    return { updatedId: data.pipeline.id };
  }
  return { error: typeof data.error === "string" ? data.error : "Failed to update the pipeline. Please try again." };
}
