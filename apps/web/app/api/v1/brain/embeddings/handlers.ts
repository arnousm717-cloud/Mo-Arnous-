import { NextResponse } from "next/server";
import { upsertEntityEmbedding } from "@ai-revenue-os/brain";
import { resolveScopedServiceActor } from "../../_shared/service-actor";
import { readBoundedJsonBody, InvalidJsonError, PayloadTooLargeError } from "../../_shared/bounded-body";
import { validateEmbeddingWriteBack, ValidationError } from "../../_shared/brain-embedding-validation";
import { apiError } from "../../_shared/api-error";

/**
 * Milestone 4.1 Phase 3 — POST /api/v1/brain/embeddings. The
 * API-key-authenticated write-back endpoint n8n's (future, not-yet-built)
 * Brain Indexing workflow calls with an already-computed embedding for one
 * entity profile. Mirrors handleRecordContactEnrichment's own structure
 * exactly (Milestone 3.3E) — this route never sees a provider credential,
 * never calls a provider, and never logs the request body: `chunkText`/
 * `embedding` are read only from the validated, typed `fields` object and
 * passed straight to `upsertEntityEmbedding`, never through
 * `withRequestLogging`'s structured-log path (that wrapper's own
 * `StructuredLogFields` type has no field for a request body at all — see
 * `_shared/logger.ts`'s own header comment).
 *
 * `organizationId` always comes from the resolved API-key actor, never
 * from the request body — the same discipline every other write-back
 * route in this API already follows; a caller cannot select another
 * organization by any means.
 */
const REQUIRED_SCOPE = "brain:embeddings:write";

export async function handleWriteBrainEmbedding(request: Request): Promise<NextResponse> {
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
    fields = validateEmbeddingWriteBack(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to validate request body", 500);
  }

  try {
    const result = await upsertEntityEmbedding(
      { organizationId: actor.organizationId },
      {
        entityType: fields.entityType,
        entityId: fields.entityId,
        chunkText: fields.chunkText,
        embedding: fields.embedding,
        sourceVersionAt: fields.sourceVersionAt,
      },
    );
    if (result.status === "entity_not_found") {
      return NextResponse.json({ result: "rejected", reason: "entity_not_found" }, { status: 200 });
    }
    if (result.status === "stale") {
      return NextResponse.json({ result: "rejected", reason: "stale" }, { status: 200 });
    }
    return NextResponse.json({ result: "accepted", status: result.status, embeddingId: result.embeddingId }, { status: 200 });
  } catch {
    return apiError("INTERNAL_ERROR", "Failed to record embedding result", 500);
  }
}
