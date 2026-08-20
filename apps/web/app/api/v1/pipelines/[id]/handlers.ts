import { NextResponse } from "next/server";
import { updatePipeline, getPipelineById, softDeletePipeline, CannotDeleteDefaultPipelineError, type UpdatePipelineInput } from "@ai-revenue-os/crm";
import { withIdempotency } from "../../_shared/idempotency";
import { resolveActor, mapCrmError, toPipelineResponseBody } from "../handlers";
import { apiError, buildApiErrorBody } from "../../_shared/api-error";
import { isValidUuid } from "../../_shared/uuid";

/**
 * Milestone 2.2D. Cross-org and nonexistent :id are indistinguishable —
 * packages/crm's getPipelineById/updatePipeline/softDeletePipeline already
 * return null for both cases identically; this file adds no special-casing
 * at all, it just maps null to 404 (matching the existing companies/
 * contacts precedent).
 */

/**
 * Deliberately has NO code path for `isDefault` at all — the only field
 * ever read here is `name`, matching packages/crm's own UpdatePipelineInput
 * type exactly (Milestone 2.2B already excludes isDefault from that type
 * structurally). This is what makes "ordinary PATCH cannot mutate
 * isDefault" true at the API layer too, not just at the domain layer —
 * even a client sending `{ "isDefault": false }` has it silently ignored,
 * never reaching packages/crm at all. Switching the default is exposed
 * only via POST /api/v1/pipelines/{id}/set-default (this milestone's own
 * explicit design decision — see ../[id]/set-default/handlers.ts).
 */
function extractUpdateInput(rawBody: unknown): UpdatePipelineInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const input: UpdatePipelineInput = {};
  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    input.name = body.name as string;
  }
  return input;
}

/** softDeletePipeline throws (not returns null) when the target is the
 * organization's active default — a 409 Conflict, same category as
 * DuplicateContactEmailError: syntactically valid request, rejected
 * because of current resource state, not because of a validation failure
 * (400) or a missing resource (404). */
function mapDeleteError(err: unknown): { status: number; body: unknown } | null {
  if (err instanceof CannotDeleteDefaultPipelineError) {
    return { status: 409, body: buildApiErrorBody("CONFLICT", err.message) };
  }
  return mapCrmError(err);
}

export async function handleGetPipeline(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:read");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const pipeline = await getPipelineById(actor, id);
  if (!pipeline) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toPipelineResponseBody(pipeline));
}

export async function handleUpdatePipeline(
  userId: string | null,
  id: string,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:update");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const input = extractUpdateInput(rawBody);
  const route = `/api/v1/pipelines/${id}`;

  if (!idempotencyKey) {
    try {
      const pipeline = await updatePipeline(actor, id, input);
      if (!pipeline) {
        return apiError("NOT_FOUND", "Not found", 404);
      }
      return NextResponse.json(toPipelineResponseBody(pipeline));
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to update pipeline", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "PATCH", route, body: input },
      async (client) => {
        try {
          const pipeline = await updatePipeline(actor, id, input, client);
          if (!pipeline) {
            return { status: 404, body: buildApiErrorBody("NOT_FOUND", "Not found") };
          }
          return { status: 200, body: toPipelineResponseBody(pipeline) };
        } catch (err) {
          const mapped = mapCrmError(err);
          if (mapped) {
            return mapped;
          }
          throw err;
        }
      },
    );

    if (outcome.kind === "conflict") {
      return apiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key already used with a different request", 409);
    }
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    return apiError("INTERNAL_ERROR", "Failed to update pipeline", 500);
  }
}

export async function handleDeletePipeline(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:delete");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  try {
    const pipeline = await softDeletePipeline(actor, id);
    if (!pipeline) {
      return apiError("NOT_FOUND", "Not found", 404);
    }
    return NextResponse.json(toPipelineResponseBody(pipeline));
  } catch (err) {
    const mapped = mapDeleteError(err);
    if (mapped) {
      return NextResponse.json(mapped.body, { status: mapped.status });
    }
    return apiError("INTERNAL_ERROR", "Failed to delete pipeline", 500);
  }
}
