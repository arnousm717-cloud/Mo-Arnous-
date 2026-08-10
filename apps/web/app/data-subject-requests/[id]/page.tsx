import { notFound, redirect } from "next/navigation";
import { resolveRequestContext } from "@ai-revenue-os/auth";
import { getDataSubjectRequestById } from "@ai-revenue-os/compliance";
import { decideDsrConsoleAccess } from "../access";
import { ErasureActions } from "./erasure-actions";

export default async function DataSubjectRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const context = await resolveRequestContext();
  const orgContext =
    context?.organizationId && context.roleKey
      ? { userId: context.userId, organizationId: context.organizationId, roleKey: context.roleKey }
      : null;
  const decision = decideDsrConsoleAccess(context?.userId ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const dsr = await getDataSubjectRequestById(decision.orgContext, id);
  if (!dsr) {
    notFound();
  }

  return (
    <main>
      <h1>Data Subject Request</h1>
      <dl>
        <dt>Subject</dt>
        <dd>
          {dsr.subjectType} / {dsr.subjectId}
        </dd>
        <dt>Request type</dt>
        <dd>{dsr.requestType}</dd>
        <dt>Status</dt>
        <dd>{dsr.status}</dd>
        <dt>Requested</dt>
        <dd>{new Date(dsr.requestedAt).toLocaleString()}</dd>
        <dt>Due (30-day SLA)</dt>
        <dd>{new Date(dsr.dueAt).toLocaleString()}</dd>
      </dl>

      {dsr.subjectType === "user" && dsr.requestType === "delete" ? (
        <ErasureActions dsrId={dsr.id} status={dsr.status} />
      ) : (
        <p>Only user/delete requests have fulfillment logic in this milestone.</p>
      )}
    </main>
  );
}
