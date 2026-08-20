import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser, type Actor, type PermissionKey } from "@ai-revenue-os/auth";
import { createPipeline, listPipelines, ValidationError, type Pipeline, type CreatePipelineInput } from "@ai-revenue-os/crm";
import { withIdempotency } from "../_shared/idempotency";
import { apiError, buildApiErrorBody } from "../_shared/api-error";

/**
 * Milestone 2.2D. Mirrors companies/handlers.ts exactly — see its own
 * comments for the full rationale, not repeated here.
 */

interface ResolvedActor {
  userId: string;
  organizationId: string;
  roleKey: string;
}

async function resolveActor(
  userId: string | null,
  permission: PermissionKey,
): Promise<ResolvedActor | NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }
  const orgContext = await resolveOrganizationContextForUser(userId);
  const actor: Actor | null = orgContext ? { userId, ...orgContext } : null;
  if (!actor || !can(actor, permission)) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }
  return { userId, organizationId: orgContext!.organizationId, roleKey: orgContext!.roleKey };
}

function mapCrmError(err: unknown): { status: number; body: unknown } | null {
  if (err instanceof ValidationError) {
    return { status: 400, body: buildApiErrorBody("VALIDATION_ERROR", err.message) };
  }
  return null;
}

interface PipelineRequestBody {
  name?: unknown;
  isDefault?: unknown;
}

/**
 * Mass-assignment protection: only `name`/`isDefault` are ever read from
 * the body — id/organizationId/organization_id/deletedAt/createdAt/
 * updatedAt have no extraction path here at all. `isDefault` is
 * deliberately accepted HERE (create-time only) because packages/crm's
 * own createPipeline already handles "create as default" transactionally
 * and safely (unset-then-insert, never violating the single-active-
 * default invariant) — this is categorically different from exposing
 * isDefault through an ordinary PATCH of an EXISTING resource, which
 * [id]/handlers.ts's extractUpdateInput deliberately has no code path for
 * at all (see that file's own comment).
 */
function extractCreateInput(rawBody: unknown): CreatePipelineInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as PipelineRequestBody;
  return {
    name: body.name as string,
    ...(body.isDefault !== undefined ? { isDefault: body.isDefault as boolean } : {}),
  };
}

function toPipelineResponseBody(pipeline: Pipeline): { pipeline: Pipeline } {
  return { pipeline };
}

export async function handleListPipelines(userId: string | null, url: URL): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");

  try {
    const page = await listPipelines(actor, {
      ...(cursor !== null ? { cursor } : {}),
      ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
    });
    return NextResponse.json({ pipelines: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof ValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to list pipelines", 500);
  }
}

export async function handleCreatePipeline(
  userId: string | null,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:create");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractCreateInput(rawBody);

  if (!idempotencyKey) {
    try {
      const pipeline = await createPipeline(actor, input);
      return NextResponse.json(toPipelineResponseBody(pipeline), { status: 201 });
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to create pipeline", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "POST", route: "/api/v1/pipelines", body: input },
      async (client) => {
        try {
          const pipeline = await createPipeline(actor, input, client);
          return { status: 201, body: toPipelineResponseBody(pipeline) };
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
    return apiError("INTERNAL_ERROR", "Failed to create pipeline", 500);
  }
}

// Re-exported for [id]/handlers.ts, [id]/set-default/handlers.ts, and
// [id]/stages/*/handlers.ts — shared rather than duplicated.
export { resolveActor, mapCrmError, toPipelineResponseBody };
export type { ResolvedActor };
