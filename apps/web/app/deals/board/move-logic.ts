import { handleUpdateDeal } from "../../api/v1/deals/[id]/handlers";

/**
 * Milestone 2.2F. Stage move is an ordinary Deal PATCH — reuses
 * handleUpdateDeal in-process (ADR-004), the exact same path
 * ../[id]/update-logic.ts uses, not a second write path. Only stageId is
 * ever sent (the board only offers stages within the SAME pipeline the
 * deal already belongs to, so pipelineId is never included — matching
 * ../[id]/update-logic.ts's own "only stageId changed" branch, validated
 * by packages/crm against the deal's CURRENT pipeline). status is never
 * sent — it is always re-derived server-side from the new stage (2.2B).
 */

export interface MoveDealFormState {
  error?: string;
  movedId?: string;
}

export async function moveDealToStageForResolvedContext(
  userId: string | null,
  dealId: string,
  formData: FormData,
): Promise<MoveDealFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const stageIdValue = formData.get("stageId");
  const stageId = typeof stageIdValue === "string" ? stageIdValue.trim() : "";
  if (stageId === "") {
    return { error: "A destination stage is required." };
  }

  const response = await handleUpdateDeal(userId, dealId, { stageId }, idempotencyKey);
  const data = (await response.json()) as { deal?: { id: string }; error?: string };

  if (response.status === 200 && data.deal) {
    return { movedId: data.deal.id };
  }
  return { error: typeof data.error === "string" ? data.error : "Failed to move the deal. Please try again." };
}
