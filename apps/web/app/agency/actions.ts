"use server";

import { revalidatePath } from "next/cache";
import { resolveAgencyRequestContext } from "@ai-revenue-os/auth";
import { createClientOrgForResolvedContext, type CreateClientOrgFormState } from "./create-client-org-logic";

export type { CreateClientOrgFormState };

export async function createClientOrgAction(
  _prevState: CreateClientOrgFormState,
  formData: FormData,
): Promise<CreateClientOrgFormState> {
  const name = formData.get("name");
  if (typeof name !== "string") {
    return { error: "Organization name is required." };
  }

  const agencyContext = await resolveAgencyRequestContext();
  const result = await createClientOrgForResolvedContext(agencyContext, name);

  if (!result.error) {
    revalidatePath("/agency");
  }
  return result;
}
