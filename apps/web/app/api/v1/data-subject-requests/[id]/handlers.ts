import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { getDataSubjectRequestById } from "@ai-revenue-os/compliance";

export async function handleGetDataSubjectRequest(userId: string | null, id: string): Promise<NextResponse> {
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dataSubjectRequest = await getDataSubjectRequestById(
    { userId, organizationId: orgContext.organizationId, roleKey: orgContext.roleKey },
    id,
  );
  if (!dataSubjectRequest) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ dataSubjectRequest });
}
