import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { fileDataSubjectRequest, type DsrRequestType, type DsrSubjectType } from "@ai-revenue-os/compliance";
import { apiError } from "../_shared/api-error";
import { withIdempotency } from "../_shared/idempotency";

const SUBJECT_TYPES: DsrSubjectType[] = ["contact", "visitor", "portal_user", "user"];
const REQUEST_TYPES: DsrRequestType[] = ["access", "export", "delete"];

interface FileDsrBody {
  subjectType?: unknown;
  subjectId?: unknown;
  requestType?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Files a data subject request — org_admin only (M1.6 Decision F).
 * organization_id comes exclusively from the caller's own server-resolved
 * context. request_type is schema-valid for 'access'/'export' (docs/03
 * §2.8) but only 'delete' has any fulfillment logic in M1.6 —
 * fileDataSubjectRequest() itself rejects the other two; this handler
 * surfaces that as a clean 400 rather than a generic 500.
 */
export async function handleFileDataSubjectRequest(
  userId: string | null,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:create")) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }

  const body = rawBody as FileDsrBody;
  if (!isNonEmptyString(body?.subjectType) || !SUBJECT_TYPES.includes(body.subjectType as DsrSubjectType)) {
    return apiError("VALIDATION_ERROR", `subjectType must be one of: ${SUBJECT_TYPES.join(", ")}`, 400);
  }
  if (!isNonEmptyString(body?.subjectId)) {
    return apiError("VALIDATION_ERROR", "subjectId is required", 400);
  }
  if (!isNonEmptyString(body?.requestType) || !REQUEST_TYPES.includes(body.requestType as DsrRequestType)) {
    return apiError("VALIDATION_ERROR", `requestType must be one of: ${REQUEST_TYPES.join(", ")}`, 400);
  }

  const actor = { userId, organizationId: orgContext.organizationId, roleKey: orgContext.roleKey };
  const input = {
    subjectType: body.subjectType as DsrSubjectType,
    subjectId: body.subjectId,
    requestType: body.requestType as DsrRequestType,
  };

  function mapFileError(err: unknown): NextResponse | null {
    if (err instanceof Error && err.message.includes("only 'delete' is supported")) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return null;
  }

  if (!idempotencyKey) {
    try {
      const dataSubjectRequest = await fileDataSubjectRequest(actor, input);
      return NextResponse.json({ dataSubjectRequest }, { status: 201 });
    } catch (err) {
      const mapped = mapFileError(err);
      if (mapped) return mapped;
      return apiError("INTERNAL_ERROR", "Failed to file data subject request", 500);
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "POST", route: "/api/v1/data-subject-requests", body: input },
      async (client) => {
        // Milestone 2.5B: fileDataSubjectRequest runs on this same client,
        // inside the reservation's own transaction — see recordConsent's
        // own comment in consent/handlers.ts for the full rationale.
        const dataSubjectRequest = await fileDataSubjectRequest(actor, input, client);
        return { status: 201, body: { dataSubjectRequest } };
      },
    );

    if (outcome.kind === "conflict") {
      return apiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key already used with a different request", 409);
    }
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (err) {
    const mapped = mapFileError(err);
    if (mapped) return mapped;
    return apiError("INTERNAL_ERROR", "Failed to file data subject request", 500);
  }
}
