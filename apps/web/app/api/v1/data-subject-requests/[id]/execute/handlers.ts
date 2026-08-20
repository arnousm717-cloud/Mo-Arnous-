import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { getDataSubjectRequestById, executeUserErasure, executeContactErasure } from "@ai-revenue-os/compliance";
import { apiError } from "../../../_shared/api-error";

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
    const result =
      dsr.subjectType === "user" ? await executeUserErasure({ userId }, id) : await executeContactErasure({ userId }, id);
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("data subject request not found") || message.includes("contact not found")) {
      return apiError("NOT_FOUND", "Not found", 404);
    }
    if (message.includes("not an active org_admin")) {
      return apiError("FORBIDDEN", "Forbidden", 403);
    }
    if (message.includes("sole active org_admin")) {
      return apiError("CONFLICT", message, 409);
    }
    if (message.includes("already completed")) {
      return apiError("CONFLICT", message, 409);
    }
    if (message.includes("only supports")) {
      return apiError("VALIDATION_ERROR", message, 400);
    }
    return apiError("INTERNAL_ERROR", "Failed to execute erasure", 500);
  }
}
