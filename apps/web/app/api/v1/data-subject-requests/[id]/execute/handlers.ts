import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { executeUserErasure } from "@ai-revenue-os/compliance";

/**
 * Irreversible (M1.6 Decision D) — executeUserErasure() delegates entirely
 * to execute_user_erasure() (SECURITY DEFINER), which independently
 * re-validates authorization and the sole-org_admin blocker itself; this
 * handler does not trust or reuse any prior call to the preview endpoint.
 */
export async function handleExecuteUserErasure(userId: string | null, id: string): Promise<NextResponse> {
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:execute")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await executeUserErasure({ userId }, id);
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("data subject request not found")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (message.includes("not an active org_admin")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (message.includes("sole active org_admin")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (message.includes("already completed")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (message.includes("only supports")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to execute erasure" }, { status: 500 });
  }
}
