import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.1 Phase 3: schema-level tests for the additive
 * brain_embeddings idempotency migration (20260907090000) — real
 * Postgres, direct SQL, no domain-layer calls, mirroring
 * brain-events-schema.test.ts's own style exactly. Covers what a
 * TypeScript-level test cannot: the constraint/FK/grant surface itself.
 */

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function seedOrg(name = "Brain Embeddings Schema Test Org"): Promise<string> {
  return seedAsAdmin(async (client) => {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      [name, `brain-embed-schema-org-${randomUUID()}`],
    );
    return org.rows[0]!.id;
  });
}

async function seedContactWithProfile(organizationId: string): Promise<{ contactId: string; profileId: string }> {
  return seedAsAdmin(async (client) => {
    const contact = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name) values ($1, 'Embed Test') returning id",
      [organizationId],
    );
    const profile = await client.query<{ id: string }>(
      `insert into public.brain_entity_profiles (organization_id, entity_type, contact_id, profile)
       values ($1, 'contact', $2, '{}'::jsonb) returning id`,
      [organizationId, contact.rows[0]!.id],
    );
    return { contactId: contact.rows[0]!.id, profileId: profile.rows[0]!.id };
  });
}

const FAKE_VECTOR = `[${Array.from({ length: 1536 }, () => "0").join(",")}]`;

async function insertEmbedding(
  organizationId: string,
  entityProfileId: string,
  overrides: { contentHash?: string; sourceVersionAt?: string } = {},
) {
  return seedAsAdmin(async (client) => {
    return client.query<{ id: string }>(
      `insert into public.brain_embeddings
         (organization_id, source_type, entity_profile_id, chunk_text, embedding, content_hash, source_version_at)
       values ($1, 'entity_profile', $2, 'test chunk', $3::vector, $4, $5)
       returning id`,
      [
        organizationId,
        entityProfileId,
        FAKE_VECTOR,
        overrides.contentHash ?? randomUUID(),
        overrides.sourceVersionAt ?? new Date().toISOString(),
      ],
    );
  });
}

describe("brain_embeddings: content_hash/source_version_at are CONDITIONALLY required (only when entity_profile_id is set)", () => {
  it("an entity_profile_id-less row (Phase 1's own general multi-entity-chunk shape) still inserts fine with none of the three new columns set — proves this migration does not break the existing shape", async () => {
    const organizationId = await seedOrg();
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          `insert into public.brain_embeddings (organization_id, source_type, chunk_text, embedding)
           values ($1, 'entity_profile', 'general chunk, no direct entity_profile_id', $2::vector)`,
          [organizationId, FAKE_VECTOR],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects an insert that sets entity_profile_id but omits content_hash", async () => {
    const organizationId = await seedOrg();
    const { profileId } = await seedContactWithProfile(organizationId);
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          `insert into public.brain_embeddings (organization_id, source_type, entity_profile_id, chunk_text, embedding, source_version_at)
           values ($1, 'entity_profile', $2, 'x', $3::vector, now())`,
          [organizationId, profileId, FAKE_VECTOR],
        ),
      ),
    ).rejects.toThrow(/brain_embeddings_entity_profile_identity_complete/);
  });

  it("rejects an insert that sets entity_profile_id but omits source_version_at", async () => {
    const organizationId = await seedOrg();
    const { profileId } = await seedContactWithProfile(organizationId);
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          `insert into public.brain_embeddings (organization_id, source_type, entity_profile_id, chunk_text, embedding, content_hash)
           values ($1, 'entity_profile', $2, 'x', $3::vector, 'hash')`,
          [organizationId, profileId, FAKE_VECTOR],
        ),
      ),
    ).rejects.toThrow(/brain_embeddings_entity_profile_identity_complete/);
  });

  it("accepts an insert that sets entity_profile_id together with both content_hash and source_version_at", async () => {
    const organizationId = await seedOrg();
    const { profileId } = await seedContactWithProfile(organizationId);
    await expect(insertEmbedding(organizationId, profileId)).resolves.toBeDefined();
  });
});

describe("brain_embeddings_entity_profile_uidx: one current row per entity profile", () => {
  it("a second insert for the same (organization_id, entity_profile_id) violates the partial unique index", async () => {
    const organizationId = await seedOrg();
    const { profileId } = await seedContactWithProfile(organizationId);
    await insertEmbedding(organizationId, profileId);
    await expect(insertEmbedding(organizationId, profileId)).rejects.toThrow(/brain_embeddings_entity_profile_uidx/);
  });

  it("two DIFFERENT entity profiles in the same org each get their own row — the index is not organization-global", async () => {
    const organizationId = await seedOrg();
    const a = await seedContactWithProfile(organizationId);
    const b = await seedContactWithProfile(organizationId);
    const first = await insertEmbedding(organizationId, a.profileId);
    const second = await insertEmbedding(organizationId, b.profileId);
    expect(first.rows[0]!.id).not.toBe(second.rows[0]!.id);
  });
});

describe("brain_embeddings_entity_profile_org_fk: tenant isolation", () => {
  it("rejects an entity_profile_id that belongs to a DIFFERENT organization even if the id itself is real", async () => {
    const orgA = await seedOrg("Brain Embeddings Schema Org A");
    const orgB = await seedOrg("Brain Embeddings Schema Org B");
    const { profileId } = await seedContactWithProfile(orgB);
    await expect(insertEmbedding(orgA, profileId)).rejects.toThrow(/brain_embeddings_entity_profile_org_fk/);
  });
});

describe("brain_embeddings_entity_profile_org_fk: ON DELETE CASCADE", () => {
  it("hard-erasing the owning contact (which cascades to its profile row) removes the embedding row structurally", async () => {
    const organizationId = await seedOrg();
    const { contactId, profileId } = await seedContactWithProfile(organizationId);
    const inserted = await insertEmbedding(organizationId, profileId);
    const embeddingId = inserted.rows[0]!.id;

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.contacts where id = $1", [contactId]);
    });

    const survives = await seedAsAdmin(async (client) => {
      const r = await client.query("select 1 from public.brain_embeddings where id = $1", [embeddingId]);
      return r.rows.length > 0;
    });
    expect(survives).toBe(false);
  });
});

describe("brain_embeddings grants: authenticated can now UPDATE in place", () => {
  it("an authenticated-role connection can UPDATE an existing row it owns (Phase 3 grant extension)", async () => {
    const organizationId = await seedOrg();
    const { profileId } = await seedContactWithProfile(organizationId);
    const inserted = await insertEmbedding(organizationId, profileId);
    const embeddingId = inserted.rows[0]!.id;

    const client = await adminPool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('app.current_org', $1, true)", [organizationId]);
      await client.query("select set_config('request.jwt.claims', json_build_object('role','authenticated')::text, true)");
      await expect(
        client.query("update public.brain_embeddings set chunk_text = 'updated' where id = $1", [embeddingId]),
      ).resolves.toBeDefined();
      await client.query("commit");
    } finally {
      client.release();
    }

    const updated = await seedAsAdmin(async (c) => {
      const r = await c.query<{ chunk_text: string }>("select chunk_text from public.brain_embeddings where id = $1", [embeddingId]);
      return r.rows[0]!.chunk_text;
    });
    expect(updated).toBe("updated");
  });
});
