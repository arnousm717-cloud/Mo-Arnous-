import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { ValidationError, InvalidPipelineRelationshipError, CannotDeleteDefaultPipelineError } from "./errors";
import { decodeCursor, resolveLimit, buildPage, type Page } from "./pagination";
import { runInClientOrTransaction } from "./transaction";

/**
 * Pipelines domain logic (Milestone 2.2B, docs/13-Technical-Design-Review.md
 * "Milestone 2.2A"/"Milestone 2.2B"). Mirrors companies.ts's structure and
 * conventions exactly (row mapper, partial-update has() pattern, cursor
 * pagination, existingClient composition).
 *
 * Closes the first 2.2A-deferred gap at THIS layer only: all supported
 * domain operations below preserve "exactly one active default pipeline"
 * for an organization initialized through the approved seed flow
 * (seed_default_pipeline(), packages/database). The database itself still
 * only guarantees "at most one" (the partial unique index) — direct SQL
 * bypassing this package can still produce zero active defaults, exactly
 * as documented in docs/13 Milestone 2.2A. This package closes the gap for
 * every operation IT exposes, not at the database layer.
 */

const WHITESPACE_ONLY = /^\s*$/;

export interface CreatePipelineInput {
  name: string;
  /** Defaults to false. When true, the domain layer transactionally
   * unsets the organization's current active default (if any) before
   * inserting this pipeline as the new one — see createPipeline's own
   * comment for why the unset-then-insert ordering matters. */
  isDefault?: boolean;
}

/** Deliberately excludes isDefault — switching the default is exposed
 * only through setDefaultPipeline, the one operation that can safely
 * preserve the single-active-default invariant. See this module's own
 * top comment and docs/13 Milestone 2.2B "Default-pipeline invariant". */
export interface UpdatePipelineInput {
  name?: string;
}

export interface ListPipelinesInput {
  cursor?: string;
  limit?: number;
}

export interface Pipeline {
  id: string;
  organizationId: string;
  name: string;
  isDefault: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PipelineRow {
  id: string;
  organization_id: string;
  name: string;
  is_default: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const PIPELINE_COLUMNS = `id, organization_id, name, is_default, deleted_at, created_at, updated_at`;

function toPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    isDefault: row.is_default,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Same non-whitespace rule as companies.ts's validateCompanyName —
 * mirrored, not shared, since it's a one-line check with no other
 * behavior in common (2.1D's own precedent: not every duplicate one-liner
 * needs its own module). */
function validatePipelineName(name: unknown): string {
  if (typeof name !== "string" || WHITESPACE_ONLY.test(name)) {
    throw new ValidationError("name must contain at least one non-whitespace character");
  }
  return name.trim();
}

/** Fetches the full row (not just a boolean) — callers here need
 * is_default to decide no-op vs. switch, unlike relationship-
 * validation.ts's validatePipelineRelationship (existence-only, used by
 * deals.ts). Active pipelines only. */
async function getActivePipelineRow(client: PoolClient, organizationId: string, id: string): Promise<PipelineRow | null> {
  const r = await client.query<PipelineRow>(
    `select ${PIPELINE_COLUMNS} from public.pipelines
     where id = $1 and organization_id = $2 and deleted_at is null`,
    [id, organizationId],
  );
  return r.rows[0] ?? null;
}

export async function createPipeline(
  ctx: RequestContext & { organizationId: string },
  input: CreatePipelineInput,
  existingClient?: PoolClient,
): Promise<Pipeline> {
  const name = validatePipelineName(input.name);
  const isDefault = input.isDefault ?? false;

  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    if (isDefault) {
      // Unset any existing active default FIRST, in the same transaction,
      // before inserting this row as the new default — this ordering is
      // what keeps the partial unique index
      // (pipelines_org_active_default_idx) from ever being violated by
      // this statement sequence, without needing a deferred constraint.
      // Postgres READ COMMITTED isolation means no concurrent transaction
      // can observe an intermediate state here regardless.
      await client.query(
        `update public.pipelines set is_default = false
         where organization_id = $1 and is_default and deleted_at is null`,
        [ctx.organizationId],
      );
    }

    const r = await client.query<PipelineRow>(
      `insert into public.pipelines (organization_id, name, is_default)
       values ($1, $2, $3)
       returning ${PIPELINE_COLUMNS}`,
      [ctx.organizationId, name, isDefault],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error("pipelines insert returned no row — this should be unreachable.");
    }
    return toPipeline(row);
  });
}

/** Excludes soft-deleted rows. Returns null identically for nonexistent,
 * cross-org, and soft-deleted — matches companies.ts/contacts.ts. */
export async function getPipelineById(
  ctx: RequestContext & { organizationId: string },
  id: string,
): Promise<Pipeline | null> {
  return withTenantContext(ctx, async (client) => {
    const row = await getActivePipelineRow(client, ctx.organizationId, id);
    return row ? toPipeline(row) : null;
  });
}

/** Like getCompanyByIdIncludingDeleted — does not filter out soft-deleted
 * rows. Exists solely for read-only display-name resolution (e.g. a
 * deal's pipeline/stage name after the pipeline has been soft-deleted),
 * never for the active-selector/relationship-validation paths, which must
 * keep excluding soft-deleted pipelines unchanged. */
export async function getPipelineByIdIncludingDeleted(
  ctx: RequestContext & { organizationId: string },
  id: string,
): Promise<Pipeline | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<PipelineRow>(
      `select ${PIPELINE_COLUMNS} from public.pipelines
       where id = $1 and organization_id = $2`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toPipeline(row) : null;
  });
}

export async function listPipelines(
  ctx: RequestContext & { organizationId: string },
  input: ListPipelinesInput = {},
): Promise<Page<Pipeline>> {
  const limit = resolveLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;

  return withTenantContext(ctx, async (client) => {
    const conditions = ["organization_id = $1", "deleted_at is null"];
    const values: unknown[] = [ctx.organizationId];

    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);

    const r = await client.query<PipelineRow>(
      `select ${PIPELINE_COLUMNS} from public.pipelines
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${values.length}`,
      values,
    );
    return buildPage(r.rows, limit, toPipeline);
  });
}

/** Partial update — name only (see UpdatePipelineInput's own comment for
 * why isDefault is deliberately not here). Cannot target an already
 * soft-deleted row. Returns null for nonexistent/cross-org/already-
 * deleted. */
export async function updatePipeline(
  ctx: RequestContext & { organizationId: string },
  id: string,
  input: UpdatePipelineInput,
  existingClient?: PoolClient,
): Promise<Pipeline | null> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const has = (key: keyof UpdatePipelineInput) => Object.prototype.hasOwnProperty.call(input, key);

    if (!has("name")) {
      const row = await getActivePipelineRow(client, ctx.organizationId, id);
      return row ? toPipeline(row) : null;
    }

    const name = validatePipelineName(input.name);
    const r = await client.query<PipelineRow>(
      `update public.pipelines set name = $1
       where id = $2 and organization_id = $3 and deleted_at is null
       returning ${PIPELINE_COLUMNS}`,
      [name, id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toPipeline(row) : null;
  });
}

/**
 * Transactionally switches the organization's active default to `id`.
 * Unsets the old default (if any) THEN sets the new one, in that order,
 * within one transaction — never transiently violates
 * pipelines_org_active_default_idx, and the resulting organization always
 * has exactly one active default when this resolves successfully. A no-op
 * (returns the row unchanged) if `id` is already the active default.
 *
 * Throws CannotDeleteDefaultPipelineError? No — throws
 * InvalidPipelineRelationshipError if `id` does not resolve to an active
 * pipeline in this organization. This is an action, not a plain read/
 * update-or-404: an invalid target is a caller error worth a typed
 * exception, not a silent null.
 */
export async function setDefaultPipeline(
  ctx: RequestContext & { organizationId: string },
  id: string,
  existingClient?: PoolClient,
): Promise<Pipeline> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const target = await getActivePipelineRow(client, ctx.organizationId, id);
    if (!target) {
      throw new InvalidPipelineRelationshipError("id must reference an active pipeline in this organization");
    }
    if (target.is_default) {
      return toPipeline(target);
    }

    await client.query(
      `update public.pipelines set is_default = false
       where organization_id = $1 and is_default and deleted_at is null`,
      [ctx.organizationId],
    );
    const r = await client.query<PipelineRow>(
      `update public.pipelines set is_default = true
       where id = $1 and organization_id = $2 and deleted_at is null
       returning ${PIPELINE_COLUMNS}`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error("setDefaultPipeline's own update returned no row — this should be unreachable.");
    }
    return toPipeline(row);
  });
}

/**
 * deleted_at = now(). Rejects deleting the organization's current active
 * default with CannotDeleteDefaultPipelineError — this package never
 * auto-selects a replacement default (no frozen design or existing
 * architecture supports inventing that selection); a caller must call
 * setDefaultPipeline to switch the default to a different active pipeline
 * first, then retry. This is what closes the second 2.2A-deferred gap:
 * no supported domain operation can reduce an organization to zero active
 * default pipelines.
 *
 * Does NOT reject deleting a non-default pipeline merely because deals
 * still reference it — mirrors the frozen Milestone 2.2 decision that
 * "unrelated deal edits must keep working when pipeline/stage is
 * soft-deleted" (see pipeline-stages.ts's own soft-delete for the fuller
 * rationale, which applies identically here) and the existing companies/
 * contacts precedent (a soft-deleted company's dependent contacts keep
 * their companyId unchanged, by design). Does not cascade to this
 * pipeline's own stages — they remain independently soft-deletable/
 * gettable, exactly like companies soft-delete never cascades to
 * contacts.
 *
 * Returns null for nonexistent/cross-org/already-deleted (matches
 * companies.ts/contacts.ts).
 */
export async function softDeletePipeline(
  ctx: RequestContext & { organizationId: string },
  id: string,
): Promise<Pipeline | null> {
  return withTenantContext(ctx, async (client) => {
    const current = await getActivePipelineRow(client, ctx.organizationId, id);
    if (!current) {
      return null;
    }
    if (current.is_default) {
      throw new CannotDeleteDefaultPipelineError(
        "cannot delete the organization's active default pipeline — call setDefaultPipeline to switch the default first",
      );
    }
    const r = await client.query<PipelineRow>(
      `update public.pipelines set deleted_at = now()
       where id = $1 and organization_id = $2 and deleted_at is null
       returning ${PIPELINE_COLUMNS}`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toPipeline(row) : null;
  });
}
