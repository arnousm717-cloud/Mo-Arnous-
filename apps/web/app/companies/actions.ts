"use server";

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { createCompanyForResolvedContext, type CreateCompanyFormState } from "./create-logic";

export type { CreateCompanyFormState };

export async function createCompanyAction(
  _prevState: CreateCompanyFormState,
  formData: FormData,
): Promise<CreateCompanyFormState> {
  const user = await getAuthenticatedUser();
  const result = await createCompanyForResolvedContext(user?.id ?? null, formData);
  if (result.createdId) {
    redirect(`/companies/${result.createdId}`);
  }
  return result;
}
