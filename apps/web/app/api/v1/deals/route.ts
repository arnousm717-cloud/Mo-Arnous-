import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../_shared/logger";
import { isSameOrigin } from "../_shared/same-origin";
import { handleListDeals, handleCreateDeal } from "./handlers";
import { apiError } from "../_shared/api-error";

export const GET = withRequestLogging("GET", "/api/v1/deals", async (request: NextRequest) => {
  const user = await getAuthenticatedUser();
  return handleListDeals(user?.id ?? null, new URL(request.url));
});

export const POST = withRequestLogging("POST", "/api/v1/deals", async (request: NextRequest) => {
  if (!isSameOrigin(request.headers.get("origin"), request.url)) {
    return apiError("FORBIDDEN", "Invalid origin", 403);
  }

  const user = await getAuthenticatedUser();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("VALIDATION_ERROR", "Invalid JSON body", 400);
  }

  return handleCreateDeal(user?.id ?? null, body, request.headers.get("Idempotency-Key"));
});
