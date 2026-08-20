import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../../../_shared/logger";
import { isSameOrigin } from "../../../../_shared/same-origin";
import { handleGetPipelineStage, handleUpdatePipelineStage, handleDeletePipelineStage } from "./handlers";
import { apiError } from "../../../../_shared/api-error";

export const GET = withRequestLogging(
  "GET",
  "/api/v1/pipelines/[id]/stages/[stageId]",
  async (_request: NextRequest, { params }: { params: Promise<{ id: string; stageId: string }> }) => {
    const { id, stageId } = await params;
    const user = await getAuthenticatedUser();
    return handleGetPipelineStage(user?.id ?? null, id, stageId);
  },
);

export const PATCH = withRequestLogging(
  "PATCH",
  "/api/v1/pipelines/[id]/stages/[stageId]",
  async (request: NextRequest, { params }: { params: Promise<{ id: string; stageId: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return apiError("FORBIDDEN", "Invalid origin", 403);
    }

    const { id, stageId } = await params;
    const user = await getAuthenticatedUser();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("VALIDATION_ERROR", "Invalid JSON body", 400);
    }

    return handleUpdatePipelineStage(user?.id ?? null, id, stageId, body, request.headers.get("Idempotency-Key"));
  },
);

export const DELETE = withRequestLogging(
  "DELETE",
  "/api/v1/pipelines/[id]/stages/[stageId]",
  async (request: NextRequest, { params }: { params: Promise<{ id: string; stageId: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return apiError("FORBIDDEN", "Invalid origin", 403);
    }

    const { id, stageId } = await params;
    const user = await getAuthenticatedUser();
    return handleDeletePipelineStage(user?.id ?? null, id, stageId);
  },
);
