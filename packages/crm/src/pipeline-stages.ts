import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { ValidationError, InvalidPipelineRelationshipError } from "./errors";
import { runInClientOrTransaction } from "./transaction";

/**
 * Pipeline stages domain logic (Milestone 2.2B). Stages are a small,
 * bounded, order-significant list per pipeline (kanban columns — this
 * app's own seed_default_pipeline() always creates exactly 5), not an
 * unbounded chronological list like companies/contacts/deals — so
 * listPipelineStages deliberately returns a plain array ordered by
 * sort_order, not a Page<T> cursor. This is the one genuine incompatibility
 * with the shared cursor convention (packages/crm/src/pagination.ts):
 * Cursor is hardcoded to (createdAt, id) ordering, which is the wrong axis
 * for a caller that needs "columns in kanban order," and real pagination
 * has no realistic need against a per-pipeline cardinality this small.
 *
 * Soft-delete does NOT reject a stage still referenced by active deals —
 * this mirrors the frozen Milestone 2.2 design decision made during
 * planning (docs/13 Milestone 2.2A: "unrelated deal edits must keep
 * working when pipeline/stage is soft-deleted"), itself informed by the
 * Milestone 2.1 Contacts-vs-soft-deleted-company regression. Deals keep
 * their stage_id pointing at the soft-deleted stage; deals.ts's own
 * partial-update semantics are what keep unrelated edits to those deals
 * working. This package does not invent a stricter rule than what was
 * already frozen.
 */

const WHITESPACE_ONLY = /^\s*$/;

export interface CreatePipelineStageInput {
  pipelineId: string;
  name: string;
  sortOrder: number;
  probability?: number | null;
  isWonStage?: boolean;
  isLostStage?: boolean;
}

export interface UpdatePipelineStageInput {
  name?: string;
  sortOrder?: number;
  probability?: number | null;
  isWonStage?: boolean;
  isLostStage?: boolean;
}

export interface PipelineStage {
  id: string;
  organizationId: string;
  pipelineId: string;
  name: string;
  sortOrder: number;
  probability: number | null;
  isWonStage: boolean;
  isLostStage: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PipelineStageRow {
  id: string;
  organization_id: string;
  pipeline_id: string;
  name: string;
  sort_order: number;
  probability: number | null;
  is_won_stage: boolean;
  is_lost_stage: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const STAGE_COLUMNS = `id, organization_id, pipeline_id, name, sort_order, probability,
   is_won_stage, is_lost_stage, deleted_at, created_at, updated_at`;

function toPipelineStage(row: PipelineStageRow): PipelineStage {
  return {
    id: row.id,
    organizationId: row.organization_id,
    pipelineId: row.pipeline_id,
    name: row.name,
    sortOrder: row.sort_order,
    probability: row.probability,
    isWonStage: row.is_won_stage,
    isLostStage: row.is_lost_stage,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateStageName(name: unknown): string {
  if (typeof name !== "string" || WHITESPACE_ONLY.test(name)) {
    throw new ValidationError("name must contain at least one non-whitespace character");
  }
  return name.trim();
}

/** Mirrors pipeline_stages_probability_range exactly (same 0..100 bound),
 * same domain-layer-mirrors-DB-CHECK discipline as every other validator
 * in this package. */
function validateStageProbability(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new ValidationError("probability must be an integer between 0 and 100, or null");
  }
  return value;
}

function validateSortOrder(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError("sortOrder must be an integer");
  }
  return value;
}

/** Mirrors pipeline_stages_not_won_and_lost exactly — validated against
 * the FINAL merged state, not just the supplied patch (same discipline as
 * contacts.ts's validateContactIdentity). */
function validateWonLostExclusivity(isWonStage: boolean, isLostStage: boolean): void {
  if (isWonStage && isLostStage) {
    throw new ValidationError("a stage cannot be both isWonStage and isLostStage");
  }
}

/** Active pipeline required — mirrors deals.ts's own pipeline validation,
 * duplicated here (not extracted) because it additionally needs to assert
 * "in THIS organization" for a stage create, an existence-only shape
 * identical to relationship-validation.ts's validatePipelineRelationship;
 * reused directly rather than re-implemented. */
async function assertActivePipeline(client: PoolClient, organizationId: string, pipelineId: string): Promise<void> {
  const r = await client.query(
    `select 1 from public.pipelines where id = $1 and organization_id = $2 and deleted_at is null limit 1`,
    [pipelineId, organizationId],
  );
  if (r.rows.length === 0) {
    throw new InvalidPipelineRelationshipError("pipelineId must reference an active pipeline in this organization");
  }
}

async function getActiveStageRow(
  client: PoolClient,
  organizationId: string,
  pipelineId: string,
  id: string,
): Promise<PipelineStageRow | null> {
  const r = await client.query<PipelineStageRow>(
    `select ${STAGE_COLUMNS} from public.pipeline_stages
     where id = $1 and organization_id = $2 and pipeline_id = $3 and deleted_at is null`,
    [id, organizationId, pipelineId],
  );
  return r.rows[0] ?? null;
}

/**
 * Recomputes deals.status for every deal referencing `stageId` (org +
 * stage scoped), including soft-deleted deals — a deliberate choice
 * (docs/13 Milestone 2.2B "Stage-classification cascade"): status is
 * treated as a pure derived/denormalized field kept unconditionally in
 * sync with its stage's current classification, decoupled from the
 * deal's own soft-delete lifecycle. This avoids a restored (undeleted)
 * deal ever showing a status that went stale while it was deleted — the
 * repository's own soft-delete convention treats deleted_at as ordinary,
 * recoverable deletion, so "restore, then see correct data" is the
 * expected experience, not "restore, then see whatever was true the
 * moment it was deleted." `status is distinct from` avoids touching (and
 * therefore bumping updated_at on) any deal whose status already matches.
 */
async function cascadeDealStatusForStage(
  client: PoolClient,
  organizationId: string,
  stageId: string,
  status: "open" | "won" | "lost",
): Promise<void> {
  await client.query(
    `update public.deals set status = $1
     where organization_id = $2 and stage_id = $3 and status is distinct from $1`,
    [status, organizationId, stageId],
  );
}

function deriveStatusFromFlags(isWonStage: boolean, isLostStage: boolean): "open" | "won" | "lost" {
  if (isWonStage) {
    return "won";
  }
  if (isLostStage) {
    return "lost";
  }
  return "open";
}

export async function createPipelineStage(
  ctx: RequestContext & { organizationId: string },
  input: CreatePipelineStageInput,
  existingClient?: PoolClient,
): Promise<PipelineStage> {
  const name = validateStageName(input.name);
  const sortOrder = validateSortOrder(input.sortOrder);
  const probability = validateStageProbability(input.probability ?? null);
  const isWonStage = input.isWonStage ?? false;
  const isLostStage = input.isLostStage ?? false;
  validateWonLostExclusivity(isWonStage, isLostStage);

  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    await assertActivePipeline(client, ctx.organizationId, input.pipelineId);

    const r = await client.query<PipelineStageRow>(
      `insert into public.pipeline_stages
         (organization_id, pipeline_id, name, sort_order, probability, is_won_stage, is_lost_stage)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${STAGE_COLUMNS}`,
      [ctx.organizationId, input.pipelineId, name, sortOrder, probability, isWonStage, isLostStage],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error("pipeline_stages insert returned no row — this should be unreachable.");
    }
    return toPipelineStage(row);
  });
}

/** Excludes soft-deleted rows. Returns null identically for nonexistent,
 * cross-org, soft-deleted, AND wrong-pipeline. */
export async function getPipelineStageById(
  ctx: RequestContext & { organizationId: string },
  pipelineId: string,
  id: string,
): Promise<PipelineStage | null> {
  return withTenantContext(ctx, async (client) => {
    const row = await getActiveStageRow(client, ctx.organizationId, pipelineId, id);
    return row ? toPipelineStage(row) : null;
  });
}

/** Like getCompanyByIdIncludingDeleted/getPipelineByIdIncludingDeleted —
 * does not filter out soft-deleted rows. Read-only display-name
 * resolution only. Still pipeline-scoped: a deal always carries both
 * pipelineId and stageId together, so the caller always has both. */
export async function getPipelineStageByIdIncludingDeleted(
  ctx: RequestContext & { organizationId: string },
  pipelineId: string,
  id: string,
): Promise<PipelineStage | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<PipelineStageRow>(
      `select ${STAGE_COLUMNS} from public.pipeline_stages
       where id = $1 and organization_id = $2 and pipeline_id = $3`,
      [id, ctx.organizationId, pipelineId],
    );
    const row = r.rows[0];
    return row ? toPipelineStage(row) : null;
  });
}

/** Active stages only, ordered by sort_order ASC (id ASC tie-break) — the
 * kanban column order, not creation order. Plain array, not Page<T> — see
 * this module's own top comment. */
export async function listPipelineStages(
  ctx: RequestContext & { organizationId: string },
  pipelineId: string,
): Promise<PipelineStage[]> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<PipelineStageRow>(
      `select ${STAGE_COLUMNS} from public.pipeline_stages
       where organization_id = $1 and pipeline_id = $2 and deleted_at is null
       order by sort_order asc, id asc`,
      [ctx.organizationId, pipelineId],
    );
    return r.rows.map(toPipelineStage);
  });
}

/**
 * Partial update. Validates won/lost exclusivity against the FINAL
 * merged state. If isWonStage/isLostStage's FINAL value differs from the
 * stage's CURRENT value (a genuine classification change, not merely
 * resupplying the same value), cascades deals.status for every deal
 * referencing this stage in the SAME transaction — see
 * cascadeDealStatusForStage's own comment for the soft-deleted-deals
 * decision. Cannot target an already soft-deleted row. Returns null for
 * nonexistent/cross-org/soft-deleted/wrong-pipeline.
 */
export async function updatePipelineStage(
  ctx: RequestContext & { organizationId: string },
  pipelineId: string,
  id: string,
  input: UpdatePipelineStageInput,
  existingClient?: PoolClient,
): Promise<PipelineStage | null> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const current = await getActiveStageRow(client, ctx.organizationId, pipelineId, id);
    if (!current) {
      return null;
    }

    const has = (key: keyof UpdatePipelineStageInput) => Object.prototype.hasOwnProperty.call(input, key);

    const finalIsWonStage = has("isWonStage") ? (input.isWonStage ?? false) : current.is_won_stage;
    const finalIsLostStage = has("isLostStage") ? (input.isLostStage ?? false) : current.is_lost_stage;
    validateWonLostExclusivity(finalIsWonStage, finalIsLostStage);

    const sets: string[] = [];
    const values: unknown[] = [];

    if (has("name")) {
      values.push(validateStageName(input.name));
      sets.push(`name = $${values.length}`);
    }
    if (has("sortOrder")) {
      values.push(validateSortOrder(input.sortOrder));
      sets.push(`sort_order = $${values.length}`);
    }
    if (has("probability")) {
      values.push(validateStageProbability(input.probability ?? null));
      sets.push(`probability = $${values.length}`);
    }
    if (has("isWonStage")) {
      values.push(finalIsWonStage);
      sets.push(`is_won_stage = $${values.length}`);
    }
    if (has("isLostStage")) {
      values.push(finalIsLostStage);
      sets.push(`is_lost_stage = $${values.length}`);
    }

    if (sets.length === 0) {
      return toPipelineStage(current);
    }

    values.push(id, ctx.organizationId, pipelineId);
    const r = await client.query<PipelineStageRow>(
      `update public.pipeline_stages set ${sets.join(", ")}
       where id = $${values.length - 2} and organization_id = $${values.length - 1} and pipeline_id = $${values.length} and deleted_at is null
       returning ${STAGE_COLUMNS}`,
      values,
    );
    const row = r.rows[0];
    if (!row) {
      return null;
    }

    const classificationChanged = finalIsWonStage !== current.is_won_stage || finalIsLostStage !== current.is_lost_stage;
    if (classificationChanged) {
      await cascadeDealStatusForStage(
        client,
        ctx.organizationId,
        id,
        deriveStatusFromFlags(finalIsWonStage, finalIsLostStage),
      );
    }

    return toPipelineStage(row);
  });
}

/** deleted_at = now(). Does NOT reject a stage still referenced by active
 * deals — see this module's own top comment for the frozen-design
 * rationale. Never a physical DELETE. Returns null for nonexistent/
 * cross-org/already-deleted/wrong-pipeline. */
export async function softDeletePipelineStage(
  ctx: RequestContext & { organizationId: string },
  pipelineId: string,
  id: string,
): Promise<PipelineStage | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<PipelineStageRow>(
      `update public.pipeline_stages set deleted_at = now()
       where id = $1 and organization_id = $2 and pipeline_id = $3 and deleted_at is null
       returning ${STAGE_COLUMNS}`,
      [id, ctx.organizationId, pipelineId],
    );
    const row = r.rows[0];
    return row ? toPipelineStage(row) : null;
  });
}
