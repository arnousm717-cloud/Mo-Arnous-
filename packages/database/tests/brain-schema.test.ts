import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.1 Phase 1 schema/constraint coverage (Brain Foundation
 * database + GDPR foundation). Mirrors pipelines-deals-schema.test.ts
 * exactly in style. Every brain_* table cascade-deletes along with its
 * organization, so cleanupFixtures()'s existing `delete from
 * organizations` already tears these down too — no dedicated cleanup
 * needed here.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
}

let fx: Fixture;

async function seedOrgs(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Brain Schema Test Org A', $1) returning id",
      [`brain-schema-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Brain Schema Test Org B', $1) returning id",
      [`brain-schema-test-org-b-${randomUUID()}`],
    );
    return { orgAId: orgA.rows[0]!.id, orgBId: orgB.rows[0]!.id };
  });
}

async function seedContact(
  client: import("pg").PoolClient,
  organizationId: string,
  firstName = "Brain Test Contact",
): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
    [organizationId, firstName],
  );
  return r.rows[0]!.id;
}

async function seedCompany(
  client: import("pg").PoolClient,
  organizationId: string,
  name = "Brain Test Co",
): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.companies (organization_id, name) values ($1, $2) returning id",
    [organizationId, name],
  );
  return r.rows[0]!.id;
}

async function seedDeal(client: import("pg").PoolClient, organizationId: string): Promise<string> {
  const pipeline = await client.query<{ id: string }>(
    "insert into public.pipelines (organization_id, name) values ($1, 'Brain Test Pipeline') returning id",
    [organizationId],
  );
  const stage = await client.query<{ id: string }>(
    "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, 'Brain Test Stage', 10) returning id",
    [organizationId, pipeline.rows[0]!.id],
  );
  const deal = await client.query<{ id: string }>(
    "insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3) returning id",
    [organizationId, pipeline.rows[0]!.id, stage.rows[0]!.id],
  );
  return deal.rows[0]!.id;
}

async function seedKnowledgeDocument(
  client: import("pg").PoolClient,
  organizationId: string,
  title = "Brain Test Doc",
): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.brain_knowledge_documents (organization_id, title, content_text) values ($1, $2, 'some content') returning id",
    [organizationId, title],
  );
  return r.rows[0]!.id;
}

function vectorLiteral(dims: number, fill = 0.1): string {
  return `[${Array.from({ length: dims }, () => fill).join(",")}]`;
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedOrgs();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("pgvector: extension and type", () => {
  it("the vector extension is installed", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query("select extname, extversion from pg_extension where extname = 'vector'");
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it("the vector type is available", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query("select typname from pg_type where typname = 'vector'");
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });
});

describe("deals prerequisite: composite UNIQUE(organization_id, id)", () => {
  it("the deals_organization_id_id_key unique constraint exists", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select conname from pg_constraint
         where conrelid = 'public.deals'::regclass and conname = 'deals_organization_id_id_key'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });
});

describe("brain_knowledge_documents: basic schema", () => {
  it("an admin-seeded document has title/content_text and defaults apply", async () => {
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.brain_knowledge_documents (organization_id, title, content_text) values ($1, $2, $3) returning source_type, deleted_at",
        [fx.orgAId, "Onboarding Guide", "Some content mentioning nothing personal."],
      );
      return r.rows[0];
    });
    expect(row.source_type).toBe("manual_upload");
    expect(row.deleted_at).toBeNull();
  });

  it("content_text is required", async () => {
    await expect(
      seedAsAdmin(async (client) => {
        await client.query("insert into public.brain_knowledge_documents (organization_id, title) values ($1, $2)", [
          fx.orgAId,
          "Missing Content",
        ]);
      }),
    ).rejects.toThrow(/null value in column "content_text"/i);
  });

  it("deleted_at soft-delete leaves the row physically present", async () => {
    const doc = await seedAsAdmin(async (client) => {
      const id = await seedKnowledgeDocument(client, fx.orgAId, "Soft Deleted Doc");
      await client.query("update public.brain_knowledge_documents set deleted_at = now() where id = $1", [id]);
      return { id };
    });
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.brain_knowledge_documents where id = $1", [
        doc.id,
      ]);
      return r.rows[0];
    });
    expect(row.deleted_at).not.toBeNull();
  });

  it("an ordinary authenticated session genuinely cannot INSERT into brain_knowledge_documents — no compliant ingestion/DSR design exists yet (Milestone 4.1 Phase 1 acceptance-audit fix round)", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_knowledge_documents (organization_id, title, content_text) values ($1, $2, $3)",
          [fx.orgAId, "Should Be Denied", "content"],
        );
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an ordinary authenticated session genuinely cannot UPDATE brain_knowledge_documents", async () => {
    const docId = await seedAsAdmin(async (client) => seedKnowledgeDocument(client, fx.orgAId, "Update Denied Doc"));
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("update public.brain_knowledge_documents set title = 'Hijacked' where id = $1", [docId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("brain_entity_profiles: entity_type/entity_match CHECK", () => {
  it("accepts a contact-only profile", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const contactId = await seedContact(client, fx.orgAId);
      const r = await client.query(
        "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2) returning entity_type, contact_id, company_id, deal_id",
        [fx.orgAId, contactId],
      );
      return r.rows[0];
    });
    expect(row.entity_type).toBe("contact");
    expect(row.contact_id).toBeTruthy();
    expect(row.company_id).toBeNull();
    expect(row.deal_id).toBeNull();
  });

  it("accepts a company-only profile", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const companyId = await seedCompany(client, fx.orgAId);
      const r = await client.query(
        "insert into public.brain_entity_profiles (organization_id, entity_type, company_id) values ($1, 'company', $2) returning entity_type, company_id",
        [fx.orgAId, companyId],
      );
      return r.rows[0];
    });
    expect(row.entity_type).toBe("company");
  });

  it("accepts a deal-only profile", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const dealId = await seedDeal(client, fx.orgAId);
      const r = await client.query(
        "insert into public.brain_entity_profiles (organization_id, entity_type, deal_id) values ($1, 'deal', $2) returning entity_type, deal_id",
        [fx.orgAId, dealId],
      );
      return r.rows[0];
    });
    expect(row.entity_type).toBe("deal");
  });

  it("rejects entity_type='contact' with contact_id null", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_entity_profiles (organization_id, entity_type) values ($1, 'contact')",
          [fx.orgAId],
        );
      }),
    ).rejects.toThrow(/brain_entity_profiles_entity_match|violates check constraint/i);
  });

  it("rejects a row with both contact_id and company_id set", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const contactId = await seedContact(client, fx.orgAId);
        const companyId = await seedCompany(client, fx.orgAId);
        await client.query(
          "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id, company_id) values ($1, 'contact', $2, $3)",
          [fx.orgAId, contactId, companyId],
        );
      }),
    ).rejects.toThrow(/brain_entity_profiles_entity_match|violates check constraint/i);
  });

  it("rejects an entity_type outside contact/company/deal", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const contactId = await seedContact(client, fx.orgAId);
        await client.query(
          "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'lead', $2)",
          [fx.orgAId, contactId],
        );
      }),
    ).rejects.toThrow(/violates check constraint/i);
  });
});

describe("brain_entity_profiles: composite-FK tenant isolation", () => {
  it("a profile cannot reference a contact belonging to a different organization", async () => {
    const contactInOrgB = await seedAsAdmin(async (client) => seedContact(client, fx.orgBId));
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2)",
          [fx.orgAId, contactInOrgB],
        );
      }),
    ).rejects.toThrow(/brain_entity_profiles_contact_org_fk|foreign key/i);
  });

  it("a profile cannot reference a deal belonging to a different organization", async () => {
    const dealInOrgB = await seedAsAdmin(async (client) => seedDeal(client, fx.orgBId));
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_entity_profiles (organization_id, entity_type, deal_id) values ($1, 'deal', $2)",
          [fx.orgAId, dealInOrgB],
        );
      }),
    ).rejects.toThrow(/brain_entity_profiles_deal_org_fk|foreign key/i);
  });
});

describe("brain_entity_profile_history: cross-tenant parent attack (Milestone 4.1 Phase 1 acceptance-audit regression coverage)", () => {
  it("org A cannot create a history row whose entity_profile_id points at org B's profile", async () => {
    const profileInOrgB = await seedAsAdmin(async (client) => {
      const contactB = await seedContact(client, fx.orgBId, "Org B History Attack Contact");
      const r = await client.query<{ id: string }>(
        "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2) returning id",
        [fx.orgBId, contactB],
      );
      return r.rows[0]!.id;
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_entity_profile_history (organization_id, entity_profile_id, profile) values ($1, $2, $3)",
          [fx.orgAId, profileInOrgB, JSON.stringify({})],
        );
      }),
    ).rejects.toThrow(/brain_entity_profile_history_profile_org_fk|foreign key/i);
  });
});

describe("brain_entity_profiles: at-most-one-profile-per-entity invariant", () => {
  it("a second profile for the same contact in the same organization is rejected", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const contactId = await seedContact(client, fx.orgAId);
        await client.query(
          "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2)",
          [fx.orgAId, contactId],
        );
        await client.query(
          "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2)",
          [fx.orgAId, contactId],
        );
      }),
    ).rejects.toThrow(/brain_entity_profiles_contact_uidx|duplicate key/i);
  });

  it("two different contacts (even in the same organization) can each have their own profile", async () => {
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const contactOne = await seedContact(client, fx.orgAId, "Contact One");
      const contactTwo = await seedContact(client, fx.orgAId, "Contact Two");
      await client.query(
        "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2)",
        [fx.orgAId, contactOne],
      );
      await client.query(
        "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2)",
        [fx.orgAId, contactTwo],
      );
    });
  });
});

describe("brain_entity_profiles: GDPR cascade on entity hard-delete", () => {
  it("hard-deleting a contact cascades to its brain_entity_profiles row", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const contactId = await seedContact(client, fx.orgAId, "Cascade Contact");
      const profile = await client.query<{ id: string }>(
        "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2) returning id",
        [fx.orgAId, contactId],
      );
      await client.query("delete from public.contacts where id = $1", [contactId]);
      const remaining = await client.query("select id from public.brain_entity_profiles where id = $1", [
        profile.rows[0]!.id,
      ]);
      expect(remaining.rows).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("brain_entity_profile_history: schema and cascade", () => {
  it("a history row can be created for an existing profile", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const contactId = await seedContact(client, fx.orgAId);
      const profile = await client.query<{ id: string }>(
        "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2) returning id",
        [fx.orgAId, contactId],
      );
      const r = await client.query(
        "insert into public.brain_entity_profile_history (organization_id, entity_profile_id, profile) values ($1, $2, $3) returning entity_profile_id",
        [fx.orgAId, profile.rows[0]!.id, JSON.stringify({ summary: "v1" })],
      );
      return r.rows[0];
    });
    expect(row.entity_profile_id).toBeTruthy();
  });

  it("hard-deleting the owning profile cascades to its history rows", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const contactId = await seedContact(client, fx.orgAId, "History Cascade Contact");
      const profile = await client.query<{ id: string }>(
        "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2) returning id",
        [fx.orgAId, contactId],
      );
      const history = await client.query<{ id: string }>(
        "insert into public.brain_entity_profile_history (organization_id, entity_profile_id, profile) values ($1, $2, $3) returning id",
        [fx.orgAId, profile.rows[0]!.id, JSON.stringify({ summary: "v1" })],
      );
      await client.query("delete from public.brain_entity_profiles where id = $1", [profile.rows[0]!.id]);
      const remaining = await client.query("select id from public.brain_entity_profile_history where id = $1", [
        history.rows[0]!.id,
      ]);
      expect(remaining.rows).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("brain_embeddings: source_match CHECK and vector column", () => {
  it("accepts an entity_profile-sourced row with knowledge_document_id null and embedding null", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'some chunk') returning source_type, knowledge_document_id, embedding",
        [fx.orgAId],
      );
      return r.rows[0];
    });
    expect(row.source_type).toBe("entity_profile");
    expect(row.knowledge_document_id).toBeNull();
    expect(row.embedding).toBeNull();
  });

  it("rejects source_type='knowledge_document' with knowledge_document_id null", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'knowledge_document', 'some chunk')",
          [fx.orgAId],
        );
      }),
    ).rejects.toThrow(/brain_embeddings_source_match|violates check constraint/i);
  });

  it("accepts a knowledge_document-sourced row referencing its own document", async () => {
    const docId = await seedAsAdmin(async (client) => seedKnowledgeDocument(client, fx.orgAId));
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.brain_embeddings (organization_id, source_type, knowledge_document_id, chunk_text) values ($1, 'knowledge_document', $2, 'chunk') returning knowledge_document_id",
        [fx.orgAId, docId],
      );
      return r.rows[0];
    });
    expect(row.knowledge_document_id).toBeTruthy();
  });

  it("a knowledge_document-sourced row cannot reference a document belonging to a different organization", async () => {
    const docInOrgB = await seedAsAdmin(async (client) => seedKnowledgeDocument(client, fx.orgBId));
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_embeddings (organization_id, source_type, knowledge_document_id, chunk_text) values ($1, 'knowledge_document', $2, 'chunk')",
          [fx.orgAId, docInOrgB],
        );
      }),
    ).rejects.toThrow(/brain_embeddings_knowledge_document_org_fk|foreign key/i);
  });

  it("accepts a well-formed 1536-dimension vector", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text, embedding) values ($1, 'entity_profile', 'chunk', $2::vector) returning embedding",
        [fx.orgAId, vectorLiteral(1536)],
      );
      return r.rows[0];
    });
    expect(row.embedding).toBeTruthy();
  });

  it("rejects a malformed vector with the wrong dimension count", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.brain_embeddings (organization_id, source_type, chunk_text, embedding) values ($1, 'entity_profile', 'chunk', $2::vector)",
          [fx.orgAId, vectorLiteral(3)],
        );
      }),
    ).rejects.toThrow(/different vector dimensions|expected 1536 dimensions/i);
  });

  it("hard-deleting the referenced knowledge document cascades to its embeddings", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const docId = await seedKnowledgeDocument(client, fx.orgAId, "Cascade Doc");
      const embedding = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, knowledge_document_id, chunk_text) values ($1, 'knowledge_document', $2, 'chunk') returning id",
        [fx.orgAId, docId],
      );
      await client.query("delete from public.brain_knowledge_documents where id = $1", [docId]);
      const remaining = await client.query("select id from public.brain_embeddings where id = $1", [
        embedding.rows[0]!.id,
      ]);
      expect(remaining.rows).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("brain_embedding_entity_refs: entity_match CHECK and cascade", () => {
  it("accepts a contact ref for an entity_profile-sourced embedding", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const contactId = await seedContact(client, fx.orgAId);
      const embedding = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'chunk') returning id",
        [fx.orgAId],
      );
      const r = await client.query(
        "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, contact_id) values ($1, $2, 'contact', $3) returning entity_type, contact_id",
        [fx.orgAId, embedding.rows[0]!.id, contactId],
      );
      return r.rows[0];
    });
    expect(row.entity_type).toBe("contact");
  });

  it("rejects an entity ref with entity_type='deal' but deal_id null", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const embedding = await client.query<{ id: string }>(
          "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'chunk') returning id",
          [fx.orgAId],
        );
        await client.query(
          "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type) values ($1, $2, 'deal')",
          [fx.orgAId, embedding.rows[0]!.id],
        );
      }),
    ).rejects.toThrow(/brain_embedding_entity_refs_entity_match|violates check constraint/i);
  });

  it("an entity ref cannot reference a company belonging to a different organization", async () => {
    const companyInOrgB = await seedAsAdmin(async (client) => seedCompany(client, fx.orgBId));
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const embedding = await client.query<{ id: string }>(
          "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'chunk') returning id",
          [fx.orgAId],
        );
        await client.query(
          "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, company_id) values ($1, $2, 'company', $3)",
          [fx.orgAId, embedding.rows[0]!.id, companyInOrgB],
        );
      }),
    ).rejects.toThrow(/brain_embedding_entity_refs_company_org_fk|foreign key/i);
  });

  it("cross-tenant parent attack (Milestone 4.1 Phase 1 acceptance-audit regression coverage): org A cannot create an entity ref whose embedding_id points at org B's embedding", async () => {
    const embeddingInOrgB = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'org b chunk') returning id",
        [fx.orgBId],
      );
      return r.rows[0]!.id;
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const contactId = await seedContact(client, fx.orgAId, "Cross Org Embedding Attack Contact");
        await client.query(
          "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
          [fx.orgAId, embeddingInOrgB, contactId],
        );
      }),
    ).rejects.toThrow(/brain_embedding_entity_refs_embedding_org_fk|foreign key/i);
  });

  it("a single embedding can carry refs to more than one entity (multi-entity chunk)", async () => {
    const refs = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const contactId = await seedContact(client, fx.orgAId, "Multi Entity Contact");
      const companyId = await seedCompany(client, fx.orgAId, "Multi Entity Co");
      const embedding = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'shared chunk') returning id",
        [fx.orgAId],
      );
      await client.query(
        "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
        [fx.orgAId, embedding.rows[0]!.id, contactId],
      );
      await client.query(
        "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, company_id) values ($1, $2, 'company', $3)",
        [fx.orgAId, embedding.rows[0]!.id, companyId],
      );
      const r = await client.query("select entity_type from public.brain_embedding_entity_refs where embedding_id = $1", [
        embedding.rows[0]!.id,
      ]);
      return r.rows;
    });
    expect(refs).toHaveLength(2);
  });

  it("hard-deleting the referenced contact cascades to its entity refs only, leaving the embedding row itself", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const contactId = await seedContact(client, fx.orgAId, "Ref Cascade Contact");
      const embedding = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'chunk') returning id",
        [fx.orgAId],
      );
      const ref = await client.query<{ id: string }>(
        "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, contact_id) values ($1, $2, 'contact', $3) returning id",
        [fx.orgAId, embedding.rows[0]!.id, contactId],
      );
      await client.query("delete from public.contacts where id = $1", [contactId]);
      const remainingRef = await client.query("select id from public.brain_embedding_entity_refs where id = $1", [
        ref.rows[0]!.id,
      ]);
      const remainingEmbedding = await client.query("select id from public.brain_embeddings where id = $1", [
        embedding.rows[0]!.id,
      ]);
      expect(remainingRef.rows).toEqual([]);
      // The embedding row itself is untouched by the FK cascade — its
      // removal (if now orphaned) is the explicit application-level purge
      // in execute_contact_erasure(), covered in brain-gdpr-erasure.test.ts,
      // not this table's own FK behavior.
      expect(remainingEmbedding.rows).toHaveLength(1);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("brain_sync_state: schema and uniqueness", () => {
  it("a sync-state row can be created with a sync_key", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.brain_sync_state (organization_id, sync_key) values ($1, $2) returning sync_key, cursor, last_synced_at",
        [fx.orgAId, "crm_contacts"],
      );
      return r.rows[0];
    });
    expect(row.sync_key).toBe("crm_contacts");
    expect(row.cursor).toEqual({});
    expect(row.last_synced_at).toBeNull();
  });

  it("a second row with the same sync_key in the same organization is rejected", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.brain_sync_state (organization_id, sync_key) values ($1, $2)", [
          fx.orgAId,
          "crm_deals",
        ]);
        await client.query("insert into public.brain_sync_state (organization_id, sync_key) values ($1, $2)", [
          fx.orgAId,
          "crm_deals",
        ]);
      }),
    ).rejects.toThrow(/brain_sync_state_organization_id_sync_key_key|duplicate key/i);
  });

  it("the same sync_key can exist independently for two different organizations", async () => {
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await client.query("insert into public.brain_sync_state (organization_id, sync_key) values ($1, $2)", [
        fx.orgAId,
        "visitor_identifications",
      ]);
    });
    await withTenantContext({ organizationId: fx.orgBId }, async (client) => {
      await client.query("insert into public.brain_sync_state (organization_id, sync_key) values ($1, $2)", [
        fx.orgBId,
        "visitor_identifications",
      ]);
    });
  });
});

describe("data_retention_policies: Brain registration", () => {
  it("brain_entity_profiles/brain_entity_profile_history/brain_embeddings/brain_embedding_entity_refs each have a platform-default retention row", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ data_type: string; retention_days: number }>(
        `select data_type, retention_days from public.data_retention_policies
         where organization_id is null
           and data_type in ('brain_entity_profiles', 'brain_entity_profile_history', 'brain_embeddings', 'brain_embedding_entity_refs')
         order by data_type`,
      );
      return r.rows;
    });
    expect(rows.map((r) => r.data_type)).toEqual([
      "brain_embedding_entity_refs",
      "brain_embeddings",
      "brain_entity_profile_history",
      "brain_entity_profiles",
    ]);
    for (const row of rows) {
      expect(row.retention_days).toBe(2555);
    }
  });

  it("brain_knowledge_documents and brain_sync_state deliberately have no retention row", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select data_type from public.data_retention_policies
         where organization_id is null and data_type in ('brain_knowledge_documents', 'brain_sync_state')`,
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});
