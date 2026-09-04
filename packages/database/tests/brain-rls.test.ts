import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.1 Phase 1 RLS/privilege adversarial coverage (Brain
 * Foundation database + GDPR foundation). Mirrors pipelines-deals-
 * rls.test.ts exactly in style: real Postgres, never mocked, org A vs
 * org B.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
  contactAId: string;
  contactBId: string;
  profileAId: string;
  profileBId: string;
  embeddingAId: string;
  embeddingBId: string;
  docAId: string;
  docBId: string;
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Brain RLS Test Org A', $1) returning id",
      [`brain-rls-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Brain RLS Test Org B', $1) returning id",
      [`brain-rls-test-org-b-${randomUUID()}`],
    );
    const contactA = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name) values ($1, 'Org A Contact') returning id",
      [orgA.rows[0]!.id],
    );
    const contactB = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name) values ($1, 'Org B Contact') returning id",
      [orgB.rows[0]!.id],
    );
    const profileA = await client.query<{ id: string }>(
      "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2) returning id",
      [orgA.rows[0]!.id, contactA.rows[0]!.id],
    );
    const profileB = await client.query<{ id: string }>(
      "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2) returning id",
      [orgB.rows[0]!.id, contactB.rows[0]!.id],
    );
    const embeddingA = await client.query<{ id: string }>(
      "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'org a chunk') returning id",
      [orgA.rows[0]!.id],
    );
    const embeddingB = await client.query<{ id: string }>(
      "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'org b chunk') returning id",
      [orgB.rows[0]!.id],
    );
    const docA = await client.query<{ id: string }>(
      "insert into public.brain_knowledge_documents (organization_id, title, content_text) values ($1, 'Org A Doc', 'content') returning id",
      [orgA.rows[0]!.id],
    );
    const docB = await client.query<{ id: string }>(
      "insert into public.brain_knowledge_documents (organization_id, title, content_text) values ($1, 'Org B Doc', 'content') returning id",
      [orgB.rows[0]!.id],
    );
    return {
      orgAId: orgA.rows[0]!.id,
      orgBId: orgB.rows[0]!.id,
      contactAId: contactA.rows[0]!.id,
      contactBId: contactB.rows[0]!.id,
      profileAId: profileA.rows[0]!.id,
      profileBId: profileB.rows[0]!.id,
      embeddingAId: embeddingA.rows[0]!.id,
      embeddingBId: embeddingB.rows[0]!.id,
      docAId: docA.rows[0]!.id,
      docBId: docB.rows[0]!.id,
    };
  });
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedFixture();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("brain_*: cross-tenant SELECT isolation", () => {
  it("org A cannot SELECT org B's entity profile", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.brain_entity_profiles where id = $1", [fx.profileBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot SELECT org B's embedding", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.brain_embeddings where id = $1", [fx.embeddingBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot SELECT org B's knowledge document", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.brain_knowledge_documents where id = $1", [fx.docBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's knowledge document — no UPDATE grant exists for authenticated at all (Milestone 4.1 Phase 1 acceptance-audit fix round), so this is denied at the grant level before organization_id is even relevant", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("update public.brain_knowledge_documents set title = 'Hijacked' where id = $1", [
          fx.docBId,
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);
    const stillIntact = await seedAsAdmin(async (client) => {
      const r = await client.query("select title from public.brain_knowledge_documents where id = $1", [fx.docBId]);
      return r.rows[0];
    });
    expect(stillIntact.title).toBe("Org B Doc");
  });

  it("org A cannot UPDATE org B's entity profile", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "update public.brain_entity_profiles set profile = '{\"x\":1}'::jsonb where id = $1 returning id",
        [fx.profileBId],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});

describe("brain_*: WITH CHECK prevents organization_id spoofing on INSERT", () => {
  it("INSERT into a knowledge document is denied at the grant level regardless of organization_id — no INSERT grant exists for authenticated at all (Milestone 4.1 Phase 1 acceptance-audit fix round)", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_knowledge_documents (organization_id, title, content_text) values ($1, 'Spoofed', 'content')",
          [fx.orgBId],
        );
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("INSERT cannot spoof organization_id on an entity profile to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        // Deliberately targets org A's own contact with org B's spoofed
        // organization_id — RLS's WITH CHECK must reject this before the
        // composite FK (which would also reject it) is even relevant.
        await client.query(
          "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2)",
          [fx.orgBId, fx.contactAId],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("INSERT cannot spoof organization_id on an embedding to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'chunk')",
          [fx.orgBId],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("INSERT cannot spoof organization_id on a sync-state row to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.brain_sync_state (organization_id, sync_key) values ($1, $2)", [
          fx.orgBId,
          "spoofed_key",
        ]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });
});

describe("brain_*: effective grants match the approved design", () => {
  it("authenticated has SELECT/INSERT/UPDATE (no DELETE) on brain_entity_profiles/brain_sync_state", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type from information_schema.role_table_grants
         where table_schema = 'public'
           and table_name in ('brain_entity_profiles', 'brain_sync_state')
           and grantee = 'authenticated'
         order by table_name, privilege_type`,
      );
      return r.rows;
    });
    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.privilege_type]);
    }
    expect(byTable.get("brain_entity_profiles")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(byTable.get("brain_sync_state")).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("authenticated has exactly SELECT (no INSERT, no UPDATE, no DELETE) on brain_knowledge_documents — no compliant ingestion/DSR design exists yet (Milestone 4.1 Phase 1 acceptance-audit fix round)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'brain_knowledge_documents' and grantee = 'authenticated'`,
      );
      return r.rows.map((row) => row.privilege_type);
    });
    expect(rows).toEqual(["SELECT"]);
  });

  it("authenticated has exactly SELECT/INSERT (no UPDATE, no DELETE) on brain_entity_profile_history/brain_embeddings/brain_embedding_entity_refs", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type from information_schema.role_table_grants
         where table_schema = 'public'
           and table_name in ('brain_entity_profile_history', 'brain_embeddings', 'brain_embedding_entity_refs')
           and grantee = 'authenticated'
         order by table_name, privilege_type`,
      );
      return r.rows;
    });
    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.privilege_type]);
    }
    expect(byTable.get("brain_entity_profile_history")).toEqual(["INSERT", "SELECT"]);
    expect(byTable.get("brain_embeddings")).toEqual(["INSERT", "SELECT"]);
    expect(byTable.get("brain_embedding_entity_refs")).toEqual(["INSERT", "SELECT"]);
  });

  it.each([
    "brain_knowledge_documents",
    "brain_entity_profiles",
    "brain_entity_profile_history",
    "brain_embeddings",
    "brain_embedding_entity_refs",
    "brain_sync_state",
  ])("anon has zero grants on %s", async (table) => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = $1 and grantee = 'anon'`,
        [table],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it.each([
    "brain_knowledge_documents",
    "brain_entity_profiles",
    "brain_entity_profile_history",
    "brain_embeddings",
    "brain_embedding_entity_refs",
    "brain_sync_state",
  ])("an authenticated session genuinely cannot physically DELETE from %s", async (table) => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(`delete from public.${table} where organization_id = $1`, [fx.orgAId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it.each([
    "brain_knowledge_documents",
    "brain_entity_profiles",
    "brain_entity_profile_history",
    "brain_embeddings",
    "brain_embedding_entity_refs",
    "brain_sync_state",
  ])("an authenticated session genuinely cannot TRUNCATE %s", async (table) => {
    await expect(
      withTenantContext({}, async (client) => {
        await client.query(`truncate public.${table}`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
