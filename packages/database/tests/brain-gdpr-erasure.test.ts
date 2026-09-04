import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { closePool } from "../src/pool";
// Deliberately the REAL, committing withTenantContext (src/tenant-context),
// not tests/helpers.ts's always-rolled-back test variant — mirrors
// packages/compliance/tests/contact-erasure.test.ts's own
// createOrgWithOwner/executeContactErasure fixture pattern exactly, since
// this test needs create_organization_with_owner() and
// execute_contact_erasure() to actually persist.
import { withTenantContext } from "../src/tenant-context";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.1 Phase 1: GDPR/DSR coverage for the execute_contact_erasure()
 * Brain-embedding-purge extension (20260905090400). Calls the SQL function
 * directly via RPC (matching contact-erasure.test.ts's own "forged tenant
 * context" raw-SQL calling convention: `select * from
 * public.execute_contact_erasure($1, $2)`), staying entirely within
 * packages/database — this milestone does not touch packages/compliance.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `brain-gdpr-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createOrgWithOwner(ownerId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId: ownerId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `brain-gdpr-${randomUUID()}`,
      ownerId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

async function createContact(organizationId: string, firstName: string): Promise<string> {
  const row = await seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
      [organizationId, firstName],
    );
    return r.rows[0]!;
  });
  return row.id;
}

async function createCompany(organizationId: string, name: string): Promise<string> {
  const row = await seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name) values ($1, $2) returning id",
      [organizationId, name],
    );
    return r.rows[0]!;
  });
  return row.id;
}

async function fileDeleteDsr(organizationId: string, contactId: string): Promise<string> {
  const row = await seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'contact', $2, 'delete') returning id",
      [organizationId, contactId],
    );
    return r.rows[0]!;
  });
  return row.id;
}

async function executeErasure(admin: string, dsrId: string): Promise<{ target_contact_id: string; completed_at: string }> {
  return withTenantContext({ userId: admin }, async (client) => {
    const r = await client.query("select * from public.execute_contact_erasure($1, $2)", [dsrId, admin]);
    return r.rows[0];
  });
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("execute_contact_erasure: Brain profile/history cascade via composite FK", () => {
  it("erasing a contact removes its brain_entity_profiles and brain_entity_profile_history rows", async () => {
    const admin = await createAuthUser("profile-cascade-admin");
    const orgId = await createOrgWithOwner(admin, "Brain GDPR Profile Cascade Org");
    const contactId = await createContact(orgId, "Erased Profile Contact");
    const profileId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_entity_profiles (organization_id, entity_type, contact_id) values ($1, 'contact', $2) returning id",
        [orgId, contactId],
      );
      return r.rows[0]!.id;
    });
    const historyId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_entity_profile_history (organization_id, entity_profile_id, profile) values ($1, $2, $3) returning id",
        [orgId, profileId, JSON.stringify({ summary: "v1" })],
      );
      return r.rows[0]!.id;
    });

    const dsrId = await fileDeleteDsr(orgId, contactId);
    const result = await executeErasure(admin, dsrId);
    expect(result.target_contact_id).toBe(contactId);

    const profileAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.brain_entity_profiles where id = $1", [profileId]);
      return r.rows;
    });
    const historyAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.brain_entity_profile_history where id = $1", [historyId]);
      return r.rows;
    });
    expect(profileAfter).toEqual([]);
    expect(historyAfter).toEqual([]);
  });
});

describe("execute_contact_erasure: Brain-embedding targeted deletion (Milestone 4.1 Phase 1 acceptance-audit fix round)", () => {
  it("HOSTILE TEST 1 — MULTI-ENTITY PII: a shared embedding containing the erased contact's real name/email/phone is deleted in full, even though a company ref also exists", async () => {
    const admin = await createAuthUser("multi-entity-pii-admin");
    const orgId = await createOrgWithOwner(admin, "Brain GDPR Multi-Entity PII Org");
    const contactId = await createContact(orgId, "Jane HostileTest");
    const companyId = await createCompany(orgId, "Hostile Co");
    const erasedContactName = "Jane HostileTest";
    const erasedContactEmail = "jane.hostile@example.test";
    const erasedContactPhone = "555-0100";
    const chunkText = `${erasedContactName} (${erasedContactEmail}) mentioned she works at Hostile Co and her direct phone is ${erasedContactPhone}.`;
    const embeddingId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', $2) returning id",
        [orgId, chunkText],
      );
      return r.rows[0]!.id;
    });
    await seedAsAdmin(async (client) => {
      await client.query(
        "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
        [orgId, embeddingId, contactId],
      );
      await client.query(
        "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, company_id) values ($1, $2, 'company', $3)",
        [orgId, embeddingId, companyId],
      );
    });

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    // Contact is gone.
    const contactAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.contacts where id = $1", [contactId]);
      return r.rows;
    });
    expect(contactAfter).toEqual([]);

    // The target embedding is gone ENTIRELY — not merely the contact's own
    // ref on it. This is the exact case the acceptance audit reproduced as
    // a live BLOCKER: the embedding used to survive (because the company
    // ref remained), leaving the erased contact's own PII fully readable
    // in chunk_text. It must now be impossible to retrieve, because the
    // row itself no longer exists.
    const embeddingAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, chunk_text from public.brain_embeddings where id = $1", [
        embeddingId,
      ]);
      return r.rows;
    });
    expect(embeddingAfter).toEqual([]);

    // All refs for the target embedding are gone too (cascaded via the
    // embedding's own deletion, including the company's ref — not merely
    // the contact's).
    const refsAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.brain_embedding_entity_refs where embedding_id = $1", [
        embeddingId,
      ]);
      return r.rows;
    });
    expect(refsAfter).toEqual([]);

    // The erased contact's PII cannot be retrieved from brain_embeddings at
    // all — scanning every remaining row in the organization, not just the
    // one we expect to be gone.
    const anyRemainingChunkWithPii = await seedAsAdmin(async (client) => {
      const r = await client.query<{ chunk_text: string }>(
        "select chunk_text from public.brain_embeddings where organization_id = $1",
        [orgId],
      );
      return r.rows.some(
        (row) =>
          row.chunk_text.includes(erasedContactName) ||
          row.chunk_text.includes(erasedContactEmail) ||
          row.chunk_text.includes(erasedContactPhone),
      );
    });
    expect(anyRemainingChunkWithPii).toBe(false);

    // The company itself remains untouched — only the shared derived
    // artifact was removed, not the company entity.
    const companyAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, name from public.companies where id = $1", [companyId]);
      return r.rows;
    });
    expect(companyAfter).toEqual([{ id: companyId, name: "Hostile Co" }]);

    // Unrelated Brain data belonging to the company (its own, separate
    // entity_profiles row) survives — proves this was a targeted deletion
    // of the specific shared embedding, not a blanket sweep of the
    // company's own Brain data.
    const companyProfileId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_entity_profiles (organization_id, entity_type, company_id) values ($1, 'company', $2) returning id",
        [orgId, companyId],
      );
      return r.rows[0]!.id;
    });
    const companyProfileStillThere = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.brain_entity_profiles where id = $1", [companyProfileId]);
      return r.rows;
    });
    expect(companyProfileStillThere).toHaveLength(1);
  });

  it("HOSTILE TEST 2 — SAME-ORG UNRELATED ORPHAN: an unrelated, already-orphaned entity_profile embedding in the same organization survives byte-for-byte", async () => {
    const admin = await createAuthUser("unrelated-orphan-admin");
    const orgId = await createOrgWithOwner(admin, "Brain GDPR Unrelated Orphan Org");
    const contactId = await createContact(orgId, "Erased Contact With Own Embedding");

    // Embedding X: genuinely linked to the contact being erased.
    const targetEmbeddingId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'chunk genuinely about the erased contact') returning id",
        [orgId],
      );
      return r.rows[0]!.id;
    });
    await seedAsAdmin(async (client) => {
      await client.query(
        "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
        [orgId, targetEmbeddingId, contactId],
      );
    });

    // Embedding Y: unrelated, zero refs from the start (e.g. an in-flight
    // ingestion write with nothing to do with this contact) — same
    // organization. This is the exact case the acceptance audit reproduced
    // as a live HIGH defect: the prior "purge every orphan" design deleted
    // this too, as a side effect of an unrelated contact's erasure.
    const unrelatedChunkText = "Unrelated orphan chunk about nothing in particular, no refs yet";
    const unrelatedEmbeddingId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', $2) returning id",
        [orgId, unrelatedChunkText],
      );
      return r.rows[0]!.id;
    });

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    // X is deleted.
    const targetAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.brain_embeddings where id = $1", [targetEmbeddingId]);
      return r.rows;
    });
    expect(targetAfter).toEqual([]);

    // Y survives byte-for-byte — chunk_text unchanged.
    const unrelatedAfter = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string; chunk_text: string }>(
        "select id, chunk_text from public.brain_embeddings where id = $1",
        [unrelatedEmbeddingId],
      );
      return r.rows;
    });
    expect(unrelatedAfter).toHaveLength(1);
    expect(unrelatedAfter[0]!.chunk_text).toBe(unrelatedChunkText);
  });

  it("HOSTILE TEST 3 — CROSS-ORG SAFETY: an unrelated, already-orphaned embedding in a DIFFERENT organization is untouched", async () => {
    const admin = await createAuthUser("embedding-cross-org-admin");
    const orgId = await createOrgWithOwner(admin, "Brain GDPR Embedding Cross Org A");
    const otherOrgOwner = await createAuthUser("embedding-cross-org-owner-b");
    const otherOrgId = await createOrgWithOwner(otherOrgOwner, "Brain GDPR Embedding Cross Org B");
    const contactId = await createContact(orgId, "Erased Cross Org Contact");

    const otherOrgChunkText = "unrelated org B chunk";
    const otherOrgEmbeddingId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', $2) returning id",
        [otherOrgId, otherOrgChunkText],
      );
      return r.rows[0]!.id;
    });
    // Deliberately no entity refs at all for this org-B embedding — an
    // orphan in its own right, unrelated to org A's erasure, must be left
    // alone regardless.

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    const stillThere = await seedAsAdmin(async (client) => {
      const r = await client.query<{ chunk_text: string }>(
        "select chunk_text from public.brain_embeddings where id = $1",
        [otherOrgEmbeddingId],
      );
      return r.rows;
    });
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0]!.chunk_text).toBe(otherOrgChunkText);
  });

  it("target contact/company/deal entity refs are removed through deletion of the target embedding itself, not through a separate ref-cleanup step", async () => {
    const admin = await createAuthUser("target-refs-cascade-admin");
    const orgId = await createOrgWithOwner(admin, "Brain GDPR Target Refs Cascade Org");
    const contactId = await createContact(orgId, "Target Refs Cascade Contact");
    const companyId = await createCompany(orgId, "Target Refs Cascade Co");
    const embeddingId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, chunk_text) values ($1, 'entity_profile', 'chunk with contact and company refs') returning id",
        [orgId],
      );
      return r.rows[0]!.id;
    });
    const contactRefId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, contact_id) values ($1, $2, 'contact', $3) returning id",
        [orgId, embeddingId, contactId],
      );
      return r.rows[0]!.id;
    });
    const companyRefId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, company_id) values ($1, $2, 'company', $3) returning id",
        [orgId, embeddingId, companyId],
      );
      return r.rows[0]!.id;
    });

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    const refsAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.brain_embedding_entity_refs where id = any($1)", [
        [contactRefId, companyRefId],
      ]);
      return r.rows;
    });
    expect(refsAfter).toEqual([]);
  });

  it("a knowledge_document-sourced embedding (no entity refs by design) is left untouched by contact erasure", async () => {
    const admin = await createAuthUser("embedding-knowledge-doc-admin");
    const orgId = await createOrgWithOwner(admin, "Brain GDPR Knowledge Doc Org");
    const contactId = await createContact(orgId, "Erased Knowledge Doc Org Contact");
    const docId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_knowledge_documents (organization_id, title, content_text) values ($1, 'Unrelated Doc', 'content') returning id",
        [orgId],
      );
      return r.rows[0]!.id;
    });
    const embeddingId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.brain_embeddings (organization_id, source_type, knowledge_document_id, chunk_text) values ($1, 'knowledge_document', $2, 'doc chunk') returning id",
        [orgId, docId],
      );
      return r.rows[0]!.id;
    });

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    const stillThere = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.brain_embeddings where id = $1", [embeddingId]);
      return r.rows;
    });
    expect(stillThere).toHaveLength(1);
  });
});

describe("preview_contact_erasure: deliberately not extended for Brain data", () => {
  it("still returns only (can_proceed, blocker_reason, target_contact_id) — no Brain-specific field was added", async () => {
    const admin = await createAuthUser("preview-shape-admin");
    const orgId = await createOrgWithOwner(admin, "Brain GDPR Preview Shape Org");
    const contactId = await createContact(orgId, "Preview Shape Contact");
    const dsrId = await fileDeleteDsr(orgId, contactId);

    const row = await withTenantContext({ userId: admin }, async (client) => {
      const r = await client.query("select * from public.preview_contact_erasure($1, $2)", [dsrId, admin]);
      return r.rows[0];
    });
    expect(Object.keys(row).sort()).toEqual(["blocker_reason", "can_proceed", "target_contact_id"]);
  });
});
