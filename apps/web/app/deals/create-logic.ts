import { handleCreateDeal } from "../api/v1/deals/handlers";

/**
 * Milestone 2.2E. Mirrors apps/web/app/companies/create-logic.ts exactly
 * — reuses handleCreateDeal in-process (ADR-004, no network hop).
 * Relationship validation (owner/company/contact/pipeline/stage), status
 * derivation, and currency/probability/amount format checks are NOT
 * reimplemented here — they remain exclusively packages/crm's, surfaced
 * to the form only via whatever error message handleCreateDeal's own
 * mapCrmError already returns. No `status` field is ever read from
 * formData — there is no code path for a client to supply one.
 */

export interface CreateDealFormState {
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

/** Same coercion discipline as companies/create-logic.ts's
 * parseOptionalNumber — the one genuinely-needed FormData->number
 * coercion, not a second copy of packages/crm's own probability/amount
 * validation. */
function parseOptionalNumber(value: FormDataEntryValue | null, label: string): number | undefined | { error: string } {
  const raw = trimmedOrUndefined(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    return { error: `${label} must be a number.` };
  }
  return parsed;
}

export async function createDealForResolvedContext(
  userId: string | null,
  formData: FormData,
): Promise<CreateDealFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const pipelineId = trimmedOrUndefined(formData.get("pipelineId"));
  const stageId = trimmedOrUndefined(formData.get("stageId"));
  if (pipelineId === undefined || stageId === undefined) {
    return { error: "Pipeline and stage are required." };
  }

  const probability = parseOptionalNumber(formData.get("probability"), "Probability");
  if (probability && typeof probability === "object") {
    return { error: probability.error };
  }

  const body: Record<string, unknown> = { pipelineId, stageId };
  const companyId = trimmedOrUndefined(formData.get("companyId"));
  if (companyId !== undefined) body.companyId = companyId;
  const primaryContactId = trimmedOrUndefined(formData.get("primaryContactId"));
  if (primaryContactId !== undefined) body.primaryContactId = primaryContactId;
  const amount = trimmedOrUndefined(formData.get("amount"));
  if (amount !== undefined) body.amount = amount;
  const currency = trimmedOrUndefined(formData.get("currency"));
  if (currency !== undefined) body.currency = currency.toUpperCase();
  if (probability !== undefined) body.probability = probability;
  const expectedCloseDate = trimmedOrUndefined(formData.get("expectedCloseDate"));
  if (expectedCloseDate !== undefined) body.expectedCloseDate = expectedCloseDate;
  const ownerId = trimmedOrUndefined(formData.get("ownerId"));
  if (ownerId !== undefined) body.ownerId = ownerId;

  const response = await handleCreateDeal(userId, body, idempotencyKey);
  const data = (await response.json()) as { deal?: { id: string }; error?: string };

  if (response.status === 201 && data.deal) {
    return { createdId: data.deal.id };
  }
  return { error: typeof data.error === "string" ? data.error : "Failed to create the deal. Please try again." };
}
