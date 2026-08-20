import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { getDataSubjectRequestById } from "@ai-revenue-os/compliance";
import { apiError } from "../../_shared/api-error";

export async function handleGetDataSubjectRequest(userId: string | null, id: string): Promise<NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:read")) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }

  const dataSubjectRequest = await getDataSubjectRequestById(
    { userId, organizationId: orgContext.organizationId, roleKey: orgContext.roleKey },
    id,
  );
  if (!dataSubjectRequest) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  return NextResponse.json({ dataSubjectRequest });
}
