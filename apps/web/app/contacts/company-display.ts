import { getCompanyByIdIncludingDeleted } from "@ai-revenue-os/crm";
import type { CompanyOption } from "./company-options";

/**
 * Staging bugfix (post-2.1G-C). A contact's companyId is deliberately
 * preserved when its linked company is soft-deleted (2.1B design), but
 * listActiveCompanyOptions (and therefore every page's companyOptions)
 * excludes soft-deleted companies — so a naive `find()` against that list
 * alone has no entry for it. Shared by the list page and the detail page
 * so both resolve the same way, rather than duplicating this logic
 * (CLAUDE.md "no duplicate logic").
 *
 * Never falls back to the raw id: an active company gets its plain name;
 * a soft-deleted one is resolved via getCompanyByIdIncludingDeleted
 * (tenant-scoped, read-only) and labeled "<name> (deleted)"; a
 * genuinely unresolvable id (edge case — the row itself somehow gone)
 * gets a generic, still-safe "Deleted company" label.
 */
export async function resolveCompanyDisplayName(
  ctx: { userId: string; organizationId: string; roleKey: string },
  companyId: string,
  activeCompanyOptions: CompanyOption[],
): Promise<string> {
  const active = activeCompanyOptions.find((c) => c.id === companyId);
  if (active) {
    return active.name;
  }
  const deleted = await getCompanyByIdIncludingDeleted(ctx, companyId);
  return deleted ? `${deleted.name} (deleted)` : "Deleted company";
}
