import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser, can } from "@ai-revenue-os/auth";
import { EntityTable, type EntityTableColumn } from "@ai-revenue-os/ui";
import { handleListDeals } from "../api/v1/deals/handlers";
import { decideDealsConsoleAccess } from "./access";
import { listActiveCompanyOptions } from "../_shared/company-options";
import { resolveCompanyDisplayName } from "../_shared/company-display";
import { listActiveContactOptions } from "../_shared/contact-options";
import { resolveContactDisplayName } from "../_shared/contact-display";
import { listActivePipelineOptions, listActiveStageOptions } from "../_shared/pipeline-options";
import { resolvePipelineDisplayName, resolveStageDisplayName } from "../_shared/pipeline-display";
import { listActiveOwnerOptions } from "../_shared/owner-options";
import { resolveOwnerLabel } from "../_shared/owner-option";
import { dealDisplayLabel } from "./deal-display";
import { DealForm } from "./deal-form";
import styles from "../companies/companies.module.css";

const DEAL_STATUSES = ["open", "won", "lost"] as const;

interface DealRow {
  id: string;
  companyId: string | null;
  primaryContactId: string | null;
  pipelineId: string;
  stageId: string;
  amount: string | null;
  currency: string;
  status: string;
  ownerId: string | null;
  expectedCloseDate: string | null;
  updatedAt: string;
}

/**
 * Milestone 2.2E. Mirrors apps/web/app/contacts/page.tsx exactly — same
 * first-party, in-process-handler-reuse architecture (ADR-004), same
 * link-based cursor continuation, same "resolve names for soft-deleted
 * relationships missing from the active-options list" pattern — applied
 * to four relationship types here (company/contact/pipeline/stage)
 * instead of one.
 *
 * "Deal" column UX limitation (deal-display.ts's own comment, restated
 * here because it governs this page's central column): `deals` has no
 * name/title field. The column shows the resolved company name, falling
 * back to the resolved contact name, falling back to a short id — never
 * a full raw UUID.
 */
export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; pipelineId?: string; stageId?: string; ownerId?: string; companyId?: string; status?: string }>;
}): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const orgContext = user ? await resolveOrganizationContextForUser(user.id) : null;
  const decision = decideDealsConsoleAccess(user?.id ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const { userId, organizationId, roleKey } = decision.orgContext;
  const { cursor, pipelineId, stageId, ownerId, companyId, status } = await searchParams;

  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (pipelineId) params.set("pipelineId", pipelineId);
  if (stageId) params.set("stageId", stageId);
  if (ownerId) params.set("ownerId", ownerId);
  if (companyId) params.set("companyId", companyId);
  if (status) params.set("status", status);
  const url = new URL(`http://internal/deals?${params.toString()}`);

  const response = await handleListDeals(userId, url);
  const data = (await response.json()) as { deals?: DealRow[]; nextCursor?: string | null; error?: string };
  const rows = data.deals ?? [];

  const actor = { userId, organizationId, roleKey };
  const canCreate = can(actor, "deals:create");

  const [companyOptions, contactOptions, pipelineOptions, ownerOptions] = await Promise.all([
    listActiveCompanyOptions(actor),
    listActiveContactOptions(actor),
    listActivePipelineOptions(actor),
    listActiveOwnerOptions(actor),
  ]);
  const stageOptions = await listActiveStageOptions(
    actor,
    pipelineOptions.map((p) => p.id),
  );

  const companyNameById = new Map(companyOptions.map((c) => [c.id, c.name]));
  const contactNameById = new Map(contactOptions.map((c) => [c.id, c.name]));
  const pipelineNameById = new Map(pipelineOptions.map((p) => [p.id, p.name]));
  const stageNameById = new Map(stageOptions.map((s) => [s.id, s.name]));

  // Same "resolve just the missing ids" pattern as contacts/page.tsx,
  // repeated for every relationship a deal can carry — a soft-deleted
  // company/contact/pipeline/stage stays referenced (the frozen Milestone
  // 2.2 relationship-preservation decision), so the active-options maps
  // above are deliberately missing an entry for it.
  const missingCompanyIds = Array.from(
    new Set(rows.map((r) => r.companyId).filter((id): id is string => id !== null && !companyNameById.has(id))),
  );
  const missingContactIds = Array.from(
    new Set(
      rows.map((r) => r.primaryContactId).filter((id): id is string => id !== null && !contactNameById.has(id)),
    ),
  );
  const missingPipelineIds = Array.from(new Set(rows.map((r) => r.pipelineId).filter((id) => !pipelineNameById.has(id))));
  const missingStages = rows.filter((r) => !stageNameById.has(r.stageId));

  const [companyLabels, contactLabels, pipelineLabels, stageLabels] = await Promise.all([
    Promise.all(missingCompanyIds.map((id) => resolveCompanyDisplayName(actor, id, companyOptions))),
    Promise.all(missingContactIds.map((id) => resolveContactDisplayName(actor, id, contactOptions))),
    Promise.all(missingPipelineIds.map((id) => resolvePipelineDisplayName(actor, id, pipelineOptions))),
    Promise.all(missingStages.map((r) => resolveStageDisplayName(actor, r.pipelineId, r.stageId, stageOptions))),
  ]);
  missingCompanyIds.forEach((id, i) => companyNameById.set(id, companyLabels[i]!));
  missingContactIds.forEach((id, i) => contactNameById.set(id, contactLabels[i]!));
  missingPipelineIds.forEach((id, i) => pipelineNameById.set(id, pipelineLabels[i]!));
  missingStages.forEach((r, i) => stageNameById.set(r.stageId, stageLabels[i]!));

  const columns: EntityTableColumn<DealRow>[] = [
    {
      key: "deal",
      header: "Deal",
      render: (row) => {
        const companyName = row.companyId ? (companyNameById.get(row.companyId) ?? null) : null;
        const contactName = row.primaryContactId ? (contactNameById.get(row.primaryContactId) ?? null) : null;
        return <Link href={`/deals/${row.id}`}>{dealDisplayLabel(row.id, companyName, contactName)}</Link>;
      },
    },
    { key: "company", header: "Company", render: (row) => (row.companyId ? (companyNameById.get(row.companyId) ?? "Deleted company") : "—") },
    {
      key: "contact",
      header: "Primary Contact",
      render: (row) => (row.primaryContactId ? (contactNameById.get(row.primaryContactId) ?? "Deleted contact") : "—"),
    },
    { key: "pipeline", header: "Pipeline", render: (row) => pipelineNameById.get(row.pipelineId) ?? "Deleted pipeline" },
    { key: "stage", header: "Stage", render: (row) => stageNameById.get(row.stageId) ?? "Deleted stage" },
    { key: "amount", header: "Amount", render: (row) => (row.amount !== null ? `${row.amount} ${row.currency}` : "—") },
    { key: "status", header: "Status", render: (row) => row.status },
    { key: "owner", header: "Owner", render: (row) => resolveOwnerLabel(ownerOptions, row.ownerId) ?? "—" },
    {
      key: "expectedClose",
      header: "Expected Close",
      render: (row) => (row.expectedCloseDate ? new Date(row.expectedCloseDate).toLocaleDateString() : "—"),
    },
    { key: "updated", header: "Updated", render: (row) => new Date(row.updatedAt).toLocaleDateString() },
  ];

  const tableState = response.status !== 200 ? "error" : rows.length ? "ready" : "empty";

  const nextCursorParams = new URLSearchParams();
  if (data.nextCursor) nextCursorParams.set("cursor", data.nextCursor);
  if (pipelineId) nextCursorParams.set("pipelineId", pipelineId);
  if (stageId) nextCursorParams.set("stageId", stageId);
  if (ownerId) nextCursorParams.set("ownerId", ownerId);
  if (companyId) nextCursorParams.set("companyId", companyId);
  if (status) nextCursorParams.set("status", status);

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>Deals</h1>
        <Link href="/deals/board">Board view</Link>
      </header>

      <section className={styles.section}>
        <form method="get" className={styles.filterForm}>
          <div className={styles.field}>
            <label htmlFor="pipeline-filter">Pipeline</label>
            <select id="pipeline-filter" name="pipelineId" defaultValue={pipelineId ?? ""}>
              <option value="">All pipelines</option>
              {pipelineOptions.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="stage-filter">Stage</label>
            <select id="stage-filter" name="stageId" defaultValue={stageId ?? ""}>
              <option value="">All stages</option>
              {stageOptions.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {(pipelineNameById.get(stage.pipelineId) ?? "Pipeline") + " — " + stage.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="owner-filter">Owner</label>
            <select id="owner-filter" name="ownerId" defaultValue={ownerId ?? ""}>
              <option value="">All owners</option>
              {ownerOptions.map((owner) => (
                <option key={owner.userId} value={owner.userId}>
                  {owner.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="company-filter">Company</label>
            <select id="company-filter" name="companyId" defaultValue={companyId ?? ""}>
              <option value="">All companies</option>
              {companyOptions.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="status-filter">Status</label>
            <select id="status-filter" name="status" defaultValue={status ?? ""}>
              <option value="">All statuses</option>
              {DEAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
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
          rows={rows}
          getRowId={(row) => row.id}
          state={tableState}
          emptyMessage="No deals yet."
          errorMessage={typeof data.error === "string" ? data.error : "Failed to load deals."}
        />

        {data.nextCursor ? (
          <Link href={`/deals?${nextCursorParams.toString()}`} className={styles.loadMoreLink}>
            Load more
          </Link>
        ) : null}
      </section>

      {canCreate ? (
        <section className={styles.section}>
          <h2>Create a deal</h2>
          <DealForm
            companyOptions={companyOptions}
            contactOptions={contactOptions}
            pipelineOptions={pipelineOptions}
            stageOptions={stageOptions}
            ownerOptions={ownerOptions}
          />
        </section>
      ) : null}
    </main>
  );
}
