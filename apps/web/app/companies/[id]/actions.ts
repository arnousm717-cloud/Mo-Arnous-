"use server";

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { updateCompanyForResolvedContext, type UpdateCompanyFormState } from "./update-logic";
import { deleteCompanyForResolvedContext, type DeleteCompanyFormState } from "./delete-logic";

export type { UpdateCompanyFormState, DeleteCompanyFormState };

export async function updateCompanyAction(
  companyId: string,
  _prevState: UpdateCompanyFormState,
  formData: FormData,
): Promise<UpdateCompanyFormState> {
  const user = await getAuthenticatedUser();
  const result = await updateCompanyForResolvedContext(user?.id ?? null, companyId, formData);
  if (result.updatedId) {
    redirect(`/companies/${result.updatedId}`);
  }
  return result;
}

export async function deleteCompanyAction(
  companyId: string,
  _prevState: DeleteCompanyFormState,
  _formData: FormData,
): Promise<DeleteCompanyFormState> {
  const user = await getAuthenticatedUser();
  const result = await deleteCompanyForResolvedContext(user?.id ?? null, companyId);
  if (result.deleted) {
    redirect("/companies");
  }
  return result;
}
