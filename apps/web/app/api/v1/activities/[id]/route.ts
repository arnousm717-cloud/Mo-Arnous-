import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../_shared/logger";
import { isSameOrigin } from "../../_shared/same-origin";
import { handleGetActivity, handleUpdateActivity, handleDeleteActivity } from "./handlers";

export const GET = withRequestLogging(
  "GET",
  "/api/v1/activities/[id]",
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleGetActivity(user?.id ?? null, id);
  },
);

export const PATCH = withRequestLogging(
  "PATCH",
  "/api/v1/activities/[id]",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }

    const { id } = await params;
    const user = await getAuthenticatedUser();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    return handleUpdateActivity(user?.id ?? null, id, body, request.headers.get("Idempotency-Key"));
  },
);

export const DELETE = withRequestLogging(
  "DELETE",
  "/api/v1/activities/[id]",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }

    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleDeleteActivity(user?.id ?? null, id);
  },
);
