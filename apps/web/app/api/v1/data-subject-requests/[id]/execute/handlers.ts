import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { getDataSubjectRequestById, executeUserErasure, executeContactErasure } from "@ai-revenue-os/compliance";

/**
 * Irreversible (M1.6 Decision D, dispatch added M2.1F-C) —
 * executeUserErasure()/executeContactErasure() each delegate entirely to
 * their own SECURITY DEFINER SQL function, which independently
 * re-validates authorization (and, for users, the sole-org_admin blocker)
 * itself; this handler does not trust or reuse any prior call to the
 * preview endpoint.
 *
 * Same tenant-scoped-fetch-then-dispatch shape as the preview handler:
 * the DSR is read via getDataSubjectRequestById (RLS: organization_id =
 * current_org()) before any dispatch decision, so a cross-org or
 * nonexistent id is a plain 404 and subject_type is read exclusively from
 * that server-fetched row — never from the request, and never assumed.
 */
export async function handleExecuteErasure(userId: string | null, id: string): Promise<NextResponse> {
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:execute")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dsr = await getDataSubjectRequestById({ userId, ...orgContext }, id);
  if (!dsr) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (dsr.subjectType !== "user" && dsr.subjectType !== "contact") {
    return NextResponse.json(
      { error: `subject_type '${dsr.subjectType}' has no erasure fulfillment logic` },
      { status: 400 },
    );
  }

  try {
    const result =
      dsr.subjectType === "user" ? await executeUserErasure({ userId }, id) : await executeContactErasure({ userId }, id);
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("data subject request not found") || message.includes("contact not found")) {
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
