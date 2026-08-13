"use server";

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { updateContactForResolvedContext, type UpdateContactFormState } from "./update-logic";
import { deleteContactForResolvedContext, type DeleteContactFormState } from "./delete-logic";

export type { UpdateContactFormState, DeleteContactFormState };

export async function updateContactAction(
  contactId: string,
  _prevState: UpdateContactFormState,
  formData: FormData,
): Promise<UpdateContactFormState> {
  const user = await getAuthenticatedUser();
  const result = await updateContactForResolvedContext(user?.id ?? null, contactId, formData);
  if (result.updatedId) {
    redirect(`/contacts/${result.updatedId}`);
  }
  return result;
}

export async function deleteContactAction(
  contactId: string,
  _prevState: DeleteContactFormState,
  _formData: FormData,
): Promise<DeleteContactFormState> {
  const user = await getAuthenticatedUser();
  const result = await deleteContactForResolvedContext(user?.id ?? null, contactId);
  if (result.deleted) {
    redirect("/contacts");
  }
  return result;
}
