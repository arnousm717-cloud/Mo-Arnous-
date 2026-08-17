import { redirect, notFound } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser, can } from "@ai-revenue-os/auth";
import { handleGetDeal } from "../../api/v1/deals/[id]/handlers";
import { decideDealsConsoleAccess } from "../access";
import { listActiveCompanyOptions } from "../../_shared/company-options";
import { resolveCompanyDisplayName } from "../../_shared/company-display";
import { listActiveContactOptions } from "../../_shared/contact-options";
import { resolveContactDisplayName } from "../../_shared/contact-display";
import { listActivePipelineOptions, listActiveStageOptions } from "../../_shared/pipeline-options";
import { resolvePipelineDisplayName, resolveStageDisplayName } from "../../_shared/pipeline-display";
import { listActiveOwnerOptions } from "../../_shared/owner-options";
import { resolveOwnerLabel } from "../../_shared/owner-option";
import { dealDisplayLabel } from "../deal-display";
import { DealEditForm, type EditableDeal } from "./deal-edit-form";
import { DeleteDealForm } from "./delete-deal-form";
import { ActivityTimelineSection } from "../../_shared/activity-timeline/section";
import { parseTimelineLimit } from "../../_shared/activity-timeline/timeline-limit";
import styles from "../../companies/companies.module.css";

interface DealDetail extends EditableDeal {
  createdAt: string;
  updatedAt: string;
}

/**
 * Milestone 2.2E. Mirrors apps/web/app/contacts/[id]/page.tsx exactly.
 * handleGetDeal already returns an identical 404 for a cross-org id, a
 * genuinely nonexistent one, and a soft-deleted deal — this page adds no
 * special-casing, it just maps "not 200" to notFound().
 *
 * A linked company/contact/pipeline/stage that has since been
 * soft-deleted is deliberately NOT treated as an error here — every one
 * of those ids is displayed as-is, never dropped or nulled by this page.
 * Each name is resolved via its own *IncludingDeleted read helper
 * (tenant-scoped, read-only) when it isn't in the active options list,
 * rendered as "<name> (deleted)" — never a raw id. Each resolved entry is
 * also merged into the options list passed to DealEditForm so its own
 * <select> shows that label instead of falling back to an id-only
 * synthetic option — the exact pattern already established for
 * Contacts' companyOptions, applied here to four relationships instead
 * of one.
 */
export default async function DealDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ timelineLimit?: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const { timelineLimit: timelineLimitParam } = await searchParams;
  const user = await getAuthenticatedUser();
  const orgContext = user ? await resolveOrganizationContextForUser(user.id) : null;
  const decision = decideDealsConsoleAccess(user?.id ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const { userId, organizationId, roleKey } = decision.orgContext;
  const response = await handleGetDeal(userId, id);
  if (response.status !== 200) {
    notFound();
  }

  const data = (await response.json()) as { deal: DealDetail };
  const deal = data.deal;

  const actor = { userId, organizationId, roleKey };
  const canUpdate = can(actor, "deals:update");
  const canDelete = can(actor, "deals:delete");

  let companyOptions = canUpdate || deal.companyId ? await listActiveCompanyOptions(actor) : [];
  let contactOptions = canUpdate || deal.primaryContactId ? await listActiveContactOptions(actor) : [];
  let pipelineOptions = canUpdate ? await listActivePipelineOptions(actor) : [];
  if (!canUpdate && !pipelineOptions.some((p) => p.id === deal.pipelineId)) {
    // Read-only viewers still need the deal's own pipeline resolvable for
    // the detail view below, even though they get no pipelineOptions for
    // any <select> (there is no edit form to populate for them).
    pipelineOptions = await listActivePipelineOptions(actor);
  }
  let stageOptions = pipelineOptions.length > 0 ? await listActiveStageOptions(actor, pipelineOptions.map((p) => p.id)) : [];

  let companyName: string | null = null;
  if (deal.companyId) {
    const active = companyOptions.find((c) => c.id === deal.companyId);
    if (active) {
      companyName = active.name;
    } else {
      companyName = await resolveCompanyDisplayName(actor, deal.companyId, companyOptions);
      if (canUpdate) {
        companyOptions = [...companyOptions, { id: deal.companyId, name: companyName }];
      }
    }
  }

  let contactName: string | null = null;
  if (deal.primaryContactId) {
    const active = contactOptions.find((c) => c.id === deal.primaryContactId);
    if (active) {
      contactName = active.name;
    } else {
      contactName = await resolveContactDisplayName(actor, deal.primaryContactId, contactOptions);
      if (canUpdate) {
        contactOptions = [...contactOptions, { id: deal.primaryContactId, name: contactName }];
      }
    }
  }

  let pipelineName: string;
  const activePipeline = pipelineOptions.find((p) => p.id === deal.pipelineId);
  if (activePipeline) {
    pipelineName = activePipeline.name;
  } else {
    pipelineName = await resolvePipelineDisplayName(actor, deal.pipelineId, pipelineOptions);
    if (canUpdate) {
      pipelineOptions = [...pipelineOptions, { id: deal.pipelineId, name: pipelineName, isDefault: false }];
    }
  }

  let stageName: string;
  const activeStage = stageOptions.find((s) => s.id === deal.stageId);
  if (activeStage) {
    stageName = activeStage.name;
  } else {
    stageName = await resolveStageDisplayName(actor, deal.pipelineId, deal.stageId, stageOptions);
    if (canUpdate) {
      stageOptions = [...stageOptions, { id: deal.stageId, pipelineId: deal.pipelineId, name: stageName }];
    }
  }

  const ownerOptions = canUpdate || deal.ownerId ? await listActiveOwnerOptions(actor) : [];

  const displayName = dealDisplayLabel(deal.id, companyName, contactName);

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>{displayName}</h1>
      </header>

      {canUpdate ? (
        <DealEditForm
          deal={deal}
          companyOptions={companyOptions}
          contactOptions={contactOptions}
          pipelineOptions={pipelineOptions}
          stageOptions={stageOptions}
          ownerOptions={ownerOptions}
        />
      ) : (
        <dl className={styles.detailFields}>
          <dt>Company</dt>
          <dd>{companyName ?? "—"}</dd>
          <dt>Primary contact</dt>
          <dd>{contactName ?? "—"}</dd>
          <dt>Pipeline</dt>
          <dd>{pipelineName}</dd>
          <dt>Stage</dt>
          <dd>{stageName}</dd>
          <dt>Amount</dt>
          <dd>{deal.amount !== null ? `${deal.amount} ${deal.currency}` : "—"}</dd>
          <dt>Status</dt>
          <dd>{deal.status}</dd>
          <dt>Probability</dt>
          <dd>{deal.probability !== null ? `${deal.probability}%` : "—"}</dd>
          <dt>Expected close date</dt>
          <dd>{deal.expectedCloseDate ? new Date(deal.expectedCloseDate).toLocaleDateString() : "—"}</dd>
          <dt>Owner</dt>
          <dd>{resolveOwnerLabel(ownerOptions, deal.ownerId) ?? "—"}</dd>
        </dl>
      )}

      {canDelete ? (
        <section className={styles.section}>
          <DeleteDealForm dealId={deal.id} />
        </section>
      ) : null}

      <ActivityTimelineSection
        actor={actor}
        relatedToType="deal"
        relatedToId={deal.id}
        returnPath={`/deals/${deal.id}`}
        timelineLimit={parseTimelineLimit(timelineLimitParam)}
      />
    </main>
  );
}
