import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../../_shared/logger";
import { isSameOrigin } from "../../_shared/same-origin";
import { handleGetContact, handleUpdateContact, handleDeleteContact } from "./handlers";
import { apiError } from "../../_shared/api-error";

export const GET = withRequestLogging(
  "GET",
  "/api/v1/contacts/[id]",
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleGetContact(user?.id ?? null, id);
  },
);

export const PATCH = withRequestLogging(
  "PATCH",
  "/api/v1/contacts/[id]",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return apiError("FORBIDDEN", "Invalid origin", 403);
    }

    const { id } = await params;
    const user = await getAuthenticatedUser();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("VALIDATION_ERROR", "Invalid JSON body", 400);
    }

    return handleUpdateContact(user?.id ?? null, id, body, request.headers.get("Idempotency-Key"));
  },
);

export const DELETE = withRequestLogging(
  "DELETE",
  "/api/v1/contacts/[id]",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isSameOrigin(request.headers.get("origin"), request.url)) {
      return apiError("FORBIDDEN", "Invalid origin", 403);
    }

    const { id } = await params;
    const user = await getAuthenticatedUser();
    return handleDeleteContact(user?.id ?? null, id);
  },
);
