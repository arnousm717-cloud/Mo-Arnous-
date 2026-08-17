import { getContactByIdIncludingDeleted } from "@ai-revenue-os/crm";
import type { ContactOption } from "./contact-options";

/**
 * Milestone 2.2E. Mirrors company-display.ts exactly, using the new
 * getContactByIdIncludingDeleted (added this milestone, packages/crm) —
 * a deal's primaryContactId is preserved when its linked contact is
 * soft-deleted, so a naive `find()` against the active-only options list
 * has no entry for it. Never falls back to the raw id.
 *
 * Milestone 2.3F: getContactByIdIncludingDeleted queries WITHOUT a
 * deleted_at filter, so a null result means the contacts row is
 * PHYSICALLY ABSENT — for contacts, that only happens via
 * execute_contact_erasure() (GDPR hard-delete); ordinary deletion is
 * always soft-delete and would still be found here with deletedAt set.
 * "Erased contact" is therefore the accurate label for this branch, kept
 * distinct from the soft-delete "(deleted)" suffix below.
 */
export async function resolveContactDisplayName(
  ctx: { userId: string; organizationId: string; roleKey: string },
  contactId: string,
  activeContactOptions: ContactOption[],
): Promise<string> {
  const active = activeContactOptions.find((c) => c.id === contactId);
  if (active) {
    return active.name;
  }
  const deleted = await getContactByIdIncludingDeleted(ctx, contactId);
  if (!deleted) {
    return "Erased contact";
  }
  const name = [deleted.firstName, deleted.lastName].filter(Boolean).join(" ") || deleted.email || "(no name)";
  return `${name} (deleted)`;
}
