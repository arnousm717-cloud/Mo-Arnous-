"use server";

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { createPipelineForResolvedContext, type CreatePipelineFormState } from "./create-logic";

export type { CreatePipelineFormState };

export async function createPipelineAction(
  _prevState: CreatePipelineFormState,
  formData: FormData,
): Promise<CreatePipelineFormState> {
  const user = await getAuthenticatedUser();
  const result = await createPipelineForResolvedContext(user?.id ?? null, formData);
  if (result.createdId) {
    redirect(`/pipelines/${result.createdId}`);
  }
  return result;
}
