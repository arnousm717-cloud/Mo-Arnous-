import type { PoolClient } from "pg";
import {
  InvalidCompanyRelationshipError,
  InvalidContactRelationshipError,
  InvalidPipelineRelationshipError,
  InvalidStageRelationshipError,
} from "./errors";

/**
 * Shared "does this id resolve to an active, same-organization row"
 * checks (Milestone 2.2B). validateCompanyRelationship moved here from
 * contacts.ts unchanged — deals.ts now needs the identical check a second
 * time, and owner-validation.ts already established the precedent that
 * genuine duplication (not speculative sharing) gets extracted into its
 * own module. Each function throws a single typed error collapsing
 * "does not exist", "belongs to another organization", "is
 * soft-deleted" (and, for stages, "belongs to a different pipeline")
 * into one indistinguishable outcome — matches the exact discipline
 * already established for InvalidCompanyRelationshipError/InvalidOwnerError.
 * None of these weaken the database's own composite FKs, which remain the
 * structural guarantee regardless — these exist purely to give a caller a
 * friendlier typed error before ever reaching a raw foreign-key violation.
 */

export async function validateCompanyRelationship(
  client: PoolClient,
  organizationId: string,
  companyId: string | null,
): Promise<void> {
  if (companyId === null) {
    return;
  }
  const r = await client.query(
    `select 1 from public.companies
     where id = $1 and organization_id = $2 and deleted_at is null
     limit 1`,
    [companyId, organizationId],
  );
  if (r.rows.length === 0) {
    throw new InvalidCompanyRelationshipError("companyId must reference an active company in this organization");
  }
}

export async function validateContactRelationship(
  client: PoolClient,
  organizationId: string,
  contactId: string | null,
): Promise<void> {
  if (contactId === null) {
    return;
  }
  const r = await client.query(
    `select 1 from public.contacts
     where id = $1 and organization_id = $2 and deleted_at is null
     limit 1`,
    [contactId, organizationId],
  );
  if (r.rows.length === 0) {
    throw new InvalidContactRelationshipError(
      "primaryContactId must reference an active contact in this organization",
    );
  }
}

/** pipelineId is required on deals (never nullable), unlike
 * company/contact/owner — no null short-circuit here. */
export async function validatePipelineRelationship(
  client: PoolClient,
  organizationId: string,
  pipelineId: string,
): Promise<void> {
  const r = await client.query(
    `select 1 from public.pipelines
     where id = $1 and organization_id = $2 and deleted_at is null
     limit 1`,
    [pipelineId, organizationId],
  );
  if (r.rows.length === 0) {
    throw new InvalidPipelineRelationshipError("pipelineId must reference an active pipeline in this organization");
  }
}

export interface StageClassification {
  isWonStage: boolean;
  isLostStage: boolean;
}

/**
 * Also returns the stage's is_won_stage/is_lost_stage flags on success —
 * every caller of this function (createDeal, updateDeal) immediately
 * needs them to derive deals.status, so returning them here avoids a
 * second round-trip for the same row.
 */
export async function validateStageRelationship(
  client: PoolClient,
  organizationId: string,
  pipelineId: string,
  stageId: string,
): Promise<StageClassification> {
  const r = await client.query<{ is_won_stage: boolean; is_lost_stage: boolean }>(
    `select is_won_stage, is_lost_stage from public.pipeline_stages
     where id = $1 and organization_id = $2 and pipeline_id = $3 and deleted_at is null
     limit 1`,
    [stageId, organizationId, pipelineId],
  );
  const row = r.rows[0];
  if (!row) {
    throw new InvalidStageRelationshipError(
      "stageId must reference an active stage belonging to pipelineId in this organization",
    );
  }
  return { isWonStage: row.is_won_stage, isLostStage: row.is_lost_stage };
}

/** stage_id is the single source of truth for a deal's status (frozen
 * Milestone 2.2 design) — this is the one place that mapping is defined,
 * reused by both createDeal and updateDeal so the rule can never drift
 * between them. */
export function deriveDealStatus(classification: StageClassification): "open" | "won" | "lost" {
  if (classification.isWonStage) {
    return "won";
  }
  if (classification.isLostStage) {
    return "lost";
  }
  return "open";
}
