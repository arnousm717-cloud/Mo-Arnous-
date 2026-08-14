import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../../_shared/logger";
import { isSameOrigin } from "../../../_shared/same-origin";
import { handleSetDefaultPipeline } from "./handlers";

export const POST = withRequestLogging(
  "POST",
  "/api/v1/pipelines/[id]/set-default",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }

    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleSetDefaultPipeline(user?.id ?? null, id);
  },
);
