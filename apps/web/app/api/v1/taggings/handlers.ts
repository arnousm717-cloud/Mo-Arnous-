import { NextResponse } from "next/server";
import {
  createTagging,
  listTaggings,
  ValidationError,
  InvalidTagRelationshipError,
  InvalidCompanyRelationshipError,
  InvalidContactRelationshipError,
  InvalidDealRelationshipError,
  DuplicateTaggingError,
  type Tagging,
  type CreateTaggingInput,
} from "@ai-revenue-os/crm";
import { isValidUuid } from "../_shared/uuid";
import { resolveActor } from "../tags/handlers";
import { apiError, buildApiErrorBody } from "../_shared/api-error";

/**
 * Milestone 2.3D. Taggings has no permission keys of its own — every
 * operation here authorizes under the OWNING Tag's own tags:* keys,
 * exactly as packages/auth/src/permissions.ts's own comment documents
 * (2.3C frozen design), mirroring pipeline_stages' precedent of importing
 * a parent resource's resolveActor rather than duplicating it (contrast
 * with activities/notes/tags/handlers.ts, which each define their own —
 * Taggings deliberately does NOT, since it has no key family of its own
 * to check).
 *
 * No idempotency machinery on POST (deliberate, frozen 2.3 design):
 * duplicate Tagging creation is already uniquely constrained at the
 * database level (taggings_tag_id_taggable_type_taggable_id_key) and maps
 * to 409 through that constraint — adding Idempotency-Key replay on top
 * would be unnecessary complexity for a resource with no other mutable
 * state to replay.
 */

const TAGGABLE_TYPES = ["company", "contact", "deal"];

function mapTaggingCrmError(err: unknown): { status: number; body: unknown } | null {
  if (err instanceof DuplicateTaggingError) {
    return { status: 409, body: buildApiErrorBody("CONFLICT", err.message) };
  }
  if (
    err instanceof ValidationError ||
    err instanceof InvalidTagRelationshipError ||
    err instanceof InvalidCompanyRelationshipError ||
    err instanceof InvalidContactRelationshipError ||
    err instanceof InvalidDealRelationshipError
  ) {
    return { status: 400, body: buildApiErrorBody("VALIDATION_ERROR", err.message) };
  }
  return null;
}

interface TaggingRequestBody {
  tagId?: unknown;
  taggableType?: unknown;
  taggableId?: unknown;
}

/** Mass-assignment protection: only these three fields are ever read from
 * the body. */
function extractCreateInput(rawBody: unknown): CreateTaggingInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as TaggingRequestBody;
  return {
    tagId: body.tagId as string,
    taggableType: body.taggableType as CreateTaggingInput["taggableType"],
    taggableId: body.taggableId as string,
  };
}

function toTaggingResponseBody(tagging: Tagging): { tagging: Tagging } {
  return { tagging };
}

export async function handleListTaggings(userId: string | null, url: URL): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tags:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const tagId = url.searchParams.get("tagId");
  const taggableType = url.searchParams.get("taggableType");
  const taggableId = url.searchParams.get("taggableId");

  if (tagId !== null && !isValidUuid(tagId)) {
    return apiError("VALIDATION_ERROR", "tagId must be a valid UUID", 400);
  }
  if (taggableType !== null && !TAGGABLE_TYPES.includes(taggableType)) {
    return apiError("VALIDATION_ERROR", `taggableType must be one of ${TAGGABLE_TYPES.join(", ")}`, 400);
  }
  if (taggableId !== null && !isValidUuid(taggableId)) {
    return apiError("VALIDATION_ERROR", "taggableId must be a valid UUID", 400);
  }

  try {
    const page = await listTaggings(actor, {
      ...(cursor !== null ? { cursor } : {}),
      ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
      ...(tagId !== null ? { tagId } : {}),
      ...(taggableType !== null ? { taggableType: taggableType as CreateTaggingInput["taggableType"] } : {}),
      ...(taggableId !== null ? { taggableId } : {}),
    });
    return NextResponse.json({ taggings: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof ValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to list taggings", 500);
  }
}

export async function handleCreateTagging(userId: string | null, rawBody: unknown): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tags:create");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractCreateInput(rawBody);
  if (input.tagId !== undefined && input.tagId !== null && !isValidUuid(input.tagId)) {
    return apiError("VALIDATION_ERROR", "tagId must be a valid UUID", 400);
  }
  if (input.taggableId !== undefined && input.taggableId !== null && !isValidUuid(input.taggableId)) {
    return apiError("VALIDATION_ERROR", "taggableId must be a valid UUID", 400);
  }

  try {
    const tagging = await createTagging(actor, input);
    return NextResponse.json(toTaggingResponseBody(tagging), { status: 201 });
  } catch (err) {
    const mapped = mapTaggingCrmError(err);
    if (mapped) {
      return NextResponse.json(mapped.body, { status: mapped.status });
    }
    return apiError("INTERNAL_ERROR", "Failed to create tagging", 500);
  }
}

export { resolveActor, mapTaggingCrmError, toTaggingResponseBody };
