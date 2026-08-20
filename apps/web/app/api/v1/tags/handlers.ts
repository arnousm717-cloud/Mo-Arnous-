import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser, type Actor, type PermissionKey } from "@ai-revenue-os/auth";
import {
  createTag,
  listTags,
  ValidationError,
  DuplicateTagNameError,
  type Tag,
  type CreateTagInput,
} from "@ai-revenue-os/crm";
import { withIdempotency } from "../_shared/idempotency";
import { apiError, buildApiErrorBody } from "../_shared/api-error";

/**
 * Milestone 2.3D. Mirrors activities/handlers.ts (and, through it,
 * deals/handlers.ts) exactly — see their own comments for the full
 * rationale, not repeated here. Tags has no polymorphic relationship
 * fields, so no InvalidXRelationshipError mapping and no relatedToId-style
 * UUID filter is needed here at all — only cursor/limit, matching
 * packages/crm's own ListTagsInput exactly (frozen 2.3 minimal filter
 * scope: no name lookup, no full-text search).
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
  if (err instanceof DuplicateTagNameError) {
    return { status: 409, body: buildApiErrorBody("CONFLICT", err.message) };
  }
  if (err instanceof ValidationError) {
    return { status: 400, body: buildApiErrorBody("VALIDATION_ERROR", err.message) };
  }
  return null;
}

interface TagRequestBody {
  name?: unknown;
  color?: unknown;
}

/**
 * Mass-assignment protection: only these two fields are ever read from
 * the body.
 */
function extractCreateInput(rawBody: unknown): CreateTagInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as TagRequestBody;
  return {
    name: body.name as string,
    ...(body.color !== undefined ? { color: body.color as string | null } : {}),
  };
}

function toTagResponseBody(tag: Tag): { tag: Tag } {
  return { tag };
}

export async function handleListTags(userId: string | null, url: URL): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tags:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");

  try {
    const page = await listTags(actor, {
      ...(cursor !== null ? { cursor } : {}),
      ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
    });
    return NextResponse.json({ tags: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof ValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to list tags", 500);
  }
}

export async function handleCreateTag(
  userId: string | null,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tags:create");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractCreateInput(rawBody);

  if (!idempotencyKey) {
    try {
      const tag = await createTag(actor, input);
      return NextResponse.json(toTagResponseBody(tag), { status: 201 });
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to create tag", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "POST", route: "/api/v1/tags", body: input },
      async (client) => {
        try {
          const tag = await createTag(actor, input, client);
          return { status: 201, body: toTagResponseBody(tag) };
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
    return apiError("INTERNAL_ERROR", "Failed to create tag", 500);
  }
}

// Re-exported for [id]/handlers.ts AND ../taggings/handlers.ts (Taggings
// authorizes under tags:* — 2.3C frozen design, no taggings:* permission
// family) — mirrors the pipeline_stages precedent of importing a parent
// resource's resolveActor rather than duplicating it.
export { resolveActor, mapCrmError, toTagResponseBody };
export type { ResolvedActor };
