import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { generateApiKey } from "@ai-revenue-os/auth";
import { adminPool, seedContact } from "./crm-api-fixtures";
import { handleSearchBrainEmbeddings } from "../app/api/v1/brain/search/handlers";
import { POST } from "../app/api/v1/brain/search/route";
import { handleWriteBrainEmbedding } from "../app/api/v1/brain/embeddings/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.1 Phase 4 — HTTP-level coverage for
 * POST /api/v1/brain/search, mirroring brain-embeddings-api.test.ts's own
 * style exactly (Milestone 4.1 Phase 3 precedent): direct handler
 * invocation, no running server, real Postgres, a real api_keys row
 * issued and presented as a real Bearer header — no mocking of
 * authentication. Fixture embeddings are written through the real
 * POST /api/v1/brain/embeddings write-back handler (not a second,
 * divergent construction path).
 */

afterAll(async () => {
  await closePool();
});

async function seedOrg(): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Brain Search API Test Org', $1) returning id",
      [`brain-search-api-org-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function seedProfile(organizationId: string, contactId: string, computedAt = new Date().toISOString()): Promise<{ id: string; computedAt: string }> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string; computed_at: string }>(
      `insert into public.brain_entity_profiles (organization_id, entity_type, contact_id, profile, computed_at)
       values ($1, 'contact', $2, '{}'::jsonb, $3) returning id, computed_at`,
      [organizationId, contactId, computedAt],
    );
    return { id: r.rows[0]!.id, computedAt: r.rows[0]!.computed_at };
  } finally {
    client.release();
  }
}

async function issueApiKey(organizationId: string, scopes: string[] = ["brain:embeddings:read"], revoked = false): Promise<string> {
  const { plaintext, keyHash, keyPrefix } = generateApiKey("test");
  const client = await adminPool.connect();
  try {
    await client.query(
      "insert into public.api_keys (organization_id, name, key_hash, key_prefix, scopes, revoked_at) values ($1, $2, $3, $4, $5, $6)",
      [organizationId, "Test n8n Search Key", keyHash, keyPrefix, JSON.stringify(scopes), revoked ? new Date().toISOString() : null],
    );
    return plaintext;
  } finally {
    client.release();
  }
}

function fakeVector(dim = 0, magnitude = 1): number[] {
  const v = new Array(1536).fill(0);
  v[dim] = magnitude;
  return v;
}

function searchRequest(body: unknown, authorization?: string): Request {
  return new Request("https://example.test/api/v1/brain/search", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
  });
}

function embeddingWriteRequest(body: unknown, authorization?: string): Request {
  return new Request("https://example.test/api/v1/brain/embeddings", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
  });
}

async function seedFixtureEmbedding(organizationId: string, vector: number[]): Promise<{ contactId: string; profileId: string }> {
  const contactId = await seedContact(organizationId);
  const profile = await seedProfile(organizationId, contactId);
  const writeKey = await issueApiKey(organizationId, ["brain:embeddings:write"]);
  const response = await handleWriteBrainEmbedding(
    embeddingWriteRequest(
      { entityType: "contact", entityId: contactId, chunkText: "fixture", embedding: vector, sourceVersionAt: profile.computedAt },
      `Bearer ${writeKey}`,
    ),
  );
  if (response.status !== 200) throw new Error("fixture write-back failed");
  const body = (await response.json()) as { result: string };
  if (body.result !== "accepted") throw new Error(`fixture write-back rejected: ${JSON.stringify(body)}`);
  return { contactId, profileId: profile.id };
}

describe("POST /api/v1/brain/search: authentication", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector() }));
    expect(response.status).toBe(401);
  });

  it("rejects a revoked key with 401", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId, ["brain:embeddings:read"], true);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector() }, `Bearer ${key}`));
    expect(response.status).toBe(401);
  });

  it("rejects a valid key lacking the brain:embeddings:read scope with 403", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId, ["some:other-scope"]);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector() }, `Bearer ${key}`));
    expect(response.status).toBe(403);
  });

  it("a key scoped only for brain:embeddings:write cannot search (scopes are not implicitly bidirectional)", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId, ["brain:embeddings:write"]);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector() }, `Bearer ${key}`));
    expect(response.status).toBe(403);
  });

  it("accepts a valid, correctly-scoped key and returns a real ranked result", async () => {
    const orgId = await seedOrg();
    const fixture = await seedFixtureEmbedding(orgId, fakeVector(0));
    const key = await issueApiKey(orgId);

    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector(0) }, `Bearer ${key}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: Array<{ entityProfileId: string; similarity: number }> };
    expect(body.results.map((r) => r.entityProfileId)).toContain(fixture.profileId);
    const own = body.results.find((r) => r.entityProfileId === fixture.profileId)!;
    expect(own.similarity).toBeCloseTo(1, 5);
  });
});

describe("POST /api/v1/brain/search: tenant isolation", () => {
  it("a key scoped to org A never observes org B's embeddings, even with an identical query vector", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    await seedFixtureEmbedding(orgB, fakeVector(0));
    const keyForOrgA = await issueApiKey(orgA);

    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector(0) }, `Bearer ${keyForOrgA}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });
});

describe("POST /api/v1/brain/search: request validation", () => {
  it("rejects an unknown field with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(
      searchRequest({ queryVector: fakeVector(), query: "not allowed" }, `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a query field (query text is never accepted)", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(searchRequest({ query: "find me a contact" }, `Bearer ${key}`));
    expect(response.status).toBe(400);
  });

  it("rejects a wrong-dimension queryVector with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector().slice(0, 10) }, `Bearer ${key}`));
    expect(response.status).toBe(400);
  });

  it("rejects a NaN element with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const bad = fakeVector();
    bad[3] = NaN;
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: bad }, `Bearer ${key}`));
    expect(response.status).toBe(400);
  });

  it("rejects an all-zero queryVector with 400 (Final Implementation Acceptance Audit correction) — no results, no similarity computed", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: new Array(1536).fill(0) }, `Bearer ${key}`));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid limit with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector(), limit: 0 }, `Bearer ${key}`));
    expect(response.status).toBe(400);
  });

  it("rejects a limit exceeding SEARCH_MAX_LIMIT with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector(), limit: 51 }, `Bearer ${key}`));
    expect(response.status).toBe(400);
  });

  it("rejects an invalid entityType with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector(), entityType: "invalid" }, `Bearer ${key}`));
    expect(response.status).toBe(400);
  });

  it("rejects a minSimilarity outside [-1, 1] with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector(), minSimilarity: 2 }, `Bearer ${key}`));
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(
      new Request("https://example.test/api/v1/brain/search", {
        method: "POST",
        body: "{not valid json",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/v1/brain/search: zero results", () => {
  it("returns 200 with an empty results array when nothing matches", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector() }, `Bearer ${key}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });
});

describe("POST /api/v1/brain/search: result shape", () => {
  it("never returns raw embedding values or chunk content in the response body", async () => {
    const orgId = await seedOrg();
    await seedFixtureEmbedding(orgId, fakeVector(0));
    const key = await issueApiKey(orgId);

    const response = await handleSearchBrainEmbeddings(searchRequest({ queryVector: fakeVector(0) }, `Bearer ${key}`));
    const body = (await response.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      expect(Object.keys(result).sort()).toEqual(["entityId", "entityProfileId", "entityType", "similarity", "sourceVersionAt"]);
    }
  });
});

describe("POST /api/v1/brain/search: PII/logging safety", () => {
  it("the real, logging-wrapped route's structured completion log line never contains the query vector's values", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);

    // A vector with a highly distinctive, unlikely-to-collide magnitude.
    const distinctiveVector = fakeVector(7, 0.123456789);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let recordedCalls: unknown[][];
    try {
      const response = await POST(searchRequest(distinctiveVector.length ? { queryVector: distinctiveVector } : {}, `Bearer ${key}`) as never);
      expect(response.status).toBe(200);
      recordedCalls = logSpy.mock.calls;
    } finally {
      logSpy.mockRestore();
    }

    expect(recordedCalls.length).toBeGreaterThan(0);
    for (const call of recordedCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("0.123456789");
    }
  });

  it("an all-zero queryVector rejected with 400 is never logged either (Final Implementation Acceptance Audit correction)", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let recordedCalls: unknown[][];
    try {
      const response = await POST(searchRequest({ queryVector: new Array(1536).fill(0) }, `Bearer ${key}`) as never);
      expect(response.status).toBe(400);
      recordedCalls = logSpy.mock.calls;
    } finally {
      logSpy.mockRestore();
    }

    expect(recordedCalls.length).toBeGreaterThan(0);
    for (const call of recordedCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("queryVector");
      expect(serialized).not.toContain("[0,0,0");
    }
  });
});
