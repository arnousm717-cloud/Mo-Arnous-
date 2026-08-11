import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../_shared/logger";
import { handleGetDataSubjectRequest } from "./handlers";

export const GET = withRequestLogging(
  "GET",
  "/api/v1/data-subject-requests/[id]",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleGetDataSubjectRequest(user?.id ?? null, id);
  },
);
