"use server";

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { updateDealForResolvedContext, type UpdateDealFormState } from "./update-logic";
import { deleteDealForResolvedContext, type DeleteDealFormState } from "./delete-logic";

export type { UpdateDealFormState, DeleteDealFormState };

export async function updateDealAction(
  dealId: string,
  _prevState: UpdateDealFormState,
  formData: FormData,
): Promise<UpdateDealFormState> {
  const user = await getAuthenticatedUser();
  const result = await updateDealForResolvedContext(user?.id ?? null, dealId, formData);
  if (result.updatedId) {
    redirect(`/deals/${result.updatedId}`);
  }
  return result;
}

export async function deleteDealAction(
  dealId: string,
  _prevState: DeleteDealFormState,
  _formData: FormData,
): Promise<DeleteDealFormState> {
  const user = await getAuthenticatedUser();
  const result = await deleteDealForResolvedContext(user?.id ?? null, dealId);
  if (result.deleted) {
    redirect("/deals");
  }
  return result;
}
