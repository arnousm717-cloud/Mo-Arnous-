import { NextResponse } from "next/server";
import {
  createPipelineStage,
  listPipelineStages,
  getPipelineById,
  ValidationError,
  InvalidPipelineRelationshipError,
  type PipelineStage,
  type CreatePipelineStageInput,
} from "@ai-revenue-os/crm";
import { withIdempotency } from "../../../_shared/idempotency";
import { resolveActor } from "../../handlers";

/**
 * Milestone 2.2D. Nested resource — pipeline_stages has no permission
 * keys of its own (Milestone 2.2C); every operation here authorizes under
 * the PARENT pipeline's own pipelines:* keys, exactly as
 * packages/auth/src/permissions.ts's own comment documents.
 *
 * IDOR safety: LIST explicitly pre-checks the parent pipeline exists and
 * is accessible (getPipelineById -> 404 if not) before ever listing —
 * unlike a single-stage lookup, an empty stages array for a nonexistent/
 * cross-org parent would be genuinely ambiguous with "this real pipeline
 * just has zero stages," so the pre-check removes that ambiguity
 * explicitly. CREATE does NOT need a separate pre-check: packages/crm's
 * own createPipelineStage already validates pipelineId as part of the
 * single mutation (InvalidPipelineRelationshipError on failure, mapped to
 * 404 below, matching the pre-check's own classification) — a redundant
 * second query would just be the "duplicate domain validation" this
 * milestone's own architectural rule (§2) forbids.
 */

function mapCrmError(err: unknown): { status: number; body: unknown } | null {
  // InvalidPipelineRelationshipError here means the :id PATH parameter
  // doesn't resolve — a path-identified parent, same role as a company's
  // own :id elsewhere — so it maps to 404, NOT 400 (contrast with
  // deals/handlers.ts, where pipelineId is a body field and the identical
  // error class maps to 400 there).
  if (err instanceof InvalidPipelineRelationshipError) {
    return { status: 404, body: { error: "Not found" } };
  }
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: err.message } };
  }
  return null;
}

interface StageRequestBody {
  name?: unknown;
  sortOrder?: unknown;
  probability?: unknown;
  isWonStage?: unknown;
  isLostStage?: unknown;
}

/**
 * Mass-assignment protection: only these five fields are ever read from
 * the body. `pipelineId` is ALWAYS taken from the URL path parameter,
 * NEVER from the body — a body field named `pipelineId` (or any other
 * name) has no code path to override it, exactly mirroring
 * organizationId's own "never from the request" discipline. This is what
 * makes it structurally impossible to create a stage under a different
 * pipeline than the one named in the URL, regardless of what the body
 * claims.
 */
function extractCreateInput(rawBody: unknown, pipelineId: string): CreatePipelineStageInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as StageRequestBody;
  return {
    pipelineId,
    name: body.name as string,
    sortOrder: body.sortOrder as number,
    ...(body.probability !== undefined ? { probability: body.probability as number | null } : {}),
    ...(body.isWonStage !== undefined ? { isWonStage: body.isWonStage as boolean } : {}),
    ...(body.isLostStage !== undefined ? { isLostStage: body.isLostStage as boolean } : {}),
  };
}

function toStageResponseBody(stage: PipelineStage): { stage: PipelineStage } {
  return { stage };
}

export async function handleListPipelineStages(userId: string | null, pipelineId: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const pipeline = await getPipelineById(actor, pipelineId);
  if (!pipeline) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const stages = await listPipelineStages(actor, pipelineId);
  return NextResponse.json({ stages });
}

export async function handleCreatePipelineStage(
  userId: string | null,
  pipelineId: string,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:create");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractCreateInput(rawBody, pipelineId);
  const route = `/api/v1/pipelines/${pipelineId}/stages`;

  if (!idempotencyKey) {
    try {
      const stage = await createPipelineStage(actor, input);
      return NextResponse.json(toStageResponseBody(stage), { status: 201 });
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return NextResponse.json({ error: "Failed to create pipeline stage" }, { status: 500 });
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "POST", route, body: input },
      async (client) => {
        try {
          const stage = await createPipelineStage(actor, input, client);
          return { status: 201, body: toStageResponseBody(stage) };
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
      return NextResponse.json({ error: "Idempotency-Key already used with a different request" }, { status: 409 });
    }
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    return NextResponse.json({ error: "Failed to create pipeline stage" }, { status: 500 });
  }
}

// Re-exported for [stageId]/handlers.ts — shared rather than duplicated.
export { mapCrmError, toStageResponseBody };
