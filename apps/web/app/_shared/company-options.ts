import { listCompanies, type Company } from "@ai-revenue-os/crm";

/**
 * Milestone 2.2E: moved here unchanged from contacts/company-options.ts —
 * Deals now needs the identical "active companies for a selector" list a
 * second time, matching the exact precedent already established for
 * owner-options (2.2-P0): genuine duplication gets extracted to
 * apps/web/app/_shared, not copy-pasted per resource. Populates a
 * companyId selector/filter from the existing listCompanies() domain
 * function — not a new query, not a duplicate of packages/crm's own
 * logic. listCompanies already excludes soft-deleted companies
 * (`deleted_at is null` in its own WHERE clause, 2.1D), so a soft-deleted
 * company can never appear as a choice here without any special-casing
 * in this file.
 *
 * Capped at packages/crm's own MAX_LIMIT (100) rather than paging through
 * every company for a dropdown — a known, deliberate simplification (an
 * org with more than 100 companies would see a truncated list here), not
 * a hidden correctness bug.
 */
export interface CompanyOption {
  id: string;
  name: string;
}

export async function listActiveCompanyOptions(ctx: {
  userId: string;
  organizationId: string;
  roleKey: string;
}): Promise<CompanyOption[]> {
  const page = await listCompanies(ctx, { limit: 100 });
  return page.items.map((company: Company) => ({ id: company.id, name: company.name }));
}
