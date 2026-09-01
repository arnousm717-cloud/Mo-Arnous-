import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../../../../_shared/logger";
import { isSameOrigin } from "../../../../../_shared/same-origin";
import { apiError } from "../../../../../_shared/api-error";
import { handleRevokeTrackingSitePublicKey } from "./handlers";

export const POST = withRequestLogging(
  "POST",
  "/api/v1/tracking-sites/[trackingSiteId]/public-keys/[keyId]/revoke",
  async (request: NextRequest, { params }: { params: Promise<{ trackingSiteId: string; keyId: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return apiError("FORBIDDEN", "Invalid origin", 403);
    }

    const { trackingSiteId, keyId } = await params;
    const user = await getAuthenticatedUser();
    return handleRevokeTrackingSitePublicKey(user?.id ?? null, trackingSiteId, keyId);
  },
);
