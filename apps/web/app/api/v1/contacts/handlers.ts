import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser, type Actor, type PermissionKey } from "@ai-revenue-os/auth";
import {
  createContact,
  listContacts,
  ValidationError,
  InvalidOwnerError,
  InvalidCompanyRelationshipError,
  DuplicateContactEmailError,
  type Contact,
  type CreateContactInput,
} from "@ai-revenue-os/crm";
import { withIdempotency } from "../_shared/idempotency";
import { apiError, buildApiErrorBody } from "../_shared/api-error";

/** Milestone 2.1F-B. Mirrors companies/handlers.ts exactly — see its own
 * comments for the full rationale, not repeated here. */

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

/** instanceof-checks against packages/crm's typed errors — never fragile
 * message-substring matching. DuplicateContactEmailError -> 409, the other
 * three -> 400. Returns null for anything unexpected. */
function mapCrmError(err: unknown): { status: number; body: unknown } | null {
  if (err instanceof DuplicateContactEmailError) {
    return { status: 409, body: buildApiErrorBody("CONFLICT", err.message) };
  }
  if (
    err instanceof ValidationError ||
    err instanceof InvalidOwnerError ||
    err instanceof InvalidCompanyRelationshipError
  ) {
    return { status: 400, body: buildApiErrorBody("VALIDATION_ERROR", err.message) };
  }
  return null;
}

interface ContactRequestBody {
  companyId?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  phone?: unknown;
  jobTitle?: unknown;
  linkedinUrl?: unknown;
  lifecycleStage?: unknown;
  ownerId?: unknown;
}

/** Mass-assignment protection: only these nine fields are ever read from
 * the body — id/organizationId/organization_id/deletedAt/createdAt/
 * updatedAt have no extraction path here at all. */
function extractCreateInput(rawBody: unknown): CreateContactInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as ContactRequestBody;
  return {
    ...(body.companyId !== undefined ? { companyId: body.companyId as string | null } : {}),
    ...(body.firstName !== undefined ? { firstName: body.firstName as string | null } : {}),
    ...(body.lastName !== undefined ? { lastName: body.lastName as string | null } : {}),
    ...(body.email !== undefined ? { email: body.email as string | null } : {}),
    ...(body.phone !== undefined ? { phone: body.phone as string | null } : {}),
    ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle as string | null } : {}),
    ...(body.linkedinUrl !== undefined ? { linkedinUrl: body.linkedinUrl as string | null } : {}),
    ...(body.lifecycleStage !== undefined ? { lifecycleStage: body.lifecycleStage as string | null } : {}),
    ...(body.ownerId !== undefined ? { ownerId: body.ownerId as string | null } : {}),
  };
}

function toContactResponseBody(contact: Contact): { contact: Contact } {
  return { contact };
}

export async function handleListContacts(userId: string | null, url: URL): Promise<NextResponse> {
  const actor = await resolveActor(userId, "contacts:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const companyId = url.searchParams.get("companyId");
  const ownerId = url.searchParams.get("ownerId");
  const lifecycleStage = url.searchParams.get("lifecycleStage");

  try {
    const page = await listContacts(actor, {
      ...(cursor !== null ? { cursor } : {}),
      ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
      ...(companyId !== null ? { companyId } : {}),
      ...(ownerId !== null ? { ownerId } : {}),
      ...(lifecycleStage !== null ? { lifecycleStage } : {}),
    });
    return NextResponse.json({ contacts: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof ValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to list contacts", 500);
  }
}

export async function handleCreateContact(
  userId: string | null,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "contacts:create");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractCreateInput(rawBody);

  if (!idempotencyKey) {
    try {
      const contact = await createContact(actor, input);
      return NextResponse.json(toContactResponseBody(contact), { status: 201 });
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to create contact", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "POST", route: "/api/v1/contacts", body: input },
      async (client) => {
        try {
          const contact = await createContact(actor, input, client);
          return { status: 201, body: toContactResponseBody(contact) };
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
    return apiError("INTERNAL_ERROR", "Failed to create contact", 500);
  }
}

// Re-exported for [id]/handlers.ts — shared with this file's own handlers
// rather than duplicated, matching CLAUDE.md's "no duplicate logic" rule.
export { resolveActor, mapCrmError, toContactResponseBody };
export type { ResolvedActor };
