import { redirect, notFound } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser, can } from "@ai-revenue-os/auth";
import { handleGetPipeline } from "../../api/v1/pipelines/[id]/handlers";
import { handleListPipelineStages } from "../../api/v1/pipelines/[id]/stages/handlers";
import { decidePipelinesConsoleAccess } from "../access";
import { PipelineEditForm } from "./pipeline-edit-form";
import { SetDefaultForm } from "./set-default-form";
import { DeletePipelineForm } from "./delete-pipeline-form";
import { StageForm } from "./stage-form";
import { StageEditForm, type EditableStage } from "./stage-edit-form";
import styles from "../../companies/companies.module.css";

interface PipelineDetail {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * Milestone 2.2F. Configuration-management detail page — mirrors
 * apps/web/app/deals/[id]/page.tsx's own architecture (ADR-004,
 * in-process 2.2D handler reuse). handleGetPipeline already returns an
 * identical 404 for a cross-org id, a genuinely nonexistent one, and a
 * soft-deleted pipeline — this page adds no special-casing.
 *
 * Editing pipeline metadata (name) and setting the default are rendered
 * as two clearly separate sections with their own headings, never one
 * combined form — the explicit distinction this milestone's design
 * requires.
 */
export default async function PipelineDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const user = await getAuthenticatedUser();
  const orgContext = user ? await resolveOrganizationContextForUser(user.id) : null;
  const decision = decidePipelinesConsoleAccess(user?.id ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const { userId, organizationId, roleKey } = decision.orgContext;
  const response = await handleGetPipeline(userId, id);
  if (response.status !== 200) {
    notFound();
  }

  const data = (await response.json()) as { pipeline: PipelineDetail };
  const pipeline = data.pipeline;

  const stagesResponse = await handleListPipelineStages(userId, id);
  const stagesData = (await stagesResponse.json()) as { stages?: EditableStage[] };
  const stages = (stagesData.stages ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const nextSortOrder = stages.length > 0 ? Math.max(...stages.map((s) => s.sortOrder)) + 1 : 0;

  const actor = { userId, organizationId, roleKey };
  const canUpdate = can(actor, "pipelines:update");
  const canDelete = can(actor, "pipelines:delete");
  const canManageStages = can(actor, "pipelines:create");

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>{pipeline.name}</h1>
      </header>

      {canUpdate ? (
        <section className={styles.section}>
          <h2>Pipeline name</h2>
          <PipelineEditForm pipelineId={pipeline.id} name={pipeline.name} />
        </section>
      ) : (
        <section className={styles.section}>
          <dl className={styles.detailFields}>
            <dt>Name</dt>
            <dd>{pipeline.name}</dd>
            <dt>Default</dt>
            <dd>{pipeline.isDefault ? "Default" : "—"}</dd>
          </dl>
        </section>
      )}

      {canUpdate ? (
        <section className={styles.section}>
          <h2>Default pipeline</h2>
          <SetDefaultForm pipelineId={pipeline.id} isDefault={pipeline.isDefault} />
        </section>
      ) : null}

      <section className={styles.section}>
        <h2>Stages</h2>
        {stages.length === 0 ? (
          <p>No stages yet.</p>
        ) : (
          <ul className={styles.section}>
            {stages.map((stage) => (
              <StageEditForm
                key={stage.id}
                pipelineId={pipeline.id}
                stage={stage}
                canUpdate={canUpdate}
                canDelete={canDelete}
              />
            ))}
          </ul>
        )}
      </section>

      {canManageStages ? (
        <section className={styles.section}>
          <h2>Add a stage</h2>
          <StageForm pipelineId={pipeline.id} nextSortOrder={nextSortOrder} />
        </section>
      ) : null}

      {canDelete ? (
        <section className={styles.section}>
          <h2>Delete pipeline</h2>
          <DeletePipelineForm pipelineId={pipeline.id} isDefault={pipeline.isDefault} />
        </section>
      ) : null}
    </main>
  );
}
