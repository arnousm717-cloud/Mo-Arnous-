import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import { generateApiKey } from "../src/api-keys";
import { parseBearerApiKey, resolveServiceActorFromApiKey, hasScope } from "../src/service-auth";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.3B — service-to-service authentication coverage. Real
 * Postgres throughout (no mocks), mirroring tracking-context.test.ts's
 * own established fixture style: getPool() as the admin-equivalent
 * connection.
 */

afterAll(async () => {
  await closePool();
});

async function seedOrg(label: string): Promise<string> {
  const client = await getPool().connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      [label, `service-auth-${label}-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function issueKey(
  organizationId: string,
  opts: { scopes?: string[]; revoked?: boolean } = {},
): Promise<{ plaintext: string; apiKeyId: string }> {
  const { plaintext, keyHash, keyPrefix } = generateApiKey("test");
  const client = await getPool().connect();
  try {
    const r = await client.query<{ id: string }>(
      `insert into public.api_keys (organization_id, name, key_hash, key_prefix, scopes, revoked_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        organizationId,
        "Test Key",
        keyHash,
        keyPrefix,
        JSON.stringify(opts.scopes ?? []),
        opts.revoked ? new Date().toISOString() : null,
      ],
    );
    return { plaintext, apiKeyId: r.rows[0]!.id };
  } finally {
    client.release();
  }
}

describe("parseBearerApiKey: structural pre-check, no DB", () => {
  it("accepts a well-formed Bearer arev_test_ token", () => {
    expect(parseBearerApiKey("Bearer arev_test_abc123")).toBe("arev_test_abc123");
  });

  it("accepts a well-formed Bearer arev_live_ token", () => {
    expect(parseBearerApiKey("Bearer arev_live_abc123")).toBe("arev_live_abc123");
  });

  it("rejects null", () => {
    expect(parseBearerApiKey(null)).toBeNull();
  });

  it("rejects a missing Bearer prefix", () => {
    expect(parseBearerApiKey("arev_test_abc123")).toBeNull();
  });

  it("rejects a non-arev token, even if otherwise well-formed as Bearer", () => {
    expect(parseBearerApiKey("Bearer sk_live_someOtherProvider")).toBeNull();
  });

  it("rejects an empty token", () => {
    expect(parseBearerApiKey("Bearer ")).toBeNull();
  });

  it("rejects an oversized token", () => {
    expect(parseBearerApiKey(`Bearer arev_test_${"a".repeat(200)}`)).toBeNull();
  });

  it("rejects a session-cookie-shaped header (never treated as an API key)", () => {
    expect(parseBearerApiKey("Cookie sb-access-token=xyz")).toBeNull();
  });
});

describe("resolveServiceActorFromApiKey: real DB resolution", () => {
  it("a valid, unrevoked key resolves to its own organization and scopes", async () => {
    const orgId = await seedOrg("valid");
    const { plaintext } = await issueKey(orgId, { scopes: ["enrichment:write"] });

    const actor = await resolveServiceActorFromApiKey(`Bearer ${plaintext}`);
    expect(actor).not.toBeNull();
    expect(actor!.organizationId).toBe(orgId);
    expect(actor!.scopes).toEqual(["enrichment:write"]);
  });

  it("a key with no scopes resolves with an empty scopes array, not null/undefined", async () => {
    const orgId = await seedOrg("noscopes");
    const { plaintext } = await issueKey(orgId);

    const actor = await resolveServiceActorFromApiKey(`Bearer ${plaintext}`);
    expect(actor!.scopes).toEqual([]);
  });

  it("a revoked key resolves to null — indistinguishable from nonexistent", async () => {
    const orgId = await seedOrg("revoked");
    const { plaintext } = await issueKey(orgId, { revoked: true });

    const actor = await resolveServiceActorFromApiKey(`Bearer ${plaintext}`);
    expect(actor).toBeNull();
  });

  it("a well-formed but never-issued key resolves to null", async () => {
    const { plaintext } = generateApiKey("test");
    const actor = await resolveServiceActorFromApiKey(`Bearer ${plaintext}`);
    expect(actor).toBeNull();
  });

  it("a structurally malformed header resolves to null without ever reaching the database", async () => {
    const actor = await resolveServiceActorFromApiKey("not-a-bearer-header");
    expect(actor).toBeNull();
  });

  it("a missing header (null) resolves to null", async () => {
    const actor = await resolveServiceActorFromApiKey(null);
    expect(actor).toBeNull();
  });

  it("organizationId is taken exclusively from the matched key row — two different orgs' keys resolve to their own, distinct organizationId", async () => {
    const orgA = await seedOrg("crossA");
    const orgB = await seedOrg("crossB");
    const keyA = await issueKey(orgA);
    const keyB = await issueKey(orgB);

    const actorA = await resolveServiceActorFromApiKey(`Bearer ${keyA.plaintext}`);
    const actorB = await resolveServiceActorFromApiKey(`Bearer ${keyB.plaintext}`);
    expect(actorA!.organizationId).toBe(orgA);
    expect(actorB!.organizationId).toBe(orgB);
    expect(actorA!.organizationId).not.toBe(actorB!.organizationId);
  });

  it("resolution bumps last_used_at on the matched row", async () => {
    const orgId = await seedOrg("lastused");
    const { plaintext, apiKeyId } = await issueKey(orgId);

    const before = await getPool().query<{ last_used_at: string | null }>(
      "select last_used_at from public.api_keys where id = $1",
      [apiKeyId],
    );
    expect(before.rows[0]!.last_used_at).toBeNull();

    await resolveServiceActorFromApiKey(`Bearer ${plaintext}`);

    const after = await getPool().query<{ last_used_at: string | null }>(
      "select last_used_at from public.api_keys where id = $1",
      [apiKeyId],
    );
    expect(after.rows[0]!.last_used_at).not.toBeNull();
  });

  it("a tampered/incorrect key sharing only the correct prefix resolves to null", async () => {
    const orgId = await seedOrg("tampered");
    const { plaintext } = await issueKey(orgId);
    const tampered = plaintext.slice(0, -1) + (plaintext.endsWith("a") ? "b" : "a");

    const actor = await resolveServiceActorFromApiKey(`Bearer ${tampered}`);
    expect(actor).toBeNull();
  });
});

describe("hasScope: pure, deny-by-default", () => {
  it("returns true when the scope is present", () => {
    expect(hasScope({ apiKeyId: "x", organizationId: "y", scopes: ["enrichment:write"] }, "enrichment:write")).toBe(
      true,
    );
  });

  it("returns false when the scope is absent", () => {
    expect(hasScope({ apiKeyId: "x", organizationId: "y", scopes: ["events:read"] }, "enrichment:write")).toBe(
      false,
    );
  });

  it("returns false for an actor with no scopes at all", () => {
    expect(hasScope({ apiKeyId: "x", organizationId: "y", scopes: [] }, "enrichment:write")).toBe(false);
  });
});
