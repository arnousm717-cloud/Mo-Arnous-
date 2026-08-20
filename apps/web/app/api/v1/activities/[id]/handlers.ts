import { NextResponse } from "next/server";
import {
  updateActivity,
  getActivityById,
  softDeleteActivity,
  type UpdateActivityInput,
  type CreateActivityInput,
} from "@ai-revenue-os/crm";
import { withIdempotency } from "../../_shared/idempotency";
import { isValidUuid } from "../../_shared/uuid";
import { resolveActor, mapCrmError, toActivityResponseBody } from "../handlers";
import { apiError, buildApiErrorBody } from "../../_shared/api-error";

/**
 * Milestone 2.3D. Cross-org and nonexistent :id are indistinguishable —
 * packages/crm's getActivityById/updateActivity/softDeleteActivity already
 * return null for both cases identically; this file adds no
 * special-casing at all, it just maps null to 404 (matching the existing
 * companies/contacts/deals precedent). A malformed (non-UUID-shaped) :id
 * is classified identically — also 404, never reaching the database at
 * all — extending that same "path :id reveals nothing about why" doctrine
 * to a third case (Milestone 2.3D malformed-UUID hardening).
 */

/** hasOwnProperty-preserving extraction — a key is only present on the
 * returned object if it was actually present in the raw parsed body, so
 * packages/crm's own Object.prototype.hasOwnProperty-based partial-update
 * logic sees exactly what the client sent. No relatedToType/relatedToId
 * key anywhere in this extraction — those are not reassignable in
 * Milestone 2.3 (frozen design), never client-settable through this or
 * any other path, mirroring how deals/[id]/handlers.ts never lets status
 * be set directly. */
function extractUpdateInput(rawBody: unknown): UpdateActivityInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const input: UpdateActivityInput = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (has("type")) input.type = body.type as CreateActivityInput["type"];
  if (has("subject")) input.subject = body.subject as string | null;
  if (has("body")) input.body = body.body as string | null;
  if (has("dueAt")) input.dueAt = body.dueAt as string | null;
  if (has("completedAt")) input.completedAt = body.completedAt as string | null;
  return input;
}

export async function handleGetActivity(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "activities:read");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const activity = await getActivityById(actor, id);
  if (!activity) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toActivityResponseBody(activity));
}

export async function handleUpdateActivity(
  userId: string | null,
  id: string,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "activities:update");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const input = extractUpdateInput(rawBody);
  const route = `/api/v1/activities/${id}`;

  if (!idempotencyKey) {
    try {
      const activity = await updateActivity(actor, id, input);
      if (!activity) {
        return apiError("NOT_FOUND", "Not found", 404);
      }
      return NextResponse.json(toActivityResponseBody(activity));
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to update activity", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "PATCH", route, body: input },
      async (client) => {
        try {
          const activity = await updateActivity(actor, id, input, client);
          if (!activity) {
            return { status: 404, body: buildApiErrorBody("NOT_FOUND", "Not found") };
          }
          return { status: 200, body: toActivityResponseBody(activity) };
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
    return apiError("INTERNAL_ERROR", "Failed to update activity", 500);
  }
}

export async function handleDeleteActivity(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "activities:delete");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const activity = await softDeleteActivity(actor, id);
  if (!activity) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toActivityResponseBody(activity));
}
