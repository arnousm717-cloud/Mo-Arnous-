import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { generateApiKey } from "@ai-revenue-os/auth";
import { adminPool, seedContact } from "./crm-api-fixtures";
import { handleWriteBrainEmbedding } from "../app/api/v1/brain/embeddings/handlers";
import { POST } from "../app/api/v1/brain/embeddings/route";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.1 Phase 3 — HTTP-level coverage for
 * POST /api/v1/brain/embeddings, mirroring enrichment-write-back-api.
 * test.ts's own style exactly (Milestone 3.3E precedent): direct handler
 * invocation, no running server, real Postgres, a real api_keys row
 * issued and presented as a real Bearer header "exactly how n8n would" —
 * no mocking of authentication, and no real embedding-provider call
 * anywhere (this route never makes one; the test payload's own vector is
 * a synthetic fixture, matching what an already-computed n8n result would
 * look like).
 */

afterAll(async () => {
  await closePool();
});

async function seedOrg(): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Brain Embeddings API Test Org', $1) returning id",
      [`brain-embed-api-org-${randomUUID()}`],
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

async function issueApiKey(organizationId: string, scopes: string[] = ["brain:embeddings:write"], revoked = false): Promise<string> {
  const { plaintext, keyHash, keyPrefix } = generateApiKey("test");
  const client = await adminPool.connect();
  try {
    await client.query(
      "insert into public.api_keys (organization_id, name, key_hash, key_prefix, scopes, revoked_at) values ($1, $2, $3, $4, $5, $6)",
      [organizationId, "Test n8n Brain Key", keyHash, keyPrefix, JSON.stringify(scopes), revoked ? new Date().toISOString() : null],
    );
    return plaintext;
  } finally {
    client.release();
  }
}

function fakeVector(seed = 0): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.01);
}

function embeddingRequest(body: unknown, authorization?: string): Request {
  return new Request("https://example.test/api/v1/brain/embeddings", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
  });
}

function validBody(overrides: Partial<{ entityType: string; entityId: string; chunkText: string; embedding: number[]; sourceVersionAt: string }> = {}) {
  return {
    entityType: "contact",
    entityId: randomUUID(),
    chunkText: "a canonical profile chunk",
    embedding: fakeVector(),
    sourceVersionAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("POST /api/v1/brain/embeddings: authentication", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const response = await handleWriteBrainEmbedding(embeddingRequest(validBody()));
    expect(response.status).toBe(401);
  });

  it("rejects a revoked key with 401", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId, ["brain:embeddings:write"], true);
    const response = await handleWriteBrainEmbedding(embeddingRequest(validBody(), `Bearer ${key}`));
    expect(response.status).toBe(401);
  });

  it("rejects a valid key lacking the brain:embeddings:write scope with 403", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId, ["some:other-scope"]);
    const response = await handleWriteBrainEmbedding(embeddingRequest(validBody(), `Bearer ${key}`));
    expect(response.status).toBe(403);
  });

  it("accepts a valid, correctly-scoped key against a real existing profile", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const profile = await seedProfile(orgId, contactId);
    const key = await issueApiKey(orgId);

    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ entityId: contactId, sourceVersionAt: profile.computedAt }), `Bearer ${key}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string; status?: string; embeddingId?: string };
    expect(body.result).toBe("accepted");
    expect(body.status).toBe("created");
    expect(body.embeddingId).toBeTruthy();
  });
});

describe("POST /api/v1/brain/embeddings: tenant isolation", () => {
  it("a key scoped to org A cannot attach an embedding to org B's contact — rejected as entity_not_found, indistinguishable from a genuinely missing profile", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const contactInB = await seedContact(orgB);
    await seedProfile(orgB, contactInB);
    const keyForOrgA = await issueApiKey(orgA);

    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ entityId: contactInB }), `Bearer ${keyForOrgA}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string; reason?: string };
    expect(body).toEqual({ result: "rejected", reason: "entity_not_found" });

    const row = await adminPool.query("select id from public.brain_embeddings where organization_id = $1", [orgA]);
    expect(row.rows).toHaveLength(0);
  });
});

describe("POST /api/v1/brain/embeddings: request validation", () => {
  it("rejects an unknown field with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleWriteBrainEmbedding(
      embeddingRequest({ ...validBody(), extra: "nope" }, `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an invalid entityType with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ entityType: "not-a-real-type" }), `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a malformed entityId with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ entityId: "not-a-uuid" }), `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an empty chunkText with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ chunkText: "" }), `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a too-short embedding with 400 (dimension validation)", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ embedding: fakeVector().slice(0, 100) }), `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a too-long embedding with 400 (dimension validation)", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ embedding: [...fakeVector(), 0] }), `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a non-numeric embedding element with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const bad = fakeVector();
    (bad as unknown[])[5] = "not-a-number";
    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ embedding: bad }), `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a NaN embedding element with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const bad = fakeVector();
    bad[5] = NaN;
    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ embedding: bad }), `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an invalid sourceVersionAt with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ sourceVersionAt: "not-a-date" }), `Bearer ${key}`),
    );
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleWriteBrainEmbedding(
      new Request("https://example.test/api/v1/brain/embeddings", {
        method: "POST",
        body: "{not valid json",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/v1/brain/embeddings: idempotency and staleness", () => {
  it("a duplicate POST (identical body) is idempotent — second call returns 'unchanged', no error, same embeddingId", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const profile = await seedProfile(orgId, contactId);
    const key = await issueApiKey(orgId);
    const body = validBody({ entityId: contactId, sourceVersionAt: profile.computedAt });

    const first = await handleWriteBrainEmbedding(embeddingRequest(body, `Bearer ${key}`));
    const firstBody = (await first.json()) as { embeddingId: string };

    const second = await handleWriteBrainEmbedding(embeddingRequest(body, `Bearer ${key}`));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { result: string; status: string; embeddingId: string };
    expect(secondBody.status).toBe("unchanged");
    expect(secondBody.embeddingId).toBe(firstBody.embeddingId);
  });

  it("a stale POST (sourceVersionAt older than the current profile) is rejected, never overwriting stored state", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const profile = await seedProfile(orgId, contactId, "2026-06-01T00:00:00.000Z");
    const key = await issueApiKey(orgId);

    const fresh = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ entityId: contactId, chunkText: "fresh chunk", sourceVersionAt: profile.computedAt }), `Bearer ${key}`),
    );
    expect(fresh.status).toBe(200);

    const stale = await handleWriteBrainEmbedding(
      embeddingRequest(validBody({ entityId: contactId, chunkText: "stale chunk", sourceVersionAt: "2020-01-01T00:00:00.000Z" }), `Bearer ${key}`),
    );
    expect(stale.status).toBe(200);
    const staleBody = (await stale.json()) as { result: string; reason?: string };
    expect(staleBody).toEqual({ result: "rejected", reason: "stale" });

    const row = await adminPool.query<{ chunk_text: string }>(
      "select chunk_text from public.brain_embeddings where organization_id = $1 and entity_profile_id = $2",
      [orgId, profile.id],
    );
    expect(row.rows[0]!.chunk_text).toBe("fresh chunk");
  });

  it("a POST for an entity with no profile row is rejected as entity_not_found, no row written", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleWriteBrainEmbedding(embeddingRequest(validBody(), `Bearer ${key}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string; reason?: string };
    expect(body).toEqual({ result: "rejected", reason: "entity_not_found" });
  });
});

describe("POST /api/v1/brain/embeddings: PII/logging safety", () => {
  it("the real, logging-wrapped route's structured completion log line never contains the chunkText content or any embedding value", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const profile = await seedProfile(orgId, contactId);
    const key = await issueApiKey(orgId);

    const secretMarker = `unmistakable-chunk-marker-${randomUUID()}`;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let recordedCalls: unknown[][];
    try {
      // Deliberately POST (the actual withRequestLogging-wrapped route
      // export), not handleWriteBrainEmbedding directly — the logging
      // behavior under test lives entirely in that wrapper, not the
      // handler, so this must exercise the real route to mean anything.
      const response = await POST(
        embeddingRequest(validBody({ entityId: contactId, chunkText: secretMarker, sourceVersionAt: profile.computedAt }), `Bearer ${key}`) as never,
      );
      expect(response.status).toBe(200);
      // Captured BEFORE mockRestore() — mockRestore() also clears
      // recorded .mock.calls (it's mockReset() + restoring the original
      // implementation), so reading it afterward would always see zero.
      recordedCalls = logSpy.mock.calls;
    } finally {
      logSpy.mockRestore();
    }

    // At least one structured log line was actually emitted (proves this
    // test exercises real logging, not a vacuously-empty spy).
    expect(recordedCalls.length).toBeGreaterThan(0);

    // _shared/logger.ts's own StructuredLogFields type has no field for a
    // request body at all — this is the empirical proof: no console.log
    // call anywhere in the real route's execution path ever received the
    // secret chunk text or a numeric vector value.
    for (const call of recordedCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(secretMarker);
      expect(serialized).not.toMatch(/-?0\.0[0-9]{5,}/); // a fakeVector()-shaped float
    }
  });
});
