import { handleUpdatePipelineStage } from "../../api/v1/pipelines/[id]/stages/[stageId]/handlers";

/**
 * Milestone 2.2F. Reuses handleUpdatePipelineStage in-process (ADR-004).
 * Unlike deals' relationship fields, a stage's own scalar fields
 * (name/sortOrder/probability/isWonStage/isLostStage) carry no
 * relationship-preservation concern — there is nothing here analogous to
 * a soft-deleted company that an unrelated edit must not disturb — so
 * every field is always resent on every edit, the same "always resend
 * scalar fields" discipline already used by
 * ../../deals/[id]/update-logic.ts's amount/currency/probability/
 * expectedCloseDate. Won/lost mutual exclusivity and the 0..100
 * probability bound are NOT reimplemented here — remain exclusively
 * packages/crm's, which additionally cascades deals.status when a
 * classification genuinely changes (2.2B) — this file has no knowledge
 * of that cascade at all, it just forwards the PATCH.
 */

export interface UpdateStageFormState {
  error?: string;
  updatedId?: string;
}

function parseOptionalInt(value: FormDataEntryValue | null): number | null | { error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed)) {
    return { error: "Probability must be a whole number." };
  }
  return parsed;
}

export async function updateStageForResolvedContext(
  userId: string | null,
  pipelineId: string,
  stageId: string,
  formData: FormData,
): Promise<UpdateStageFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const nameValue = formData.get("name");
  const name = typeof nameValue === "string" ? nameValue.trim() : "";
  if (name === "") {
    return { error: "Name is required." };
  }

  const sortOrderValue = formData.get("sortOrder");
  const sortOrder = typeof sortOrderValue === "string" ? Number(sortOrderValue.trim()) : NaN;
  if (!Number.isInteger(sortOrder)) {
    return { error: "Sort order must be a whole number." };
  }

  const probability = parseOptionalInt(formData.get("probability"));
  if (probability !== null && typeof probability === "object") {
    return { error: probability.error };
  }

  const isWonStage = formData.get("isWonStage") === "on";
  const isLostStage = formData.get("isLostStage") === "on";

  const body = { name, sortOrder, probability, isWonStage, isLostStage };

  const response = await handleUpdatePipelineStage(userId, pipelineId, stageId, body, idempotencyKey);
  const data = (await response.json()) as { stage?: { id: string }; error?: { code: string; message: string; request_id: string } };

  if (response.status === 200 && data.stage) {
    return { updatedId: data.stage.id };
  }
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to update the stage. Please try again." };
}
