import { NextResponse } from "next/server";
import { updateDeal, getDealById, softDeleteDeal, type UpdateDealInput } from "@ai-revenue-os/crm";
import { withIdempotency } from "../../_shared/idempotency";
import { resolveActor, mapCrmError, toDealResponseBody } from "../handlers";
import { apiError, buildApiErrorBody } from "../../_shared/api-error";
import { isValidUuid } from "../../_shared/uuid";

/**
 * Milestone 2.2D. Cross-org and nonexistent :id are indistinguishable —
 * packages/crm's getDealById/updateDeal/softDeleteDeal already return null
 * for both cases identically; this file adds no special-casing at all, it
 * just maps null to 404 (matching the existing companies/contacts
 * precedent).
 */

/** hasOwnProperty-preserving extraction — a key is only present on the
 * returned object if it was actually present in the raw parsed body, so
 * packages/crm's own Object.prototype.hasOwnProperty-based partial-update
 * logic sees exactly what the client sent. No `status` key anywhere in
 * this extraction — status remains fully domain-derived (Milestone 2.2B),
 * never client-settable through this or any other path. */
function extractUpdateInput(rawBody: unknown): UpdateDealInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const input: UpdateDealInput = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (has("companyId")) input.companyId = body.companyId as string | null;
  if (has("primaryContactId")) input.primaryContactId = body.primaryContactId as string | null;
  if (has("pipelineId")) input.pipelineId = body.pipelineId as string;
  if (has("stageId")) input.stageId = body.stageId as string;
  if (has("amount")) input.amount = body.amount as number | string | null;
  if (has("currency")) input.currency = body.currency as string;
  if (has("probability")) input.probability = body.probability as number | null;
  if (has("expectedCloseDate")) input.expectedCloseDate = body.expectedCloseDate as string | null;
  if (has("ownerId")) input.ownerId = body.ownerId as string | null;
  return input;
}

export async function handleGetDeal(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "deals:read");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const deal = await getDealById(actor, id);
  if (!deal) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toDealResponseBody(deal));
}

export async function handleUpdateDeal(
  userId: string | null,
  id: string,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "deals:update");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const input = extractUpdateInput(rawBody);
  const route = `/api/v1/deals/${id}`;

  if (!idempotencyKey) {
    try {
      const deal = await updateDeal(actor, id, input);
      if (!deal) {
        return apiError("NOT_FOUND", "Not found", 404);
      }
      return NextResponse.json(toDealResponseBody(deal));
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return apiError("INTERNAL_ERROR", "Failed to update deal", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "PATCH", route, body: input },
      async (client) => {
        try {
          const deal = await updateDeal(actor, id, input, client);
          if (!deal) {
            return { status: 404, body: buildApiErrorBody("NOT_FOUND", "Not found") };
          }
          return { status: 200, body: toDealResponseBody(deal) };
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
    return apiError("INTERNAL_ERROR", "Failed to update deal", 500);
  }
}

export async function handleDeleteDeal(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "deals:delete");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const deal = await softDeleteDeal(actor, id);
  if (!deal) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toDealResponseBody(deal));
}
