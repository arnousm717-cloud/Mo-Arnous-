/**
 * Milestone 4.2 Step 2 — agent_runs domain shape. Mirrors the accepted
 * Step 1 schema (packages/database/supabase/migrations/
 * 20260910090000_create_agent_runs_schema.sql) column-for-column, in the
 * same camelCase-mapped-from-snake_case convention every other domain
 * package in this repo already uses. Deliberately does NOT include an
 * AgentDefinition/persona shape — agent_key is a static, code-defined
 * string (matching workflow_runs.workflow_key), not yet backed by any
 * table; a real persona/definition type is M4.3 scope.
 */

import type { EntityType } from "@ai-revenue-os/brain";

export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed";

/**
 * Milestone 4.2 Step 3 (Correction) — the ONLY shape `agent_runs.input`
 * may ever hold: a bounded array of polymorphic entity references,
 * reusing `packages/brain`'s own established `EntityType`/`entityType`/
 * `entityId` convention (`packages/brain/src/{types,embeddings,
 * repository,backfill}.ts`) rather than inventing a new reference
 * representation — the same "contact"|"company"|"deal" set that
 * `docs/05-AI-Agent-Architecture.md`'s own persona input descriptions
 * (Sales/Research/Scoring: deal_id/company_id/contact_id) already use.
 * No other field, and no free-form value, is structurally representable
 * here — see `validation.ts` for the runtime enforcement every caller
 * of `enqueueAgentRun` goes through, regardless of what eventually calls
 * it (no HTTP route exists yet — see `repository.ts`'s own header
 * comment for the full M4.2 scope boundary).
 */
export interface AgentRunReference {
  entityType: EntityType;
  entityId: string;
}

export interface AgentRun {
  id: string;
  organizationId: string;
  agentKey: string;
  triggeredBy: string | null;
  /** References/IDs only, never copied CRM content — the Step 1
   * migration's own binding column comment, now a real, enforced type
   * rather than `unknown` — see `validation.ts`. */
  input: { references: AgentRunReference[] };
  status: AgentRunStatus;
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * Milestone 4.2 Step 2 Correction — the fencing token a successful
 * `claimAgentRun` returns. `attemptCount` identifies exactly which
 * worker acquisition (generation) this claim represents; the caller
 * MUST pass it back to `completeAgentRun`/`failAgentRun` so a stale
 * claimant whose lease has since been reclaimed by another caller can
 * never mutate a newer generation's outcome — see repository.ts's own
 * header comment for the full fencing argument.
 */
export interface ClaimedAgentRun {
  runId: string;
  attemptCount: number;
}

/**
 * Milestone 4.2 — the minimized shape `enqueueAgentRun` returns to its
 * caller. Deliberately excludes `input`/`triggeredBy`/`organizationId`/
 * `error`/`attemptCount`/timestamps — a freshly enqueued row's own
 * lifecycle state is entirely predictable (`status = 'queued'`,
 * `attempt_count = 1`, no lease/outcome yet), so there is nothing about
 * it worth exposing beyond identity + status, regardless of what kind
 * of caller (future HTTP route or otherwise) eventually consumes it.
 */
export interface EnqueuedAgentRun {
  id: string;
  agentKey: string;
  status: AgentRunStatus;
}
