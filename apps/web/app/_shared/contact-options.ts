import { listContacts, type Contact } from "@ai-revenue-os/crm";

/**
 * Milestone 2.2E. Mirrors company-options.ts exactly — populates a
 * primaryContactId selector/filter from the existing listContacts()
 * domain function. listContacts already excludes soft-deleted contacts,
 * so a soft-deleted contact can never appear as a choice here. Same
 * MAX_LIMIT(100) cap and rationale as company-options.ts.
 */
export interface ContactOption {
  id: string;
  name: string;
}

function displayName(contact: Contact): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || "(no name)";
}

export async function listActiveContactOptions(ctx: {
  userId: string;
  organizationId: string;
  roleKey: string;
}): Promise<ContactOption[]> {
  const page = await listContacts(ctx, { limit: 100 });
  return page.items.map((contact: Contact) => ({ id: contact.id, name: displayName(contact) }));
}
