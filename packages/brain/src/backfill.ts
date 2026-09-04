import { listContacts, listCompanies, listDeals } from "@ai-revenue-os/crm";
import type { RequestContext } from "@ai-revenue-os/database";
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
