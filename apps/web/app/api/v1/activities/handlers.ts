import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser, type Actor, type PermissionKey } from "@ai-revenue-os/auth";
import {
  createActivity,
  listActivities,
  ValidationError,
  InvalidCompanyRelationshipError,
  InvalidContactRelationshipError,
  InvalidDealRelationshipError,
  type Activity,
  type CreateActivityInput,
} from "@ai-revenue-os/crm";
import { withIdempotency } from "../_shared/idempotency";
import { isValidUuid } from "../_shared/uuid";

/**
 * Milestone 2.3D. Mirrors deals/handlers.ts exactly — see its own comment
 * for the full rationale, not repeated here. organizationId is never read
 * from the request; only from resolveOrganizationContextForUser's
 * server-resolved result. createdBy is never read from the request body
 * either — packages/crm's createActivity sources it exclusively from
 * ctx.userId (2.3B), which this file passes as `actor.userId`.
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const orgContext = await resolveOrganizationContextForUser(userId);
  const actor: Actor | null = orgContext ? { userId, ...orgContext } : null;
  if (!actor || !can(actor, permission)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { userId, organizationId: orgContext!.organizationId, roleKey: orgContext!.roleKey };
}

/**
 * instanceof-checks against packages/crm's typed errors — never fragile
 * message-substring matching. relatedToType/relatedToId are body fields
 * on an Activity (never a URL path resource identifier), so an invalid
 * relationship maps to 400, exactly like deals/handlers.ts's own
 * company/contact/pipeline/stage relationship errors. Returns null for
 * anything unexpected.
 */
function mapCrmError(err: unknown): { status: number; body: unknown } | null {
  if (
    err instanceof ValidationError ||
    err instanceof InvalidCompanyRelationshipError ||
    err instanceof InvalidContactRelationshipError ||
    err instanceof InvalidDealRelationshipError
  ) {
    return { status: 400, body: { error: err.message } };
  }
  return null;
}

const ACTIVITY_TYPES = ["call", "email", "meeting", "note", "task"];
const RELATED_TO_TYPES = ["company", "contact", "deal"];

interface ActivityRequestBody {
  type?: unknown;
  relatedToType?: unknown;
  relatedToId?: unknown;
  subject?: unknown;
  body?: unknown;
  dueAt?: unknown;
  completedAt?: unknown;
}

/**
 * Mass-assignment protection: only these seven fields are ever read from
 * the body. id/organizationId/organization_id/createdBy/created_by/
 * createdAt/created_at/updatedAt/updated_at/deletedAt/deleted_at have no
 * corresponding extraction here at all — there is no code path for them
 * to reach packages/crm, matching deals/handlers.ts's own extraction
 * discipline exactly.
 */
function extractCreateInput(rawBody: unknown): CreateActivityInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as ActivityRequestBody;
  return {
    type: body.type as CreateActivityInput["type"],
    relatedToType: body.relatedToType as CreateActivityInput["relatedToType"],
    relatedToId: body.relatedToId as string,
    ...(body.subject !== undefined ? { subject: body.subject as string | null } : {}),
    ...(body.body !== undefined ? { body: body.body as string | null } : {}),
    ...(body.dueAt !== undefined ? { dueAt: body.dueAt as string | null } : {}),
    ...(body.completedAt !== undefined ? { completedAt: body.completedAt as string | null } : {}),
  };
}

function toActivityResponseBody(activity: Activity): { activity: Activity } {
  return { activity };
}

export async function handleListActivities(userId: string | null, url: URL): Promise<NextResponse> {
  const actor = await resolveActor(userId, "activities:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const relatedToType = url.searchParams.get("relatedToType");
  const relatedToId = url.searchParams.get("relatedToId");
  const type = url.searchParams.get("type");
  const createdBy = url.searchParams.get("createdBy");
  const completedParam = url.searchParams.get("completed");

  if (relatedToType !== null && !RELATED_TO_TYPES.includes(relatedToType)) {
    return NextResponse.json({ error: `relatedToType must be one of ${RELATED_TO_TYPES.join(", ")}` }, { status: 400 });
  }
  if (relatedToId !== null && !isValidUuid(relatedToId)) {
    return NextResponse.json({ error: "relatedToId must be a valid UUID" }, { status: 400 });
  }
  if (type !== null && !ACTIVITY_TYPES.includes(type)) {
    return NextResponse.json({ error: `type must be one of ${ACTIVITY_TYPES.join(", ")}` }, { status: 400 });
  }
  if (createdBy !== null && !isValidUuid(createdBy)) {
    return NextResponse.json({ error: "createdBy must be a valid UUID" }, { status: 400 });
  }
  let completed: boolean | undefined;
  if (completedParam !== null) {
    if (completedParam !== "true" && completedParam !== "false") {
      return NextResponse.json({ error: "completed must be 'true' or 'false'" }, { status: 400 });
    }
    completed = completedParam === "true";
  }

  try {
    const page = await listActivities(actor, {
      ...(cursor !== null ? { cursor } : {}),
      ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
      ...(relatedToType !== null ? { relatedToType: relatedToType as CreateActivityInput["relatedToType"] } : {}),
      ...(relatedToId !== null ? { relatedToId } : {}),
      ...(type !== null ? { type: type as CreateActivityInput["type"] } : {}),
      ...(createdBy !== null ? { createdBy } : {}),
      ...(completed !== undefined ? { completed } : {}),
    });
    return NextResponse.json({ activities: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to list activities" }, { status: 500 });
  }
}

export async function handleCreateActivity(
  userId: string | null,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "activities:create");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractCreateInput(rawBody);
  if (input.relatedToId !== undefined && input.relatedToId !== null && !isValidUuid(input.relatedToId)) {
    return NextResponse.json({ error: "relatedToId must be a valid UUID" }, { status: 400 });
  }

  if (!idempotencyKey) {
    try {
      const activity = await createActivity(actor, input);
      return NextResponse.json(toActivityResponseBody(activity), { status: 201 });
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return NextResponse.json({ error: "Failed to create activity" }, { status: 500 });
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "POST", route: "/api/v1/activities", body: input },
      async (client) => {
        try {
          const activity = await createActivity(actor, input, client);
          return { status: 201, body: toActivityResponseBody(activity) };
        } catch (err) {
          const mapped = mapCrmError(err);
          if (mapped) {
            return mapped;
          }
          throw err; // unexpected — roll back the whole idempotency transaction
        }
      },
    );

    if (outcome.kind === "conflict") {
      return NextResponse.json({ error: "Idempotency-Key already used with a different request" }, { status: 409 });
    }
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    return NextResponse.json({ error: "Failed to create activity" }, { status: 500 });
  }
}

// Re-exported for [id]/handlers.ts — shared with this file's own handlers
// rather than duplicated, matching CLAUDE.md's "no duplicate logic" rule.
export { resolveActor, mapCrmError, toActivityResponseBody };
export type { ResolvedActor };
