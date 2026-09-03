import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../_shared/logger";
import { isSameOrigin } from "../_shared/same-origin";
import { apiError } from "../_shared/api-error";
import { handleListScoringRules, handleCreateScoringRule } from "./handlers";

export const GET = withRequestLogging("GET", "/api/v1/scoring-rules", async (_request: NextRequest) => {
  const user = await getAuthenticatedUser();
  return handleListScoringRules(user?.id ?? null);
});

export const POST = withRequestLogging("POST", "/api/v1/scoring-rules", async (request: NextRequest) => {
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

  return handleCreateScoringRule(user?.id ?? null, body);
});
