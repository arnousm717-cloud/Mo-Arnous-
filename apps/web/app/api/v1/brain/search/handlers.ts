import { NextResponse } from "next/server";
import { searchEntityProfilesByEmbedding, SearchValidationError } from "@ai-revenue-os/brain";
import { resolveScopedServiceActor } from "../../_shared/service-actor";
import { readBoundedJsonBody, InvalidJsonError, PayloadTooLargeError } from "../../_shared/bounded-body";
import { validateSearchRequest, ValidationError } from "../../_shared/brain-search-validation";
import { apiError } from "../../_shared/api-error";

/**
 * Milestone 4.1 Phase 4 — POST /api/v1/brain/search. The
 * API-key-authenticated retrieval endpoint for the Tenant-Safe Semantic
 * Retrieval Foundation. Mirrors handleWriteBrainEmbedding's own structure
 * exactly (Milestone 4.1 Phase 3) — this route never sees a provider
 * credential, never calls a provider, never accepts query text, and never
 * logs the request body: `queryVector` is read only from the validated,
 * typed `fields` object and passed straight to
 * searchEntityProfilesByEmbedding, never through withRequestLogging's
 * structured-log path (that wrapper's own StructuredLogFields type has no
 * field for a request body at all — see _shared/logger.ts's own header
 * comment).
 *
 * `organizationId` always comes from the resolved API-key actor, never
 * from the request body — the same discipline every other write-back/
 * read-back route in this API already follows; a caller cannot select
 * another organization by any means.
 */
const REQUIRED_SCOPE = "brain:embeddings:read";

export async function handleSearchBrainEmbeddings(request: Request): Promise<NextResponse> {
  const actor = await resolveScopedServiceActor(request, REQUIRED_SCOPE);
  if (actor instanceof NextResponse) {
    return actor;
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
    fields = validateSearchRequest(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to validate request body", 500);
  }

  try {
    const results = await searchEntityProfilesByEmbedding({ organizationId: actor.organizationId }, fields);
    return NextResponse.json({ results }, { status: 200 });
  } catch (err) {
    if (err instanceof SearchValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to perform search", 500);
  }
}
