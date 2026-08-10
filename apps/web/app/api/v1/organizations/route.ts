import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { withRequestLogging } from "../_shared/logger";
import { handleCreateOrganization, handleGetOrganizations, isSameOrigin } from "./handlers";

export const GET = withRequestLogging("GET", "/api/v1/organizations", async () => {
  const user = await getAuthenticatedUser();
  return handleGetOrganizations(user?.id ?? null);
});

export const POST = withRequestLogging("POST", "/api/v1/organizations", async (request: NextRequest) => {
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

  return handleCreateOrganization(user?.id ?? null, body);
});
