import { handleCreatePipeline } from "../api/v1/pipelines/handlers";

/**
 * Milestone 2.2F. Mirrors apps/web/app/deals/create-logic.ts exactly —
 * reuses handleCreatePipeline in-process (ADR-004, no network hop). Name
 * validation is NOT reimplemented here — it remains exclusively
 * packages/crm's, surfaced to the form only via whatever error message
 * handleCreatePipeline's own mapCrmError already returns.
 */

export interface CreatePipelineFormState {
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

export async function createPipelineForResolvedContext(
  userId: string | null,
  formData: FormData,
): Promise<CreatePipelineFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const name = trimmedOrUndefined(formData.get("name"));
  if (name === undefined) {
    return { error: "Name is required." };
  }

  // isDefault is accepted here ONLY because handleCreatePipeline's own
  // extractCreateInput explicitly supports it at create time (2.2D) —
  // packages/crm's createPipeline handles it transactionally and safely.
  // This is categorically different from (and does not reintroduce) the
  // ordinary-PATCH isDefault bypass update-logic.ts deliberately has no
  // code path for — switching an EXISTING pipeline's default still goes
  // exclusively through set-default-logic.ts's dedicated action.
  const isDefault = formData.get("isDefault") === "on";

  const response = await handleCreatePipeline(userId, { name, ...(isDefault ? { isDefault: true } : {}) }, idempotencyKey);
  const data = (await response.json()) as { pipeline?: { id: string }; error?: { code: string; message: string; request_id: string } };

  if (response.status === 201 && data.pipeline) {
    return { createdId: data.pipeline.id };
  }
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to create the pipeline. Please try again." };
}
