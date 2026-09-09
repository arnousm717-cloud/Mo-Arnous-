import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, seedAsAdmin, createOrgWithActiveMember } from "./helpers";
import {
  findEmbeddingRecoveryCandidates,
  deriveEmbeddingRecoveryEventId,
} from "../src/backfill";
import { claimEmbeddingRecoveryAttempt, completeBrainProjectionRun } from "../src/repository";

/** Test-only: rewinds a workflow_runs row's completed_at into the past,
 * simulating elapsed real time without a fragile wall-clock sleep — the
 * same technique already established by this codebase's own freshness
 * tests (e.g. packages/brain/tests/search.test.ts's staleness test). */
async function rewindCompletedAt(
  organizationId: string,
  workflowKey: string,
  sourceEventId: string,
  secondsAgo: number,
): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query(
      `update public.workflow_runs
       set completed_at = now() - make_interval(secs => $1)
       where organization_id = $2 and workflow_key = $3 and source_event_id = $4`,
      [secondsAgo, organizationId, workflowKey, sourceEventId],
    );
  });
}

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

/**
 * Milestone 4.1 Phase 5 — findEmbeddingRecoveryCandidates /
 * deriveEmbeddingRecoveryEventId. Real Postgres throughout, no ranking or
 * claim behavior mocked. Unlike embedding-backfill.test.ts's own coverage
 * of findProfilesNeedingEmbedding (a one-shot forward-cursor sweep), every
 * test here is a REPEAT-INVOCATION test by design — the entire point of
 * this function is to remain repeatable, never advancing past a profile
 * it can still usefully rediscover.
 */
async function seedProfileRow(organizationId: string, computedAt: string): Promise<{ id: string; contactId: string }> {
  return seedAsAdmin(async (client) => {
    const contact = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, email) values ($1, 'Recovery', $2) returning id",
      [organizationId, `embed-recovery-${randomUUID()}@example.test`],
    );
    const profile = await client.query<{ id: string }>(
      `insert into public.brain_entity_profiles (organization_id, entity_type, contact_id, profile, computed_at)
       values ($1, 'contact', $2, '{}'::jsonb, $3) returning id`,
      [organizationId, contact.rows[0]!.id, computedAt],
    );
    return { id: profile.rows[0]!.id, contactId: contact.rows[0]!.id };
  });
}

async function seedEmbeddingRow(organizationId: string, entityProfileId: string, sourceVersionAt: string): Promise<void> {
  await seedAsAdmin(async (client) => {
    const vector = `[${Array.from({ length: 1536 }, () => "0").join(",")}]`;
    await client.query(
      `insert into public.brain_embeddings (organization_id, source_type, entity_profile_id, chunk_text, embedding, content_hash, source_version_at)
       values ($1, 'entity_profile', $2, 'x', $3::vector, $4, $5)`,
      [organizationId, entityProfileId, vector, randomUUID(), sourceVersionAt],
    );
  });
}

describe("findEmbeddingRecoveryCandidates: identification only", () => {
  it("a profile with no embedding row at all is discovered", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");

    const candidates = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(candidates.map((c) => c.profileId)).toContain(profile.id);
  });

  it("a profile whose stored embedding is stale (source_version_at < computed_at) is discovered", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-05T00:00:00.000Z");
    await seedEmbeddingRow(organizationId, profile.id, "2026-01-01T00:00:00.000Z");

    const candidates = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(candidates.map((c) => c.profileId)).toContain(profile.id);
  });

  it("a profile whose embedding is fresh (source_version_at >= computed_at) is excluded", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    await seedEmbeddingRow(organizationId, profile.id, "2026-01-01T00:00:00.000Z");

    const candidates = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(candidates.map((c) => c.profileId)).not.toContain(profile.id);
  });

  it("a hard-erased contact's profile is excluded (re-derived from live current state, no second erasure system)", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");

    const before = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(before.map((c) => c.profileId)).toContain(profile.id);

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.contacts where id = $1", [profile.contactId]);
    });

    const after = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(after.map((c) => c.profileId)).not.toContain(profile.id);
  });

  it("no vector content or CRM content in the returned candidate shape", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");

    const candidates = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(Object.keys(c).sort()).toEqual(["computedAt", "entityId", "entityType", "profileId"]);
    }
  });
});

describe("findEmbeddingRecoveryCandidates: repeatable, no persistent forward cursor", () => {
  it("a second call with nothing changed rediscovers the EXACT SAME candidate — unlike findProfilesNeedingEmbedding, this never advances past it", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");

    const first = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(first.map((c) => c.profileId)).toContain(profile.id);

    const second = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(second.map((c) => c.profileId)).toContain(profile.id);
  });

  it("ordering within a single invocation is well-defined: every returned profile id is unique, none omitted or duplicated under the cap", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z"));
    }

    const candidates = await findEmbeddingRecoveryCandidates({ organizationId });
    const ids = candidates.map((c) => c.profileId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of seeded) {
      expect(ids).toContain(p.id);
    }
  });

  it("ordering deliberately reshuffles across separate invocations — this is the anti-starvation fairness mechanism, not a bug (see backfill.ts's own header comment)", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    for (let i = 0; i < 30; i++) {
      await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    }

    // 30 candidates, capped at 10 per call: if ordering never rotated
    // across separate invocations (e.g. a naive `order by id asc`, or the
    // hour-truncated ordering this implementation explicitly rejected —
    // see the header comment's own account of that live-reproduced bug),
    // the exact same 10 would be selected every time, and 20 of the 30
    // profiles would never be reachable at all. Sampling many rounds and
    // requiring the union to exceed one round's own cap is a robust,
    // non-flaky way to prove real rotation without asserting on the
    // literal order of any single call.
    const seenAcrossCalls = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const candidates = await findEmbeddingRecoveryCandidates({ organizationId }, { limitPerEntityType: 10 });
      for (const c of candidates) seenAcrossCalls.add(c.profileId);
    }
    expect(seenAcrossCalls.size).toBeGreaterThan(10);
  });

  it("batch cap: more candidates exist than limitPerEntityType, but the result never exceeds it", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    for (let i = 0; i < 15; i++) {
      await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    }

    const candidates = await findEmbeddingRecoveryCandidates({ organizationId }, { limitPerEntityType: 5 });
    expect(candidates).toHaveLength(5);
  });

  it("remaining profiles beyond the cap stay discoverable on a later call (no permanent starvation)", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const seeded = [];
    for (let i = 0; i < 8; i++) {
      seeded.push(await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z"));
    }

    // Simulate every seeded profile eventually receiving its embedding
    // one call at a time, using a small cap each call — proves the
    // discovery set shrinks as embeddings land, not that any one profile
    // is permanently invisible.
    const seenAcrossCalls = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const candidates = await findEmbeddingRecoveryCandidates({ organizationId }, { limitPerEntityType: 3 });
      for (const c of candidates) seenAcrossCalls.add(c.profileId);
      for (const c of candidates) {
        await seedEmbeddingRow(organizationId, c.profileId, "2026-01-01T00:00:00.000Z");
      }
    }
    for (const p of seeded) {
      expect(seenAcrossCalls.has(p.id)).toBe(true);
    }
  });
});

describe("findEmbeddingRecoveryCandidates: tenant isolation", () => {
  it("never reports another organization's profiles", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    await seedProfileRow(orgB.organizationId, "2026-01-01T00:00:00.000Z");

    const candidatesA = await findEmbeddingRecoveryCandidates({ organizationId: orgA.organizationId });
    expect(candidatesA).toHaveLength(0);
  });
});

describe("deriveEmbeddingRecoveryEventId", () => {
  it("is deterministic: same profileId + same computedAt always produces the same id", () => {
    const a = deriveEmbeddingRecoveryEventId("11111111-1111-1111-1111-111111111111", "2026-01-01T00:00:00.000Z");
    const b = deriveEmbeddingRecoveryEventId("11111111-1111-1111-1111-111111111111", "2026-01-01T00:00:00.000Z");
    expect(a).toBe(b);
  });

  it("is a valid UUID string (workflow_runs.source_event_id is a uuid column, not free text)", () => {
    const id = deriveEmbeddingRecoveryEventId("11111111-1111-1111-1111-111111111111", "2026-01-01T00:00:00.000Z");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("changes when computedAt changes — a recomputed profile becomes a NEW recovery state, even for the same profileId", () => {
    const profileId = "11111111-1111-1111-1111-111111111111";
    const a = deriveEmbeddingRecoveryEventId(profileId, "2026-01-01T00:00:00.000Z");
    const b = deriveEmbeddingRecoveryEventId(profileId, "2026-01-02T00:00:00.000Z");
    expect(a).not.toBe(b);
  });

  it("changes when profileId changes, for the same computedAt", () => {
    const a = deriveEmbeddingRecoveryEventId("11111111-1111-1111-1111-111111111111", "2026-01-01T00:00:00.000Z");
    const b = deriveEmbeddingRecoveryEventId("22222222-2222-2222-2222-222222222222", "2026-01-01T00:00:00.000Z");
    expect(a).not.toBe(b);
  });
});

describe("recovery idempotency via claimEmbeddingRecoveryAttempt + deriveEmbeddingRecoveryEventId (real workflow_runs)", () => {
  it("same profile state (same derived id) cannot be claimed again IMMEDIATELY after the first claim succeeded", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    const sourceEventId = deriveEmbeddingRecoveryEventId(profile.id, "2026-01-01T00:00:00.000Z");
    const ctx = { organizationId };
    const workflowKey = "brain_embedding_recovery_contact";

    const firstClaim = await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId });
    expect(firstClaim).toBe(true);
    await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId, status: "succeeded" });

    const secondClaim = await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId });
    expect(secondClaim).toBe(false);
  });

  it("a profile recomputed to a newer computedAt becomes claimable again even though the OLD state already succeeded", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    const ctx = { organizationId };
    const workflowKey = "brain_embedding_recovery_contact";

    const oldEventId = deriveEmbeddingRecoveryEventId(profile.id, "2026-01-01T00:00:00.000Z");
    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId: oldEventId })).toBe(true);
    await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId: oldEventId, status: "succeeded" });

    // Profile recomputed -- a new computed_at -> a new derived event id.
    const newEventId = deriveEmbeddingRecoveryEventId(profile.id, "2026-01-05T00:00:00.000Z");
    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId: newEventId })).toBe(true);

    // The OLD state's own claim remains untouched -- still not
    // immediately reclaimable (it IS eventually reclaimable after its
    // own cooldown -- see the dedicated eventual-retry tests below).
    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId: oldEventId })).toBe(false);
  });

  it("a failed attempt (never completed 'succeeded') remains immediately claimable on the next recovery run — no cooldown applies to failures", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    const sourceEventId = deriveEmbeddingRecoveryEventId(profile.id, "2026-01-01T00:00:00.000Z");
    const ctx = { organizationId };
    const workflowKey = "brain_embedding_recovery_contact";

    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(true);
    await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId, status: "failed", error: "webhook down" });

    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(true);
  });
});

describe("recovery eventual retry after cooldown — the corrected HIGH defect (successful webhook acknowledgement is not permanent proof of materialization)", () => {
  it("REGRESSION: a succeeded attempt whose embedding never materializes becomes reclaimable once completed_at is older than the cooldown, with computedAt unchanged", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    const sourceEventId = deriveEmbeddingRecoveryEventId(profile.id, "2026-01-01T00:00:00.000Z");
    const ctx = { organizationId };
    const workflowKey = "brain_embedding_recovery_contact";

    // 1-3: claim succeeds, simulated n8n 2xx -> production completion logic.
    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(true);
    await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId, status: "succeeded" });

    // 5-6: no embedding write-back ever occurs; the profile still needs one.
    const stillCandidate = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(stillCandidate.map((c) => c.profileId)).toContain(profile.id);

    // 7: immediate reclaim blocked.
    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(false);

    // 8-9: simulate elapsed time beyond the 900s cooldown, computedAt unchanged.
    await rewindCompletedAt(organizationId, workflowKey, sourceEventId, 901);

    // 10: reclaim now succeeds -- this is the fix.
    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(true);
  });

  it("cooldown boundary: reclaim is blocked just under 900s and allowed just over it", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    const sourceEventId = deriveEmbeddingRecoveryEventId(profile.id, "2026-01-01T00:00:00.000Z");
    const ctx = { organizationId };
    const workflowKey = "brain_embedding_recovery_contact";

    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(true);
    await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId, status: "succeeded" });

    await rewindCompletedAt(organizationId, workflowKey, sourceEventId, 899);
    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(false);

    await rewindCompletedAt(organizationId, workflowKey, sourceEventId, 901);
    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(true);
  });

  it("fresh embedding suppresses retry entirely: once the embedding materializes, the profile is never a candidate again, even well past the cooldown", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    const sourceEventId = deriveEmbeddingRecoveryEventId(profile.id, "2026-01-01T00:00:00.000Z");
    const ctx = { organizationId };
    const workflowKey = "brain_embedding_recovery_contact";

    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(true);
    await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId, status: "succeeded" });

    // The embedding DOES materialize this time (e.g. n8n's own workflow
    // genuinely completed).
    await seedEmbeddingRow(organizationId, profile.id, "2026-01-01T00:00:00.000Z");

    await rewindCompletedAt(organizationId, workflowKey, sourceEventId, 10_000);

    const candidates = await findEmbeddingRecoveryCandidates({ organizationId });
    expect(candidates.map((c) => c.profileId)).not.toContain(profile.id);
  });

  it("attempt_count increments across a cooldown-based reclaim (observability only, never a terminal cutoff)", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const profile = await seedProfileRow(organizationId, "2026-01-01T00:00:00.000Z");
    const sourceEventId = deriveEmbeddingRecoveryEventId(profile.id, "2026-01-01T00:00:00.000Z");
    const ctx = { organizationId };
    const workflowKey = "brain_embedding_recovery_contact";

    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(true);
    await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId, status: "succeeded" });
    await rewindCompletedAt(organizationId, workflowKey, sourceEventId, 901);
    expect(await claimEmbeddingRecoveryAttempt(ctx, { workflowKey, sourceEventId })).toBe(true);

    const row = await seedAsAdmin(async (client) => {
      const r = await client.query<{ attempt_count: number }>(
        "select attempt_count from public.workflow_runs where organization_id = $1 and workflow_key = $2 and source_event_id = $3",
        [organizationId, workflowKey, sourceEventId],
      );
      return r.rows[0]!;
    });
    expect(row.attempt_count).toBeGreaterThanOrEqual(2);
  });

  it("tenant isolation: an identical derived id in a different organization is an entirely independent claim, cooldown included", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const profileA = await seedProfileRow(orgA.organizationId, "2026-01-01T00:00:00.000Z");
    // Force an identical derived id in org B by using the SAME profile id
    // is impossible (profile ids are real, distinct UUIDs) -- instead
    // prove isolation the direct way: org B's claim for its OWN profile
    // with the SAME computedAt is unaffected by org A's claim/cooldown
    // state for a DIFFERENT profile, and org A's own claim cannot be
    // reclaimed by presenting org B's organizationId.
    const workflowKey = "brain_embedding_recovery_contact";
    const sourceEventIdA = deriveEmbeddingRecoveryEventId(profileA.id, "2026-01-01T00:00:00.000Z");

    expect(await claimEmbeddingRecoveryAttempt({ organizationId: orgA.organizationId }, { workflowKey, sourceEventId: sourceEventIdA })).toBe(
      true,
    );
    await completeBrainProjectionRun({ organizationId: orgA.organizationId }, { workflowKey, sourceEventId: sourceEventIdA, status: "succeeded" });

    // Attempting the SAME (workflowKey, sourceEventId) under org B's
    // tenant context claims a genuinely different row (the unique key is
    // (organization_id, workflow_key, source_event_id)) -- succeeds
    // immediately, proving no cross-tenant interference.
    expect(await claimEmbeddingRecoveryAttempt({ organizationId: orgB.organizationId }, { workflowKey, sourceEventId: sourceEventIdA })).toBe(
      true,
    );

    // Org A's own row remains correctly blocked (immediate, within cooldown).
    expect(await claimEmbeddingRecoveryAttempt({ organizationId: orgA.organizationId }, { workflowKey, sourceEventId: sourceEventIdA })).toBe(
      false,
    );
  });
});
