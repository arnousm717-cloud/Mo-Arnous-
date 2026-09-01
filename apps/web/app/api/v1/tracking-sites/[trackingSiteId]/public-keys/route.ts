import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../../_shared/logger";
import { isSameOrigin } from "../../../_shared/same-origin";
import { apiError } from "../../../_shared/api-error";
import { handleRegisterTrackingSitePublicKey, handleListTrackingSitePublicKeys } from "./handlers";

export const GET = withRequestLogging(
  "GET",
  "/api/v1/tracking-sites/[trackingSiteId]/public-keys",
  async (_request: NextRequest, { params }: { params: Promise<{ trackingSiteId: string }> }) => {
    const { trackingSiteId } = await params;
    const user = await getAuthenticatedUser();
    return handleListTrackingSitePublicKeys(user?.id ?? null, trackingSiteId);
  },
);

export const POST = withRequestLogging(
  "POST",
  "/api/v1/tracking-sites/[trackingSiteId]/public-keys",
  async (request: NextRequest, { params }: { params: Promise<{ trackingSiteId: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return apiError("FORBIDDEN", "Invalid origin", 403);
    }

    const { trackingSiteId } = await params;
    const user = await getAuthenticatedUser();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("VALIDATION_ERROR", "Invalid JSON body", 400);
    }

    return handleRegisterTrackingSitePublicKey(user?.id ?? null, trackingSiteId, body);
  },
);
