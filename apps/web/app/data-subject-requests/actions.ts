"use server";

import { redirect } from "next/navigation";
import { resolveRequestContext } from "@ai-revenue-os/auth";
import { fileDsrForResolvedContext, type FileDsrFormState } from "./file-dsr-logic";

export type { FileDsrFormState };

export async function fileDsrAction(
  _prevState: FileDsrFormState,
  formData: FormData,
): Promise<FileDsrFormState> {
  const subjectType = formData.get("subjectType");
  const subjectId = formData.get("subjectId");
  if (typeof subjectType !== "string" || typeof subjectId !== "string") {
    return { error: "Subject type and subject id are required." };
  }

  const context = await resolveRequestContext();
  const orgContext =
    context?.organizationId && context.roleKey
      ? { userId: context.userId, organizationId: context.organizationId, roleKey: context.roleKey }
      : null;

  const result = await fileDsrForResolvedContext(orgContext, subjectType, subjectId);
  if (result.filedId) {
    redirect(`/data-subject-requests/${result.filedId}`);
  }
  return result;
}
