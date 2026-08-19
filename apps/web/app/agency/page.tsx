import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveAgencyRequestContext } from "@ai-revenue-os/auth";
import { getAgencyById, listOrganizationsForAgency } from "@ai-revenue-os/tenancy";
import { CreateClientOrgForm } from "./create-client-org-form";
import { decideAgencyConsoleAccess } from "./access";

/**
 * Agency Console shell (M1.4 — client org list/grid only, no
 * impersonation/client-entry workflow, no CRM UI, docs/07-UI-UX-System.md
 * §6). Access logic lives in ./access.ts's decideAgencyConsoleAccess() so
 * it's testable independent of this Server Component.
 *
 * Milestone 2.4D adds four navigation links to the read-only CRM roll-up
 * pages (companies/contacts/deals/pipelines) — no other change to this
 * shell. Each linked page independently re-resolves and re-checks its own
 * agency-rollup-read permission; a link being visible here is not itself
 * an authorization decision.
 */
export default async function AgencyConsolePage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const agencyContext = user ? await resolveAgencyRequestContext() : null;
  const decision = decideAgencyConsoleAccess(user?.id ?? null, agencyContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const [agency, organizations] = await Promise.all([
    getAgencyById(decision.agencyContext),
    listOrganizationsForAgency(decision.agencyContext),
  ]);

  return (
    <main>
      <header>
        <h1>{agency?.name ?? "Agency Console"}</h1>
        <p>Role: {decision.agencyContext.roleKey}</p>
      </header>

      <nav>
        <Link href="/agency/companies">Companies</Link>
        {" | "}
        <Link href="/agency/contacts">Contacts</Link>
        {" | "}
        <Link href="/agency/deals">Deals</Link>
        {" | "}
        <Link href="/agency/pipelines">Pipelines</Link>
      </nav>

      <section>
        <h2>Client organizations</h2>
        {organizations.length === 0 ? (
          <p>No client organizations yet.</p>
        ) : (
          <ul>
            {organizations.map((org) => (
              <li key={org.id}>{org.name}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Create a client organization</h2>
        <CreateClientOrgForm />
      </section>
    </main>
  );
}
