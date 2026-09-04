import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { canonicalizeProfile } from "./projector";
import type { CanonicalProfile, EntityType } from "./types";

/**
 * Milestone 4.1 Phase 2 (Detailed Design §I/§J/§K, Final Design Challenge
 * §A/§D). All Brain-table reads/writes go through @ai-revenue-os/database's
 * withTenantContext — packages/brain never manages its own connection or
 * issues SQL outside RLS, the same convention every other domain package
 * (crm, intelligence, compliance) already follows.
 */

const ENTITY_ID_COLUMN: Record<EntityType, "contact_id" | "company_id" | "deal_id"> = {
  contact: "contact_id",
  company: "company_id",
  deal: "deal_id",
};

/**
 * Bounded per sweep/claim, same reasoning as CLAIM_LEASE_SECONDS in
 * packages/intelligence/src/scoring.ts — a still-'running' workflow_runs
 * row is only reclaimable once it is stale, matching event_deliveries'
 * own time-based lease condition.
 */
const CLAIM_LEASE_SECONDS = 120;

export const BRAIN_PROJECTION_WORKFLOW_KEY: Record<EntityType, string> = {
  contact: "brain_projection_contact",
  company: "brain_projection_company",
  deal: "brain_projection_deal",
};

export type UpsertEntityProfileResult =
  | { status: "created"; profileId: string; historyWritten: false }
  | { status: "updated"; profileId: string; historyWritten: boolean }
  | { status: "stale"; profileId: string; historyWritten: false };

export interface UpsertEntityProfileInput {
  entityType: EntityType;
  entityId: string;
  profile: CanonicalProfile;
  /**
   * The SOURCE CRM row's own `updated_at` (captured at reconciliation-read
   * time) — NEVER wall-clock write-completion time. Final Design Challenge
   * §A: using write-completion time as the freshness clock lets a worker
   * that read STALE data but happens to finish LAST overwrite a worker
   * that read FRESH data but finished first. Using the source row's own
   * `updated_at` — server-authoritative, monotonic per row — ties the
   * guard to which DATA was read, not to which worker's write commits
   * last, making the final stored profile correct regardless of dispatch
   * ordering or completion-time inversion.
   */
  sourceUpdatedAt: string;
}

interface ProfileRow {
  id: string;
  profile: CanonicalProfile;
  computed_at: string;
}

/**
 * Bounded reconciliation attempts for the first-insert race below — proven
 * sufficient, not merely "usually enough" (see that branch's own comment
 * for the exact argument), so this is not a general-purpose retry-count
 * tuning knob.
 */
const MAX_UPSERT_ATTEMPTS = 2;

/**
 * Idempotent, concurrency-safe upsert of one entity's current canonical
 * profile, plus conditional history-row insertion (Detailed Design §I).
 *
 * Concurrency model (Final Design Challenge §A): `SELECT ... FOR UPDATE`
 * locks any EXISTING row for this entity for the duration of this
 * transaction, so two concurrent reconciliations for the SAME entity are
 * serialized by Postgres itself — the second waits for the first to
 * commit, then re-reads the now-current row and re-evaluates the
 * freshness guard against it. This is simpler than an optimistic
 * `ON CONFLICT ... WHERE` guard and gives the same correctness with less
 * reasoning required: no lost-update window, no need to reconstruct "the
 * previous value" from a RETURNING clause that can't express it for an
 * UPSERT.
 *
 * `sourceUpdatedAt >= stored.computed_at` (not strict `>`): a reconciliation
 * carrying data at least as fresh as what's stored is always allowed to
 * write (a redelivered event that re-reads the identical current state is
 * a harmless, idempotent re-write, never rejected). Only a reconciliation
 * carrying STRICTLY STALER data (`sourceUpdatedAt < stored.computed_at`)
 * is rejected as `stale`. The narrow theoretical case of two updates to
 * the exact same row landing on the identical `updated_at` microsecond
 * with DIFFERENT content is an accepted, documented LOW limitation
 * (Final Design Challenge §A) — resolved by last-write-wins under the
 * lock, never by a thrown error.
 *
 * History (Detailed Design §I): a history row is written only when the
 * canonical content genuinely changed (content-comparison, gated by
 * `canonicalizeProfile`, immune to jsonb key-reordering — see that
 * function's own comment) — never on every reconciliation, never for a
 * duplicate/retry/unrelated-field/backfill-rerun that converges on
 * identical content. The history row captures the IMMEDIATELY PREVIOUS
 * snapshot (the row's content before this write), not the new one.
 * Never written on first creation — there is no previous state to record.
 *
 * First-insert race (M4.1 Phase 2 Final Implementation Acceptance Audit
 * finding, BLOCKER, corrected here): `SELECT ... FOR UPDATE` cannot lock a
 * row that does not exist yet, so two concurrent FIRST-TIME reconciliations
 * for the same entity can both observe "no row" and both attempt
 * `INSERT ... ON CONFLICT DO NOTHING`. The loser's own INSERT returns zero
 * rows — but that outcome is only ever reported by Postgres AFTER the
 * winning transaction's INSERT has already committed: a conflicting INSERT
 * blocks on the winner's row-level lock until the winner resolves
 * (commits or rolls back), so "0 rows returned" is itself proof the
 * winner is now durably visible. The loop below therefore does not return
 * a bare "stale" result on a lost first-insert race — it loops back to
 * re-run the existing-row branch, which is now GUARANTEED to find the
 * winner's row (it cannot have been un-inserted in the interim: no
 * DELETE grant exists on this table for `authenticated`, so nothing this
 * transaction's own role can do removes it, and a concurrent hard-erasure
 * cascade — the only thing that could — is an entirely separate,
 * already-tested concern handled upstream by the caller's own
 * entity_not_found path, not by this function). This makes
 * MAX_UPSERT_ATTEMPTS = 2 PROVABLY sufficient, for any number of
 * concurrently racing writers, not just two: attempt 1 either takes the
 * existing-row branch directly or loses a first-insert race; if it loses,
 * attempt 2's own existing-row branch cannot itself "find no row" a
 * second time, so it always returns. The loop is bounded, not unbounded,
 * and the trailing `throw` after it is unreachable by this same argument.
 */
export async function upsertEntityProfile(
  ctx: RequestContext & { organizationId: string },
  input: UpsertEntityProfileInput,
): Promise<UpsertEntityProfileResult> {
  const column = ENTITY_ID_COLUMN[input.entityType];
  const newCanonical = canonicalizeProfile(input.profile);

  return withTenantContext(ctx, async (client) => {
    for (let attempt = 0; attempt < MAX_UPSERT_ATTEMPTS; attempt++) {
      const existing = await client.query<ProfileRow>(
        `select id, profile, computed_at from public.brain_entity_profiles
         where organization_id = $1 and ${column} = $2
         for update`,
        [ctx.organizationId, input.entityId],
      );
      const existingRow = existing.rows[0];

      if (existingRow) {
        if (new Date(input.sourceUpdatedAt).getTime() < new Date(existingRow.computed_at).getTime()) {
          return { status: "stale", profileId: existingRow.id, historyWritten: false };
        }

        const previousCanonical = canonicalizeProfile(existingRow.profile);
        const contentChanged = previousCanonical !== newCanonical;

        await client.query(
          `update public.brain_entity_profiles set profile = $1::jsonb, computed_at = $2
           where id = $3`,
          [JSON.stringify(input.profile), input.sourceUpdatedAt, existingRow.id],
        );

        if (contentChanged) {
          await client.query(
            `insert into public.brain_entity_profile_history (organization_id, entity_profile_id, profile, computed_at)
             values ($1, $2, $3::jsonb, $4)`,
            [ctx.organizationId, existingRow.id, JSON.stringify(existingRow.profile), existingRow.computed_at],
          );
        }

        return { status: "updated", profileId: existingRow.id, historyWritten: contentChanged };
      }

      // No existing row under this lock — attempt a fresh insert. The
      // conflict target must exactly match one of the three PARTIAL
      // unique indexes Phase 1 created (brain_entity_profiles_contact_uidx
      // et al., each `where <col> is not null`) — Postgres only infers a
      // partial index as the arbiter when the ON CONFLICT clause repeats
      // its own predicate verbatim; a plain `(organization_id, ${column})`
      // target with no WHERE would fail to infer any arbiter at all, since
      // no non-partial unique constraint exists on this table.
      const inserted = await client.query<{ id: string }>(
        `insert into public.brain_entity_profiles (organization_id, entity_type, ${column}, profile, computed_at)
         values ($1, $2, $3, $4::jsonb, $5)
         on conflict (organization_id, ${column}) where ${column} is not null do nothing
         returning id`,
        [ctx.organizationId, input.entityType, input.entityId, JSON.stringify(input.profile), input.sourceUpdatedAt],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow) {
        return { status: "created", profileId: insertedRow.id, historyWritten: false };
      }
      // Lost the first-insert race — loop back to reconcile against the
      // now-durably-existing winner via the existing-row branch above
      // (see this function's own header comment for why this is
      // guaranteed to succeed on the very next iteration).
    }

    // Unreachable: MAX_UPSERT_ATTEMPTS = 2 is proven sufficient above.
    // Present only so this function's control flow is total under
    // TypeScript's own analysis.
    throw new Error(
      `upsertEntityProfile: first-insert reconciliation did not converge within ${MAX_UPSERT_ATTEMPTS} attempts for entityType=${input.entityType} entityId=${input.entityId} — this should be unreachable.`,
    );
  });
}

/**
 * Layer 1 idempotency (Detailed Design §J, Final Design Challenge §D):
 * reuses workflow_runs' established claim-lease pattern verbatim from
 * recalculateContactScoreForEvent (packages/intelligence/src/scoring.ts).
 * A redelivered/duplicate/concurrently-overlapping trigger for the exact
 * same (organizationId, workflowKey, sourceEventId) triple is a clean
 * no-op at this layer — the caller never reaches any read of CRM state or
 * any Brain-table write.
 */
export async function claimBrainProjectionRun(
  ctx: RequestContext & { organizationId: string },
  input: { workflowKey: string; sourceEventId: string; contactId?: string },
): Promise<boolean> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into public.workflow_runs (organization_id, workflow_key, source_event_id, contact_id, status, started_at)
       values ($1, $2, $3, $4, 'running', now())
       on conflict (organization_id, workflow_key, source_event_id) do update set
         status = 'running',
         started_at = now(),
         contact_id = excluded.contact_id,
         attempt_count = public.workflow_runs.attempt_count + 1
       where public.workflow_runs.status = 'failed'
          or (public.workflow_runs.status = 'running' and public.workflow_runs.started_at < now() - make_interval(secs => $5))
       returning id`,
      [ctx.organizationId, input.workflowKey, input.sourceEventId, input.contactId ?? null, CLAIM_LEASE_SECONDS],
    );
    return result.rows.length > 0;
  });
}

/** Completion bookkeeping — best-effort observability, same discipline as
 * recalculateContactScoreForEvent's own completion write. Guarded so this
 * can never downgrade an already-'succeeded' run. */
export async function completeBrainProjectionRun(
  ctx: RequestContext & { organizationId: string },
  input: { workflowKey: string; sourceEventId: string; status: "succeeded" | "failed"; error?: string },
): Promise<void> {
  await withTenantContext(ctx, async (client) => {
    await client.query(
      `update public.workflow_runs
       set status = $4, completed_at = now(), error = $5
       where organization_id = $1 and workflow_key = $2 and source_event_id = $3 and status <> 'succeeded'`,
      [ctx.organizationId, input.workflowKey, input.sourceEventId, input.status, input.error ?? null],
    );
  });
}

export interface SyncStateCursor {
  nextCursor: string | null;
}

/** brain_sync_state — backfill/bootstrap bookkeeping ONLY (Detailed Design
 * §K, Final Design Challenge §D confirms no other role for this table in
 * Phase 2). Never consulted or written by the real-time event-consumer
 * path. */
export async function getSyncState(
  ctx: RequestContext & { organizationId: string },
  syncKey: string,
): Promise<SyncStateCursor | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<{ cursor: SyncStateCursor }>(
      `select cursor from public.brain_sync_state where organization_id = $1 and sync_key = $2`,
      [ctx.organizationId, syncKey],
    );
    return r.rows[0]?.cursor ?? null;
  });
}

export async function upsertSyncState(
  ctx: RequestContext & { organizationId: string },
  syncKey: string,
  cursor: SyncStateCursor,
): Promise<void> {
  await withTenantContext(ctx, async (client) => {
    await client.query(
      `insert into public.brain_sync_state (organization_id, sync_key, cursor, last_synced_at, updated_at)
       values ($1, $2, $3::jsonb, now(), now())
       on conflict (organization_id, sync_key) do update set
         cursor = excluded.cursor,
         last_synced_at = excluded.last_synced_at,
         updated_at = excluded.updated_at`,
      [ctx.organizationId, syncKey, JSON.stringify(cursor)],
    );
  });
}
