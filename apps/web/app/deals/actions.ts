"use server";

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { createDealForResolvedContext, type CreateDealFormState } from "./create-logic";

export type { CreateDealFormState };

export async function createDealAction(
  _prevState: CreateDealFormState,
  formData: FormData,
): Promise<CreateDealFormState> {
  const user = await getAuthenticatedUser();
  const result = await createDealForResolvedContext(user?.id ?? null, formData);
  if (result.createdId) {
    redirect(`/deals/${result.createdId}`);
  }
  return result;
}
