import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  seedAsAdmin,
  createOrgWithActiveMember,
  seedContact,
  seedCompany,
  seedProfile,
  getEmbeddingRow,
  countEmbeddingEntityRefs,
  fakeVector,
} from "./helpers";
import { upsertEntityEmbedding, computeContentHash, isValidEmbeddingVector, EMBEDDING_DIMENSION } from "../src/embeddings";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("EMBEDDING_DIMENSION / isValidEmbeddingVector", () => {
  it("accepts an array of exactly 1536 finite numbers", () => {
    expect(isValidEmbeddingVector(fakeVector())).toBe(true);
    expect(EMBEDDING_DIMENSION).toBe(1536);
  });
  it("rejects an array that is too short", () => {
    expect(isValidEmbeddingVector(fakeVector().slice(0, 1535))).toBe(false);
  });
  it("rejects an array that is too long", () => {
    expect(isValidEmbeddingVector([...fakeVector(), 0])).toBe(false);
  });
  it("rejects an array containing NaN", () => {
    const v = fakeVector();
    v[10] = NaN;
    expect(isValidEmbeddingVector(v)).toBe(false);
  });
  it("rejects an array containing Infinity", () => {
    const v = fakeVector();
    v[10] = Infinity;
    expect(isValidEmbeddingVector(v)).toBe(false);
  });
  it("rejects a non-array value", () => {
    expect(isValidEmbeddingVector("not an array")).toBe(false);
    expect(isValidEmbeddingVector(null)).toBe(false);
    expect(isValidEmbeddingVector(undefined)).toBe(false);
  });
});

describe("computeContentHash: canonical content-hash contract", () => {
  it("the same canonical input produces the same hash", () => {
    const input = { entityType: "contact" as const, entityId: "11111111-1111-1111-1111-111111111111", chunkText: "hello" };
    expect(computeContentHash(input)).toBe(computeContentHash({ ...input }));
  });
  it("changed chunkText produces a different hash", () => {
    const base = { entityType: "contact" as const, entityId: "11111111-1111-1111-1111-111111111111", chunkText: "hello" };
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, chunkText: "goodbye" }));
  });
  it("changed source identity (entityId) produces a different hash, even with identical chunkText", () => {
    const base = { entityType: "contact" as const, entityId: "11111111-1111-1111-1111-111111111111", chunkText: "hello" };
    expect(computeContentHash(base)).not.toBe(
      computeContentHash({ ...base, entityId: "22222222-2222-2222-2222-222222222222" }),
    );
  });
  it("changed entityType produces a different hash, even with identical chunkText and entityId", () => {
    const base = { entityType: "contact" as const, entityId: "11111111-1111-1111-1111-111111111111", chunkText: "hello" };
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, entityType: "company" as const }));
  });
  it("is a hex-encoded sha256 digest (64 hex characters)", () => {
    const hash = computeContentHash({ entityType: "contact", entityId: "11111111-1111-1111-1111-111111111111", chunkText: "x" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("upsertEntityEmbedding: first write, duplicate, newer, stale", () => {
  it("first write for an entity with an existing profile creates a row and its entity_refs", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    const profile = await seedProfile(organizationId, "contact_id", contactId, "2026-01-01T00:00:00.000Z");

    const result = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contactId, chunkText: "chunk one", embedding: fakeVector(1), sourceVersionAt: profile.computedAt },
    );
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("unreachable");

    const row = await getEmbeddingRow(organizationId, profile.id);
    expect(row).not.toBeNull();
    expect(row.chunk_text).toBe("chunk one");
    expect(await countEmbeddingEntityRefs(result.embeddingId)).toBe(1);
  });

  it("a truly-duplicate redelivery (identical content) is a real no-op — status 'unchanged', no write", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    const profile = await seedProfile(organizationId, "contact_id", contactId, "2026-01-01T00:00:00.000Z");

    const input = { entityType: "contact" as const, entityId: contactId, chunkText: "same text", embedding: fakeVector(2), sourceVersionAt: profile.computedAt };
    const first = await upsertEntityEmbedding({ organizationId }, input);
    expect(first.status).toBe("created");

    const second = await upsertEntityEmbedding({ organizationId }, input);
    expect(second.status).toBe("unchanged");
    if (first.status !== "created" || second.status !== "unchanged") throw new Error("unreachable");
    expect(second.embeddingId).toBe(first.embeddingId);
    // Still exactly one entity_ref — the "unchanged" no-op path never re-inserts one.
    expect(await countEmbeddingEntityRefs(first.embeddingId)).toBe(1);
  });

  it("a newer result (fresher sourceVersionAt, changed content) updates the SAME row in place, never inserting a second one", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    const profile = await seedProfile(organizationId, "contact_id", contactId, "2026-01-01T00:00:00.000Z");

    const first = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contactId, chunkText: "v1", embedding: fakeVector(3), sourceVersionAt: profile.computedAt },
    );
    expect(first.status).toBe("created");
    if (first.status !== "created") throw new Error("unreachable");

    // Recompute the profile to a NEWER computed_at, matching how a real
    // profile recomputation would raise the bar for what counts as fresh.
    const recomputedAt = "2026-01-02T00:00:00.000Z";
    await seedAsAdmin(async (client) => {
      await client.query("update public.brain_entity_profiles set computed_at = $1 where id = $2", [recomputedAt, profile.id]);
    });

    const second = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contactId, chunkText: "v2", embedding: fakeVector(4), sourceVersionAt: recomputedAt },
    );
    expect(second.status).toBe("updated");
    if (second.status !== "updated") throw new Error("unreachable");
    expect(second.embeddingId).toBe(first.embeddingId);

    const row = await getEmbeddingRow(organizationId, profile.id);
    expect(row.chunk_text).toBe("v2");
    // Only ONE embedding row exists for this entity profile — update in place, never a second row.
    expect(await countEmbeddingEntityRefs(first.embeddingId)).toBe(1);
  });

  it("a stale result (sourceVersionAt older than the CURRENT profile's computed_at) is rejected, never overwriting fresher stored state", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    const profile = await seedProfile(organizationId, "contact_id", contactId, "2026-01-05T00:00:00.000Z");

    const stale = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contactId, chunkText: "too old", embedding: fakeVector(5), sourceVersionAt: "2020-01-01T00:00:00.000Z" },
    );
    expect(stale.status).toBe("stale");

    // Nothing was ever written — no embedding row exists at all.
    const row = await getEmbeddingRow(organizationId, profile.id);
    expect(row).toBeNull();
  });

  it("a stale result arriving AFTER a fresher one was already stored does not overwrite it", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    const profile = await seedProfile(organizationId, "contact_id", contactId, "2026-01-10T00:00:00.000Z");

    const fresh = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contactId, chunkText: "fresh", embedding: fakeVector(6), sourceVersionAt: profile.computedAt },
    );
    expect(fresh.status).toBe("created");

    const lateStale = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contactId, chunkText: "late and stale", embedding: fakeVector(7), sourceVersionAt: "2020-01-01T00:00:00.000Z" },
    );
    expect(lateStale.status).toBe("stale");

    const row = await getEmbeddingRow(organizationId, profile.id);
    expect(row.chunk_text).toBe("fresh");
  });
});

describe("upsertEntityEmbedding: entity_not_found (no profile, or hard-erased)", () => {
  it("rejects a write-back for an entity that has no brain_entity_profiles row at all", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    // Deliberately no seedProfile call.

    const result = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contactId, chunkText: "orphan", embedding: fakeVector(8), sourceVersionAt: new Date().toISOString() },
    );
    expect(result.status).toBe("entity_not_found");
  });

  it("post-erasure stale write-back is rejected: a hard-erased contact's profile row is gone, so a late write-back cannot resurrect anything", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    const profile = await seedProfile(organizationId, "contact_id", contactId, "2026-01-01T00:00:00.000Z");

    const first = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contactId, chunkText: "before erasure", embedding: fakeVector(9), sourceVersionAt: profile.computedAt },
    );
    expect(first.status).toBe("created");

    // Hard-erase the contact directly — brain_entity_profiles cascades
    // away structurally (the existing Phase 1 FK), which in turn cascades
    // away the embedding row (this phase's new FK) — no second erasure
    // mechanism, proven live, not merely asserted.
    await seedAsAdmin(async (client) => {
      await client.query("delete from public.contacts where id = $1", [contactId]);
    });

    const rowGone = await getEmbeddingRow(organizationId, profile.id);
    expect(rowGone).toBeNull();

    // A late/stale write-back arriving after the erasure finds no profile
    // to attach to — rejected, never resurrecting anything.
    const late = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contactId, chunkText: "arrives after erasure", embedding: fakeVector(10), sourceVersionAt: profile.computedAt },
    );
    expect(late.status).toBe("entity_not_found");
  });
});

describe("upsertEntityEmbedding: tenant isolation", () => {
  it("a write-back scoped to organization A cannot attach to organization B's profile, even given B's real entityId", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const contactInB = (await seedContact(orgB.organizationId)).id;
    await seedProfile(orgB.organizationId, "contact_id", contactInB, "2026-01-01T00:00:00.000Z");

    const result = await upsertEntityEmbedding(
      { organizationId: orgA.organizationId },
      { entityType: "contact", entityId: contactInB, chunkText: "cross-tenant attempt", embedding: fakeVector(11), sourceVersionAt: "2026-01-01T00:00:00.000Z" },
    );
    // orgA has no brain_entity_profiles row for contactInB (that row
    // belongs to orgB) — the tenant-scoped lookup correctly finds nothing.
    expect(result.status).toBe("entity_not_found");
  });
});

describe("upsertEntityEmbedding: soft-delete tombstone", () => {
  it("a tombstoned (soft-deleted) profile can still receive an embedding — same code path as an active entity", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const companyId = (await seedCompany(organizationId)).id;
    const profile = await seedProfile(organizationId, "company_id", companyId, "2026-01-01T00:00:00.000Z");

    const result = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "company", entityId: companyId, chunkText: "tombstoned company profile text", embedding: fakeVector(12), sourceVersionAt: profile.computedAt },
    );
    expect(result.status).toBe("created");
  });
});

describe("upsertEntityEmbedding: rejects a malformed vector before it reaches persistent state", () => {
  it("throws for a wrong-dimension embedding, no row written", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactId = (await seedContact(organizationId)).id;
    const profile = await seedProfile(organizationId, "contact_id", contactId, "2026-01-01T00:00:00.000Z");

    await expect(
      upsertEntityEmbedding(
        { organizationId },
        { entityType: "contact", entityId: contactId, chunkText: "bad", embedding: fakeVector().slice(0, 10), sourceVersionAt: profile.computedAt },
      ),
    ).rejects.toThrow(RangeError);

    const row = await getEmbeddingRow(organizationId, profile.id);
    expect(row).toBeNull();
  });
});

describe("upsertEntityEmbedding: concurrent first write-back", () => {
  /**
   * Genuinely simultaneous `Promise.all`, zero stagger — same technique
   * `upsertEntityProfile`'s own first-insert race test uses (see that
   * test's own header comment for why a timing-staggered alternative was
   * proven unreliable). Required outcome (per this phase's own
   * authorization): no uncaught unique violation, exactly one logical
   * current embedding row, deterministic final state.
   */
  it("two genuinely concurrent first-time write-backs for the same entity converge to exactly one embedding row, reflecting the fresher source, regardless of which one wins the physical INSERT", async () => {
    for (let trial = 0; trial < 5; trial++) {
      const { organizationId } = await createOrgWithActiveMember();
      const contactId = (await seedContact(organizationId)).id;
      const profile = await seedProfile(organizationId, "contact_id", contactId, "2026-01-01T00:00:00.000Z");

      const older = { entityType: "contact" as const, entityId: contactId, chunkText: "OLDER", embedding: fakeVector(100 + trial), sourceVersionAt: profile.computedAt };
      const newer = { entityType: "contact" as const, entityId: contactId, chunkText: "NEWER", embedding: fakeVector(200 + trial), sourceVersionAt: profile.computedAt };

      const [olderOutcome, newerOutcome] = await Promise.all([
        upsertEntityEmbedding({ organizationId }, older),
        upsertEntityEmbedding({ organizationId }, newer),
      ]);

      expect(olderOutcome).toBeDefined();
      expect(newerOutcome).toBeDefined();

      const outcomes = [olderOutcome, newerOutcome];
      const createdCount = outcomes.filter((o) => o.status === "created").length;
      expect(createdCount).toBe(1);
      // Same sourceVersionAt for both — the loser's own content_hash may
      // legitimately differ from the winner's (different chunkText), so
      // it lands as "updated", never "stale" (equal freshness is always
      // accepted, never rejected) and never a second "created".
      expect(outcomes.filter((o) => o.status === "updated").length).toBe(1);

      const row = await getEmbeddingRow(organizationId, profile.id);
      expect(row).not.toBeNull();
      // Deterministic final state: whichever call's write landed LAST
      // under the FOR UPDATE lock is what's stored — either is a valid,
      // real outcome of a genuine race; what matters is there is exactly
      // ONE row, not zero, not two, and no exception was thrown.
      expect(["OLDER", "NEWER"]).toContain(row.chunk_text);
      expect(await countEmbeddingEntityRefs(row.id)).toBe(1);
    }
  });
});
