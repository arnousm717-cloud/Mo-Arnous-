import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser, can } from "@ai-revenue-os/auth";
import { EntityTable, type EntityTableColumn } from "@ai-revenue-os/ui";
import { handleListPipelines } from "../api/v1/pipelines/handlers";
import { decidePipelinesConsoleAccess } from "./access";
import { listActiveStageOptions } from "../_shared/pipeline-options";
import { PipelineForm } from "./pipeline-form";
import styles from "../companies/companies.module.css";

interface PipelineRow {
  id: string;
  name: string;
  isDefault: boolean;
  updatedAt: string;
}

/**
 * Milestone 2.2F. Configuration-management page — mirrors
 * apps/web/app/deals/page.tsx's own list+inline-create architecture
 * (ADR-004, in-process handler reuse). Deleted pipelines are excluded:
 * handleListPipelines/listPipelines already exclude deleted_at rows
 * (2.2B), this page adds no special-casing. No search/sort/offset
 * pagination — none required by the frozen pipelines API contract
 * (cursor pagination only, and an organization's pipeline count is small
 * and bounded, unlike deals/companies/contacts).
 */
export default async function PipelinesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  const orgContext = user ? await resolveOrganizationContextForUser(user.id) : null;
  const decision = decidePipelinesConsoleAccess(user?.id ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const { userId, organizationId, roleKey } = decision.orgContext;
  const { cursor } = await searchParams;

  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  const url = new URL(`http://internal/pipelines?${params.toString()}`);

  const response = await handleListPipelines(userId, url);
  const data = (await response.json()) as { pipelines?: PipelineRow[]; nextCursor?: string | null; error?: { code: string; message: string; request_id: string } };
  const rows = data.pipelines ?? [];

  const actor = { userId, organizationId, roleKey };
  const canCreate = can(actor, "pipelines:create");

  // Stage counts reuse the existing listActiveStageOptions composition
  // (2.2E) rather than a new packages/crm "count stages" function — an
  // organization's pipeline count is small and bounded (2.2B's own
  // documented assumption), so this stays well within the "avoid
  // over-engineering a new read-model" guidance.
  const stageOptions = await listActiveStageOptions(
    actor,
    rows.map((r) => r.id),
  );
  const stageCountByPipelineId = new Map<string, number>();
  for (const stage of stageOptions) {
    stageCountByPipelineId.set(stage.pipelineId, (stageCountByPipelineId.get(stage.pipelineId) ?? 0) + 1);
  }

  const columns: EntityTableColumn<PipelineRow>[] = [
    {
      key: "name",
      header: "Name",
      render: (row) => <Link href={`/pipelines/${row.id}`}>{row.name}</Link>,
    },
    { key: "default", header: "Default", render: (row) => (row.isDefault ? "Default" : "—") },
    { key: "stages", header: "Stages", render: (row) => stageCountByPipelineId.get(row.id) ?? 0 },
    { key: "updated", header: "Updated", render: (row) => new Date(row.updatedAt).toLocaleDateString() },
  ];

  const tableState = response.status !== 200 ? "error" : rows.length ? "ready" : "empty";

  const nextCursorParams = new URLSearchParams();
  if (data.nextCursor) nextCursorParams.set("cursor", data.nextCursor);

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>Pipelines</h1>
      </header>

      <section className={styles.section}>
        <EntityTable
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          state={tableState}
          emptyMessage="No pipelines yet."
          errorMessage={typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to load pipelines."}
        />

        {data.nextCursor ? (
          <Link href={`/pipelines?${nextCursorParams.toString()}`} className={styles.loadMoreLink}>
            Load more
          </Link>
        ) : null}
      </section>

      {canCreate ? (
        <section className={styles.section}>
          <h2>Create a pipeline</h2>
          <PipelineForm />
        </section>
      ) : null}
    </main>
  );
}
