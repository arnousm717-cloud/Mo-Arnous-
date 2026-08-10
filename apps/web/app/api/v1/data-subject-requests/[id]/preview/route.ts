import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { isSameOrigin } from "../../../_shared/same-origin";
import { handlePreviewUserErasure } from "./handlers";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request.headers.get("origin"), request.url)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }

  const { id } = await params;
  const user = await getAuthenticatedUser();
  return handlePreviewUserErasure(user?.id ?? null, id);
}
