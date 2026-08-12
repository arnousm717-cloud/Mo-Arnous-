import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.1B schema/constraint coverage (docs/13-Technical-Design-
 * Review.md "Milestone 2.1" — Detailed design). Companies/contacts are
 * cascade-deleted along with their organization (companies.organization_id
 * / contacts.organization_id both `on delete cascade`), so
 * cleanupFixtures()'s existing `delete from organizations` already tears
 * these down too — no dedicated cleanup needed here.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
}

let fx: Fixture;

async function seedOrgs(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Schema Test Org A', $1) returning id",
      [`schema-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Schema Test Org B', $1) returning id",
      [`schema-test-org-b-${randomUUID()}`],
    );
    return { orgAId: orgA.rows[0]!.id, orgBId: orgB.rows[0]!.id };
  });
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

describe("companies: basic schema", () => {
  it("a company can be created with just organization_id and name", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.companies (organization_id, name) values ($1, $2) returning id, organization_id, name, domain, deleted_at",
        [fx.orgAId, "Acme Corp"],
      );
      return r.rows[0];
    });
    expect(row.name).toBe("Acme Corp");
    expect(row.organization_id).toBe(fx.orgAId);
    expect(row.domain).toBeNull();
    expect(row.deleted_at).toBeNull();
  });

  it("name is required", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.companies (organization_id) values ($1)", [fx.orgAId]);
      }),
    ).rejects.toThrow(/null value in column "name"/i);
  });
});

describe("contacts: lifecycle_stage", () => {
  it.each(["lead", "prospect", "customer", "inactive"])("accepts the approved value %s", async (stage) => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, first_name, lifecycle_stage) values ($1, $2, $3) returning lifecycle_stage",
        [fx.orgAId, "Stage Test", stage],
      );
      return r.rows[0];
    });
    expect(row.lifecycle_stage).toBe(stage);
  });

  it("rejects a lifecycle_stage outside the approved set", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.contacts (organization_id, first_name, lifecycle_stage) values ($1, $2, $3)",
          [fx.orgAId, "Bad Stage", "opportunity"],
        );
      }),
    ).rejects.toThrow(/contacts_lifecycle_stage_check|violates check constraint/i);
  });

  it("lifecycle_stage is nullable", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning lifecycle_stage",
        [fx.orgAId, "No Stage"],
      );
      return r.rows[0];
    });
    expect(row.lifecycle_stage).toBeNull();
  });
});

describe("contacts: identity CHECK constraint", () => {
  it("rejects a contact with no first_name, last_name, or email", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.contacts (organization_id) values ($1)", [fx.orgAId]);
      }),
    ).rejects.toThrow(/contacts_identity_required|violates check constraint/i);
  });

  it("rejects a contact whose only identity fields are whitespace-only", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.contacts (organization_id, first_name, last_name, email) values ($1, $2, $3, $4)",
          [fx.orgAId, "   ", "\t", "  "],
        );
      }),
    ).rejects.toThrow(/contacts_identity_required|violates check constraint/i);
  });

  it("accepts a contact identified by email alone", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, email) values ($1, $2) returning email",
        [fx.orgAId, `identity-${randomUUID()}@example.test`],
      );
      return r.rows[0];
    });
    expect(row.email).toContain("@example.test");
  });

  it("accepts a contact identified by first_name alone, surrounded by otherwise-empty fields", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, first_name, last_name, email) values ($1, $2, $3, $4) returning first_name",
        [fx.orgAId, "  Real Name  ", "", null],
      );
      return r.rows[0];
    });
    expect(row.first_name).toBe("  Real Name  ");
  });
});

describe("contacts: email uniqueness (case-insensitive, active contacts only)", () => {
  it("rejects a duplicate active email in the same organization, case-insensitively", async () => {
    const email = `Dup.Case.${randomUUID()}@Example.com`;
    // Seeded via seedAsAdmin (real commit) — withTenantContext always
    // rolls back its own transaction, so a row created in one
    // withTenantContext call is gone before the next one starts and would
    // never actually collide.
    await seedAsAdmin(async (client) => {
      await client.query("insert into public.contacts (organization_id, email) values ($1, $2)", [fx.orgAId, email]);
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.contacts (organization_id, email) values ($1, $2)", [
          fx.orgAId,
          email.toLowerCase(),
        ]);
      }),
    ).rejects.toThrow(/contacts_org_active_email_idx|duplicate key/i);
  });

  it("allows the same email across two different organizations", async () => {
    const email = `cross-org-${randomUUID()}@example.test`;
    await seedAsAdmin(async (client) => {
      await client.query("insert into public.contacts (organization_id, email) values ($1, $2)", [fx.orgAId, email]);
      await client.query("insert into public.contacts (organization_id, email) values ($1, $2)", [fx.orgBId, email]);
    });
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query("select organization_id from public.contacts where email = $1", [email]);
      return r.rows;
    });
    expect(rows).toHaveLength(2);
  });

  it("allows re-using an email after the original contact holding it is soft-deleted", async () => {
    const email = `reused-${randomUUID()}@example.test`;
    const original = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, email) values ($1, $2) returning id",
        [fx.orgAId, email],
      );
      return r.rows[0];
    });
    await seedAsAdmin(async (client) => {
      await client.query("update public.contacts set deleted_at = now() where id = $1", [original.id]);
    });
    const reused = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, email) values ($1, $2) returning id",
        [fx.orgAId, email],
      );
      return r.rows[0];
    });
    expect(reused.id).not.toBe(original.id);
    await seedAsAdmin(async (client) => {
      await client.query("delete from public.contacts where id = $1", [original.id]);
    });
  });

  it("allows multiple contacts with a NULL email in the same organization", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await client.query("insert into public.contacts (organization_id, first_name) values ($1, $2)", [
        fx.orgAId,
        "Null Email One",
      ]);
      const r = await client.query(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
        [fx.orgAId, "Null Email Two"],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });
});

describe("contacts: company FK (same-org success, cross-org failure)", () => {
  it("a contact can reference a company in its own organization", async () => {
    const company = await seedAsAdmin(async (client) => {
      const r = await client.query("insert into public.companies (organization_id, name) values ($1, $2) returning id", [
        fx.orgAId,
        "Same Org Co",
      ]);
      return r.rows[0];
    });
    const contact = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, company_id, first_name) values ($1, $2, $3) returning company_id",
        [fx.orgAId, company.id, "Linked Contact"],
      );
      return r.rows[0];
    });
    expect(contact.company_id).toBe(company.id);
  });

  it("a contact cannot reference a company belonging to a different organization", async () => {
    const companyInOrgB = await seedAsAdmin(async (client) => {
      const r = await client.query("insert into public.companies (organization_id, name) values ($1, $2) returning id", [
        fx.orgBId,
        "Org B Co",
      ]);
      return r.rows[0];
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.contacts (organization_id, company_id, first_name) values ($1, $2, $3)",
          [fx.orgAId, companyInOrgB.id, "Cross Org Attempt"],
        );
      }),
    ).rejects.toThrow(/contacts_company_org_fk|foreign key/i);
  });

  it("hard-deleting a company sets only company_id to NULL on its contacts, leaving organization_id intact", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const company = await client.query(
        "insert into public.companies (organization_id, name) values ($1, $2) returning id",
        [fx.orgAId, "About To Be Hard Deleted"],
      );
      const contact = await client.query(
        "insert into public.contacts (organization_id, company_id, first_name) values ($1, $2, $3) returning id",
        [fx.orgAId, company.rows[0].id, "Orphaned By Design"],
      );
      await client.query("delete from public.companies where id = $1", [company.rows[0].id]);
      const after = await client.query(
        "select organization_id, company_id from public.contacts where id = $1",
        [contact.rows[0].id],
      );
      expect(after.rows[0].company_id).toBeNull();
      expect(after.rows[0].organization_id).toBe(fx.orgAId);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("companies/contacts: updated_at trigger", () => {
  // Insert and update run as two separate, really-committed transactions
  // (seedAsAdmin, not withTenantContext) deliberately: now() is
  // transaction time in Postgres, frozen for the life of one transaction
  // — combining both statements into a single withTenantContext call
  // (to dodge its always-rollback behavior) would make both timestamps
  // identical regardless of whether the trigger works, since they'd share
  // one transaction's now(). Two separate transactions is what actually
  // exercises "does a later, real update produce a later timestamp."
  it("advances updated_at when a company row is updated", async () => {
    const inserted = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.companies (organization_id, name) values ($1, $2) returning id, updated_at",
        [fx.orgAId, "Timestamp Co"],
      );
      return r.rows[0];
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "update public.companies set name = $1 where id = $2 returning updated_at",
        ["Timestamp Co Renamed", inserted.id],
      );
      return r.rows[0];
    });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(inserted.updated_at).getTime());
  });

  it("advances updated_at when a contact row is updated", async () => {
    const inserted = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id, updated_at",
        [fx.orgAId, "Timestamp Contact"],
      );
      return r.rows[0];
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "update public.contacts set first_name = $1 where id = $2 returning updated_at",
        ["Timestamp Contact Renamed", inserted.id],
      );
      return r.rows[0];
    });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(inserted.updated_at).getTime());
  });
});

describe("soft delete", () => {
  it("a soft-deleted company row remains physically present after a real commit — never a physical DELETE", async () => {
    // Uses seedAsAdmin (real commit) deliberately, not withTenantContext
    // (which always rolls back) — this specifically proves persistence
    // across a real transaction boundary, not just within one still-open
    // transaction.
    const company = await seedAsAdmin(async (client) => {
      const insert = await client.query(
        "insert into public.companies (organization_id, name) values ($1, $2) returning id",
        [fx.orgAId, "Soft Deleted Co"],
      );
      await client.query("update public.companies set deleted_at = now() where id = $1", [insert.rows[0].id]);
      return insert.rows[0];
    });
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, deleted_at from public.companies where id = $1", [company.id]);
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(row.deleted_at).not.toBeNull();
    await seedAsAdmin(async (client) => {
      await client.query("delete from public.companies where id = $1", [company.id]);
    });
  });

  it("deleted_at can be cleared (restore) via an ordinary UPDATE", async () => {
    const company = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const insert = await client.query(
        "insert into public.companies (organization_id, name) values ($1, $2) returning id",
        [fx.orgAId, "Restore Test Co"],
      );
      await client.query("update public.companies set deleted_at = now() where id = $1", [insert.rows[0].id]);
      const restored = await client.query(
        "update public.companies set deleted_at = null where id = $1 returning deleted_at",
        [insert.rows[0].id],
      );
      return restored.rows[0];
    });
    expect(company.deleted_at).toBeNull();
  });

  it("RLS itself does not hide a soft-deleted row from an ordinary SELECT within the same organization", async () => {
    const company = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const insert = await client.query(
        "insert into public.companies (organization_id, name) values ($1, $2) returning id",
        [fx.orgAId, "Visible Despite Soft Delete"],
      );
      await client.query("update public.companies set deleted_at = now() where id = $1", [insert.rows[0].id]);
      const selected = await client.query("select id, deleted_at from public.companies where id = $1", [
        insert.rows[0].id,
      ]);
      return selected.rows[0];
    });
    expect(company).toBeDefined();
    expect(company.deleted_at).not.toBeNull();
  });
});
