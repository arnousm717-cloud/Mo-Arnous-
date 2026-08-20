import { handleDeleteContact } from "../../api/v1/contacts/[id]/handlers";

/**
 * Reuses handleDeleteContact in-process (ADR-004) — softDeleteContact()
 * only. No packages/compliance import, no executeContactErasure call,
 * anywhere in this file or its dependency graph — this is the ordinary,
 * recoverable soft-delete, never GDPR erasure.
 */

export interface DeleteContactFormState {
  error?: string;
  deleted?: boolean;
}

export async function deleteContactForResolvedContext(
  userId: string | null,
  contactId: string,
): Promise<DeleteContactFormState> {
  const response = await handleDeleteContact(userId, contactId);
  if (response.status === 200) {
    return { deleted: true };
  }
  const data = (await response.json()) as { error?: { code: string; message: string; request_id: string } };
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to remove the contact. Please try again." };
}
