import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { isSameOrigin } from "../_shared/same-origin";
import { handleFileDataSubjectRequest } from "./handlers";

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

  return handleFileDataSubjectRequest(user?.id ?? null, body);
}
