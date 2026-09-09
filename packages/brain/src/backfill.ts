import { createHash } from "node:crypto";
import { listContacts, listCompanies, listDeals } from "@ai-revenue-os/crm";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { projectContactProfile, projectCompanyProfile, projectDealProfile } from "./projector";
import { upsertEntityProfile, getSyncState, upsertSyncState } from "./repository";
import type { EntityType } from "./types";

/**
 * Milestone 4.1 Phase 2 backfill/bootstrap (Detailed Design §L, Final
 * Design Challenge §D confirms brain_sync_state's role here). Seeds an
 * initial Brain profile for every currently-ACTIVE contact/company/deal in
 * one organization — no schema change, no new table, no embeddings, no AI
 * call. Reuses the exact same projector + repository path as live
 * ingestion (never a second, divergent implementation), so a backfilled
 * profile is byte-identical in shape to an event-driven one.
 *
 * Only covers currently-active entities (list* functions already exclude
 * soft-deleted rows, matching the `.created`/`.updated` reconciliation
 * read path) — an entity that was ALREADY soft-deleted before Phase 2
 * ever ran will not be retroactively tombstoned by backfill. This is an
 * accepted, narrow bootstrap-only limitation: any FUTURE soft-delete of
 * that entity still tombstones it correctly via the live `.deleted` event
 * path (packages/brain/src/ingestion.ts) — backfill's job is only to seed
 * a starting point for currently-active data, not to reconstruct history.
 *
 * Idempotent and safe to re-run: upsertEntityProfile's own monotonic guard
 * (packages/brain/src/repository.ts) makes reprocessing an already-current
 * entity a harmless no-op, and the cursor only advances after a page's
 * writes have already committed, so a crash mid-run resumes from the last
 * successfully-processed page rather than restarting or double-processing
 * an unbounded backlog.
 */

const PAGE_SIZE = 50;

const SYNC_KEY: Record<EntityType, string> = {
  contact: "brain_backfill_contacts",
  company: "brain_backfill_companies",
  deal: "brain_backfill_deals",
};

export interface BackfillReport {
  entityType: EntityType;
  processed: number;
  profilesCreated: number;
  profilesUpdated: number;
  historyRowsWritten: number;
  cursor: string | null;
}

async function backfillContacts(ctx: RequestContext & { organizationId: string }): Promise<BackfillReport> {
  const syncKey = SYNC_KEY.contact;
  const report: BackfillReport = { entityType: "contact", processed: 0, profilesCreated: 0, profilesUpdated: 0, historyRowsWritten: 0, cursor: null };
  let cursor = (await getSyncState(ctx, syncKey))?.nextCursor ?? undefined;

  for (;;) {
    const page = await listContacts(ctx, { ...(cursor ? { cursor } : {}), limit: PAGE_SIZE });
    for (const contact of page.items) {
      const profile = projectContactProfile(contact, false);
      const result = await upsertEntityProfile(ctx, { entityType: "contact", entityId: contact.id, profile, sourceUpdatedAt: contact.updatedAt });
      report.processed += 1;
      if (result.status === "created") report.profilesCreated += 1;
      if (result.status === "updated") {
        report.profilesUpdated += 1;
        if (result.historyWritten) report.historyRowsWritten += 1;
      }
    }
    cursor = page.nextCursor ?? undefined;
    await upsertSyncState(ctx, syncKey, { nextCursor: cursor ?? null });
    report.cursor = cursor ?? null;
    if (!page.nextCursor) break;
  }

  return report;
}

async function backfillCompanies(ctx: RequestContext & { organizationId: string }): Promise<BackfillReport> {
  const syncKey = SYNC_KEY.company;
  const report: BackfillReport = { entityType: "company", processed: 0, profilesCreated: 0, profilesUpdated: 0, historyRowsWritten: 0, cursor: null };
  let cursor = (await getSyncState(ctx, syncKey))?.nextCursor ?? undefined;

  for (;;) {
    const page = await listCompanies(ctx, { ...(cursor ? { cursor } : {}), limit: PAGE_SIZE });
    for (const company of page.items) {
      const profile = projectCompanyProfile(company, false);
      const result = await upsertEntityProfile(ctx, { entityType: "company", entityId: company.id, profile, sourceUpdatedAt: company.updatedAt });
      report.processed += 1;
      if (result.status === "created") report.profilesCreated += 1;
      if (result.status === "updated") {
        report.profilesUpdated += 1;
        if (result.historyWritten) report.historyRowsWritten += 1;
      }
    }
    cursor = page.nextCursor ?? undefined;
    await upsertSyncState(ctx, syncKey, { nextCursor: cursor ?? null });
    report.cursor = cursor ?? null;
    if (!page.nextCursor) break;
  }

  return report;
}

async function backfillDeals(ctx: RequestContext & { organizationId: string }): Promise<BackfillReport> {
  const syncKey = SYNC_KEY.deal;
  const report: BackfillReport = { entityType: "deal", processed: 0, profilesCreated: 0, profilesUpdated: 0, historyRowsWritten: 0, cursor: null };
  let cursor = (await getSyncState(ctx, syncKey))?.nextCursor ?? undefined;

  for (;;) {
    const page = await listDeals(ctx, { ...(cursor ? { cursor } : {}), limit: PAGE_SIZE });
    for (const deal of page.items) {
      const profile = projectDealProfile(deal, false);
      const result = await upsertEntityProfile(ctx, { entityType: "deal", entityId: deal.id, profile, sourceUpdatedAt: deal.updatedAt });
      report.processed += 1;
      if (result.status === "created") report.profilesCreated += 1;
      if (result.status === "updated") {
        report.profilesUpdated += 1;
        if (result.historyWritten) report.historyRowsWritten += 1;
      }
    }
    cursor = page.nextCursor ?? undefined;
    await upsertSyncState(ctx, syncKey, { nextCursor: cursor ?? null });
    report.cursor = cursor ?? null;
    if (!page.nextCursor) break;
  }

  return report;
}

/** Runs all three entity-type backfills for one organization, sequentially, tenant-scoped throughout (every read/write goes through ctx.organizationId under withTenantContext/RLS). */
export async function bootstrapBrainForOrganization(ctx: RequestContext & { organizationId: string }): Promise<BackfillReport[]> {
  return [await backfillContacts(ctx), await backfillCompanies(ctx), await backfillDeals(ctx)];
}

/**
 * Milestone 4.1 Phase 3 — embedding-trigger backfill (Detailed Design
 * §O). Identifies which `brain_entity_profiles` rows need a (re-)embed:
 * no current `brain_embeddings` row at all, or the existing one's own
 * `source_version_at` is older than the profile's current `computed_at`.
 *
 * Does NOT generate a vector itself, and makes no external call — this
 * repository never calls an embedding provider (see `embeddings.ts`'s own
 * header comment). This function's only job is identification: its output
 * feeds the exact same trigger/write-back architecture the live dispatcher
 * path already uses (the `brain_embedding_trigger_*` `workflow_runs`-keyed
 * webhook consumers registered in `apps/web`) — wiring that a future,
 * app-layer caller performs, not this pure domain function.
 *
 * Pagination is keyset by `brain_entity_profiles.id` alone — a UUID, never
 * a timestamp — deliberately, to avoid reintroducing ANY variant of the
 * node-postgres millisecond-precision `timestamptz`-cursor class of bug
 * `packages/crm/src/pagination.ts` had to fix for Phase 2 (see that
 * module's own header comment for the full history): a UUID comparison
 * has no floating-precision loss to begin with, so there is no analogous
 * defect possible here by construction, not merely by care.
 */
const EMBEDDING_BACKFILL_PAGE_SIZE = 50;

const EMBEDDING_BACKFILL_SYNC_KEY: Record<EntityType, string> = {
  contact: "brain_embedding_backfill_contacts",
  company: "brain_embedding_backfill_companies",
  deal: "brain_embedding_backfill_deals",
};

export interface EmbeddingBackfillRef {
  entityType: EntityType;
  entityId: string;
  profileId: string;
  computedAt: string;
}

export interface EmbeddingBackfillReport {
  entityType: EntityType;
  scanned: number;
  needingEmbedding: EmbeddingBackfillRef[];
  cursor: string | null;
}

async function findProfilesNeedingEmbeddingForEntity(
  ctx: RequestContext & { organizationId: string },
  entityType: EntityType,
): Promise<EmbeddingBackfillReport> {
  const column = entityType === "contact" ? "contact_id" : entityType === "company" ? "company_id" : "deal_id";
  const syncKey = EMBEDDING_BACKFILL_SYNC_KEY[entityType];
  const report: EmbeddingBackfillReport = { entityType, scanned: 0, needingEmbedding: [], cursor: null };
  let cursor = (await getSyncState(ctx, syncKey))?.nextCursor ?? null;

  for (;;) {
    // One query per page, over EVERY profile in id order (not
    // pre-filtered) — needs_embedding is a computed column, not a WHERE
    // clause, so the cursor always advances over the full page regardless
    // of how many rows in it actually need embedding. A WHERE-filtered
    // query would leave the cursor stuck forever on a page where every
    // profile already has a current embedding.
    const rows = await withTenantContext(ctx, async (client) => {
      const r = await client.query<{ id: string; entity_id: string; computed_at: string; needs_embedding: boolean }>(
        `select ep.id, ep.${column} as entity_id, ep.computed_at,
                (be.id is null or be.source_version_at < ep.computed_at) as needs_embedding
         from public.brain_entity_profiles ep
         left join public.brain_embeddings be
           on be.organization_id = ep.organization_id and be.entity_profile_id = ep.id
         where ep.organization_id = $1
           and ep.entity_type = $2
           and ($3::uuid is null or ep.id > $3::uuid)
         order by ep.id asc
         limit $4`,
        [ctx.organizationId, entityType, cursor, EMBEDDING_BACKFILL_PAGE_SIZE],
      );
      return r.rows;
    });

    report.scanned += rows.length;
    for (const row of rows) {
      if (row.needs_embedding) {
        report.needingEmbedding.push({ entityType, entityId: row.entity_id, profileId: row.id, computedAt: row.computed_at });
      }
    }

    const lastId = rows[rows.length - 1]?.id ?? null;
    cursor = lastId ?? cursor;
    await upsertSyncState(ctx, syncKey, { nextCursor: cursor });
    report.cursor = cursor;

    if (rows.length < EMBEDDING_BACKFILL_PAGE_SIZE) {
      break;
    }
  }

  return report;
}

/** Runs the embedding-trigger identification pass for all three entity
 * types, sequentially, tenant-scoped throughout — the embedding-backfill
 * counterpart to `bootstrapBrainForOrganization` above. */
export async function findProfilesNeedingEmbedding(
  ctx: RequestContext & { organizationId: string },
): Promise<EmbeddingBackfillReport[]> {
  return [
    await findProfilesNeedingEmbeddingForEntity(ctx, "contact"),
    await findProfilesNeedingEmbeddingForEntity(ctx, "company"),
    await findProfilesNeedingEmbeddingForEntity(ctx, "deal"),
  ];
}

/**
 * Milestone 4.1 Phase 5 — Automated Embedding-Trigger Recovery.
 *
 * `findProfilesNeedingEmbedding` above is a ONE-SHOT, forward-only-cursor
 * sweep (Detailed Design §O) — correct for its own designed purpose (an
 * operator-run, eventually-terminating bootstrap pass over a large
 * pre-existing dataset), but structurally unsuited to being invoked
 * REPEATEDLY on a schedule: once its persistent `brain_sync_state` cursor
 * reaches the end of an organization's profile set, every later call
 * immediately returns empty (`ep.id > cursor` matches nothing) — it can
 * never rediscover a profile whose embedding became missing/stale AFTER
 * the cursor already passed it. This function is a deliberately SEPARATE,
 * narrower, REPEATABLE discovery query for exactly that periodic-recovery
 * use case — `findProfilesNeedingEmbedding`'s own accepted contract is
 * untouched, not reused, not modified.
 *
 * No persistent cursor at all: every call re-scans the SAME
 * `needs_embedding` condition (no current `brain_embeddings` row, or the
 * existing one's `source_version_at` older than the profile's current
 * `computed_at` — identical truth condition to the sweep above, just
 * evaluated fresh every time) and is capped per entity type
 * (`limitPerEntityType`, mirroring `packages/intelligence/src/
 * scoring.ts`'s own `RECOVERY_BATCH_SIZE = 10` precedent for exactly this
 * "bounded periodic recovery sweep" pattern).
 *
 * Ordering is `md5(profile id || now())`: DETERMINISTIC within any one
 * invocation (Postgres's own `now()` is fixed for the entire duration of
 * one statement/transaction, so a single call's own result order is
 * stable and reproducible), but genuinely RESHUFFLES on every SEPARATE
 * invocation (a different call has a different transaction, hence a
 * different `now()`, hence a different order) — this is the fairness
 * mechanism that replaces the (impossible, without a persistent cursor)
 * alternative of literal insertion-order pagination. An earlier draft of
 * this function truncated `now()` to the current UTC HOUR specifically to
 * make the ordering reproducible across near-simultaneous calls for
 * testing — live-reproduced during implementation as a genuine fairness
 * bug: within that same hour, `order by id asc limit N` and
 * `order by md5(id || hour) asc limit N` are BOTH exactly as
 * starvation-prone, since neither changes between calls until the hour
 * rolls over, which could leave a candidate beyond the cap waiting up to
 * ~59 minutes even under otherwise-healthy operation. Full-precision
 * `now()` closes this: every one of the (bounded, capped) per-invocation
 * cron ticks gets an independent shuffle, so a candidate beyond one
 * invocation's cap has a fresh, non-degenerate chance on the very next
 * invocation rather than waiting for an hour boundary. Uses a built-in
 * Postgres function only (no `pgcrypto` extension, no new dependency).
 *
 * Returns only entity/profile identity and the profile's current
 * `computedAt` — no vector content, no chunk text, nothing this function
 * doesn't already need for its own job. Makes no external call and holds
 * no provider credential, identical in spirit to
 * `findProfilesNeedingEmbedding` above — this repository still never
 * calls an embedding provider (`embeddings.ts`'s own header comment).
 */
const EMBEDDING_RECOVERY_LIMIT_PER_ENTITY_TYPE = 10;

export interface EmbeddingRecoveryCandidate {
  entityType: EntityType;
  entityId: string;
  profileId: string;
  computedAt: string;
}

async function findEmbeddingRecoveryCandidatesForEntity(
  ctx: RequestContext & { organizationId: string },
  entityType: EntityType,
  limit: number,
): Promise<EmbeddingRecoveryCandidate[]> {
  const column = entityType === "contact" ? "contact_id" : entityType === "company" ? "company_id" : "deal_id";
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<{ id: string; entity_id: string; computed_at: string }>(
      // `ep.computed_at::text` (not the bare `timestamptz` column): the
      // returned value is fed directly into deriveEmbeddingRecoveryEventId's
      // hash as this profile's version identity — node-pg's default
      // timestamptz parser returns a JS `Date` object, and template-literal
      // string coercion of a `Date` calls the locale/timezone-dependent
      // `Date.prototype.toString()`, not a stable ISO representation. An
      // explicit SQL-side text cast makes `computedAt` a genuine,
      // deterministic string at runtime (matching its own TypeScript type
      // honestly), independent of the Node process's own locale/timezone
      // settings — found and fixed while adding the eventual-retry
      // correction, whose own regression test exposed this by needing to
      // independently re-derive the same event id a second time.
      `select ep.id, ep.${column} as entity_id, ep.computed_at::text as computed_at
       from public.brain_entity_profiles ep
       left join public.brain_embeddings be
         on be.organization_id = ep.organization_id and be.entity_profile_id = ep.id
       where ep.organization_id = $1
         and ep.entity_type = $2
         and (be.id is null or be.source_version_at < ep.computed_at)
       order by md5(ep.id::text || now()::text) asc
       limit $3`,
      [ctx.organizationId, entityType, limit],
    );
    return r.rows.map((row) => ({ entityType, entityId: row.entity_id, profileId: row.id, computedAt: row.computed_at }));
  });
}

/** Runs the recovery-candidate discovery pass for all three entity types,
 * sequentially, tenant-scoped throughout. Safe to call on every recovery
 * invocation — no state to advance, no state to corrupt if a call is
 * skipped or repeated. */
export async function findEmbeddingRecoveryCandidates(
  ctx: RequestContext & { organizationId: string },
  opts: { limitPerEntityType?: number } = {},
): Promise<EmbeddingRecoveryCandidate[]> {
  const limit = opts.limitPerEntityType ?? EMBEDDING_RECOVERY_LIMIT_PER_ENTITY_TYPE;
  return [
    ...(await findEmbeddingRecoveryCandidatesForEntity(ctx, "contact", limit)),
    ...(await findEmbeddingRecoveryCandidatesForEntity(ctx, "company", limit)),
    ...(await findEmbeddingRecoveryCandidatesForEntity(ctx, "deal", limit)),
  ];
}

/**
 * Deterministic recovery-attempt identity for `workflow_runs.source_event_id`
 * (a `uuid` column — free text is not accepted, so an arbitrary composite
 * key cannot be stored directly; this derives a stable, valid UUID from
 * one instead). sha256 of `{profileId}:{computedAt}`, first 16 bytes
 * formatted as UUID syntax — `node:crypto` only, no dependency added, not
 * claiming true RFC 4122 v5 compliance (Postgres's `uuid` column only
 * requires valid 128-bit hex-and-hyphen syntax, not a specific version).
 *
 * This identity is what makes recovery both idempotent AND correctly
 * re-eligible on a real state change, in combination with
 * `claimEmbeddingRecoveryAttempt` (`repository.ts`) — the Phase-5-
 * specific claim function this recovery path actually calls, NOT the
 * generic `claimBrainProjectionRun` (that function remains reserved for
 * Phase 2/3/lead-scoring's own synchronous consumers, where a
 * `'succeeded'` row is correctly permanent; see `claimEmbeddingRecoveryAttempt`'s
 * own header comment for why Phase 5's asynchronous, webhook-triggered
 * consumer needs different semantics). `completeBrainProjectionRun` IS
 * reused unchanged by this path, to record each attempt's own outcome:
 * - SAME profile, SAME `computedAt` (the profile has not been
 *   recomputed since the last recovery attempt) -> SAME derived id ->
 *   `claimEmbeddingRecoveryAttempt`'s own reclaim guard blocks an
 *   immediate re-claim of an already-`'succeeded'` attempt — no
 *   duplicate notification for a state already (recently) requested.
 *   This block is NOT permanent, unlike `claimBrainProjectionRun`'s own
 *   guard: an HTTP 2xx from n8n only proves the webhook was accepted,
 *   never that the embedding actually materialized, so
 *   `claimEmbeddingRecoveryAttempt` also reclaims a `'succeeded'` row
 *   once its own `completed_at` is older than
 *   `EMBEDDING_RECOVERY_COOLDOWN_SECONDS` (900s) — this is the fix for
 *   the Final Implementation Acceptance Audit's own HIGH finding that a
 *   successful webhook acknowledgement had incorrectly been treated as
 *   permanent proof of materialization.
 * - The profile is later recomputed (a NEW `computedAt`) -> a DIFFERENT
 *   derived id -> no existing `workflow_runs` row for that new id -> a
 *   fresh claim succeeds immediately, even though the OLD state's
 *   attempt is still marked `'succeeded'` and correctly stays untouched
 *   (independent of, and not blocked by, the old state's own cooldown).
 */
export function deriveEmbeddingRecoveryEventId(profileId: string, computedAt: string): string {
  const hash = createHash("sha256").update(`${profileId}:${computedAt}`, "utf8").digest();
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
