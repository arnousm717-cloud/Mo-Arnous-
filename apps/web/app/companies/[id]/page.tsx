import { redirect, notFound } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser, can } from "@ai-revenue-os/auth";
import { handleGetCompany } from "../../api/v1/companies/[id]/handlers";
import { decideCompaniesConsoleAccess } from "../access";
import { listActiveOwnerOptions } from "../../_shared/owner-options";
import { resolveOwnerLabel } from "../../_shared/owner-option";
import { CompanyEditForm, type EditableCompany } from "./company-edit-form";
import { DeleteCompanyForm } from "./delete-company-form";
import styles from "../companies.module.css";

interface CompanyDetail extends EditableCompany {
  enrichmentStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Milestone 2.1G-B. Same first-party, in-process-handler-reuse
 * architecture as ../page.tsx. handleGetCompany already returns an
 * identical 404 for a cross-org id and a genuinely nonexistent one (and
 * for a soft-deleted company — softDeleteCompany's own getCompanyById
 * no longer returns it) — this page adds no special-casing of its own,
 * it just maps "not 200" to notFound(), matching backend semantics
 * exactly rather than trying to distinguish cases the backend itself
 * deliberately keeps indistinguishable.
 */
export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const user = await getAuthenticatedUser();
  const orgContext = user ? await resolveOrganizationContextForUser(user.id) : null;
  const decision = decideCompaniesConsoleAccess(user?.id ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const { userId, organizationId, roleKey } = decision.orgContext;
  const response = await handleGetCompany(userId, id);
  if (response.status !== 200) {
    notFound();
  }

  const data = (await response.json()) as { company: CompanyDetail };
  const company = data.company;

  const actor = { userId, organizationId, roleKey };
  const canUpdate = can(actor, "companies:update");
  const canDelete = can(actor, "companies:delete");
  const ownerOptions = canUpdate || company.ownerId ? await listActiveOwnerOptions(actor) : [];

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>{company.name}</h1>
      </header>

      {canUpdate ? (
        <CompanyEditForm company={company} ownerOptions={ownerOptions} />
      ) : (
        <dl className={styles.detailFields}>
          <dt>Domain</dt>
          <dd>{company.domain ?? "—"}</dd>
          <dt>Industry</dt>
          <dd>{company.industry ?? "—"}</dd>
          <dt>Employee count</dt>
          <dd>{company.employeeCount ?? "—"}</dd>
          <dt>Annual revenue</dt>
          <dd>{company.annualRevenue ?? "—"}</dd>
          <dt>LinkedIn</dt>
          <dd>{company.linkedinUrl ?? "—"}</dd>
          <dt>Owner</dt>
          <dd>{resolveOwnerLabel(ownerOptions, company.ownerId) ?? "—"}</dd>
        </dl>
      )}

      {canDelete ? (
        <section className={styles.section}>
          <DeleteCompanyForm companyId={company.id} />
        </section>
      ) : null}
    </main>
  );
}
