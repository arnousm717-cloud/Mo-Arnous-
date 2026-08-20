import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { isSameOrigin } from "../../../_shared/same-origin";
import { withRequestLogging } from "../../../_shared/logger";
import { handlePreviewErasure } from "./handlers";
import { apiError } from "../../../_shared/api-error";

export const POST = withRequestLogging(
  "POST",
  "/api/v1/data-subject-requests/[id]/preview",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return apiError("FORBIDDEN", "Invalid origin", 403);
    }

    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handlePreviewErasure(user?.id ?? null, id);
  },
);
