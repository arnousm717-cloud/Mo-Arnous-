import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser, can } from "@ai-revenue-os/auth";
import { EntityTable, type EntityTableColumn } from "@ai-revenue-os/ui";
import { handleListCompanies } from "../api/v1/companies/handlers";
import { decideCompaniesConsoleAccess } from "./access";
import { listActiveOwnerOptions } from "./owner-options";
import { CompanyForm } from "./company-form";
import styles from "./companies.module.css";

interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  ownerId: string | null;
  updatedAt: string;
}

/**
 * Milestone 2.1G-B. First-party UI, ADR-004 architecture: this Server
 * Component resolves auth/org context itself, then reuses the existing
 * 2.1F-B handleListCompanies handler in-process (no browser fetch to
 * /api/v1/companies, no second HTTP client) — the exact same RBAC/
 * mass-assignment/pagination logic the real API route runs, just invoked
 * as a function call instead of over the network.
 *
 * Cursor pagination is plain link-based navigation (?cursor=...), not
 * EntityTable's onLoadMore client callback — a Server Component has
 * nothing to wire that client callback to without introducing browser
 * fetch solely for pagination, which would violate ADR-004. EntityTable
 * itself needed no change: omitting onLoadMore already hides its Load
 * More button entirely (proved in 2.1G-A's own tests), so this page
 * simply renders a plain <Link> "Load more" below the table instead.
 */
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; ownerId?: string }>;
}): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const orgContext = user ? await resolveOrganizationContextForUser(user.id) : null;
  const decision = decideCompaniesConsoleAccess(user?.id ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const { userId, organizationId, roleKey } = decision.orgContext;
  const { cursor, ownerId } = await searchParams;

  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (ownerId) params.set("ownerId", ownerId);
  const url = new URL(`http://internal/companies?${params.toString()}`);

  const response = await handleListCompanies(userId, url);
  const data = (await response.json()) as { companies?: CompanyRow[]; nextCursor?: string | null; error?: string };

  const canCreate = can({ userId, organizationId, roleKey }, "companies:create");
  const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey });

  const columns: EntityTableColumn<CompanyRow>[] = [
    {
      key: "name",
      header: "Name",
      render: (row) => <Link href={`/companies/${row.id}`}>{row.name}</Link>,
    },
    { key: "domain", header: "Domain", render: (row) => row.domain ?? "—" },
    { key: "industry", header: "Industry", render: (row) => row.industry ?? "—" },
    { key: "owner", header: "Owner", render: (row) => row.ownerId ?? "—" },
    { key: "updated", header: "Updated", render: (row) => new Date(row.updatedAt).toLocaleDateString() },
  ];

  const tableState = response.status !== 200 ? "error" : data.companies?.length ? "ready" : "empty";
  const nextCursorParams = new URLSearchParams();
  if (data.nextCursor) nextCursorParams.set("cursor", data.nextCursor);
  if (ownerId) nextCursorParams.set("ownerId", ownerId);

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>Companies</h1>
      </header>

      <section className={styles.section}>
        <form method="get" className={styles.filterForm}>
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
          <button type="submit" className={styles.secondaryButton}>
            Filter
          </button>
        </form>

        <EntityTable
          columns={columns}
          rows={data.companies ?? []}
          getRowId={(row) => row.id}
          state={tableState}
          emptyMessage="No companies yet."
          errorMessage={typeof data.error === "string" ? data.error : "Failed to load companies."}
        />

        {data.nextCursor ? (
          <Link href={`/companies?${nextCursorParams.toString()}`} className={styles.loadMoreLink}>
            Load more
          </Link>
        ) : null}
      </section>

      {canCreate ? (
        <section className={styles.section}>
          <h2>Create a company</h2>
          <CompanyForm ownerOptions={ownerOptions} />
        </section>
      ) : null}
    </main>
  );
}
