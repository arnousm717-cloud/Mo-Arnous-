import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { fileDataSubjectRequest, type DsrRequestType, type DsrSubjectType } from "@ai-revenue-os/compliance";

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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:create")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = rawBody as FileDsrBody;
  if (!isNonEmptyString(body?.subjectType) || !SUBJECT_TYPES.includes(body.subjectType as DsrSubjectType)) {
    return NextResponse.json({ error: `subjectType must be one of: ${SUBJECT_TYPES.join(", ")}` }, { status: 400 });
  }
  if (!isNonEmptyString(body?.subjectId)) {
    return NextResponse.json({ error: "subjectId is required" }, { status: 400 });
  }
  if (!isNonEmptyString(body?.requestType) || !REQUEST_TYPES.includes(body.requestType as DsrRequestType)) {
    return NextResponse.json({ error: `requestType must be one of: ${REQUEST_TYPES.join(", ")}` }, { status: 400 });
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
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to file data subject request" }, { status: 500 });
  }
}
