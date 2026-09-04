import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { ValidationError } from "./errors";
import { decodeCursor, resolveLimit, buildPage, type Page } from "./pagination";
import { validateOwner } from "./owner-validation";
import {
  validateCompanyRelationship,
  validateContactRelationship,
  validatePipelineRelationship,
  validateStageRelationship,
  deriveDealStatus,
} from "./relationship-validation";
import { runInClientOrTransaction } from "./transaction";

/**
 * Deals domain logic (Milestone 2.2B, docs/13-Technical-Design-Review.md
 * "Milestone 2.2"). Closes the second 2.2A-deferred gap: status is a
 * fully derived field, never an independent create/update input — the
 * type system enforces this structurally (neither CreateDealInput nor
 * UpdateDealInput below declares a `status` field at all), and every
 * function here only ever reads the specific named fields it expects off
 * `input`, never spreads or forwards a raw object into the query — the
 * exact same discipline already established for organizationId on
 * companies.ts/contacts.ts (never read from `input`, always from `ctx`).
 *
 * Partial-update semantics for every relationship field (companyId,
 * primaryContactId, pipelineId, stageId, ownerId) apply the Milestone 2.1
 * Contacts lesson from day one, natively: a field is only (re)validated
 * when its FINAL value genuinely differs from the CURRENT stored value —
 * an unchanged historical relationship (e.g. a companyId that has since
 * been soft-deleted, but the caller isn't touching it) is never
 * revalidated merely because it's present in the patch, or merely because
 * it exists on the record. See updateDeal's own comment for the full
 * pipelineId/stageId coupling rules.
 */

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DEAL_STATUSES = ["open", "won", "lost"] as const;
type DealStatus = (typeof DEAL_STATUSES)[number];

export interface CreateDealInput {
  companyId?: string | null;
  primaryContactId?: string | null;
  pipelineId: string;
  stageId: string;
  amount?: number | string | null;
  /** Defaults to 'EUR' when omitted, mirroring the database column
   * default — applied here too so the returned Deal always reflects the
   * effective value immediately. */
  currency?: string;
  probability?: number | null;
  expectedCloseDate?: string | null;
  ownerId?: string | null;
}

/** Deliberately excludes status — see this module's own top comment.
 * pipelineId/stageId are optional here (unlike CreateDealInput, where
 * both are required) but never nullable — a deal always has a pipeline
 * and a stage; see updateDeal's own comment for the coupling rules when
 * either is supplied. */
export interface UpdateDealInput {
  companyId?: string | null;
  primaryContactId?: string | null;
  pipelineId?: string;
  stageId?: string;
  amount?: number | string | null;
  currency?: string;
  probability?: number | null;
  expectedCloseDate?: string | null;
  ownerId?: string | null;
}

export interface ListDealsInput {
  pipelineId?: string;
  stageId?: string;
  ownerId?: string;
  companyId?: string;
  status?: DealStatus;
  cursor?: string;
  limit?: number;
}

export interface Deal {
  id: string;
  organizationId: string;
  companyId: string | null;
  primaryContactId: string | null;
  pipelineId: string;
  stageId: string;
  // Postgres `numeric` comes back as a string (companies.ts's
  // annualRevenue precedent) — matched honestly here too.
  amount: string | null;
  currency: string;
  probability: number | null;
  expectedCloseDate: string | null;
  status: DealStatus;
  ownerId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DealRow {
  id: string;
  organization_id: string;
  company_id: string | null;
  primary_contact_id: string | null;
  pipeline_id: string;
  stage_id: string;
  amount: string | null;
  currency: string;
  probability: number | null;
  expected_close_date: string | null;
  status: string;
  owner_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** listDeals-only row shape (M4.1 Phase 2 pagination-precision
 * correction) — see packages/crm/src/pagination.ts's own header comment. */
type DealListRow = DealRow & { created_at_cursor: string };

const DEAL_COLUMNS = `id, organization_id, company_id, primary_contact_id, pipeline_id, stage_id,
   amount, currency, probability, expected_close_date, status, owner_id, deleted_at, created_at, updated_at`;

function toDeal(row: DealRow): Deal {
  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    primaryContactId: row.primary_contact_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    amount: row.amount,
    currency: row.currency,
    probability: row.probability,
    expectedCloseDate: row.expected_close_date,
    status: row.status as DealStatus,
    ownerId: row.owner_id,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Mirrors deals_currency_format exactly (uppercase 3-letter, format-only
 * — not a fixed enum, per the frozen Milestone 2.2 currency decision). */
function validateCurrency(value: string): string {
  if (!CURRENCY_PATTERN.test(value)) {
    throw new ValidationError("currency must be an uppercase 3-letter code (e.g. EUR, USD)");
  }
  return value;
}

/** Mirrors deals_probability_range exactly. */
function validateDealProbability(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new ValidationError("probability must be an integer between 0 and 100, or null");
  }
  return value;
}

/** No database CHECK constrains amount beyond `numeric` — this domain-
 * layer rule (finite, non-negative) is this package's own addition, not a
 * mirrored DB CHECK: a negative deal amount is not meaningful business
 * data, and the frozen design explicitly calls out "amount validation" as
 * required. Accepts a number or a numeric string (matching how
 * companies.ts's annualRevenue is round-tripped as a string). */
function validateAmount(value: number | string | null): string | number | null {
  if (value === null) {
    return null;
  }
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) {
    throw new ValidationError("amount must be a non-negative finite number, or null");
  }
  return value;
}

/** No semantic validation (e.g. "must be in the future") — not requested
 * by the frozen design and would be an invented constraint. Only checks
 * the value is a well-formed date the `date` column can actually store. */
function validateExpectedCloseDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ValidationError("expectedCloseDate must be a valid date string, or null");
  }
  return value;
}

async function getActiveDealRow(client: PoolClient, organizationId: string, id: string): Promise<DealRow | null> {
  const r = await client.query<DealRow>(
    `select ${DEAL_COLUMNS} from public.deals
     where id = $1 and organization_id = $2 and deleted_at is null`,
    [id, organizationId],
  );
  return r.rows[0] ?? null;
}

export async function createDeal(
  ctx: RequestContext & { organizationId: string },
  input: CreateDealInput,
  existingClient?: PoolClient,
): Promise<Deal> {
  if (typeof input.pipelineId !== "string" || input.pipelineId.length === 0) {
    throw new ValidationError("pipelineId is required");
  }
  if (typeof input.stageId !== "string" || input.stageId.length === 0) {
    throw new ValidationError("stageId is required");
  }
  const companyId = input.companyId ?? null;
  const primaryContactId = input.primaryContactId ?? null;
  const ownerId = input.ownerId ?? null;
  const currency = validateCurrency(input.currency ?? "EUR");
  const probability = validateDealProbability(input.probability ?? null);
  const amount = validateAmount(input.amount ?? null);
  const expectedCloseDate = validateExpectedCloseDate(input.expectedCloseDate ?? null);

  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    await validateCompanyRelationship(client, ctx.organizationId, companyId);
    await validateContactRelationship(client, ctx.organizationId, primaryContactId);
    await validatePipelineRelationship(client, ctx.organizationId, input.pipelineId);
    const classification = await validateStageRelationship(
      client,
      ctx.organizationId,
      input.pipelineId,
      input.stageId,
    );
    await validateOwner(client, ctx.organizationId, ownerId);
    const status = deriveDealStatus(classification);

    const r = await client.query<DealRow>(
      `insert into public.deals
         (organization_id, company_id, primary_contact_id, pipeline_id, stage_id, amount, currency, probability, expected_close_date, status, owner_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning ${DEAL_COLUMNS}`,
      [
        ctx.organizationId,
        companyId,
        primaryContactId,
        input.pipelineId,
        input.stageId,
        amount,
        currency,
        probability,
        expectedCloseDate,
        status,
        ownerId,
      ],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error("deals insert returned no row — this should be unreachable.");
    }
    // Milestone 4.1 Phase 2: emitted inside this same transaction so the
    // outbox row is atomic with the insert itself — see emit_contact_event's
    // own comment (contacts.ts) for the full SECURITY DEFINER rationale.
    await client.query("select public.emit_deal_event($1, 'deal.created')", [row.id]);
    return toDeal(row);
  });
}

/** Excludes soft-deleted rows. Returns null identically for nonexistent
 * and cross-org. */
export async function getDealById(ctx: RequestContext & { organizationId: string }, id: string): Promise<Deal | null> {
  return withTenantContext(ctx, async (client) => {
    const row = await getActiveDealRow(client, ctx.organizationId, id);
    return row ? toDeal(row) : null;
  });
}

/**
 * Milestone 4.1 Phase 2. Mirrors getContactByIdIncludingDeleted/
 * getCompanyByIdIncludingDeleted exactly (same tenant-scoped, read-only
 * shape, no new migration) — does not filter out soft-deleted rows. Added
 * for packages/brain's own tombstone-projection reconciliation read on a
 * deal.deleted event (Brain must be able to read the deal's last-known
 * content even after deleted_at is set, to project isDeleted: true rather
 * than treat the entity as though it never existed). Never used for the
 * active deal list/filter/relationship-validation paths — those must keep
 * excluding soft-deleted deals unchanged.
 */
export async function getDealByIdIncludingDeleted(
  ctx: RequestContext & { organizationId: string },
  id: string,
): Promise<Deal | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<DealRow>(
      `select ${DEAL_COLUMNS} from public.deals
       where id = $1 and organization_id = $2`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toDeal(row) : null;
  });
}

export async function listDeals(
  ctx: RequestContext & { organizationId: string },
  input: ListDealsInput = {},
): Promise<Page<Deal>> {
  const limit = resolveLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;
  if (input.status !== undefined && !(DEAL_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`status must be one of ${DEAL_STATUSES.join(", ")}`);
  }

  return withTenantContext(ctx, async (client) => {
    const conditions = ["organization_id = $1", "deleted_at is null"];
    const values: unknown[] = [ctx.organizationId];

    if (input.pipelineId !== undefined) {
      values.push(input.pipelineId);
      conditions.push(`pipeline_id = $${values.length}`);
    }
    if (input.stageId !== undefined) {
      values.push(input.stageId);
      conditions.push(`stage_id = $${values.length}`);
    }
    if (input.ownerId !== undefined) {
      values.push(input.ownerId);
      conditions.push(`owner_id = $${values.length}`);
    }
    if (input.companyId !== undefined) {
      values.push(input.companyId);
      conditions.push(`company_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      conditions.push(`status = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);

    const r = await client.query<DealListRow>(
      `select ${DEAL_COLUMNS}, created_at::text as created_at_cursor from public.deals
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${values.length}`,
      values,
    );
    return buildPage(r.rows, limit, toDeal);
  });
}

/**
 * Partial update.
 *
 * companyId/primaryContactId/ownerId: revalidated ONLY when the supplied
 * final value differs from the currently stored value — an unchanged
 * relationship (even one that has since become inactive) is never
 * revalidated merely because the field is present in the patch. A
 * genuine reassignment (including reassigning TO null) is always
 * revalidated.
 *
 * pipelineId/stageId: coupled, never nullable (a deal always has both).
 * - Neither supplied: both, and status, are left untouched.
 * - stageId supplied alone (pipelineId omitted or unchanged): the new
 *   stageId must belong to the deal's CURRENT pipeline. If it's a
 *   genuinely different stage, status is re-derived from it.
 * - pipelineId supplied and genuinely changing: stageId MUST also be
 *   supplied in the same call (rejected otherwise, ValidationError) — the
 *   deal's current stage almost never belongs to the new pipeline, and
 *   this package never guesses a replacement stage. The new stageId is
 *   validated against the NEW pipelineId, and status is re-derived from
 *   it (pipeline_id and stage_id are written together, so they can never
 *   disagree even transiently within this operation).
 * - pipelineId supplied but equal to the current value: treated as
 *   stageId-only reassignment (see above); pipelineId itself is not
 *   re-validated.
 *
 * Cannot target an already soft-deleted row. Returns null for
 * nonexistent/cross-org/already-deleted.
 */
export async function updateDeal(
  ctx: RequestContext & { organizationId: string },
  id: string,
  input: UpdateDealInput,
  existingClient?: PoolClient,
): Promise<Deal | null> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const current = await getActiveDealRow(client, ctx.organizationId, id);
    if (!current) {
      return null;
    }

    const has = (key: keyof UpdateDealInput) => Object.prototype.hasOwnProperty.call(input, key);
    const sets: string[] = [];
    const values: unknown[] = [];

    if (has("companyId")) {
      const newCompanyId = input.companyId ?? null;
      if (newCompanyId !== current.company_id) {
        await validateCompanyRelationship(client, ctx.organizationId, newCompanyId);
      }
      values.push(newCompanyId);
      sets.push(`company_id = $${values.length}`);
    }

    if (has("primaryContactId")) {
      const newContactId = input.primaryContactId ?? null;
      if (newContactId !== current.primary_contact_id) {
        await validateContactRelationship(client, ctx.organizationId, newContactId);
      }
      values.push(newContactId);
      sets.push(`primary_contact_id = $${values.length}`);
    }

    if (has("ownerId")) {
      const newOwnerId = input.ownerId ?? null;
      if (newOwnerId !== current.owner_id) {
        await validateOwner(client, ctx.organizationId, newOwnerId);
      }
      values.push(newOwnerId);
      sets.push(`owner_id = $${values.length}`);
    }

    if (has("amount")) {
      values.push(validateAmount(input.amount ?? null));
      sets.push(`amount = $${values.length}`);
    }
    if (has("currency")) {
      values.push(validateCurrency(input.currency as string));
      sets.push(`currency = $${values.length}`);
    }
    if (has("probability")) {
      values.push(validateDealProbability(input.probability ?? null));
      sets.push(`probability = $${values.length}`);
    }
    if (has("expectedCloseDate")) {
      values.push(validateExpectedCloseDate(input.expectedCloseDate ?? null));
      sets.push(`expected_close_date = $${values.length}`);
    }

    // pipelineId/stageId: coupled relationship-consistency handling.
    const pipelineSupplied = has("pipelineId");
    const stageSupplied = has("stageId");
    const newPipelineId = pipelineSupplied ? (input.pipelineId as string) : current.pipeline_id;
    const pipelineChanging = pipelineSupplied && newPipelineId !== current.pipeline_id;

    if (pipelineChanging && !stageSupplied) {
      throw new ValidationError("stageId must be supplied together with pipelineId when reassigning a deal's pipeline");
    }

    if (pipelineChanging) {
      await validatePipelineRelationship(client, ctx.organizationId, newPipelineId);
    }

    if (stageSupplied) {
      const newStageId = input.stageId as string;
      const stageChanging = pipelineChanging || newStageId !== current.stage_id;
      if (stageChanging) {
        const classification = await validateStageRelationship(client, ctx.organizationId, newPipelineId, newStageId);
        const newStatus = deriveDealStatus(classification);
        values.push(newStageId);
        sets.push(`stage_id = $${values.length}`);
        values.push(newStatus);
        sets.push(`status = $${values.length}`);
      } else {
        // Same stage resupplied unchanged — no-op, no revalidation, no
        // status recompute (matches the unchanged-relationship rule).
        values.push(newStageId);
        sets.push(`stage_id = $${values.length}`);
      }
    }

    if (pipelineSupplied) {
      values.push(newPipelineId);
      sets.push(`pipeline_id = $${values.length}`);
    }

    if (sets.length === 0) {
      return toDeal(current);
    }

    values.push(id, ctx.organizationId);
    const r = await client.query<DealRow>(
      `update public.deals set ${sets.join(", ")}
       where id = $${values.length - 1} and organization_id = $${values.length} and deleted_at is null
       returning ${DEAL_COLUMNS}`,
      values,
    );
    const row = r.rows[0];
    if (row) {
      // Milestone 4.1 Phase 2: only for a genuine UPDATE (the sets.length
      // === 0 branch above performs no write and returns early).
      await client.query("select public.emit_deal_event($1, 'deal.updated')", [row.id]);
    }
    return row ? toDeal(row) : null;
  });
}

/** deleted_at = now(). Preserves every relationship field unchanged.
 * Never a physical DELETE. Returns null for nonexistent/cross-org/
 * already-deleted. */
export async function softDeleteDeal(ctx: RequestContext & { organizationId: string }, id: string): Promise<Deal | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<DealRow>(
      `update public.deals set deleted_at = now()
       where id = $1 and organization_id = $2 and deleted_at is null
       returning ${DEAL_COLUMNS}`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    if (row) {
      // Milestone 4.1 Phase 2: emitted after deleted_at is already set on
      // the row this UPDATE...RETURNING just proved (see emit_contact_event's
      // own comment in contacts.ts for the full rationale).
      await client.query("select public.emit_deal_event($1, 'deal.deleted')", [row.id]);
    }
    return row ? toDeal(row) : null;
  });
}
