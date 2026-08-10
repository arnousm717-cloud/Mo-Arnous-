import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { previewUserErasure } from "@ai-revenue-os/compliance";

/**
 * Dry-run (M1.6 Decision D) — never mutates data. A blocked result
 * (canProceed: false) is still a 200: it's a successful preview that
 * reports a blocker, not a failure of the preview operation itself. Only
 * "the request doesn't exist" or "caller isn't authorized at all" are
 * errors (404/403) — the sole-org_admin blocker is reported in the body.
 */
export async function handlePreviewUserErasure(userId: string | null, id: string): Promise<NextResponse> {
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:execute")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const preview = await previewUserErasure({ userId }, id);
    return NextResponse.json({ preview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("data subject request not found")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (message.includes("not an active org_admin")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (message.includes("only supports")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to preview erasure" }, { status: 500 });
  }
}
