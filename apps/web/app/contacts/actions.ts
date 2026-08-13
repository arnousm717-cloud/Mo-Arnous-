"use server";

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { createContactForResolvedContext, type CreateContactFormState } from "./create-logic";

export type { CreateContactFormState };

export async function createContactAction(
  _prevState: CreateContactFormState,
  formData: FormData,
): Promise<CreateContactFormState> {
  const user = await getAuthenticatedUser();
  const result = await createContactForResolvedContext(user?.id ?? null, formData);
  if (result.createdId) {
    redirect(`/contacts/${result.createdId}`);
  }
  return result;
}
