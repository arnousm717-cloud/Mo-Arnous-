import { handleCreateContact } from "../api/v1/contacts/handlers";

/**
 * Mirrors apps/web/app/companies/create-logic.ts exactly — reuses
 * handleCreateContact in-process (ADR-004, no network hop). The identity
 * invariant (at least one of firstName/lastName/email), duplicate-email
 * 409, and invalid owner/company relationship checks are NOT
 * reimplemented here — they remain exclusively packages/crm's, surfaced
 * to the form only via whatever error message handleCreateContact's own
 * mapCrmError already returns.
 */

export interface CreateContactFormState {
  error?: string;
  createdId?: string;
}

function trimmedOrUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export async function createContactForResolvedContext(
  userId: string | null,
  formData: FormData,
): Promise<CreateContactFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const body: Record<string, unknown> = {};
  const companyId = trimmedOrUndefined(formData.get("companyId"));
  if (companyId !== undefined) body.companyId = companyId;
  const firstName = trimmedOrUndefined(formData.get("firstName"));
  if (firstName !== undefined) body.firstName = firstName;
  const lastName = trimmedOrUndefined(formData.get("lastName"));
  if (lastName !== undefined) body.lastName = lastName;
  const email = trimmedOrUndefined(formData.get("email"));
  if (email !== undefined) body.email = email;
  const phone = trimmedOrUndefined(formData.get("phone"));
  if (phone !== undefined) body.phone = phone;
  const jobTitle = trimmedOrUndefined(formData.get("jobTitle"));
  if (jobTitle !== undefined) body.jobTitle = jobTitle;
  const linkedinUrl = trimmedOrUndefined(formData.get("linkedinUrl"));
  if (linkedinUrl !== undefined) body.linkedinUrl = linkedinUrl;
  const lifecycleStage = trimmedOrUndefined(formData.get("lifecycleStage"));
  if (lifecycleStage !== undefined) body.lifecycleStage = lifecycleStage;
  const ownerId = trimmedOrUndefined(formData.get("ownerId"));
  if (ownerId !== undefined) body.ownerId = ownerId;

  const response = await handleCreateContact(userId, body, idempotencyKey);
  const data = (await response.json()) as { contact?: { id: string }; error?: { code: string; message: string; request_id: string } };

  if (response.status === 201 && data.contact) {
    return { createdId: data.contact.id };
  }
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to create the contact. Please try again." };
}
