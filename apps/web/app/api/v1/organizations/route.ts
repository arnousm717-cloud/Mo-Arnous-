import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { handleCreateOrganization, handleGetOrganizations, isSameOrigin } from "./handlers";

export async function GET() {
  const user = await getAuthenticatedUser();
  return handleGetOrganizations(user?.id ?? null);
}

export async function POST(request: NextRequest) {
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
}
