/**
 * Milestone 2.2E — documented UX limitation: `public.deals` has no
 * dedicated name/title column (docs/03-Database-Architecture.md §2.2's
 * own target schema, confirmed unchanged through 2.2A/2.2B/2.2D — never
 * invented one here to make the list prettier, per this milestone's
 * explicit instruction). The "Deal" column therefore uses the most
 * appropriate EXISTING identifier this record actually has: the resolved
 * company name, falling back to the resolved primary contact name,
 * falling back to a short id-derived label — never the full raw UUID as
 * a "name." This is a real, reported limitation, not a hidden
 * workaround: a future milestone that adds a genuine `name` field to
 * `deals` should replace this function's use entirely, not extend it.
 */
export function dealDisplayLabel(dealId: string, companyName: string | null, contactName: string | null): string {
  if (companyName) {
    return companyName;
  }
  if (contactName) {
    return contactName;
  }
  return `Deal ${dealId.slice(0, 8)}`;
}
