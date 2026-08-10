import { can } from "@ai-revenue-os/auth";
import { fileDataSubjectRequest, type DsrSubjectType } from "@ai-revenue-os/compliance";

/**
 * Kept out of actions.ts ("use server") deliberately — same reasoning as
 * apps/web/app/agency/create-client-org-logic.ts: trusts an
 * already-resolved orgContext parameter, so it must not be independently
 * client-invokable as an RPC endpoint the way every "use server" export is.
 */

export interface FileDsrFormState {
  error?: string;
  filedId?: string;
}

const SUBJECT_TYPES: DsrSubjectType[] = ["contact", "visitor", "portal_user", "user"];

export async function fileDsrForResolvedContext(
  orgContext: { userId: string; organizationId: string; roleKey: string } | null,
  subjectType: string,
  subjectId: string,
): Promise<FileDsrFormState> {
  if (!orgContext || !can(orgContext, "data-subject-requests:create")) {
    return { error: "You do not have permission to file data subject requests." };
  }
  if (!SUBJECT_TYPES.includes(subjectType as DsrSubjectType)) {
    return { error: `Subject type must be one of: ${SUBJECT_TYPES.join(", ")}.` };
  }
  if (!subjectId.trim()) {
    return { error: "Subject id is required." };
  }

  try {
    const dsr = await fileDataSubjectRequest(orgContext, {
      subjectType: subjectType as DsrSubjectType,
      subjectId: subjectId.trim(),
      requestType: "delete",
    });
    return { filedId: dsr.id };
  } catch {
    return { error: "Failed to file the request. Please try again." };
  }
}
