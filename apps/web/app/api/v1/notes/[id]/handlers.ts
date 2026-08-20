import { NextResponse } from "next/server";
import { updateNote, getNoteById, softDeleteNote, type UpdateNoteInput } from "@ai-revenue-os/crm";
import { withIdempotency } from "../../_shared/idempotency";
import { isValidUuid } from "../../_shared/uuid";
import { resolveActor, mapCrmError, toNoteResponseBody } from "../handlers";
import { apiError, buildApiErrorBody } from "../../_shared/api-error";

/**
 * Milestone 2.3D. Mirrors activities/[id]/handlers.ts exactly — see its
 * own comment for the full rationale, not repeated here.
 */

/** No relatedToType/relatedToId key anywhere in this extraction — not
 * reassignable in Milestone 2.3 (frozen design). */
function extractUpdateInput(rawBody: unknown): UpdateNoteInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  return { body: body.body as string };
}

export async function handleGetNote(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "notes:read");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const note = await getNoteById(actor, id);
  if (!note) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toNoteResponseBody(note));
}

export async function handleUpdateNote(
  userId: string | null,
  id: string,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "notes:update");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const input = extractUpdateInput(rawBody);
  const route = `/api/v1/notes/${id}`;

  if (!idempotencyKey) {
    try {
      const note = await updateNote(actor, id, input);
      if (!note) {
        return apiError("NOT_FOUND", "Not found", 404);
      }
      return NextResponse.json(toNoteResponseBody(note));
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to update note", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "PATCH", route, body: input },
      async (client) => {
        try {
          const note = await updateNote(actor, id, input, client);
          if (!note) {
            return { status: 404, body: buildApiErrorBody("NOT_FOUND", "Not found") };
          }
          return { status: 200, body: toNoteResponseBody(note) };
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
    return apiError("INTERNAL_ERROR", "Failed to update note", 500);
  }
}

export async function handleDeleteNote(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "notes:delete");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const note = await softDeleteNote(actor, id);
  if (!note) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toNoteResponseBody(note));
}
