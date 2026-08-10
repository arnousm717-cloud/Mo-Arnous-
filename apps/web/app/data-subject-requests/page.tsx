import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveRequestContext } from "@ai-revenue-os/auth";
import { listOverdueDataSubjectRequests } from "@ai-revenue-os/compliance";
import { decideDsrConsoleAccess } from "./access";
import { FileDsrForm } from "./file-dsr-form";

/**
 * Minimal internal/admin view to file and track a data subject request
 * (M1.6 — docs/12-Implementation-Milestones.md: "not the full self-service
 * experience," which is Phase 6). Deliberately narrow: file a request, see
 * its status via the detail page, and see this org's overdue requests
 * (Decision E's breach view) — no full request history/listing UI, which
 * doesn't exist as a function or a decision this milestone made.
 */
export default async function DataSubjectRequestsPage(): Promise<React.ReactElement> {
  const context = await resolveRequestContext();
  const orgContext =
    context?.organizationId && context.roleKey
      ? { userId: context.userId, organizationId: context.organizationId, roleKey: context.roleKey }
      : null;
  const decision = decideDsrConsoleAccess(context?.userId ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const overdue = await listOverdueDataSubjectRequests(decision.orgContext);

  return (
    <main>
      <header>
        <h1>Data Subject Requests</h1>
      </header>

      <section>
        <h2>File an erasure request</h2>
        <FileDsrForm />
      </section>

      <section>
        <h2>Overdue requests (past 30-day SLA)</h2>
        {overdue.length === 0 ? (
          <p>No overdue requests.</p>
        ) : (
          <ul>
            {overdue.map((dsr) => (
              <li key={dsr.id}>
                <Link href={`/data-subject-requests/${dsr.id}`}>
                  {dsr.subjectType}/{dsr.subjectId} — due {new Date(dsr.dueAt).toLocaleDateString()}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
