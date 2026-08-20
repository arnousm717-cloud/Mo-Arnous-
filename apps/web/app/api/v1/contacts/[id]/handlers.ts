import { NextResponse } from "next/server";
import { updateContact, getContactById, softDeleteContact, type UpdateContactInput } from "@ai-revenue-os/crm";
import { withIdempotency } from "../../_shared/idempotency";
import { resolveActor, mapCrmError, toContactResponseBody } from "../handlers";
import { apiError, buildApiErrorBody } from "../../_shared/api-error";

/** Milestone 2.1F-B. Mirrors companies/[id]/handlers.ts exactly. */

function extractUpdateInput(rawBody: unknown): UpdateContactInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const input: UpdateContactInput = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (has("companyId")) input.companyId = body.companyId as string | null;
  if (has("firstName")) input.firstName = body.firstName as string | null;
  if (has("lastName")) input.lastName = body.lastName as string | null;
  if (has("email")) input.email = body.email as string | null;
  if (has("phone")) input.phone = body.phone as string | null;
  if (has("jobTitle")) input.jobTitle = body.jobTitle as string | null;
  if (has("linkedinUrl")) input.linkedinUrl = body.linkedinUrl as string | null;
  if (has("lifecycleStage")) input.lifecycleStage = body.lifecycleStage as string | null;
  if (has("ownerId")) input.ownerId = body.ownerId as string | null;
  return input;
}

export async function handleGetContact(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "contacts:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const contact = await getContactById(actor, id);
  if (!contact) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toContactResponseBody(contact));
}

export async function handleUpdateContact(
  userId: string | null,
  id: string,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "contacts:update");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractUpdateInput(rawBody);
  const route = `/api/v1/contacts/${id}`;

  if (!idempotencyKey) {
    try {
      const contact = await updateContact(actor, id, input);
      if (!contact) {
        return apiError("NOT_FOUND", "Not found", 404);
      }
      return NextResponse.json(toContactResponseBody(contact));
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to update contact", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "PATCH", route, body: input },
      async (client) => {
        try {
          const contact = await updateContact(actor, id, input, client);
          if (!contact) {
            return { status: 404, body: buildApiErrorBody("NOT_FOUND", "Not found") };
          }
          return { status: 200, body: toContactResponseBody(contact) };
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
    return apiError("INTERNAL_ERROR", "Failed to update contact", 500);
  }
}

export async function handleDeleteContact(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "contacts:delete");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const contact = await softDeleteContact(actor, id);
  if (!contact) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toContactResponseBody(contact));
}
