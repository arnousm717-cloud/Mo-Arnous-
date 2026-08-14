import { handleDeleteDeal } from "../../api/v1/deals/[id]/handlers";

/**
 * Mirrors ../../contacts/[id]/delete-logic.ts exactly. Reuses
 * handleDeleteDeal in-process (ADR-004) — softDeleteDeal() only. No
 * packages/compliance import anywhere in this file or its dependency
 * graph — this is the ordinary, recoverable soft-delete, never GDPR
 * erasure.
 */

export interface DeleteDealFormState {
  error?: string;
  deleted?: boolean;
}

export async function deleteDealForResolvedContext(userId: string | null, dealId: string): Promise<DeleteDealFormState> {
  const response = await handleDeleteDeal(userId, dealId);
  if (response.status === 200) {
    return { deleted: true };
  }
  const data = (await response.json()) as { error?: string };
  return { error: typeof data.error === "string" ? data.error : "Failed to remove the deal. Please try again." };
}
