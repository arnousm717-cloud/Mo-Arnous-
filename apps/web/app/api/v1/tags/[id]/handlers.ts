import { NextResponse } from "next/server";
import { updateTag, getTagById, softDeleteTag, type UpdateTagInput } from "@ai-revenue-os/crm";
import { withIdempotency } from "../../_shared/idempotency";
import { isValidUuid } from "../../_shared/uuid";
import { resolveActor, mapCrmError, toTagResponseBody } from "../handlers";
import { apiError, buildApiErrorBody } from "../../_shared/api-error";

/**
 * Milestone 2.3D. Mirrors activities/[id]/handlers.ts exactly — see its
 * own comment for the full rationale, not repeated here.
 */

function extractUpdateInput(rawBody: unknown): UpdateTagInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const input: UpdateTagInput = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (has("name")) input.name = body.name as string;
  if (has("color")) input.color = body.color as string | null;
  return input;
}

export async function handleGetTag(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tags:read");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const tag = await getTagById(actor, id);
  if (!tag) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toTagResponseBody(tag));
}

export async function handleUpdateTag(
  userId: string | null,
  id: string,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tags:update");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const input = extractUpdateInput(rawBody);
  const route = `/api/v1/tags/${id}`;

  if (!idempotencyKey) {
    try {
      const tag = await updateTag(actor, id, input);
      if (!tag) {
        return apiError("NOT_FOUND", "Not found", 404);
      }
      return NextResponse.json(toTagResponseBody(tag));
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to update tag", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "PATCH", route, body: input },
      async (client) => {
        try {
          const tag = await updateTag(actor, id, input, client);
          if (!tag) {
            return { status: 404, body: buildApiErrorBody("NOT_FOUND", "Not found") };
          }
          return { status: 200, body: toTagResponseBody(tag) };
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
    return apiError("INTERNAL_ERROR", "Failed to update tag", 500);
  }
}

export async function handleDeleteTag(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tags:delete");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const tag = await softDeleteTag(actor, id);
  if (!tag) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toTagResponseBody(tag));
}
