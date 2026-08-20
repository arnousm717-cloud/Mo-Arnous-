import { NextResponse } from "next/server";
import {
  updatePipelineStage,
  getPipelineStageById,
  softDeletePipelineStage,
  type UpdatePipelineStageInput,
} from "@ai-revenue-os/crm";
import { withIdempotency } from "../../../../_shared/idempotency";
import { resolveActor } from "../../../handlers";
import { mapCrmError, toStageResponseBody } from "../handlers";
import { apiError, buildApiErrorBody } from "../../../../_shared/api-error";
import { isValidUuid } from "../../../../_shared/uuid";

/**
 * Milestone 2.2D.
 *
 * IDOR safety (adversarially proven by test): NO separate "does the
 * parent pipeline exist" pre-check is needed here, unlike stages/
 * handlers.ts's LIST — packages/crm's getPipelineStageById/
 * updatePipelineStage/softDeletePipelineStage all scope their lookup by
 * (organization_id, pipeline_id, id) TOGETHER in one query (Milestone
 * 2.2B), so a stage that exists but belongs to a different pipeline (even
 * one the caller legitimately owns), a cross-org pipeline id, or a
 * genuinely nonexistent pipeline id all produce the exact same `null` —
 * and therefore the exact same 404 response body — with no distinguishing
 * code path whatsoever. Adding a redundant separate pipeline-existence
 * check here would violate this milestone's own "do not duplicate
 * packages/crm validation" rule (§2) for no safety benefit: the single
 * scoped query already IS the IDOR defense.
 */

function extractUpdateInput(rawBody: unknown): UpdatePipelineStageInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const input: UpdatePipelineStageInput = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (has("name")) input.name = body.name as string;
  if (has("sortOrder")) input.sortOrder = body.sortOrder as number;
  if (has("probability")) input.probability = body.probability as number | null;
  if (has("isWonStage")) input.isWonStage = body.isWonStage as boolean;
  if (has("isLostStage")) input.isLostStage = body.isLostStage as boolean;
  return input;
}

export async function handleGetPipelineStage(
  userId: string | null,
  pipelineId: string,
  stageId: string,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:read");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(pipelineId) || !isValidUuid(stageId)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const stage = await getPipelineStageById(actor, pipelineId, stageId);
  if (!stage) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toStageResponseBody(stage));
}

export async function handleUpdatePipelineStage(
  userId: string | null,
  pipelineId: string,
  stageId: string,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:update");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(pipelineId) || !isValidUuid(stageId)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const input = extractUpdateInput(rawBody);
  const route = `/api/v1/pipelines/${pipelineId}/stages/${stageId}`;

  if (!idempotencyKey) {
    try {
      const stage = await updatePipelineStage(actor, pipelineId, stageId, input);
      if (!stage) {
        return apiError("NOT_FOUND", "Not found", 404);
      }
      return NextResponse.json(toStageResponseBody(stage));
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to update pipeline stage", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "PATCH", route, body: input },
      async (client) => {
        try {
          const stage = await updatePipelineStage(actor, pipelineId, stageId, input, client);
          if (!stage) {
            return { status: 404, body: buildApiErrorBody("NOT_FOUND", "Not found") };
          }
          return { status: 200, body: toStageResponseBody(stage) };
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
    return apiError("INTERNAL_ERROR", "Failed to update pipeline stage", 500);
  }
}

export async function handleDeletePipelineStage(
  userId: string | null,
  pipelineId: string,
  stageId: string,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:delete");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(pipelineId) || !isValidUuid(stageId)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const stage = await softDeletePipelineStage(actor, pipelineId, stageId);
  if (!stage) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toStageResponseBody(stage));
}
