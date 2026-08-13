import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser, can } from "@ai-revenue-os/auth";
import { EntityTable, type EntityTableColumn } from "@ai-revenue-os/ui";
import { handleListContacts } from "../api/v1/contacts/handlers";
import { decideContactsConsoleAccess } from "./access";
import { listActiveCompanyOptions } from "./company-options";
import { listActiveOwnerOptions } from "../companies/owner-options";
import { ContactForm } from "./contact-form";
import styles from "../companies/companies.module.css";

const LIFECYCLE_STAGES = ["lead", "prospect", "customer", "inactive"] as const;

interface ContactRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  companyId: string | null;
  lifecycleStage: string | null;
  ownerId: string | null;
  updatedAt: string;
}

/**
 * Milestone 2.1G-C. Mirrors apps/web/app/companies/page.tsx exactly — same
 * first-party, in-process-handler-reuse architecture (ADR-004), same
 * link-based cursor continuation instead of EntityTable's onLoadMore.
 * The three active filters (companyId/ownerId/lifecycleStage) are all
 * preserved together across cursor navigation and the filter form.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; companyId?: string; ownerId?: string; lifecycleStage?: string }>;
}): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const orgContext = user ? await resolveOrganizationContextForUser(user.id) : null;
  const decision = decideContactsConsoleAccess(user?.id ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const { userId, organizationId, roleKey } = decision.orgContext;
  const { cursor, companyId, ownerId, lifecycleStage } = await searchParams;

  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (companyId) params.set("companyId", companyId);
  if (ownerId) params.set("ownerId", ownerId);
  if (lifecycleStage) params.set("lifecycleStage", lifecycleStage);
  const url = new URL(`http://internal/contacts?${params.toString()}`);

  const response = await handleListContacts(userId, url);
  const data = (await response.json()) as { contacts?: ContactRow[]; nextCursor?: string | null; error?: string };

  const actor = { userId, organizationId, roleKey };
  const canCreate = can(actor, "contacts:create");
  const [companyOptions, ownerOptions] = await Promise.all([
    listActiveCompanyOptions(actor),
    listActiveOwnerOptions(actor),
  ]);
  const companyNameById = new Map(companyOptions.map((c) => [c.id, c.name]));

  const columns: EntityTableColumn<ContactRow>[] = [
    {
      key: "name",
      header: "Name",
      render: (row) => {
        const name = [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email || "(no name)";
        return <Link href={`/contacts/${row.id}`}>{name}</Link>;
      },
    },
    { key: "email", header: "Email", render: (row) => row.email ?? "—" },
    {
      key: "company",
      header: "Company",
      render: (row) => (row.companyId ? (companyNameById.get(row.companyId) ?? row.companyId) : "—"),
    },
    { key: "lifecycleStage", header: "Lifecycle Stage", render: (row) => row.lifecycleStage ?? "—" },
    { key: "owner", header: "Owner", render: (row) => row.ownerId ?? "—" },
    { key: "updated", header: "Updated", render: (row) => new Date(row.updatedAt).toLocaleDateString() },
  ];

  const tableState = response.status !== 200 ? "error" : data.contacts?.length ? "ready" : "empty";

  const nextCursorParams = new URLSearchParams();
  if (data.nextCursor) nextCursorParams.set("cursor", data.nextCursor);
  if (companyId) nextCursorParams.set("companyId", companyId);
  if (ownerId) nextCursorParams.set("ownerId", ownerId);
  if (lifecycleStage) nextCursorParams.set("lifecycleStage", lifecycleStage);

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>Contacts</h1>
      </header>

      <section className={styles.section}>
        <form method="get" className={styles.filterForm}>
          <div className={styles.field}>
            <label htmlFor="company-filter">Company</label>
            <select id="company-filter" name="companyId" defaultValue={companyId ?? ""}>
              <option value="">All companies</option>
              {companyOptions.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="owner-filter">Owner</label>
            <select id="owner-filter" name="ownerId" defaultValue={ownerId ?? ""}>
              <option value="">All owners</option>
              {ownerOptions.map((owner) => (
                <option key={owner.userId} value={owner.userId}>
                  {owner.userId}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="lifecycle-filter">Lifecycle stage</label>
            <select id="lifecycle-filter" name="lifecycleStage" defaultValue={lifecycleStage ?? ""}>
              <option value="">All stages</option>
              {LIFECYCLE_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className={styles.secondaryButton}>
            Filter
          </button>
        </form>

        <EntityTable
          columns={columns}
          rows={data.contacts ?? []}
          getRowId={(row) => row.id}
          state={tableState}
          emptyMessage="No contacts yet."
          errorMessage={typeof data.error === "string" ? data.error : "Failed to load contacts."}
        />

        {data.nextCursor ? (
          <Link href={`/contacts?${nextCursorParams.toString()}`} className={styles.loadMoreLink}>
            Load more
          </Link>
        ) : null}
      </section>

      {canCreate ? (
        <section className={styles.section}>
          <h2>Create a contact</h2>
          <ContactForm companyOptions={companyOptions} ownerOptions={ownerOptions} />
        </section>
      ) : null}
    </main>
  );
}
