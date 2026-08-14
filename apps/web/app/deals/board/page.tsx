import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { PipelineBoard, type PipelineBoardStage } from "@ai-revenue-os/ui";
import { handleListDeals } from "../../api/v1/deals/handlers";
import { handleListPipelineStages } from "../../api/v1/pipelines/[id]/stages/handlers";
import { decideDealsConsoleAccess } from "../access";
import { listActivePipelineOptions } from "../../_shared/pipeline-options";
import { listActiveCompanyOptions } from "../../_shared/company-options";
import { resolveCompanyDisplayName } from "../../_shared/company-display";
import { listActiveContactOptions } from "../../_shared/contact-options";
import { resolveContactDisplayName } from "../../_shared/contact-display";
import { dealDisplayLabel } from "../deal-display";
import { StageMoveForm } from "./stage-move-form";
import styles from "../../companies/companies.module.css";

interface DealRow {
  id: string;
  companyId: string | null;
  primaryContactId: string | null;
  stageId: string;
  amount: string | null;
  currency: string;
}

const DELETED_STAGE_COLUMN_ID = "deleted-stage-holding";

/**
 * Milestone 2.2F §14/§15/§16. A dedicated route rather than a view toggle
 * on /deals — audited both: /deals already carries five filters, cursor
 * pagination, and a create form; the board needs a fundamentally
 * different data shape (all of one pipeline's active deals grouped by
 * stage, not a filtered paginated flat list), so folding it into /deals
 * would mean two incompatible data-fetching paths sharing one route.
 * A separate, simple, server-driven route keeps both pages small and
 * single-purpose — the smallest architecture, not a new navigation
 * system (one link each way, no sidebar).
 *
 * Reuses decideDealsConsoleAccess (deals:read) unchanged — the board is a
 * view of Deals data, not a new resource, so it carries the exact same
 * RBAC gate as /deals itself. No pipelines:* permission is involved here
 * at all.
 *
 * Single-fetch limitation (§16, deliberately not engineered around): a
 * pipeline's active deals are fetched once at MAX_LIMIT (100, packages/
 * crm/src/pagination.ts) — a pipeline with more than 100 active deals
 * would only show the first 100 on the board. Documented, not hidden;
 * looping cursor pagination to assemble a complete board in one request
 * would be a new read-model concern this milestone's own scope excludes.
 */
export default async function DealsBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ pipelineId?: string }>;
}): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const orgContext = user ? await resolveOrganizationContextForUser(user.id) : null;
  const decision = decideDealsConsoleAccess(user?.id ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const { userId, organizationId, roleKey } = decision.orgContext;
  const actor = { userId, organizationId, roleKey };
  const { pipelineId: requestedPipelineId } = await searchParams;

  const pipelineOptions = await listActivePipelineOptions(actor);

  // §15: never treat a deleted/invalid pipelineId as valid — fall back to
  // the organization's active default pipeline, never a raw id.
  const requested = requestedPipelineId ? pipelineOptions.find((p) => p.id === requestedPipelineId) : undefined;
  const selectedPipeline = requested ?? pipelineOptions.find((p) => p.isDefault) ?? pipelineOptions[0];

  if (!selectedPipeline) {
    return (
      <main className={styles.page}>
        <header className={styles.pageHeader}>
          <h1>Deals board</h1>
        </header>
        <p>No active pipeline exists yet for this organization. Create one on the Pipelines page first.</p>
      </main>
    );
  }

  const stagesResponse = await handleListPipelineStages(userId, selectedPipeline.id);
  const stagesData = (await stagesResponse.json()) as { stages?: { id: string; name: string }[] };
  const stages = stagesData.stages ?? [];

  const dealsUrl = new URL(`http://internal/deals?pipelineId=${selectedPipeline.id}&limit=100`);
  const dealsResponse = await handleListDeals(userId, dealsUrl);
  const dealsData = (await dealsResponse.json()) as { deals?: DealRow[]; error?: string };
  const deals = dealsData.deals ?? [];

  const [companyOptions, contactOptions] = await Promise.all([
    listActiveCompanyOptions(actor),
    listActiveContactOptions(actor),
  ]);
  const companyNameById = new Map(companyOptions.map((c) => [c.id, c.name]));
  const contactNameById = new Map(contactOptions.map((c) => [c.id, c.name]));

  const missingCompanyIds = Array.from(
    new Set(deals.map((d) => d.companyId).filter((id): id is string => id !== null && !companyNameById.has(id))),
  );
  const missingContactIds = Array.from(
    new Set(deals.map((d) => d.primaryContactId).filter((id): id is string => id !== null && !contactNameById.has(id))),
  );
  const [companyLabels, contactLabels] = await Promise.all([
    Promise.all(missingCompanyIds.map((id) => resolveCompanyDisplayName(actor, id, companyOptions))),
    Promise.all(missingContactIds.map((id) => resolveContactDisplayName(actor, id, contactOptions))),
  ]);
  missingCompanyIds.forEach((id, i) => companyNameById.set(id, companyLabels[i]!));
  missingContactIds.forEach((id, i) => contactNameById.set(id, contactLabels[i]!));

  const activeStageIds = new Set(stages.map((s) => s.id));
  const otherStagesByStageId = new Map(
    stages.map((s) => [s.id, stages.filter((other) => other.id !== s.id).map((other) => ({ id: other.id, name: other.name }))]),
  );

  const boardStages: PipelineBoardStage[] = stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    cards: [],
  }));
  const boardStageById = new Map(boardStages.map((s) => [s.id, s]));

  // §18/§21: a deal on a since-soft-deleted stage must not silently
  // vanish from the board — it goes into an explicit holding column
  // instead of any active-stage column, with the same move control
  // (moving it to any active stage in this pipeline is exactly the
  // recovery action a user needs here).
  const deletedStageColumn: PipelineBoardStage = { id: DELETED_STAGE_COLUMN_ID, name: "Deleted stage", cards: [] };

  for (const deal of deals) {
    const companyName = deal.companyId ? (companyNameById.get(deal.companyId) ?? null) : null;
    const contactName = deal.primaryContactId ? (contactNameById.get(deal.primaryContactId) ?? null) : null;
    const label = dealDisplayLabel(deal.id, companyName, contactName);
    const amountLabel = deal.amount !== null ? `${deal.amount} ${deal.currency}` : undefined;
    const otherStages = activeStageIds.has(deal.stageId)
      ? (otherStagesByStageId.get(deal.stageId) ?? [])
      : stages.map((s) => ({ id: s.id, name: s.name }));

    const card = {
      id: deal.id,
      label,
      ...(amountLabel ? { amountLabel } : {}),
      moveControl: <StageMoveForm dealId={deal.id} otherStages={otherStages} />,
    };

    const target = boardStageById.get(deal.stageId);
    if (target) {
      target.cards.push(card);
    } else {
      deletedStageColumn.cards.push(card);
    }
  }

  const columns = deletedStageColumn.cards.length > 0 ? [...boardStages, deletedStageColumn] : boardStages;
  const boardState = dealsResponse.status !== 200 ? "error" : "ready";

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>Deals board</h1>
        <Link href="/deals">Back to list</Link>
      </header>

      {pipelineOptions.length > 1 ? (
        <form method="get" className={styles.filterForm}>
          <div className={styles.field}>
            <label htmlFor="board-pipeline">Pipeline</label>
            <select id="board-pipeline" name="pipelineId" defaultValue={selectedPipeline.id}>
              {pipelineOptions.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                  {pipeline.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className={styles.secondaryButton}>
            Switch
          </button>
        </form>
      ) : null}

      <PipelineBoard
        stages={columns}
        state={boardState}
        errorMessage={typeof dealsData.error === "string" ? dealsData.error : "Failed to load the board."}
        emptyMessage="This pipeline has no active stages yet."
      />
    </main>
  );
}
