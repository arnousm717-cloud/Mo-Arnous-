import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveAgencyRequestContext } from "@ai-revenue-os/auth";
import { EntityTable, type EntityTableColumn } from "@ai-revenue-os/ui";
import { decideAgencyConsoleAccess } from "../access";
import { listDealsForAgencyConsole, type AgencyDealRow } from "../rollup-logic";

/**
 * Milestone 2.4D. Read-only agency roll-up of client deals.
 * Authorization (deals:agency-rollup-read) happens server-side in
 * listDealsForAgencyConsole before any data is fetched. No stage-move,
 * edit, or any other control exists on this page — read-only by design.
 * AgencyDealRow (../rollup-logic.ts) never carries a raw companyId/
 * pipelineId; those are resolved to display labels (or a safe fallback)
 * before this page ever renders.
 */
export default async function AgencyDealsPage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const agencyContext = user ? await resolveAgencyRequestContext() : null;
  const decision = decideAgencyConsoleAccess(user?.id ?? null, agencyContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const result = await listDealsForAgencyConsole(decision.agencyContext);

  const columns: EntityTableColumn<AgencyDealRow>[] = [
    { key: "deal", header: "Deal", render: (row) => row.dealLabel },
    { key: "organization", header: "Client organization", render: (row) => row.organizationLabel },
    { key: "company", header: "Company", render: (row) => row.companyLabel ?? "—" },
    { key: "pipeline", header: "Pipeline", render: (row) => row.pipelineLabel ?? "—" },
    { key: "amount", header: "Amount", render: (row) => (row.amount !== null ? `${row.amount} ${row.currency}` : "—") },
    { key: "status", header: "Status", render: (row) => row.status },
    {
      key: "expectedCloseDate",
      header: "Expected close date",
      render: (row) => (row.expectedCloseDate ? new Date(row.expectedCloseDate).toLocaleDateString() : "—"),
    },
  ];

  const state = result.kind === "ready" ? (result.rows.length ? "ready" : "empty") : "error";
  const errorMessage =
    result.kind === "denied"
      ? "You do not have permission to view this."
      : "Failed to load deals across your client organizations.";

  return (
    <main>
      <header>
        <h1>Client deals</h1>
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
          emptyMessage="No deals across your client organizations yet."
          errorMessage={errorMessage}
        />
      </section>
    </main>
  );
}
