import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../_shared/logger";
import { isSameOrigin } from "../../_shared/same-origin";
import { handleDeleteTagging } from "./handlers";

export const DELETE = withRequestLogging(
  "DELETE",
  "/api/v1/taggings/[id]",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }

    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleDeleteTagging(user?.id ?? null, id);
  },
);
