import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, seedAsAdmin, createOrgWithActiveMember, seedContact, seedCompany, seedProfile } from "./helpers";
import { upsertEntityEmbedding } from "../src/embeddings";
import {
  searchEntityProfilesByEmbedding,
  resolveSearchLimit,
  isZeroNormVector,
  SearchValidationError,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
} from "../src/search";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

/**
 * Milestone 4.1 Phase 4 — searchEntityProfilesByEmbedding. Real Postgres,
 * real pgvector operators throughout — no ranking behavior is ever
 * mocked. Fixture embeddings are written through the real
 * upsertEntityEmbedding write-back path wherever possible (never a second,
 * divergent construction path), matching this codebase's established
 * "prefer real DB tests, reuse the real write path" discipline.
 *
 * Basis-vector fixtures give exact, hand-verifiable cosine similarity:
 * two basis vectors e_i/e_j (1 at index i/j, 0 elsewhere) have cosine
 * similarity 0 (orthogonal) unless i === j (similarity 1) — no floating
 * approximation needed to reason about expected ordering.
 */
function basisVector(dim: number, magnitude = 1): number[] {
  const v = new Array(1536).fill(0);
  v[dim] = magnitude;
  return v;
}

/** A vector at a known 45-degree angle from e_0 — cosine similarity with e_0 is exactly 1/sqrt(2) ≈ 0.7071. */
function fortyFiveDegreesFromE0(): number[] {
  const v = new Array(1536).fill(0);
  v[0] = 1;
  v[1] = 1;
  return v;
}

/** All-zero 1536-dim vector — legal under Phase 3's write contract
 * (dimension/finiteness only), but cosine-undefined: this is the exact
 * shape of the acceptance-audit-discovered defect this correction closes. */
function zeroVector(): number[] {
  return new Array(1536).fill(0);
}

describe("resolveSearchLimit", () => {
  it("undefined resolves to SEARCH_DEFAULT_LIMIT", () => {
    expect(resolveSearchLimit(undefined)).toBe(SEARCH_DEFAULT_LIMIT);
  });
  it("accepts 1", () => {
    expect(resolveSearchLimit(1)).toBe(1);
  });
  it("accepts SEARCH_MAX_LIMIT", () => {
    expect(resolveSearchLimit(SEARCH_MAX_LIMIT)).toBe(SEARCH_MAX_LIMIT);
  });
  it("rejects 0", () => {
    expect(() => resolveSearchLimit(0)).toThrow(SearchValidationError);
  });
  it("rejects a negative limit", () => {
    expect(() => resolveSearchLimit(-1)).toThrow(SearchValidationError);
  });
  it("rejects a limit exceeding SEARCH_MAX_LIMIT", () => {
    expect(() => resolveSearchLimit(SEARCH_MAX_LIMIT + 1)).toThrow(SearchValidationError);
  });
  it("rejects a non-integer limit", () => {
    expect(() => resolveSearchLimit(1.5)).toThrow(SearchValidationError);
  });
});

describe("searchEntityProfilesByEmbedding: vector validation", () => {
  it("rejects a wrong-dimension query vector", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await expect(
      searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0).slice(0, 100) }),
    ).rejects.toThrow(SearchValidationError);
  });
  it("rejects a query vector containing NaN", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const v = basisVector(0);
    v[5] = NaN;
    await expect(searchEntityProfilesByEmbedding({ organizationId }, { queryVector: v })).rejects.toThrow(SearchValidationError);
  });
  it("rejects a query vector containing Infinity", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const v = basisVector(0);
    v[5] = Infinity;
    await expect(searchEntityProfilesByEmbedding({ organizationId }, { queryVector: v })).rejects.toThrow(SearchValidationError);
  });

  it("rejects an all-zero query vector (cosine similarity is undefined for a zero-norm vector) — Final Implementation Acceptance Audit correction", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await expect(searchEntityProfilesByEmbedding({ organizationId }, { queryVector: zeroVector() })).rejects.toThrow(SearchValidationError);
    await expect(searchEntityProfilesByEmbedding({ organizationId }, { queryVector: zeroVector() })).rejects.toThrow(
      /all-zero/,
    );
  });
});

describe("isZeroNormVector", () => {
  it("is true only for an all-zero vector, never for a vector with any nonzero element", () => {
    expect(isZeroNormVector(zeroVector())).toBe(true);
    expect(isZeroNormVector(basisVector(0))).toBe(false);
    expect(isZeroNormVector(basisVector(0, -1))).toBe(false);
    const tiny = zeroVector();
    tiny[100] = 1e-300;
    expect(isZeroNormVector(tiny)).toBe(false);
  });
});

describe("searchEntityProfilesByEmbedding: limit validation", () => {
  it("rejects an invalid limit before ever querying the database", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await expect(
      searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), limit: 0 }),
    ).rejects.toThrow(SearchValidationError);
    await expect(
      searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), limit: SEARCH_MAX_LIMIT + 1 }),
    ).rejects.toThrow(SearchValidationError);
  });
});

describe("searchEntityProfilesByEmbedding: entityType / minSimilarity validation", () => {
  it("rejects an unsupported entityType", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await expect(
      searchEntityProfilesByEmbedding(
        { organizationId },
        { queryVector: basisVector(0), entityType: "not-a-real-type" as never },
      ),
    ).rejects.toThrow(SearchValidationError);
  });
  it("rejects a minSimilarity outside [-1, 1]", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await expect(
      searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), minSimilarity: 1.5 }),
    ).rejects.toThrow(SearchValidationError);
    await expect(
      searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), minSimilarity: -2 }),
    ).rejects.toThrow(SearchValidationError);
  });
  it("rejects a NaN/Infinity minSimilarity", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await expect(
      searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), minSimilarity: NaN }),
    ).rejects.toThrow(SearchValidationError);
    await expect(
      searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), minSimilarity: Infinity }),
    ).rejects.toThrow(SearchValidationError);
  });
});

async function fixtureContactWithEmbedding(
  organizationId: string,
  vector: number[],
  overrides: { firstName?: string } = {},
): Promise<{ contactId: string; profileId: string; embeddingId: string }> {
  const contact = await seedContact(organizationId, overrides);
  const profile = await seedProfile(organizationId, "contact_id", contact.id);
  const result = await upsertEntityEmbedding(
    { organizationId },
    { entityType: "contact", entityId: contact.id, chunkText: "fixture", embedding: vector, sourceVersionAt: profile.computedAt },
  );
  if (result.status !== "created") throw new Error("fixture setup failed");
  return { contactId: contact.id, profileId: profile.id, embeddingId: result.embeddingId };
}

describe("searchEntityProfilesByEmbedding: ranking correctness", () => {
  it("an identical vector ranks first with similarity 1", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const exact = await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: "Exact" });
    await fixtureContactWithEmbedding(organizationId, basisVector(1), { firstName: "Orthogonal" });

    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(results[0]!.entityProfileId).toBe(exact.profileId);
    expect(results[0]!.similarity).toBeCloseTo(1, 5);
  });

  it("known cosine ranking order: exact match > 45-degree > orthogonal > opposite", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const exact = await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: "Exact" });
    const fortyFive = await fixtureContactWithEmbedding(organizationId, fortyFiveDegreesFromE0(), { firstName: "FortyFive" });
    const orthogonal = await fixtureContactWithEmbedding(organizationId, basisVector(1), { firstName: "Orthogonal" });
    const opposite = await fixtureContactWithEmbedding(organizationId, basisVector(0, -1), { firstName: "Opposite" });

    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), limit: 10 });
    const order = results.map((r) => r.entityProfileId);
    expect(order).toEqual([exact.profileId, fortyFive.profileId, orthogonal.profileId, opposite.profileId]);

    expect(results[0]!.similarity).toBeCloseTo(1, 5);
    expect(results[1]!.similarity).toBeCloseTo(1 / Math.sqrt(2), 5);
    expect(results[2]!.similarity).toBeCloseTo(0, 5);
    expect(results[3]!.similarity).toBeCloseTo(-1, 5);
  });

  it("deterministic ordering for equal-similarity rows (tie-broken by entity_profile_id ASC)", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    // Two DIFFERENT contacts, byte-identical embedding vectors -> identical similarity.
    const a = await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: "TieA" });
    const b = await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: "TieB" });

    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    const tied = results.filter((r) => r.entityProfileId === a.profileId || r.entityProfileId === b.profileId);
    expect(tied).toHaveLength(2);
    const expectedOrder = [a.profileId, b.profileId].sort();
    expect(tied.map((r) => r.entityProfileId)).toEqual(expectedOrder);
  });
});

describe("searchEntityProfilesByEmbedding: tenant isolation", () => {
  it("same-tenant retrieval returns the org's own fixture", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const fixture = await fixtureContactWithEmbedding(organizationId, basisVector(0));
    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(results.map((r) => r.entityProfileId)).toContain(fixture.profileId);
  });

  it("cross-tenant rows are completely invisible, even with an identical query vector", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    await fixtureContactWithEmbedding(orgB.organizationId, basisVector(0), { firstName: "OrgBExact" });

    const resultsForA = await searchEntityProfilesByEmbedding({ organizationId: orgA.organizationId }, { queryVector: basisVector(0) });
    expect(resultsForA).toHaveLength(0);
  });

  it("explicit tenant predicate: org A's own real embedding is unaffected by org B also holding data", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const fixtureA = await fixtureContactWithEmbedding(orgA.organizationId, basisVector(0), { firstName: "OrgA" });
    await fixtureContactWithEmbedding(orgB.organizationId, basisVector(0), { firstName: "OrgB" });

    const resultsForA = await searchEntityProfilesByEmbedding({ organizationId: orgA.organizationId }, { queryVector: basisVector(0) });
    expect(resultsForA).toHaveLength(1);
    expect(resultsForA[0]!.entityProfileId).toBe(fixtureA.profileId);
  });
});

describe("searchEntityProfilesByEmbedding: freshness policy", () => {
  it("a fresh embedding (source_version_at >= computed_at) is included", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const fixture = await fixtureContactWithEmbedding(organizationId, basisVector(0));
    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(results.map((r) => r.entityProfileId)).toContain(fixture.profileId);
  });

  it("a stale embedding (profile recomputed AFTER the embedding was written) is excluded from the candidate set entirely", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const fixture = await fixtureContactWithEmbedding(organizationId, basisVector(0));

    // Simulate a later profile recomputation the embedding never caught up to.
    await seedAsAdmin(async (client) => {
      await client.query("update public.brain_entity_profiles set computed_at = now() + interval '1 hour' where id = $1", [fixture.profileId]);
    });

    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(results.map((r) => r.entityProfileId)).not.toContain(fixture.profileId);
  });

  it("a profile with no embedding row at all is simply absent, never an error", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contact = await seedContact(organizationId);
    await seedProfile(organizationId, "contact_id", contact.id);
    // No upsertEntityEmbedding call at all.

    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(results).toEqual([]);
  });
});

describe("searchEntityProfilesByEmbedding: GDPR erasure interaction", () => {
  it("a hard-erased contact's embedding can never be returned by search", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const fixture = await fixtureContactWithEmbedding(organizationId, basisVector(0));

    const before = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(before.map((r) => r.entityProfileId)).toContain(fixture.profileId);

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.contacts where id = $1", [fixture.contactId]);
    });

    const after = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(after.map((r) => r.entityProfileId)).not.toContain(fixture.profileId);
  });
});

describe("searchEntityProfilesByEmbedding: entityType filtering", () => {
  it("filters to only the requested entity type, same-tenant", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contactFixture = await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: "FilterContact" });

    const company = await seedCompany(organizationId);
    const companyProfile = await seedProfile(organizationId, "company_id", company.id);
    const companyResult = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "company", entityId: company.id, chunkText: "fixture", embedding: basisVector(0), sourceVersionAt: companyProfile.computedAt },
    );
    if (companyResult.status !== "created") throw new Error("fixture setup failed");

    const contactsOnly = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), entityType: "contact" });
    expect(contactsOnly.every((r) => r.entityType === "contact")).toBe(true);
    expect(contactsOnly.map((r) => r.entityProfileId)).toContain(contactFixture.profileId);
    expect(contactsOnly.map((r) => r.entityProfileId)).not.toContain(companyProfile.id);

    const companiesOnly = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), entityType: "company" });
    expect(companiesOnly.every((r) => r.entityType === "company")).toBe(true);
    expect(companiesOnly.map((r) => r.entityProfileId)).toContain(companyProfile.id);
  });
});

describe("searchEntityProfilesByEmbedding: minSimilarity filtering", () => {
  it("excludes candidates below the threshold", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const close = await fixtureContactWithEmbedding(organizationId, fortyFiveDegreesFromE0(), { firstName: "Close" });
    const far = await fixtureContactWithEmbedding(organizationId, basisVector(1), { firstName: "Far" });

    // 45-degree similarity is ~0.707; orthogonal is 0. A threshold of 0.5 keeps the close one, drops the far one.
    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), minSimilarity: 0.5 });
    expect(results.map((r) => r.entityProfileId)).toContain(close.profileId);
    expect(results.map((r) => r.entityProfileId)).not.toContain(far.profileId);
  });
});

describe("searchEntityProfilesByEmbedding: limit boundaries", () => {
  it("defaults to SEARCH_DEFAULT_LIMIT results when omitted", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    for (let i = 0; i < SEARCH_DEFAULT_LIMIT + 5; i++) {
      await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: `Bulk${i}` });
    }
    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(results).toHaveLength(SEARCH_DEFAULT_LIMIT);
  });

  it("respects an explicit limit up to SEARCH_MAX_LIMIT", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    for (let i = 0; i < 5; i++) {
      await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: `Small${i}` });
    }
    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), limit: 2 });
    expect(results).toHaveLength(2);
  });
});

describe("searchEntityProfilesByEmbedding: zero results", () => {
  it("returns an empty array, never an error, when nothing matches", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(results).toEqual([]);
  });
});

describe("searchEntityProfilesByEmbedding: minimized result shape", () => {
  it("never returns chunk_text, raw embedding, or any CRM field", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: "SecretFirstName" });

    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]!).sort()).toEqual(["entityId", "entityProfileId", "entityType", "similarity", "sourceVersionAt"]);
    const serialized = JSON.stringify(results[0]);
    expect(serialized).not.toContain("SecretFirstName");
    expect(serialized).not.toContain("chunk_text");
  });
});

/**
 * Final Implementation Acceptance Audit correction — stored zero-norm
 * embedding defense. Phase 3's write contract (dimension/finiteness only)
 * still permits an all-zero stored vector, so a historical row may already
 * exist; these regressions prove the SQL-side `vector_norm(be.embedding) >
 * 0` candidate predicate structurally excludes it — before similarity
 * projection, minSimilarity filtering, ordering, and limit — using the
 * REAL upsertEntityEmbedding write path to create the zero-norm fixture
 * (never a second, divergent construction path).
 */
async function fixtureContactWithZeroEmbedding(
  organizationId: string,
  overrides: { firstName?: string } = {},
): Promise<{ contactId: string; profileId: string; embeddingId: string }> {
  const contact = await seedContact(organizationId, overrides);
  const profile = await seedProfile(organizationId, "contact_id", contact.id);
  const result = await upsertEntityEmbedding(
    { organizationId },
    { entityType: "contact", entityId: contact.id, chunkText: "zero-norm fixture", embedding: zeroVector(), sourceVersionAt: profile.computedAt },
  );
  if (result.status !== "created") throw new Error("zero-norm fixture setup failed");
  return { contactId: contact.id, profileId: profile.id, embeddingId: result.embeddingId };
}

describe("searchEntityProfilesByEmbedding: stored zero-norm embedding defense", () => {
  it("Phase 3's write path still accepts a zero-norm embedding (proves the defense is genuinely needed, not hypothetical)", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const contact = await seedContact(organizationId);
    const profile = await seedProfile(organizationId, "contact_id", contact.id);
    const result = await upsertEntityEmbedding(
      { organizationId },
      { entityType: "contact", entityId: contact.id, chunkText: "x", embedding: zeroVector(), sourceVersionAt: profile.computedAt },
    );
    expect(result.status).toBe("created");
  });

  it("minSimilarity regression: a zero-norm stored row is excluded at minSimilarity 1, 0, and -1 — every threshold", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await fixtureContactWithZeroEmbedding(organizationId, { firstName: "ZeroNormRow" });

    for (const minSimilarity of [1, 0, -1]) {
      const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), minSimilarity });
      expect(results).toEqual([]);
    }
  });

  it("mixed-candidate regression: a valid embedding ranks normally, the zero-norm row never appears, and every returned similarity is a finite number", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const valid = await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: "ValidRow" });
    await fixtureContactWithZeroEmbedding(organizationId, { firstName: "ZeroNormRow" });

    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0) });

    expect(results.map((r) => r.entityProfileId)).toContain(valid.profileId);
    expect(results).toHaveLength(1);
    for (const r of results) {
      expect(typeof r.similarity).toBe("number");
      expect(Number.isFinite(r.similarity)).toBe(true);
      expect(Number.isNaN(r.similarity)).toBe(false);
    }
  });

  it("finite similarity guarantee holds across the full accepted fixture set, verified against real Postgres data", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    await fixtureContactWithEmbedding(organizationId, basisVector(0), { firstName: "Exact" });
    await fixtureContactWithEmbedding(organizationId, fortyFiveDegreesFromE0(), { firstName: "FortyFive" });
    await fixtureContactWithEmbedding(organizationId, basisVector(1), { firstName: "Orthogonal" });
    await fixtureContactWithEmbedding(organizationId, basisVector(0, -1), { firstName: "Opposite" });
    await fixtureContactWithZeroEmbedding(organizationId, { firstName: "ZeroNormRow" });

    const results = await searchEntityProfilesByEmbedding({ organizationId }, { queryVector: basisVector(0), limit: SEARCH_MAX_LIMIT });
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(typeof r.similarity).toBe("number");
      expect(Number.isFinite(r.similarity)).toBe(true);
    }
  });
});
