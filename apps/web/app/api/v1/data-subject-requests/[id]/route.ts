import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { handleGetDataSubjectRequest } from "./handlers";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthenticatedUser();
  return handleGetDataSubjectRequest(user?.id ?? null, id);
}
