import { handleUpdateContact } from "../../api/v1/contacts/[id]/handlers";

/**
 * Mirrors apps/web/app/companies/[id]/update-logic.ts exactly. Every
 * field is always resent (pre-filled with the contact's current value);
 * an untouched field round-trips its existing value, only an explicitly
 * emptied nullable field becomes null. The identity invariant (at least
 * one of firstName/lastName/email in the FINAL merged state) is
 * re-validated by packages/crm's updateContact on every call — not
 * reimplemented here — so clearing all three via this always-resend form
 * surfaces the same ValidationError handleUpdateContact already maps to
 * a safe 400.
 */

export interface UpdateContactFormState {
  error?: string;
  updatedId?: string;
}

function toNullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function updateContactForResolvedContext(
  userId: string | null,
  contactId: string,
  formData: FormData,
): Promise<UpdateContactFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const body = {
    companyId: toNullableString(formData.get("companyId")),
    firstName: toNullableString(formData.get("firstName")),
    lastName: toNullableString(formData.get("lastName")),
    email: toNullableString(formData.get("email")),
    phone: toNullableString(formData.get("phone")),
    jobTitle: toNullableString(formData.get("jobTitle")),
    linkedinUrl: toNullableString(formData.get("linkedinUrl")),
    lifecycleStage: toNullableString(formData.get("lifecycleStage")),
    ownerId: toNullableString(formData.get("ownerId")),
  };

  const response = await handleUpdateContact(userId, contactId, body, idempotencyKey);
  const data = (await response.json()) as { contact?: { id: string }; error?: string };

  if (response.status === 200 && data.contact) {
    return { updatedId: data.contact.id };
  }
  return { error: typeof data.error === "string" ? data.error : "Failed to update the contact. Please try again." };
}
