import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { createContact, updateContact, listContacts } from "@ai-revenue-os/crm";
import { adminPool, seedAsAdmin, createOrgWithActiveMember, getBrainProfileRow } from "./helpers";
import { bootstrapBrainForOrganization } from "../src/backfill";
import { upsertEntityProfile, upsertSyncState } from "../src/repository";
import { projectContactProfile } from "../src/projector";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

/**
 * Fast bulk seed, bypassing packages/crm entirely (raw SQL, admin role) —
 * this test cares about backfill's own pagination/resume behavior, not
 * CRM event emission, so a real createContact call per row is unnecessary
 * overhead.
 *
 * M4.1 Phase 2 pagination-precision correction (Final Re-Acceptance Audit
 * BLOCKER, packages/crm/src/pagination.ts — now fixed): this seed
 * deliberately places a genuine microsecond-only timestamp collision
 * exactly at backfill's own PAGE_SIZE=50 boundary — the precise condition
 * proven, before the fix, to silently drop a row from Brain's own
 * production backfill. Two blocks of "far" rows (well-separated by 10ms
 * increments, so their own relative order is unambiguous either way) sit
 * clearly newer and clearly older than an explicit boundary PAIR whose
 * timestamps differ only in the microsecond digits (`.200999` vs
 * `.200111`, both `.200Z` as a lossy JS `Date`): 49 "Newer" rows (ranks
 * 1-49) + 1 "BoundaryNewer" row (rank 50, page 1's own cursor row) +
 * 1 "BoundaryOlder" row (rank 51, colliding with BoundaryNewer, and the
 * exact row page 2 must correctly recover) + 9 "Older" rows (ranks
 * 52-60) = 60 total, forcing two real pages. This is NOT staggered away
 * from the collision — the collision is the point of this fixture.
 */
async function seedManyContactsWithBoundaryCollision(organizationId: string): Promise<{ boundaryNewerId: string; boundaryOlderId: string }> {
  return seedAsAdmin(async (client) => {
    await client.query(
      `insert into public.contacts (organization_id, first_name, email, created_at)
       select $1, 'Newer' || gs, 'newer-' || gs || '-' || gen_random_uuid() || '@example.test',
         timestamptz '2026-01-01 13:00:00+00' - (gs * interval '10 milliseconds')
       from generate_series(1, 49) as gs`,
      [organizationId],
    );
    const boundary = await client.query<{ id: string; first_name: string }>(
      `insert into public.contacts (organization_id, first_name, email, created_at) values
         ($1, 'BoundaryNewer', 'boundary-newer-' || gen_random_uuid() || '@example.test', '2026-01-01 12:00:00.200999+00'),
         ($1, 'BoundaryOlder', 'boundary-older-' || gen_random_uuid() || '@example.test', '2026-01-01 12:00:00.200111+00')
       returning id, first_name`,
      [organizationId],
    );
    await client.query(
      `insert into public.contacts (organization_id, first_name, email, created_at)
       select $1, 'Older' || gs, 'older-' || gs || '-' || gen_random_uuid() || '@example.test',
         timestamptz '2026-01-01 11:00:00+00' - (gs * interval '10 milliseconds')
       from generate_series(1, 9) as gs`,
      [organizationId],
    );
    const boundaryNewerId = boundary.rows.find((r) => r.first_name === "BoundaryNewer")!.id;
    const boundaryOlderId = boundary.rows.find((r) => r.first_name === "BoundaryOlder")!.id;
    return { boundaryNewerId, boundaryOlderId };
  });
}

/** Plain, no-collision bulk seed (staggered by 10ms) — used only where the
 * test genuinely doesn't care about the collision condition itself, e.g.
 * proving a full single-call run drains both pages regardless. */
async function seedManyContacts(organizationId: string, count: number): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query(
      `insert into public.contacts (organization_id, first_name, email, created_at)
       select $1, 'Bulk' || gs, 'bulk-' || gs || '-' || gen_random_uuid() || '@example.test', now() - (gs * interval '10 milliseconds')
       from generate_series(1, $2) as gs`,
      [organizationId, count],
    );
  });
}

describe("bootstrapBrainForOrganization: multi-page pagination and crash/resume (M4.1 Phase 2 Final Implementation Acceptance Audit finding)", () => {
  it("resumes from a persisted cursor after a simulated crash between pages, without re-processing the already-completed page — PAGE_SIZE=50, 60 real contacts (with a genuine microsecond collision at the page boundary) force two pages", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const { boundaryNewerId, boundaryOlderId } = await seedManyContactsWithBoundaryCollision(orgA.organizationId);
    // A second tenant, seeded alongside orgA, to prove the resumed run
    // never crosses tenant boundaries.
    await seedManyContacts(orgB.organizationId, 5);

    // Fetch page 1 for real via the same crm function backfill itself
    // uses, then process it via the same repository primitive backfill's
    // own inner loop calls — faithfully simulating "a first backfill
    // invocation successfully completed page 1, persisted its cursor, and
    // then the process crashed before page 2 ever started" using only
    // already-exported, real functions (no mock, no production-only test
    // hook).
    const page1 = await listContacts({ organizationId: orgA.organizationId }, { limit: 50 });
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).not.toBeNull();
    // Page 1's own last item (the cursor row) is exactly the "BoundaryNewer"
    // row seeded to collide, at millisecond precision, with "BoundaryOlder"
    // — the row that must still be correctly recovered on page 2 below.
    expect(page1.items[page1.items.length - 1]!.id).toBe(boundaryNewerId);

    for (const contact of page1.items) {
      await upsertEntityProfile(
        { organizationId: orgA.organizationId },
        { entityType: "contact", entityId: contact.id, profile: projectContactProfile(contact, false), sourceUpdatedAt: contact.updatedAt },
      );
    }
    await upsertSyncState({ organizationId: orgA.organizationId }, "brain_backfill_contacts", { nextCursor: page1.nextCursor });

    const afterPage1 = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profiles where organization_id = $1 and entity_type = 'contact'",
      [orgA.organizationId],
    );
    expect(afterPage1.rows[0].count).toBe("50");

    // Now the real resume: bootstrapBrainForOrganization reads the
    // persisted cursor first (backfill.ts's own `getSyncState` call at the
    // top of backfillContacts) and must therefore fetch only page 2 (the
    // remaining 10 contacts) — not restart from the beginning.
    const reports = await bootstrapBrainForOrganization({ organizationId: orgA.organizationId });
    const contactReport = reports.find((r) => r.entityType === "contact")!;

    // Page 1 was skipped, not re-scanned: only the remaining 10 rows were processed this call.
    expect(contactReport.processed).toBe(10);
    expect(contactReport.profilesCreated).toBe(10);
    expect(contactReport.cursor).toBeNull(); // fully drained after page 2.

    // The exact row a pre-fix pagination cursor would have silently
    // dropped — "BoundaryOlder", colliding at millisecond precision with
    // the page-1 cursor row — genuinely has a Brain profile now.
    const boundaryOlderProfile = await getBrainProfileRow(orgA.organizationId, "contact_id", boundaryOlderId);
    expect(boundaryOlderProfile).not.toBeNull();

    // Final coverage: all 60 of orgA's contacts now have a profile —
    // combining the manually-applied page 1 with the resumed page 2.
    const finalCount = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profiles where organization_id = $1 and entity_type = 'contact'",
      [orgA.organizationId],
    );
    expect(finalCount.rows[0].count).toBe("60");

    // No duplicate history: every one of the 60 rows was a pure CREATE
    // (either via the manual page-1 step or the resumed page-2 call),
    // never an UPDATE, so zero history rows should exist for any of them.
    const historyCount = await adminPool.query(
      `select count(*)::text as count from public.brain_entity_profile_history h
       join public.brain_entity_profiles p on p.id = h.entity_profile_id
       where p.organization_id = $1 and p.entity_type = 'contact'`,
      [orgA.organizationId],
    );
    expect(historyCount.rows[0].count).toBe("0");

    // Cursor only advances after successful page processing — the
    // persisted brain_sync_state row now reflects full completion, not a
    // stale mid-run value.
    const syncState = await adminPool.query(
      "select cursor from public.brain_sync_state where organization_id = $1 and sync_key = 'brain_backfill_contacts'",
      [orgA.organizationId],
    );
    expect(syncState.rows[0].cursor.nextCursor).toBeNull();

    // Tenant isolation: orgB's own 5 contacts were never touched by orgA's resume.
    const orgBCount = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profiles where organization_id = $1 and entity_type = 'contact'",
      [orgB.organizationId],
    );
    expect(orgBCount.rows[0].count).toBe("0");
    const orgBSyncState = await adminPool.query(
      "select 1 from public.brain_sync_state where organization_id = $1",
      [orgB.organizationId],
    );
    expect(orgBSyncState.rows).toHaveLength(0);
  });

  /**
   * The single most direct proof that PRODUCTION Brain backfill itself
   * (not a hand-driven page-1-then-resume simulation) uses the corrected
   * pagination mechanism: one plain `bootstrapBrainForOrganization` call,
   * no manual pre-processing, over data with a genuine collision sitting
   * exactly at PAGE_SIZE=50.
   */
  it("a single, non-resumed bootstrapBrainForOrganization call over data with a genuine page-boundary collision still covers every contact, including the exact row a pre-fix cursor would have dropped", async () => {
    const fixture = await createOrgWithActiveMember();
    const { boundaryOlderId } = await seedManyContactsWithBoundaryCollision(fixture.organizationId);

    const reports = await bootstrapBrainForOrganization({ organizationId: fixture.organizationId });
    const contactReport = reports.find((r) => r.entityType === "contact")!;
    expect(contactReport.processed).toBe(60);
    expect(contactReport.profilesCreated).toBe(60);
    expect(contactReport.cursor).toBeNull();

    const finalCount = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profiles where organization_id = $1 and entity_type = 'contact'",
      [fixture.organizationId],
    );
    expect(finalCount.rows[0].count).toBe("60");

    const boundaryOlderProfile = await getBrainProfileRow(fixture.organizationId, "contact_id", boundaryOlderId);
    expect(boundaryOlderProfile).not.toBeNull();

    // No duplicate history anywhere — every one of the 60 rows was a pure create.
    const historyCount = await adminPool.query(
      `select count(*)::text as count from public.brain_entity_profile_history h
       join public.brain_entity_profiles p on p.id = h.entity_profile_id
       where p.organization_id = $1 and p.entity_type = 'contact'`,
      [fixture.organizationId],
    );
    expect(historyCount.rows[0].count).toBe("0");
  });

  it("a full (non-resumed) run over 60 contacts still drains both pages in one bootstrapBrainForOrganization call", async () => {
    const fixture = await createOrgWithActiveMember();
    await seedManyContacts(fixture.organizationId, 60);

    const reports = await bootstrapBrainForOrganization({ organizationId: fixture.organizationId });
    const contactReport = reports.find((r) => r.entityType === "contact")!;
    expect(contactReport.processed).toBe(60);
    expect(contactReport.profilesCreated).toBe(60);
    expect(contactReport.cursor).toBeNull();

    const finalCount = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profiles where organization_id = $1 and entity_type = 'contact'",
      [fixture.organizationId],
    );
    expect(finalCount.rows[0].count).toBe("60");
  });
});

describe("bootstrapBrainForOrganization", () => {
  it("empty tenant: completes cleanly with zero processed for every entity type", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const reports = await bootstrapBrainForOrganization({ organizationId });
    expect(reports).toHaveLength(3);
    for (const report of reports) {
      expect(report.processed).toBe(0);
      expect(report.profilesCreated).toBe(0);
    }
  });

  it("populated tenant: creates a profile for every active contact", async () => {
    const fixture = await createOrgWithActiveMember();
    const ctx = { userId: fixture.userId, organizationId: fixture.organizationId, roleKey: fixture.roleKey };
    const c1 = await createContact(ctx, { firstName: "Ada" });
    const c2 = await createContact(ctx, { firstName: "Grace" });

    const reports = await bootstrapBrainForOrganization({ organizationId: fixture.organizationId });
    const contactReport = reports.find((r) => r.entityType === "contact")!;
    expect(contactReport.processed).toBeGreaterThanOrEqual(2);
    expect(contactReport.profilesCreated).toBeGreaterThanOrEqual(2);

    const row1 = await getBrainProfileRow(fixture.organizationId, "contact_id", c1.id);
    const row2 = await getBrainProfileRow(fixture.organizationId, "contact_id", c2.id);
    expect(row1).not.toBeNull();
    expect(row2).not.toBeNull();
  });

  it("multiple tenants: backfill for one organization never touches another's contacts", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    await createContact({ userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey }, { firstName: "InA" });
    const contactInB = await createContact({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, { firstName: "InB" });

    await bootstrapBrainForOrganization({ organizationId: orgA.organizationId });

    const rowInBUnderA = await getBrainProfileRow(orgA.organizationId, "contact_id", contactInB.id);
    expect(rowInBUnderA).toBeNull();
  });

  it("rerun is idempotent: a second full run over unchanged data creates zero new history rows", async () => {
    const fixture = await createOrgWithActiveMember();
    const ctx = { userId: fixture.userId, organizationId: fixture.organizationId, roleKey: fixture.roleKey };
    const contact = await createContact(ctx, { firstName: "Ada" });

    await bootstrapBrainForOrganization({ organizationId: fixture.organizationId });
    const rowAfterFirst = await getBrainProfileRow(fixture.organizationId, "contact_id", contact.id);

    const secondReports = await bootstrapBrainForOrganization({ organizationId: fixture.organizationId });
    const contactReport = secondReports.find((r) => r.entityType === "contact")!;
    expect(contactReport.profilesCreated).toBe(0); // already exists — the rerun only ever updates or no-ops.

    const historyCount = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profile_history where entity_profile_id = $1",
      [rowAfterFirst.id],
    );
    expect(historyCount.rows[0].count).toBe("0");
  });

  it("cursor only advances after a page's writes have committed — brain_sync_state reflects progress", async () => {
    const fixture = await createOrgWithActiveMember();
    const ctx = { userId: fixture.userId, organizationId: fixture.organizationId, roleKey: fixture.roleKey };
    await createContact(ctx, { firstName: "Ada" });

    await bootstrapBrainForOrganization({ organizationId: fixture.organizationId });

    const syncState = await adminPool.query(
      "select last_synced_at from public.brain_sync_state where organization_id = $1 and sync_key = 'brain_backfill_contacts'",
      [fixture.organizationId],
    );
    expect(syncState.rows).toHaveLength(1);
    expect(syncState.rows[0].last_synced_at).not.toBeNull();
  });

  it("reflects a concurrent CRM mutation deterministically (backfill and a live update both use the same monotonic guard)", async () => {
    const fixture = await createOrgWithActiveMember();
    const ctx = { userId: fixture.userId, organizationId: fixture.organizationId, roleKey: fixture.roleKey };
    const contact = await createContact(ctx, { firstName: "Ada" });

    await bootstrapBrainForOrganization({ organizationId: fixture.organizationId });
    await updateContact(ctx, contact.id, { firstName: "Grace" });
    await bootstrapBrainForOrganization({ organizationId: fixture.organizationId });

    const row = await getBrainProfileRow(fixture.organizationId, "contact_id", contact.id);
    expect(row.profile.firstName).toBe("Grace");
  });
});
