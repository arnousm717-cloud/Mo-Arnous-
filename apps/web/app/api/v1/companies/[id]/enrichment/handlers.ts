import { NextResponse } from "next/server";
import { recordEnrichmentResult } from "@ai-revenue-os/intelligence";
import { resolveScopedServiceActor } from "../../../_shared/service-actor";
import { checkEnrichmentTriggerRateLimit } from "../../../_shared/enrichment-rate-limit";
import { readBoundedJsonBody, InvalidJsonError, PayloadTooLargeError } from "../../../_shared/bounded-body";
import { validateEnrichmentWriteBack, ValidationError } from "../../../_shared/enrichment-validation";
import { apiError } from "../../../_shared/api-error";
import { isValidUuid } from "../../../_shared/uuid";

/**
 * Milestone 3.3E — POST /api/v1/companies/{id}/enrichment. Structurally
 * identical to contacts/[id]/enrichment/handlers.ts — see that file's
 * own header comment for the full rationale; the only difference is the
 * `entityType` passed to recordEnrichmentResult.
 */
const WORKFLOW_KEY = "lead_enrichment";
const REQUIRED_SCOPE = "enrichment:write";

export async function handleRecordCompanyEnrichment(request: Request, id: string): Promise<NextResponse> {
  const actor = await resolveScopedServiceActor(request, REQUIRED_SCOPE);
  if (actor instanceof NextResponse) {
    return actor;
  }

  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return apiError("VALIDATION_ERROR", "Payload too large", 413);
    }
    if (err instanceof InvalidJsonError) {
      return apiError("VALIDATION_ERROR", "Invalid JSON body", 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to read request body", 500);
  }

  let fields;
  try {
    fields = validateEnrichmentWriteBack(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to validate request body", 500);
  }

  try {
    if (!(await checkEnrichmentTriggerRateLimit(actor.organizationId))) {
      return apiError("RATE_LIMITED", "Rate limit exceeded", 429);
    }
  } catch {
    return apiError("INTERNAL_ERROR", "Rate limit check failed", 500);
  }

  try {
    const outcome = await recordEnrichmentResult(
      { organizationId: actor.organizationId },
      { entityType: "company", entityId: id, workflowKey: WORKFLOW_KEY, ...fields },
    );
    if (outcome.accepted) {
      return NextResponse.json({ result: "accepted" }, { status: 200 });
    }
    return NextResponse.json({ result: "rejected", reason: outcome.reason }, { status: 200 });
  } catch {
    return apiError("INTERNAL_ERROR", "Failed to record enrichment result", 500);
  }
}
