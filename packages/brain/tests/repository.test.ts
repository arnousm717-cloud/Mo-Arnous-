import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrgWithActiveMember, seedContact, getBrainProfileRow, countBrainHistoryRows } from "./helpers";
import { upsertEntityProfile, claimBrainProjectionRun, completeBrainProjectionRun } from "../src/repository";
import type { CanonicalContactProfile } from "../src/types";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

function contactProfile(overrides: Partial<CanonicalContactProfile> = {}): CanonicalContactProfile {
  return {
    profileVersion: 1,
    entityType: "contact",
    firstName: "Ada",
    lastName: null,
    email: null,
    phone: null,
    jobTitle: null,
    linkedinUrl: null,
    lifecycleStage: null,
    companyId: null,
    ownerId: null,
    isDeleted: false,
    ...overrides,
  };
}

describe("upsertEntityProfile: create + update + history", () => {
  it("creates a profile with no history row", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    const result = await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile(), sourceUpdatedAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(result.status).toBe("created");
    expect(result.historyWritten).toBe(false);

    const row = await getBrainProfileRow(organizationId, "contact_id", contactId);
    expect(row).not.toBeNull();
    expect(await countBrainHistoryRows(row.id)).toBe(0);
  });

  it("writes exactly one history row for a genuine content change", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Ada" }), sourceUpdatedAt: "2026-01-01T00:00:00.000Z" },
    );
    const second = await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Grace" }), sourceUpdatedAt: "2026-01-02T00:00:00.000Z" },
    );
    expect(second.status).toBe("updated");
    expect(second.historyWritten).toBe(true);

    const row = await getBrainProfileRow(organizationId, "contact_id", contactId);
    expect(row.profile.firstName).toBe("Grace");
    expect(await countBrainHistoryRows(row.id)).toBe(1);
  });

  it("writes zero additional history rows for an unchanged reconciliation (duplicate/retry)", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Ada" }), sourceUpdatedAt: "2026-01-01T00:00:00.000Z" },
    );
    // Same content, same timestamp — a redelivered event re-reading identical current state.
    const repeat = await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Ada" }), sourceUpdatedAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(repeat.historyWritten).toBe(false);
    const row = await getBrainProfileRow(organizationId, "contact_id", contactId);
    expect(await countBrainHistoryRows(row.id)).toBe(0);
  });

  it("history row captures the immediately previous snapshot, not the new one", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Ada" }), sourceUpdatedAt: "2026-01-01T00:00:00.000Z" },
    );
    await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Grace" }), sourceUpdatedAt: "2026-01-02T00:00:00.000Z" },
    );
    const row = await getBrainProfileRow(organizationId, "contact_id", contactId);
    const historyRows = await adminPool.query("select profile from public.brain_entity_profile_history where entity_profile_id = $1", [row.id]);
    expect(historyRows.rows).toHaveLength(1);
    expect(historyRows.rows[0].profile.firstName).toBe("Ada");
  });
});

describe("upsertEntityProfile: concurrency / out-of-order freshness (Final Design Challenge §A)", () => {
  it("reproduces the completion-order inversion: a stale-data write arriving AFTER a fresh-data write must not overwrite it", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;

    // Seed initial state.
    await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "State1" }), sourceUpdatedAt: "2026-01-01T00:00:00.000Z" },
    );

    // "Fresh" worker reads updated_at = T3 and finishes FIRST.
    const freshResult = await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "State3" }), sourceUpdatedAt: "2026-01-03T00:00:00.000Z" },
    );
    expect(freshResult.status).toBe("updated");

    // "Stale" worker read updated_at = T2 (older than T3, but newer than the
    // seed) and — despite carrying older data — completes its own write
    // SECOND, i.e. strictly after the fresh worker's write already landed.
    // Under a write-completion-time clock this would incorrectly win; under
    // the source-updated_at freshness clock it must be rejected.
    const staleResult = await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "State2" }), sourceUpdatedAt: "2026-01-02T00:00:00.000Z" },
    );
    expect(staleResult.status).toBe("stale");

    const row = await getBrainProfileRow(organizationId, "contact_id", contactId);
    expect(row.profile.firstName).toBe("State3");

    // History reflects only the genuine State1 -> State3 transition — the
    // rejected stale write contributed nothing.
    expect(await countBrainHistoryRows(row.id)).toBe(1);
  });

  it("a fresh-data write arriving after an even-fresher one is also correctly rejected, regardless of call order", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;

    await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Newest" }), sourceUpdatedAt: "2026-01-05T00:00:00.000Z" },
    );
    const olderAttempt = await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Older" }), sourceUpdatedAt: "2026-01-04T00:00:00.000Z" },
    );
    expect(olderAttempt.status).toBe("stale");
    const row = await getBrainProfileRow(organizationId, "contact_id", contactId);
    expect(row.profile.firstName).toBe("Newest");
  });

  it("two concurrent upserts for the same entity resolve deterministically by source freshness, never by write-completion order", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    await upsertEntityProfile(
      { organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Seed" }), sourceUpdatedAt: "2026-01-01T00:00:00.000Z" },
    );

    // Fired concurrently — SELECT ... FOR UPDATE serializes them against
    // the same row regardless of which promise's underlying query happens
    // to reach Postgres first.
    const [a, b] = await Promise.all([
      upsertEntityProfile(
        { organizationId },
        { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Fresher" }), sourceUpdatedAt: "2026-01-03T00:00:00.000Z" },
      ),
      upsertEntityProfile(
        { organizationId },
        { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "Staler" }), sourceUpdatedAt: "2026-01-02T00:00:00.000Z" },
      ),
    ]);

    // Whichever of the two ran second sees the other's already-committed
    // row under the lock and re-evaluates the freshness guard against it —
    // so regardless of which settled first in JS, the one carrying older
    // data can never be the one left standing.
    const outcomes = [a, b];
    expect(outcomes.some((o) => o.status === "updated" || o.status === "stale")).toBe(true);

    const row = await getBrainProfileRow(organizationId, "contact_id", contactId);
    expect(row.profile.firstName).toBe("Fresher");
  });
});

describe("upsertEntityProfile: first-insert concurrency race (M4.1 Phase 2 Final Implementation Acceptance Audit BLOCKER, corrected)", () => {
  /**
   * A deliberate, zero-stagger `Promise.all` — NOT a timing-biased
   * stagger. An earlier version of this test tried to force a specific
   * physical winner by delaying one call's *start* by a fixed offset; a
   * live probe against a raw two-connection reproduction (see the M4.1
   * Phase 2 Final Implementation Acceptance Audit) proved that technique
   * unreliable: any offset large enough to be a dependable bias was also
   * large enough for the head-started call to fully commit before the
   * other one's async body even began, silently routing the "loser"
   * through the already-correct EXISTING-row branch instead of the
   * first-insert race this test exists to exercise — the exact bug this
   * defeats was independently confirmed to still pass 5/5 runs against
   * that flawed technique, which would have made this test worthless.
   *
   * A genuinely simultaneous `Promise.all` with no stagger was verified
   * (a raw two-connection probe, 29/30 trials) to reliably make BOTH
   * callers observe "no row exists" before either one's INSERT commits —
   * the true race this repository function must handle. Which of the two
   * physically wins the INSERT is then uncontrolled — so instead of
   * asserting a specific winner, each test below inspects BOTH callers'
   * own returned outcomes to determine, after the fact, which one won
   * (exactly one must report `status: "created"`), and verifies the
   * invariant holds regardless of which one that turned out to be:
   * the loser's own outcome must be "updated" (it was fresher and
   * corrected the winner) or "stale" (it was staler and correctly
   * declined) exactly according to the real relative freshness of the
   * two inputs — proving both possible physical orderings are handled
   * correctly without needing to force either one.
   */
  async function raceTwo(
    organizationId: string,
    contactId: string,
    a: { profile: CanonicalContactProfile; sourceUpdatedAt: string },
    b: { profile: CanonicalContactProfile; sourceUpdatedAt: string },
  ) {
    return Promise.all([
      upsertEntityProfile({ organizationId }, { entityType: "contact", entityId: contactId, profile: a.profile, sourceUpdatedAt: a.sourceUpdatedAt }),
      upsertEntityProfile({ organizationId }, { entityType: "contact", entityId: contactId, profile: b.profile, sourceUpdatedAt: b.sourceUpdatedAt }),
    ]);
  }

  it("two genuinely concurrent first-time upserts (no pre-existing row) converge to exactly one profile reflecting the fresher source, regardless of which one wins the physical INSERT — repeated across multiple real races to cover both possible orderings", async () => {
    for (let trial = 0; trial < 8; trial++) {
      const { organizationId } = await createOrgWithActiveMember();
      const contactId = (await seedContact(organizationId)).id;

      const preExisting = await getBrainProfileRow(organizationId, "contact_id", contactId);
      expect(preExisting).toBeNull();

      const older = { profile: contactProfile({ firstName: "STALE" }), sourceUpdatedAt: "2020-01-01T00:00:00.000Z" };
      const newer = { profile: contactProfile({ firstName: "FRESH" }), sourceUpdatedAt: "2025-01-01T00:00:00.000Z" };

      // 1. Neither call throws (an unhandled unique-violation would reject the Promise.all).
      const [olderOutcome, newerOutcome] = await raceTwo(organizationId, contactId, older, newer);
      expect(olderOutcome).toBeDefined();
      expect(newerOutcome).toBeDefined();

      // Exactly one of the two was the true first-insert winner.
      const outcomes = [olderOutcome, newerOutcome];
      const createdCount = outcomes.filter((o) => o.status === "created").length;
      expect(createdCount).toBe(1);

      // The older-data caller can never end up "updated" (that would mean
      // stale data overwrote fresher data); the newer-data caller can
      // never end up "stale" (that would mean fresh data was wrongly
      // rejected in favor of older data).
      expect(olderOutcome.status).not.toBe("updated");
      expect(newerOutcome.status).not.toBe("stale");

      // 2. Exactly one current profile row exists (no duplicate — point 7).
      const rows = await adminPool.query(
        "select id, profile, computed_at from public.brain_entity_profiles where organization_id = $1 and contact_id = $2",
        [organizationId, contactId],
      );
      expect(rows.rows).toHaveLength(1);

      // 3 & 4. Final content and computed_at are always the FRESHER source, regardless of arrival order.
      expect(rows.rows[0].profile.firstName).toBe("FRESH");
      expect(new Date(rows.rows[0].computed_at).toISOString()).toBe(newer.sourceUpdatedAt);

      // 5. The stale writer is never left authoritative.
      expect(rows.rows[0].profile.firstName).not.toBe("STALE");

      // 6. History: whether FRESH won outright (status "created", no prior
      // content to snapshot) or lost the physical race and corrected the
      // STALE winner afterward (status "updated" with historyWritten
      // true, snapshotting the STALE content), history is never written
      // more than once and never contains anything but the genuinely
      // superseded STALE content.
      const historyRows = await adminPool.query(
        "select profile from public.brain_entity_profile_history where entity_profile_id = $1",
        [rows.rows[0].id],
      );
      expect(historyRows.rows.length).toBeLessThanOrEqual(1);
      if (historyRows.rows.length === 1) {
        expect(historyRows.rows[0].profile.firstName).toBe("STALE");
      }
    }
  });

  it("the reverse content roles (fresher profile submitted as the second argument) are handled identically — the invariant does not depend on argument position", async () => {
    for (let trial = 0; trial < 8; trial++) {
      const { organizationId } = await createOrgWithActiveMember();
      const contactId = (await seedContact(organizationId)).id;

      const newer = { profile: contactProfile({ firstName: "FRESH2" }), sourceUpdatedAt: "2025-06-01T00:00:00.000Z" };
      const older = { profile: contactProfile({ firstName: "STALE2" }), sourceUpdatedAt: "2020-06-01T00:00:00.000Z" };

      // newer is now passed FIRST, older SECOND — the opposite argument
      // order from the previous test, closing off any argument-position-
      // dependent bug in addition to the physical-arrival-order coverage above.
      const [newerOutcome, olderOutcome] = await raceTwo(organizationId, contactId, newer, older);
      expect(newerOutcome).toBeDefined();
      expect(olderOutcome).toBeDefined();

      const createdCount = [newerOutcome, olderOutcome].filter((o) => o.status === "created").length;
      expect(createdCount).toBe(1);
      expect(olderOutcome.status).not.toBe("updated");
      expect(newerOutcome.status).not.toBe("stale");

      const rows = await adminPool.query(
        "select id, profile, computed_at from public.brain_entity_profiles where organization_id = $1 and contact_id = $2",
        [organizationId, contactId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].profile.firstName).toBe("FRESH2");
      expect(new Date(rows.rows[0].computed_at).toISOString()).toBe(newer.sourceUpdatedAt);

      const historyRows = await adminPool.query(
        "select profile from public.brain_entity_profile_history where entity_profile_id = $1",
        [rows.rows[0].id],
      );
      expect(historyRows.rows.length).toBeLessThanOrEqual(1);
      if (historyRows.rows.length === 1) {
        expect(historyRows.rows[0].profile.firstName).toBe("STALE2");
      }
    }
  });
});

describe("upsertEntityProfile: tenant isolation", () => {
  it("two organizations never see or overwrite each other's profile for coincidentally-matching entity ids is not applicable (ids are real UUIDs) — instead: writes are strictly scoped to organization_id", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const contactId = (await seedContact(orgA.organizationId)).id;

    await upsertEntityProfile(
      { organizationId: orgA.organizationId },
      { entityType: "contact", entityId: contactId, profile: contactProfile({ firstName: "OrgA" }), sourceUpdatedAt: "2026-01-01T00:00:00.000Z" },
    );
    const rowA = await getBrainProfileRow(orgA.organizationId, "contact_id", contactId);
    const rowB = await getBrainProfileRow(orgB.organizationId, "contact_id", contactId);
    expect(rowA).not.toBeNull();
    expect(rowB).toBeNull();
  });
});

describe("claimBrainProjectionRun / completeBrainProjectionRun", () => {
  it("a duplicate claim for the same (org, workflowKey, sourceEventId) is rejected", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const sourceEventId = crypto.randomUUID();
    const first = await claimBrainProjectionRun({ organizationId }, { workflowKey: "brain_projection_contact", sourceEventId });
    const second = await claimBrainProjectionRun({ organizationId }, { workflowKey: "brain_projection_contact", sourceEventId });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("a claim can be re-acquired after completeBrainProjectionRun marks it failed", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const sourceEventId = crypto.randomUUID();
    await claimBrainProjectionRun({ organizationId }, { workflowKey: "brain_projection_contact", sourceEventId });
    await completeBrainProjectionRun({ organizationId }, { workflowKey: "brain_projection_contact", sourceEventId, status: "failed", error: "boom" });
    const reclaim = await claimBrainProjectionRun({ organizationId }, { workflowKey: "brain_projection_contact", sourceEventId });
    expect(reclaim).toBe(true);
  });

  it("company/deal claims legally leave contact_id NULL", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const sourceEventId = crypto.randomUUID();
    const claimed = await claimBrainProjectionRun({ organizationId }, { workflowKey: "brain_projection_company", sourceEventId });
    expect(claimed).toBe(true);
    const row = await adminPool.query(
      "select contact_id from public.workflow_runs where organization_id = $1 and workflow_key = 'brain_projection_company' and source_event_id = $2",
      [organizationId, sourceEventId],
    );
    expect(row.rows[0].contact_id).toBeNull();
  });
});
