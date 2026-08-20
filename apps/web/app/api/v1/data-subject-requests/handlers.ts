import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { fileDataSubjectRequest, type DsrRequestType, type DsrSubjectType } from "@ai-revenue-os/compliance";
import { apiError } from "../_shared/api-error";

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
export async function handleFileDataSubjectRequest(userId: string | null, rawBody: unknown): Promise<NextResponse> {
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

  try {
    const dataSubjectRequest = await fileDataSubjectRequest(
      { userId, organizationId: orgContext.organizationId, roleKey: orgContext.roleKey },
      {
        subjectType: body.subjectType as DsrSubjectType,
        subjectId: body.subjectId,
        requestType: body.requestType as DsrRequestType,
      },
    );
    return NextResponse.json({ dataSubjectRequest }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message.includes("only 'delete' is supported")) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to file data subject request", 500);
  }
}
