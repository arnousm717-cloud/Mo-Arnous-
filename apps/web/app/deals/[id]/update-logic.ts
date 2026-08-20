import { handleUpdateDeal } from "../../api/v1/deals/[id]/handlers";

/**
 * Mirrors ../../contacts/[id]/update-logic.ts's originalCompanyId
 * discipline, extended to every relationship field a deal carries:
 * companyId, primaryContactId, ownerId, pipelineId, stageId. Each is
 * compared against its own hidden `originalXId` field — only a value
 * that GENUINELY differs from what the deal already had is included in
 * the request body at all. An unrelated edit (e.g. changing only
 * `amount`) therefore never re-touches a relationship whose target has
 * since been soft-deleted/deactivated, exactly the Milestone 2.1
 * Contacts lesson this milestone's own prompt names explicitly.
 * packages/crm's own updateDeal (Milestone 2.2B) already implements the
 * matching "skip revalidation when unchanged" half of this contract on
 * its own side — this file is what makes an UNCHANGED value actually
 * arrive as "omitted from the body" rather than "resupplied," which is
 * what makes that domain-layer behavior reachable from the UI at all.
 *
 * pipelineId/stageId are coupled (handleUpdateDeal -> packages/crm's
 * updateDeal requires stageId whenever pipelineId genuinely changes): if
 * pipelineId changed, stageId is ALWAYS included too (the form's own
 * dependent-select behavior already guarantees the submitted stageId
 * belongs to the submitted pipelineId — see ../deal-edit-form.tsx). If
 * only stageId changed (pipeline unchanged), only stageId is sent, which
 * packages/crm validates against the deal's CURRENT (unchanged)
 * pipeline — exactly matching what the form actually offered.
 */

export interface UpdateDealFormState {
  error?: string;
  updatedId?: string;
}

function toNullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Same shape as ../../companies/[id]/update-logic.ts's
 * parseNullableNumber — empty input becomes null (a real, sent value —
 * this field has no relationship-preservation concern), a non-numeric
 * input is a validation error, anything else parses through. */
function parseNullableNumber(value: FormDataEntryValue | null, label: string): number | null | { error: string } {
  const str = toNullableString(value);
  if (str === null) {
    return null;
  }
  const parsed = Number(str);
  if (Number.isNaN(parsed)) {
    return { error: `${label} must be a number.` };
  }
  return parsed;
}

export async function updateDealForResolvedContext(
  userId: string | null,
  dealId: string,
  formData: FormData,
): Promise<UpdateDealFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const probability = parseNullableNumber(formData.get("probability"), "Probability");
  if (probability !== null && typeof probability === "object") {
    return { error: probability.error };
  }

  const submittedCompanyId = toNullableString(formData.get("companyId"));
  const originalCompanyId = toNullableString(formData.get("originalCompanyId"));
  const companyIdChanged = submittedCompanyId !== originalCompanyId;

  const submittedContactId = toNullableString(formData.get("primaryContactId"));
  const originalContactId = toNullableString(formData.get("originalPrimaryContactId"));
  const contactIdChanged = submittedContactId !== originalContactId;

  const submittedOwnerId = toNullableString(formData.get("ownerId"));
  const originalOwnerId = toNullableString(formData.get("originalOwnerId"));
  const ownerIdChanged = submittedOwnerId !== originalOwnerId;

  const submittedPipelineId = toNullableString(formData.get("pipelineId"));
  const originalPipelineId = toNullableString(formData.get("originalPipelineId"));
  const pipelineIdChanged = submittedPipelineId !== originalPipelineId;

  const submittedStageId = toNullableString(formData.get("stageId"));
  const originalStageId = toNullableString(formData.get("originalStageId"));
  const stageIdChanged = submittedStageId !== originalStageId;

  const body: Record<string, unknown> = {
    ...(companyIdChanged ? { companyId: submittedCompanyId } : {}),
    ...(contactIdChanged ? { primaryContactId: submittedContactId } : {}),
    ...(ownerIdChanged ? { ownerId: submittedOwnerId } : {}),
    ...(pipelineIdChanged ? { pipelineId: submittedPipelineId } : {}),
    ...(pipelineIdChanged || stageIdChanged ? { stageId: submittedStageId } : {}),
    amount: toNullableString(formData.get("amount")),
    currency: (toNullableString(formData.get("currency")) ?? "EUR").toUpperCase(),
    probability,
    expectedCloseDate: toNullableString(formData.get("expectedCloseDate")),
  };

  const response = await handleUpdateDeal(userId, dealId, body, idempotencyKey);
  const data = (await response.json()) as { deal?: { id: string }; error?: { code: string; message: string; request_id: string } };

  if (response.status === 200 && data.deal) {
    return { updatedId: data.deal.id };
  }
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to update the deal. Please try again." };
}
