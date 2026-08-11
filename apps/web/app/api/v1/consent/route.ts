import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { isSameOrigin } from "../_shared/same-origin";
import { withRequestLogging } from "../_shared/logger";
import { handleRecordConsent } from "./handlers";

export const POST = withRequestLogging("POST", "/api/v1/consent", async (request: NextRequest) => {
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

  return handleRecordConsent(user?.id ?? null, body);
});
