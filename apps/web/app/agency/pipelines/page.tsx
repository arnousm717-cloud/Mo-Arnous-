import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveAgencyRequestContext } from "@ai-revenue-os/auth";
import { EntityTable, type EntityTableColumn } from "@ai-revenue-os/ui";
import { decideAgencyConsoleAccess } from "../access";
import { listPipelinesForAgencyConsole, type AgencyPipelineRow } from "../rollup-logic";

/**
 * Milestone 2.4D. Read-only agency roll-up of client pipelines — name and
 * client organization only, matching agency_rollup_pipelines' own (2.4A)
 * deliberately minimal "identify and label, never manage" column set. No
 * stage list, no default-pipeline indicator, no management control.
 */
export default async function AgencyPipelinesPage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const agencyContext = user ? await resolveAgencyRequestContext() : null;
  const decision = decideAgencyConsoleAccess(user?.id ?? null, agencyContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const result = await listPipelinesForAgencyConsole(decision.agencyContext);

  const columns: EntityTableColumn<AgencyPipelineRow>[] = [
    { key: "name", header: "Pipeline", render: (row) => row.name },
    { key: "organization", header: "Client organization", render: (row) => row.organizationLabel },
  ];

  const state = result.kind === "ready" ? (result.rows.length ? "ready" : "empty") : "error";
  const errorMessage =
    result.kind === "denied"
      ? "You do not have permission to view this."
      : "Failed to load pipelines across your client organizations.";

  return (
    <main>
      <header>
        <h1>Client pipelines</h1>
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
          emptyMessage="No pipelines across your client organizations yet."
          errorMessage={errorMessage}
        />
      </section>
    </main>
  );
}
