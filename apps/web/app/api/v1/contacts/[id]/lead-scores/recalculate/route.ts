import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../../../_shared/logger";
import { handleRecalculateContactScore } from "./handlers";

export const POST = withRequestLogging(
  "POST",
  "/api/v1/contacts/[id]/lead-scores/recalculate",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleRecalculateContactScore(user?.id ?? null, id);
  },
);
