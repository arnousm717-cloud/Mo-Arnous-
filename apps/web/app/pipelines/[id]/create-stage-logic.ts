import { handleCreatePipelineStage } from "../../api/v1/pipelines/[id]/stages/handlers";

/**
 * Milestone 2.2F. Reuses handleCreatePipelineStage in-process (ADR-004).
 * pipelineId always comes from the URL path parameter this form is
 * mounted under, never from the body — mirrors handleCreatePipelineStage's
 * own extractCreateInput, which has no code path for a body-supplied
 * pipelineId at all (2.2D). probability/isWonStage/isLostStage validation
 * (0..100, mutual exclusivity) is NOT reimplemented here — remains
 * exclusively packages/crm's, surfaced only via whatever error message
 * the handler's own mapCrmError returns.
 */

export interface CreateStageFormState {
  error?: string;
  createdId?: string;
}

function trimmedOrUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseOptionalInt(value: FormDataEntryValue | null): number | undefined | { error: string } {
  const raw = trimmedOrUndefined(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return { error: "Probability must be a whole number." };
  }
  return parsed;
}

export async function createStageForResolvedContext(
  userId: string | null,
  pipelineId: string,
  formData: FormData,
): Promise<CreateStageFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const name = trimmedOrUndefined(formData.get("name"));
  if (name === undefined) {
    return { error: "Name is required." };
  }

  const sortOrderRaw = trimmedOrUndefined(formData.get("sortOrder"));
  const sortOrder = sortOrderRaw !== undefined ? Number(sortOrderRaw) : NaN;
  if (!Number.isInteger(sortOrder)) {
    return { error: "Sort order must be a whole number." };
  }

  const probability = parseOptionalInt(formData.get("probability"));
  if (probability !== undefined && typeof probability === "object") {
    return { error: probability.error };
  }

  const isWonStage = formData.get("isWonStage") === "on";
  const isLostStage = formData.get("isLostStage") === "on";

  const body: Record<string, unknown> = {
    name,
    sortOrder,
    ...(probability !== undefined ? { probability } : {}),
    ...(isWonStage ? { isWonStage } : {}),
    ...(isLostStage ? { isLostStage } : {}),
  };

  const response = await handleCreatePipelineStage(userId, pipelineId, body, idempotencyKey);
  const data = (await response.json()) as { stage?: { id: string }; error?: { code: string; message: string; request_id: string } };

  if (response.status === 201 && data.stage) {
    return { createdId: data.stage.id };
  }
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to create the stage. Please try again." };
}
