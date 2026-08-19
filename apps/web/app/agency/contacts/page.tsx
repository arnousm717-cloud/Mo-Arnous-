import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveAgencyRequestContext } from "@ai-revenue-os/auth";
import { EntityTable, type EntityTableColumn } from "@ai-revenue-os/ui";
import { decideAgencyConsoleAccess } from "../access";
import { listContactsForAgencyConsole, type AgencyContactRow } from "../rollup-logic";

/**
 * Milestone 2.4D. Read-only agency roll-up of client contacts.
 * Authorization (contacts:agency-rollup-read) happens server-side in
 * listContactsForAgencyConsole before any data is fetched. Deliberately
 * never renders email/phone/job title/LinkedIn URL/owner — the
 * agency_rollup_contacts view (2.4A) does not expose them, and
 * AgencyContactRow (../rollup-logic.ts) has no such field to render even
 * by mistake.
 */
export default async function AgencyContactsPage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const agencyContext = user ? await resolveAgencyRequestContext() : null;
  const decision = decideAgencyConsoleAccess(user?.id ?? null, agencyContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const result = await listContactsForAgencyConsole(decision.agencyContext);

  const columns: EntityTableColumn<AgencyContactRow>[] = [
    { key: "name", header: "Name", render: (row) => row.name },
    { key: "organization", header: "Client organization", render: (row) => row.organizationLabel },
    { key: "company", header: "Company", render: (row) => row.companyLabel ?? "—" },
    { key: "lifecycleStage", header: "Lifecycle stage", render: (row) => row.lifecycleStage ?? "—" },
  ];

  const state = result.kind === "ready" ? (result.rows.length ? "ready" : "empty") : "error";
  const errorMessage =
    result.kind === "denied"
      ? "You do not have permission to view this."
      : "Failed to load contacts across your client organizations.";

  return (
    <main>
      <header>
        <h1>Client contacts</h1>
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
          emptyMessage="No contacts across your client organizations yet."
          errorMessage={errorMessage}
        />
      </section>
    </main>
  );
}
