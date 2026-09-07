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
