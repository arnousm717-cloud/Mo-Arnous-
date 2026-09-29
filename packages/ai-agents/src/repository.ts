import type { PoolClient } from "pg";
import { withTenantContext, runInClientOrTransaction, type RequestContext } from "@ai-revenue-os/database";
import { AgentRunValidationError } from "./errors";
import { validateAgentRunReferences } from "./validation";
import type { ClaimedAgentRun, EnqueuedAgentRun, AgentRunReference } from "./types";

/**
 * Milestone 4.2 Step 2 (Correction) — agent_runs claim/lease/retry state
 * machine. Reuses the exact atomic `UPDATE ... WHERE <reclaim condition>
 * RETURNING` idiom `packages/brain/src/repository.ts`'s
 * `claimBrainProjectionRun`/`claimEmbeddingRecoveryAttempt` already
 * proved (twice, both live-audited) — no SELECT-then-UPDATE, no
 * SKIP LOCKED, no advisory lock; the eligibility check and the state
 * transition are one indivisible statement, so two concurrent callers
 * racing for the same row can never both win.
 *
 * Unlike `workflow_runs`' own claim functions, `agent_runs` rows are not
 * created by the claim function itself — enqueueing is `enqueueAgentRun`'s
 * own, separate concern (below). Every function here operates on an
 * already-existing row by its own `id`.
 *
 * Deliberately NO `lease_expires_at`/`available_at` columns — both
 * eligibility boundaries are derived from columns the table already
 * needs for observability (`started_at` for the running-lease case,
 * `completed_at` for the failed-backoff case).
 *
 * FENCING (Correction, addressing the Final Implementation Acceptance
 * Audit's HIGH findings): `attempt_count` doubles as the claim's own
 * generation/fencing token — no new column, no claim/lease token, no
 * worker id was introduced, exactly as the accepted correction design
 * requires. `claimAgentRun` returns the `attemptCount` it just
 * established atomically in the SAME `UPDATE ... RETURNING` that won
 * the claim (never a separate follow-up `SELECT`, which would itself be
 * a race). `completeAgentRun`/`failAgentRun` now REQUIRE that same
 * `attemptCount` back and include `attempt_count = $N` in their own
 * `WHERE` clause — so a claimant whose lease has since expired and been
 * reclaimed by a newer caller (a different, now-current `attempt_count`)
 * can never mutate that newer generation's outcome. An older generation
 * cannot mutate a newer one; this is the entire correctness contract
 * fencing exists to provide, and it required no schema change —
 * `attempt_count` already existed and already changes on every reclaim.
 */

/** 1 initial attempt + 2 retries. NOT a DB CHECK — `agent_runs.attempt_count`
 * has no upper bound at the schema level (Step 1, by design), so this
 * constant governs ONLY which rows the functions below are willing to
 * reclaim/discover, never what the database itself will store. */
const MAX_ATTEMPTS = 3;

/** Crash-recovery lease for a 'running' row — identical concept to
 * `packages/brain/src/repository.ts`'s own `CLAIM_LEASE_SECONDS`. */
const CLAIM_LEASE_SECONDS = 120;

/** Fixed backoff before a 'failed' row becomes reclaimable again. Flat,
 * not exponential/linear — no repo precedent for scaling backoff exists,
 * and M4.2 has no real failure-mode data yet to justify inventing one. */
const RETRY_BACKOFF_SECONDS = 60;

/** Matches `packages/brain/src/search.ts`'s own `resolveSearchLimit`/
 * `SEARCH_MAX_LIMIT` precedent exactly — the closest established
 * bounded-repository-list convention in this codebase — rather than
 * inventing a new validation shape. Comfortably above the future
 * dispatcher's own expected `BATCH_SIZE = 10` per-tick cadence, without
 * being unboundedly large. */
const DISCOVERY_MAX_LIMIT = 50;

function resolveDiscoveryLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgentRunValidationError("limit must be a positive integer");
  }
  if (limit > DISCOVERY_MAX_LIMIT) {
    throw new AgentRunValidationError(`limit must not exceed ${DISCOVERY_MAX_LIMIT}`);
  }
  return limit;
}

/**
 * Atomically claims one specific `agent_runs` row for execution, if and
 * only if it is currently eligible under exactly one of three
 * disjuncts:
 *
 * A. `status = 'queued'` — a brand-new row. `attempt_count` is left
 *    completely untouched (already `1` via the column's own default).
 * B. `status = 'failed'`, `attempt_count < MAX_ATTEMPTS`, and
 *    `completed_at` older than `RETRY_BACKOFF_SECONDS`. `attempt_count`
 *    increments by exactly one.
 * C. `status = 'running'`, `attempt_count < MAX_ATTEMPTS`, and
 *    `started_at` older than `CLAIM_LEASE_SECONDS` (crash recovery).
 *    `attempt_count` increments by exactly one.
 *
 * A `'running'` row already AT `MAX_ATTEMPTS` is deliberately EXCLUDED
 * from disjunct C — reclaiming it would create a 4th attempt.
 * `findExhaustedAgentRuns`/`terminalizeExhaustedAgentRun` are the
 * dedicated, separate mechanism for that state.
 *
 * Returns the winning claim's own `{runId, attemptCount}` — the fencing
 * token the caller MUST pass to `completeAgentRun`/`failAgentRun` — or
 * `null` if no eligible row matched. `organizationId` is an explicit SQL
 * predicate, never left to RLS alone.
 */
export async function claimAgentRun(
  ctx: RequestContext & { organizationId: string },
  input: { runId: string },
): Promise<ClaimedAgentRun | null> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<{ id: string; attempt_count: number }>(
      `update public.agent_runs
       set
         status = 'running',
         attempt_count = case when status = 'queued' then attempt_count else attempt_count + 1 end,
         started_at = now(),
         completed_at = null,
         error = null
       where id = $1
         and organization_id = $2
         and (
           status = 'queued'
           or (status = 'failed' and attempt_count < $3 and completed_at < now() - make_interval(secs => $4))
           or (status = 'running' and attempt_count < $3 and started_at < now() - make_interval(secs => $5))
         )
       returning id, attempt_count`,
      [input.runId, ctx.organizationId, MAX_ATTEMPTS, RETRY_BACKOFF_SECONDS, CLAIM_LEASE_SECONDS],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return { runId: row.id, attemptCount: row.attempt_count };
  });
}

/**
 * Resolves the one crash edge case `claimAgentRun` itself deliberately
 * cannot and must not resolve: a `'running'` row already at
 * `MAX_ATTEMPTS` whose lease has expired. Atomically transitions such a
 * row directly to `status = 'failed'` — WITHOUT incrementing
 * `attempt_count` and WITHOUT creating another execution attempt. Its
 * own `WHERE` condition (`attempt_count >= MAX_ATTEMPTS`) is mutually
 * exclusive with `claimAgentRun`'s own running-lease disjunct
 * (`attempt_count < MAX_ATTEMPTS`), so a given row can only ever match
 * one of the two functions' `WHERE` clauses at any instant — no
 * concurrent race between them can ever produce a contradictory or
 * double-attempted state. No fencing token needed here: unlike complete/
 * fail, this function never trusts caller-supplied attempt state, it
 * re-derives eligibility entirely from the row's own current columns.
 */
export async function terminalizeExhaustedAgentRun(
  ctx: RequestContext & { organizationId: string },
  input: { runId: string },
): Promise<boolean> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<{ id: string }>(
      `update public.agent_runs
       set
         status = 'failed',
         completed_at = now(),
         error = 'Lease expired after the maximum attempt count was already reached; this run is now permanently terminal.'
       where id = $1
         and organization_id = $2
         and status = 'running'
         and attempt_count >= $3
         and started_at < now() - make_interval(secs => $4)
       returning id`,
      [input.runId, ctx.organizationId, MAX_ATTEMPTS, CLAIM_LEASE_SECONDS],
    );
    return result.rows.length > 0;
  });
}

/**
 * Strict, FENCED state transition: only a currently `'running'` row
 * owned by the calling organization, AND still at the exact
 * `attemptCount` generation the caller itself claimed, may complete.
 * `attempt_count`/`started_at` are left untouched.
 *
 * Fencing invariant (Correction): if this row was reclaimed by another
 * caller since `attemptCount` was issued (a newer generation is now
 * current), `attempt_count = $3` no longer matches, so a stale caller's
 * completion is a structural no-op — it can never mark a newer
 * generation's still-in-progress or already-resolved attempt as
 * succeeded.
 */
export async function completeAgentRun(
  ctx: RequestContext & { organizationId: string },
  input: { runId: string; attemptCount: number },
): Promise<boolean> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<{ id: string }>(
      `update public.agent_runs
       set status = 'succeeded', completed_at = now(), error = null
       where id = $1 and organization_id = $2 and status = 'running' and attempt_count = $3
       returning id`,
      [input.runId, ctx.organizationId, input.attemptCount],
    );
    return result.rows.length > 0;
  });
}

/**
 * Strict, FENCED state transition: only a currently `'running'` row
 * owned by the calling organization, AND still at the exact
 * `attemptCount` generation the caller itself claimed, may fail — the
 * same fencing invariant as `completeAgentRun`, preventing a stale
 * claimant from overwriting a newer generation's outcome (or error
 * text) with its own out-of-date result. Deliberately does NOT
 * increment `attempt_count` — that happens only at the next successful
 * claim. `error` is stored as a plain string with no truncation/
 * sanitization framework, matching `workflow_runs.error`'s own
 * established convention; callers remain responsible for never passing
 * a secret, provider payload, or raw CRM content.
 */
export async function failAgentRun(
  ctx: RequestContext & { organizationId: string },
  input: { runId: string; attemptCount: number; error: string },
): Promise<boolean> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<{ id: string }>(
      `update public.agent_runs
       set status = 'failed', completed_at = now(), error = $4
       where id = $1 and organization_id = $2 and status = 'running' and attempt_count = $3
       returning id`,
      [input.runId, ctx.organizationId, input.attemptCount, input.error],
    );
    return result.rows.length > 0;
  });
}

/**
 * Bounded, tenant-scoped discovery of run ids a future dispatcher could
 * usefully call `claimAgentRun` against — the same three disjuncts
 * `claimAgentRun` itself checks, evaluated as a plain `SELECT`.
 *
 * Ordered by `created_at asc` (plain FIFO) — deliberately NOT the
 * hash-rotation fairness scheme Milestone 4.1 Phase 5 uses; agent runs
 * are lower-volume, Staff-triggered, user-latency-sensitive work.
 * Revisit only if real backlog/starvation evidence emerges.
 *
 * Returns bare ids only. A row already `'running'` at `MAX_ATTEMPTS`
 * with an expired lease is deliberately excluded here too — it is not
 * claimable work; `findExhaustedAgentRuns` below is its own, separate
 * discovery path.
 *
 * `limit` is validated the same way `findExhaustedAgentRuns` validates
 * its own — never passed to Postgres unchecked.
 */
export async function findClaimableAgentRuns(
  ctx: RequestContext & { organizationId: string },
  opts: { limit: number },
): Promise<string[]> {
  const limit = resolveDiscoveryLimit(opts.limit);
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<{ id: string }>(
      `select id
       from public.agent_runs
       where organization_id = $1
         and (
           status = 'queued'
           or (status = 'failed' and attempt_count < $2 and completed_at < now() - make_interval(secs => $3))
           or (status = 'running' and attempt_count < $2 and started_at < now() - make_interval(secs => $4))
         )
       order by created_at asc
       limit $5`,
      [ctx.organizationId, MAX_ATTEMPTS, RETRY_BACKOFF_SECONDS, CLAIM_LEASE_SECONDS, limit],
    );
    return result.rows.map((row) => row.id);
  });
}

/**
 * Milestone 4.2 Step 2 Correction — the discovery path
 * `findClaimableAgentRuns` deliberately does NOT provide: bounded,
 * tenant-scoped discovery of `agent_runs` rows stuck `'running'` at
 * `MAX_ATTEMPTS` with an expired lease — the exact orphan state the
 * Final Implementation Acceptance Audit found (HIGH): without this
 * function, nothing in the public repository API could ever surface
 * such a row's id, so `terminalizeExhaustedAgentRun` — despite working
 * correctly when called directly — had no normal caller able to reach
 * it, and the row would remain `'running'` forever in practice.
 *
 * Eligibility is the exact complement of `claimAgentRun`'s own excluded
 * running-lease case: `status = 'running' AND attempt_count >=
 * MAX_ATTEMPTS AND started_at < now() - CLAIM_LEASE_SECONDS`. These rows
 * are never claimable (never returned by `findClaimableAgentRuns`,
 * never won by `claimAgentRun`) — this function exists solely so a
 * future dispatcher can find them and call `terminalizeExhaustedAgentRun`
 * on each one, never to execute another attempt.
 *
 * Ordered by `started_at asc` (oldest-stuck-first) — deliberately
 * distinct from `findClaimableAgentRuns`' own `created_at asc`, since
 * this query's own relevant signal is how long a row has been stranded
 * in its current (expired) lease, not when it was originally submitted.
 */
/**
 * Milestone 4.2 (Architectural Correction) — inserts a brand-new
 * `agent_runs` row. Deliberately the ONLY function in this file that
 * creates a row rather than transitioning an existing one; it accepts
 * exactly `organization_id`/`agent_key`/`triggered_by`/`references` and
 * nothing else — `status`/`attempt_count`/`started_at`/`completed_at`/
 * `error`/`created_at` are never parameters here, so there is no
 * caller-reachable way to insert a row in any state other than the
 * schema's own defaults (`status = 'queued'`, `attempt_count = 1`,
 * everything else `null`/`now()`).
 *
 * NO PUBLIC HTTP ROUTE CALLS THIS FUNCTION IN M4.2 — the architectural
 * decision audit found no evidence-backed, non-speculative agent key to
 * expose a Staff-facing enqueue route against (`docs/03-Database-
 * Architecture.md` §2.4 explicitly discloses `agent_definitions` as
 * unbuilt "target design for Phase 4," and `docs/12-Implementation-
 * Milestones.md`'s own milestone title for M4.2 is "Queued Agent-
 * Execution Worker," not a Staff enqueue API). This function exists as
 * generic, trusted-application-caller queue-producer infrastructure —
 * the M4.2 scope this milestone's own name actually describes — for a
 * future Staff route (or any other internal producer) to call once a
 * real, supported agent key exists (M4.3/M4.4).
 *
 * `agentKey` is accepted as a plain string with NO validation at this
 * layer — this is a deliberate scope boundary, not an oversight. This
 * function performs neither identifier-shape validation nor supported-
 * persona validation; a future caller (Staff route or otherwise) is
 * responsible for whatever agent-key contract eventually governs which
 * keys are real, once one is designed with real evidence behind it. Do
 * NOT read the absence of a check here as this function "owning"
 * persona/key legitimacy — it does not, by design.
 *
 * `references` IS validated here via `validateAgentRunReferences`, not
 * merely trusted from the caller's own TypeScript type — a TypeScript
 * type is erased at runtime and provides no protection against a caller
 * that constructs (or `as`-casts) a malformed array directly. This is
 * what makes the "references/IDs only, never copied CRM content"
 * contract (the Step 1 migration's own binding column comment) hold for
 * every caller of this exported function, HTTP-mediated or not.
 *
 * Accepts an optional `existingClient` (via `runInClientOrTransaction`,
 * the same shared helper `packages/compliance`'s own mutation functions
 * already use) so a future transactional caller (e.g. an Idempotency-Key
 * reservation, once a route exists) can run this insert inside its own
 * transaction — identical wiring to `fileDataSubjectRequest`'s own
 * `existingClient` parameter.
 */
export async function enqueueAgentRun(
  ctx: RequestContext & { organizationId: string },
  input: { agentKey: string; triggeredBy: string; references: AgentRunReference[] },
  existingClient?: PoolClient,
): Promise<EnqueuedAgentRun> {
  const validatedReferences = validateAgentRunReferences(input.references);
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const result = await client.query<{ id: string; agent_key: string; status: EnqueuedAgentRun["status"] }>(
      `insert into public.agent_runs (organization_id, agent_key, triggered_by, input)
       values ($1, $2, $3, $4)
       returning id, agent_key, status`,
      [ctx.organizationId, input.agentKey, input.triggeredBy, JSON.stringify({ references: validatedReferences })],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("agent_runs insert returned no row — this should be unreachable.");
    }
    return { id: row.id, agentKey: row.agent_key, status: row.status };
  });
}

export async function findExhaustedAgentRuns(
  ctx: RequestContext & { organizationId: string },
  opts: { limit: number },
): Promise<string[]> {
  const limit = resolveDiscoveryLimit(opts.limit);
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<{ id: string }>(
      `select id
       from public.agent_runs
       where organization_id = $1
         and status = 'running'
         and attempt_count >= $2
         and started_at < now() - make_interval(secs => $3)
       order by started_at asc
       limit $4`,
      [ctx.organizationId, MAX_ATTEMPTS, CLAIM_LEASE_SECONDS, limit],
    );
    return result.rows.map((row) => row.id);
  });
}
