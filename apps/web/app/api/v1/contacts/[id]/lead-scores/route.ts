import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../../_shared/logger";
import { handleGetContactLeadScores } from "./handlers";

export const GET = withRequestLogging(
  "GET",
  "/api/v1/contacts/[id]/lead-scores",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleGetContactLeadScores(user?.id ?? null, id, new URL(request.url));
  },
);
