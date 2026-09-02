import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { generateApiKey } from "@ai-revenue-os/auth";
import { adminPool, seedCompany, seedContact } from "./crm-api-fixtures";
import { handleRecordContactEnrichment } from "../app/api/v1/contacts/[id]/enrichment/handlers";
import { handleRecordCompanyEnrichment } from "../app/api/v1/companies/[id]/enrichment/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.3E — HTTP-level coverage for the API-key-authenticated
 * enrichment write-back endpoints. Direct handler invocation, no running
 * server, real Postgres — mirrors tracking-sites-public-keys-api.test.ts's
 * own style. No mocking of authentication at all: a real api_keys row is
 * issued and presented as a real Bearer header, exactly how n8n would.
 */

async function seedOrg(): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Enrichment API Test Org', $1) returning id",
      [`enrichment-api-org-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function issueApiKey(organizationId: string, scopes: string[] = ["enrichment:write"], revoked = false): Promise<string> {
  const { plaintext, keyHash, keyPrefix } = generateApiKey("test");
  const client = await adminPool.connect();
  try {
    await client.query(
      "insert into public.api_keys (organization_id, name, key_hash, key_prefix, scopes, revoked_at) values ($1, $2, $3, $4, $5, $6)",
      [organizationId, "Test n8n Key", keyHash, keyPrefix, JSON.stringify(scopes), revoked ? new Date().toISOString() : null],
    );
    return plaintext;
  } finally {
    client.release();
  }
}

function enrichmentRequest(body: unknown, authorization?: string): Request {
  return new Request("https://example.test/api/v1/contacts/x/enrichment", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
  });
}

afterAll(async () => {
  // adminPool (crm-api-fixtures.ts) is getPool() itself — the same
  // underlying pool closePool() already closes; calling both would
  // double-close it.
  await closePool();
});

describe("POST /api/v1/contacts/[id]/enrichment: authentication", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const response = await handleRecordContactEnrichment(
      enrichmentRequest({ provider: "test", status: "completed" }),
      contactId,
    );
    expect(response.status).toBe(401);
  });

  it("rejects a revoked key with 401", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const key = await issueApiKey(orgId, ["enrichment:write"], true);
    const response = await handleRecordContactEnrichment(
      enrichmentRequest({ provider: "test", status: "completed" }, `Bearer ${key}`),
      contactId,
    );
    expect(response.status).toBe(401);
  });

  it("rejects a valid key lacking the enrichment:write scope with 403", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const key = await issueApiKey(orgId, ["some:other-scope"]);
    const response = await handleRecordContactEnrichment(
      enrichmentRequest({ provider: "test", status: "completed" }, `Bearer ${key}`),
      contactId,
    );
    expect(response.status).toBe(403);
  });

  it("accepts a valid, correctly-scoped key", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const key = await issueApiKey(orgId);
    const response = await handleRecordContactEnrichment(
      enrichmentRequest({ provider: "test", status: "completed" }, `Bearer ${key}`),
      contactId,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe("accepted");
  });
});

describe("POST /api/v1/contacts/[id]/enrichment: tenant isolation", () => {
  it("a key scoped to org A cannot write enrichment for a contact belonging to org B — rejected, indistinguishable from not-found", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const contactInOrgB = await seedContact(orgB);
    const keyForOrgA = await issueApiKey(orgA);

    const response = await handleRecordContactEnrichment(
      enrichmentRequest({ provider: "test", status: "completed" }, `Bearer ${keyForOrgA}`),
      contactInOrgB,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string; reason?: string };
    expect(body).toEqual({ result: "rejected", reason: "entity_not_found" });

    const row = await adminPool.query("select id from public.contact_enrichment where contact_id = $1", [contactInOrgB]);
    expect(row.rows).toHaveLength(0);
  });
});

describe("POST /api/v1/contacts/[id]/enrichment: request validation", () => {
  it("rejects an unknown field with 400", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const key = await issueApiKey(orgId);
    const response = await handleRecordContactEnrichment(
      enrichmentRequest({ provider: "test", status: "completed", extra: "nope" }, `Bearer ${key}`),
      contactId,
    );
    expect(response.status).toBe(400);
  });

  it("rejects an invalid status value with 400", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const key = await issueApiKey(orgId);
    const response = await handleRecordContactEnrichment(
      enrichmentRequest({ provider: "test", status: "done" }, `Bearer ${key}`),
      contactId,
    );
    expect(response.status).toBe(400);
  });

  it("rejects a workflowKey field entirely — it has no extraction path, it is always the fixed server-side constant", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const key = await issueApiKey(orgId);
    const response = await handleRecordContactEnrichment(
      enrichmentRequest({ provider: "test", status: "completed", workflowKey: "something-else" }, `Bearer ${key}`),
      contactId,
    );
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    const key = await issueApiKey(orgId);
    const response = await handleRecordContactEnrichment(
      new Request("https://example.test/x", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      }),
      contactId,
    );
    expect(response.status).toBe(400);
  });

  it("rejects a malformed contact id with 404", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    const response = await handleRecordContactEnrichment(
      enrichmentRequest({ provider: "test", status: "completed" }, `Bearer ${key}`),
      "not-a-uuid",
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /api/v1/companies/[id]/enrichment", () => {
  it("mirrors the contact endpoint's own authentication/validation/write behavior", async () => {
    const orgId = await seedOrg();
    const companyId = await seedCompany(orgId);
    const key = await issueApiKey(orgId);

    const response = await handleRecordCompanyEnrichment(
      new Request("https://example.test/api/v1/companies/x/enrichment", {
        method: "POST",
        body: JSON.stringify({ provider: "test", status: "completed", normalizedResult: { industry: "SaaS" } }),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      }),
      companyId,
    );
    expect(response.status).toBe(200);

    const row = await adminPool.query("select normalized_result from public.company_enrichment where company_id = $1", [
      companyId,
    ]);
    expect(row.rows[0].normalized_result).toEqual({ industry: "SaaS" });
  });
});

describe("POST /api/v1/contacts/[id]/enrichment: rate limiting", () => {
  it("the per-organization rate limit (30/min) rejects the 31st trigger with 429", async () => {
    const orgId = await seedOrg();
    const key = await issueApiKey(orgId);
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      const contactId = await seedContact(orgId);
      last = await handleRecordContactEnrichment(
        enrichmentRequest({ provider: "test", status: "completed" }, `Bearer ${key}`),
        contactId,
      );
    }
    expect(last!.status).toBe(429);
  });
});
