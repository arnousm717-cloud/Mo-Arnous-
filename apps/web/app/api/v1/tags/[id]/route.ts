import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../_shared/logger";
import { isSameOrigin } from "../../_shared/same-origin";
import { handleGetTag, handleUpdateTag, handleDeleteTag } from "./handlers";

export const GET = withRequestLogging(
  "GET",
  "/api/v1/tags/[id]",
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleGetTag(user?.id ?? null, id);
  },
);

export const PATCH = withRequestLogging(
  "PATCH",
  "/api/v1/tags/[id]",
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

    return handleUpdateTag(user?.id ?? null, id, body, request.headers.get("Idempotency-Key"));
  },
);

export const DELETE = withRequestLogging(
  "DELETE",
  "/api/v1/tags/[id]",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }

    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleDeleteTag(user?.id ?? null, id);
  },
);
