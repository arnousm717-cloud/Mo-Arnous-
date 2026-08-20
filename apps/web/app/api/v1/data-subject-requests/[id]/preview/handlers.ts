import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { getDataSubjectRequestById, previewUserErasure, previewContactErasure } from "@ai-revenue-os/compliance";
import { apiError } from "../../../_shared/api-error";

/**
 * Dry-run (M1.6 Decision D, dispatch added M2.1F-C) — never mutates data. A
 * blocked result (canProceed: false) is still a 200: it's a successful
 * preview that reports a blocker, not a failure of the preview operation
 * itself. Only "the request doesn't exist" or "caller isn't authorized at
 * all" are errors (404/403) — the sole-org_admin blocker is reported in the
 * body.
 *
 * The DSR is fetched tenant-scoped (RLS: organization_id = current_org())
 * before any dispatch decision is made — a cross-org or nonexistent id is
 * indistinguishable, both a plain 404, and subject_type is read exclusively
 * from that server-fetched row, never from the request. subject_type='user'
 * and 'contact' each have real fulfillment logic (M1.6 / 2.1C); 'visitor'
 * and 'portal_user' are schema-valid but have none, so they are rejected
 * with a 400 before any erasure function is ever called.
 */
export async function handlePreviewErasure(userId: string | null, id: string): Promise<NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (!orgContext || !can({ userId, ...orgContext }, "data-subject-requests:execute")) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }

  const dsr = await getDataSubjectRequestById({ userId, ...orgContext }, id);
  if (!dsr) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  if (dsr.subjectType !== "user" && dsr.subjectType !== "contact") {
    return apiError("VALIDATION_ERROR", `subject_type '${dsr.subjectType}' has no erasure fulfillment logic`, 400);
  }

  try {
    const preview =
      dsr.subjectType === "user" ? await previewUserErasure({ userId }, id) : await previewContactErasure({ userId }, id);
    return NextResponse.json({ preview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("data subject request not found") || message.includes("contact not found")) {
      return apiError("NOT_FOUND", "Not found", 404);
    }
    if (message.includes("not an active org_admin")) {
      return apiError("FORBIDDEN", "Forbidden", 403);
    }
    if (message.includes("only supports")) {
      return apiError("VALIDATION_ERROR", message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to preview erasure", 500);
  }
}
