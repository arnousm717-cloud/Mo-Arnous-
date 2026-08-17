import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser, type Actor, type PermissionKey } from "@ai-revenue-os/auth";
import {
  createNote,
  listNotes,
  ValidationError,
  InvalidCompanyRelationshipError,
  InvalidContactRelationshipError,
  InvalidDealRelationshipError,
  type Note,
  type CreateNoteInput,
} from "@ai-revenue-os/crm";
import { withIdempotency } from "../_shared/idempotency";
import { isValidUuid } from "../_shared/uuid";

/**
 * Milestone 2.3D. Mirrors activities/handlers.ts (and, through it,
 * deals/handlers.ts) exactly — see their own comments for the full
 * rationale, not repeated here. createdBy is never read from the request
 * body — packages/crm's createNote sources it exclusively from
 * ctx.userId (2.3B).
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

const RELATED_TO_TYPES = ["company", "contact", "deal"];

interface NoteRequestBody {
  relatedToType?: unknown;
  relatedToId?: unknown;
  body?: unknown;
}

/**
 * Mass-assignment protection: only these three fields are ever read from
 * the body. id/organizationId/organization_id/createdBy/created_by/
 * createdAt/created_at/updatedAt/updated_at/deletedAt/deleted_at have no
 * corresponding extraction here at all.
 */
function extractCreateInput(rawBody: unknown): CreateNoteInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as NoteRequestBody;
  return {
    relatedToType: body.relatedToType as CreateNoteInput["relatedToType"],
    relatedToId: body.relatedToId as string,
    body: body.body as string,
  };
}

function toNoteResponseBody(note: Note): { note: Note } {
  return { note };
}

export async function handleListNotes(userId: string | null, url: URL): Promise<NextResponse> {
  const actor = await resolveActor(userId, "notes:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const relatedToType = url.searchParams.get("relatedToType");
  const relatedToId = url.searchParams.get("relatedToId");

  if (relatedToType !== null && !RELATED_TO_TYPES.includes(relatedToType)) {
    return NextResponse.json({ error: `relatedToType must be one of ${RELATED_TO_TYPES.join(", ")}` }, { status: 400 });
  }
  if (relatedToId !== null && !isValidUuid(relatedToId)) {
    return NextResponse.json({ error: "relatedToId must be a valid UUID" }, { status: 400 });
  }

  try {
    const page = await listNotes(actor, {
      ...(cursor !== null ? { cursor } : {}),
      ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
      ...(relatedToType !== null ? { relatedToType: relatedToType as CreateNoteInput["relatedToType"] } : {}),
      ...(relatedToId !== null ? { relatedToId } : {}),
    });
    return NextResponse.json({ notes: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to list notes" }, { status: 500 });
  }
}

export async function handleCreateNote(
  userId: string | null,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "notes:create");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractCreateInput(rawBody);
  if (input.relatedToId !== undefined && input.relatedToId !== null && !isValidUuid(input.relatedToId)) {
    return NextResponse.json({ error: "relatedToId must be a valid UUID" }, { status: 400 });
  }

  if (!idempotencyKey) {
    try {
      const note = await createNote(actor, input);
      return NextResponse.json(toNoteResponseBody(note), { status: 201 });
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return NextResponse.json({ error: "Failed to create note" }, { status: 500 });
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "POST", route: "/api/v1/notes", body: input },
      async (client) => {
        try {
          const note = await createNote(actor, input, client);
          return { status: 201, body: toNoteResponseBody(note) };
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
    return NextResponse.json({ error: "Failed to create note" }, { status: 500 });
  }
}

export { resolveActor, mapCrmError, toNoteResponseBody };
export type { ResolvedActor };
