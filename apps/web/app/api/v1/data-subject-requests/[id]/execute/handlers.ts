import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { getDataSubjectRequestById, executeUserErasure, executeContactErasure } from "@ai-revenue-os/compliance";
import { apiError } from "../../../_shared/api-error";
import { withIdempotency } from "../../../_shared/idempotency";

/**
 * Irreversible (M1.6 Decision D, dispatch added M2.1F-C) —
 * executeUserErasure()/executeContactErasure() each delegate entirely to
 * their own SECURITY DEFINER SQL function, which independently
 * re-validates authorization (and, for users, the sole-org_admin blocker)
 * itself; this handler does not trust or reuse any prior call to the
 * preview endpoint.
 *
 * Same tenant-scoped-fetch-then-dispatch shape as the preview handler:
 * the DSR is read via getDataSubjectRequestById (RLS: organization_id =
 * current_org()) before any dispatch decision, so a cross-org or
 * nonexistent id is a plain 404 and subject_type is read exclusively from
 * that server-fetched row — never from the request, and never assumed.
 */
export async function handleExecuteErasure(
  userId: string | null,
  id: string,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:execute")) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }

  const dsr = await getDataSubjectRequestById({ userId, ...orgContext }, id);
  if (!dsr) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  if (dsr.subjectType !== "user" && dsr.subjectType !== "contact") {
    return apiError("VALIDATION_ERROR", `subject_type '${dsr.subjectType}' has no erasure fulfillment logic`, 400);
  }

  function mapExecuteError(err: unknown): NextResponse | null {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("data subject request not found") || message.includes("contact not found")) {
      return apiError("NOT_FOUND", "Not found", 404);
    }
    if (message.includes("not an active org_admin")) {
      return apiError("FORBIDDEN", "Forbidden", 403);
    }
    if (message.includes("sole active org_admin")) {
      return apiError("CONFLICT", message, 409);
    }
    if (message.includes("already completed")) {
      return apiError("CONFLICT", message, 409);
    }
    if (message.includes("only supports")) {
      return apiError("VALIDATION_ERROR", message, 400);
    }
    return null;
  }

  if (!idempotencyKey) {
    try {
      const result =
        dsr.subjectType === "user" ? await executeUserErasure({ userId }, id) : await executeContactErasure({ userId }, id);
      return NextResponse.json({ result });
    } catch (err) {
      const mapped = mapExecuteError(err);
      if (mapped) return mapped;
      return apiError("INTERNAL_ERROR", "Failed to execute erasure", 500);
    }
  }

  // Milestone 2.5B: idempotency reservation is scoped by organizationId
  // (the tenant-isolation key idempotency_keys itself requires), entirely
  // separate from the {userId}-only ctx executeUserErasure/
  // executeContactErasure need — the SECURITY DEFINER SQL functions derive
  // everything else from auth.uid() + the dsrId.
  const idempotencyActor = { userId, organizationId: orgContext.organizationId, roleKey: orgContext.roleKey };

  try {
    const outcome = await withIdempotency(
      idempotencyActor,
      {
        rawIdempotencyKey: idempotencyKey,
        method: "POST",
        route: `/api/v1/data-subject-requests/${id}/execute`,
        body: {},
      },
      async (client) => {
        // Reservation + the real erasure + completion all share this one
        // client/transaction — see executeUserErasure/executeContactErasure's
        // own comment for the approved "Option A" atomicity fix. The
        // destructive DELETE and the reservation's own completion commit
        // or roll back together; nothing is ever half-persisted.
        const result =
          dsr.subjectType === "user"
            ? await executeUserErasure({ userId }, id, client)
            : await executeContactErasure({ userId }, id, client);
        return { status: 200, body: { result } };
      },
    );

    if (outcome.kind === "conflict") {
      return apiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key already used with a different request", 409);
    }
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (err) {
    const mapped = mapExecuteError(err);
    if (mapped) return mapped;
    return apiError("INTERNAL_ERROR", "Failed to execute erasure", 500);
  }
}
