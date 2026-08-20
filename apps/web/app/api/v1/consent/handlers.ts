import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { recordConsent, type ConsentStatus, type ConsentSubjectType, type ConsentType } from "@ai-revenue-os/compliance";
import { apiError } from "../_shared/api-error";

/**
 * Kept out of route.ts deliberately — same reasoning as every other
 * handlers.ts in this codebase (see organizations/handlers.ts): Next.js's
 * route.ts only permits recognized HTTP-method exports, and splitting the
 * logic out lets it take an already-resolved userId rather than reading
 * cookies itself, which is what makes it directly testable without a
 * running dev server.
 */

const SUBJECT_TYPES: ConsentSubjectType[] = ["contact", "visitor", "portal_user"];
const CONSENT_TYPES: ConsentType[] = ["marketing_email", "cookie_tracking", "data_processing"];
const STATUSES: ConsentStatus[] = ["granted", "withdrawn"];

interface RecordConsentBody {
  subjectType?: unknown;
  subjectId?: unknown;
  consentType?: unknown;
  status?: unknown;
  source?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Staff-recorded consent — org_admin only (M1.6 Decision F), gated through
 * can() (M1.5's RBAC facade) rather than an inline role comparison.
 * organization_id comes exclusively from the caller's own server-resolved
 * context, never the request body, matching every other mutating route in
 * this codebase.
 */
export async function handleRecordConsent(userId: string | null, rawBody: unknown): Promise<NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  // The explicit `!orgContext` here is redundant with can()'s own null
  // handling at runtime — it exists purely so TypeScript narrows orgContext
  // to non-null for the code below, same pattern as
  // organizations/handlers.ts's handleCreateOrganization.
  if (!orgContext || !can({ userId, ...orgContext }, "consent:record")) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }

  const body = rawBody as RecordConsentBody;
  if (!isNonEmptyString(body?.subjectType) || !SUBJECT_TYPES.includes(body.subjectType as ConsentSubjectType)) {
    return apiError("VALIDATION_ERROR", `subjectType must be one of: ${SUBJECT_TYPES.join(", ")}`, 400);
  }
  if (!isNonEmptyString(body?.subjectId)) {
    return apiError("VALIDATION_ERROR", "subjectId is required", 400);
  }
  if (!isNonEmptyString(body?.consentType) || !CONSENT_TYPES.includes(body.consentType as ConsentType)) {
    return apiError("VALIDATION_ERROR", `consentType must be one of: ${CONSENT_TYPES.join(", ")}`, 400);
  }
  if (!isNonEmptyString(body?.status) || !STATUSES.includes(body.status as ConsentStatus)) {
    return apiError("VALIDATION_ERROR", `status must be one of: ${STATUSES.join(", ")}`, 400);
  }
  const source = body.source;
  if (source !== undefined && typeof source !== "string") {
    return apiError("VALIDATION_ERROR", "source must be a string when provided", 400);
  }

  try {
    const consent = await recordConsent(
      { userId, organizationId: orgContext.organizationId, roleKey: orgContext.roleKey },
      {
        subjectType: body.subjectType as ConsentSubjectType,
        subjectId: body.subjectId,
        consentType: body.consentType as ConsentType,
        status: body.status as ConsentStatus,
        ...(source ? { source } : {}),
      },
    );
    return NextResponse.json({ consent }, { status: 201 });
  } catch {
    // Never forward raw DB/driver error text to the client — same
    // discipline as handleCreateOrganization.
    return apiError("INTERNAL_ERROR", "Failed to record consent", 500);
  }
}
