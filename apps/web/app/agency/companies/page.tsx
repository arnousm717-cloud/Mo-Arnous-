import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveAgencyRequestContext } from "@ai-revenue-os/auth";
import { EntityTable, type EntityTableColumn } from "@ai-revenue-os/ui";
import { decideAgencyConsoleAccess } from "../access";
import { listCompaniesForAgencyConsole, type AgencyCompanyRow } from "../rollup-logic";

/**
 * Milestone 2.4D. Read-only agency roll-up of client companies across
 * every organization under the calling agency. Authorization
 * (companies:agency-rollup-read) happens in listCompaniesForAgencyConsole
 * (../rollup-logic.ts), server-side, before any roll-up data is fetched —
 * this page never renders based on a client-side permission guess. No
 * create/edit/delete control exists anywhere on this page, by design.
 */
export default async function AgencyCompaniesPage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const agencyContext = user ? await resolveAgencyRequestContext() : null;
  const decision = decideAgencyConsoleAccess(user?.id ?? null, agencyContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const result = await listCompaniesForAgencyConsole(decision.agencyContext);

  const columns: EntityTableColumn<AgencyCompanyRow>[] = [
    { key: "name", header: "Company", render: (row) => row.name },
    { key: "organization", header: "Client organization", render: (row) => row.organizationLabel },
    { key: "domain", header: "Domain", render: (row) => row.domain ?? "—" },
    { key: "industry", header: "Industry", render: (row) => row.industry ?? "—" },
    { key: "employeeCount", header: "Employee count", render: (row) => row.employeeCount ?? "—" },
    { key: "annualRevenue", header: "Annual revenue", render: (row) => row.annualRevenue ?? "—" },
  ];

  const state = result.kind === "ready" ? (result.rows.length ? "ready" : "empty") : "error";
  const errorMessage =
    result.kind === "denied"
      ? "You do not have permission to view this."
      : "Failed to load companies across your client organizations.";

  return (
    <main>
      <header>
        <h1>Client companies</h1>
        <nav>
          <Link href="/agency">Agency console</Link>
        </nav>
      </header>

      <section>
        <EntityTable
          columns={columns}
          rows={result.kind === "ready" ? result.rows : []}
          getRowId={(row) => row.id}
          state={state}
          emptyMessage="No companies across your client organizations yet."
          errorMessage={errorMessage}
        />
      </section>
    </main>
  );
}
