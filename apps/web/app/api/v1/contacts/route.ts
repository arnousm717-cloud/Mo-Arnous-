import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../_shared/logger";
import { isSameOrigin } from "../_shared/same-origin";
import { handleListContacts, handleCreateContact } from "./handlers";

export const GET = withRequestLogging("GET", "/api/v1/contacts", async (request: NextRequest) => {
  const user = await getAuthenticatedUser();
  return handleListContacts(user?.id ?? null, new URL(request.url));
});

export const POST = withRequestLogging("POST", "/api/v1/contacts", async (request: NextRequest) => {
  if (!isSameOrigin(request.headers.get("origin"), request.url)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }

  const user = await getAuthenticatedUser();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  return handleCreateContact(user?.id ?? null, body, request.headers.get("Idempotency-Key"));
});
