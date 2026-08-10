import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { isSameOrigin } from "../../../_shared/same-origin";
import { withRequestLogging } from "../../../_shared/logger";
import { handlePreviewUserErasure } from "./handlers";

export const POST = withRequestLogging(
  "POST",
  "/api/v1/data-subject-requests/[id]/preview",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }

    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handlePreviewUserErasure(user?.id ?? null, id);
  },
);
