import { getContactByIdIncludingDeleted } from "@ai-revenue-os/crm";
import type { ContactOption } from "./contact-options";

/**
 * Milestone 2.2E. Mirrors company-display.ts exactly, using the new
 * getContactByIdIncludingDeleted (added this milestone, packages/crm) —
 * a deal's primaryContactId is preserved when its linked contact is
 * soft-deleted, so a naive `find()` against the active-only options list
 * has no entry for it. Never falls back to the raw id.
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
    return "Deleted contact";
  }
  const name = [deleted.firstName, deleted.lastName].filter(Boolean).join(" ") || deleted.email || "(no name)";
  return `${name} (deleted)`;
}
