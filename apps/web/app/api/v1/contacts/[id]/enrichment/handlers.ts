import { NextResponse } from "next/server";
import { recordEnrichmentResult } from "@ai-revenue-os/intelligence";
import { resolveScopedServiceActor } from "../../../_shared/service-actor";
import { checkEnrichmentTriggerRateLimit } from "../../../_shared/enrichment-rate-limit";
import { readBoundedJsonBody, InvalidJsonError, PayloadTooLargeError } from "../../../_shared/bounded-body";
import { validateEnrichmentWriteBack, ValidationError } from "../../../_shared/enrichment-validation";
import { apiError } from "../../../_shared/api-error";
import { isValidUuid } from "../../../_shared/uuid";

/**
 * Milestone 3.3E — POST /api/v1/contacts/{id}/enrichment. The
 * API-key-authenticated write-back endpoint n8n's Lead Enrichment
 * workflow calls with an already-normalized provider result. Provider-
 * agnostic by construction — never sees a provider credential, never
 * knows which provider was used beyond the bare attribution string in
 * the body (Milestone 3.3 Architecture Resolution Report §D/§E).
 *
 * `workflowKey` is fixed server-side to 'lead_enrichment', never
 * caller-supplied — the only workflow this milestone ships.
 */
const WORKFLOW_KEY = "lead_enrichment";
const REQUIRED_SCOPE = "enrichment:write";

export async function handleRecordContactEnrichment(request: Request, id: string): Promise<NextResponse> {
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
      { entityType: "contact", entityId: id, workflowKey: WORKFLOW_KEY, ...fields },
    );
    if (outcome.accepted) {
      return NextResponse.json({ result: "accepted" }, { status: 200 });
    }
    return NextResponse.json({ result: "rejected", reason: outcome.reason }, { status: 200 });
  } catch {
    return apiError("INTERNAL_ERROR", "Failed to record enrichment result", 500);
  }
}
